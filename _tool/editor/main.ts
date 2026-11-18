// Оболочка редактора: вход через GitLab (или запасной режим), загрузка модели, дерево, мастер, корзина и черновик.
// Токен GitLab живёт только в памяти (в GitLabClient); в хранилищах — черновик (localStorage) и кэш модели (sessionStorage).
import { loadConfig, type EditorConfig } from './config.js';
import { GitLabClient, GitLabError } from './gitlab/api.js';
import { authorizeUrl, createPkce, exchangeCode } from './gitlab/oauth.js';
import { pickLists, validateFiles, type FileMap, type PickLists, type Validation } from './model.js';
import { Cart, applyCart, loadDraft, reconcile, saveDraft, type Change } from './cart.js';
import { deleteChange, startEdit, startNew, toChange, type WizardKind, type WizardState } from './forms.js';
import { h } from './fields.js';
import { Wizard } from './wizard.js';
import type { PlatformNames } from '../src/model/names.js';

export interface Deps { fetch: typeof fetch; storage: Storage; session: Storage; location: Location }

export interface AppState {
  mode: 'gitlab' | 'offline';
  cfg?: EditorConfig;
  client?: GitLabClient;
  user?: { username: string; name: string };
  files: FileMap;
  blobs: Record<string, string>;
  dirs: string[];
  baseSha?: string;
  builtAt?: string;
  /** Проверка модели: main + корзина + текущая правка мастера. */
  validation: Validation;
  cart: Cart;
  /** Правки черновика, чей файл изменился в main: ждут решения пользователя. */
  conflicts: Change[];
  wizard?: WizardState;
  step: string;
  /** Путь правки в корзине, открытой в мастере (новый файл может сменить путь при смене имени). */
  cartPath?: string;
  openMrs: { iid: number; title: string; webUrl: string }[];
}

const SS_VERIFIER = 'arch-editor:verifier';
const SS_STATE = 'arch-editor:state';
const DEBOUNCE_MS = 300;
const EMPTY: Validation = { tree: null, model: null, loadErrors: [], findings: [], ok: false };
const TEAM_ID_RE = /^[a-z][a-z0-9-]*$/;

let doc: Document;
let deps: Deps;
let app: AppState;
let wizard: Wizard | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Последние непустые списки для полей: при ошибке схемы в правке дерево не строится, а списки нужны. */
let lists: { picks: PickLists; platform: PlatformNames } = { picks: pickLists(EMPTY), platform: { env: 'prod', domain: '', registry: '', git: '' } };

const $ = (id: string) => doc.getElementById(id) as HTMLElement;
const projectKey = () => app.cfg?.projectPath ?? 'offline';
const cacheKey = (sha: string) => `arch-editor:model:${projectKey()}:${sha}`;

function ss(fn: (s: Storage) => void): void {
  try { fn(deps.session); } catch { /* хранилище недоступно — без кэша */ }
}

// ---- статус, тосты, модальное окно ----

function setScreen(state: 'login' | 'loading' | 'ready' | 'error', ...content: Node[]): void {
  doc.body.dataset.state = state;
  if (content.length) $('app').replaceChildren(...content);
}

function toast(msg: string, kind: 'ok' | 'warn' | 'err' = 'ok'): void {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => { t.hidden = true; }, kind === 'ok' ? 3000 : 8000));
}

/** Review Focus 3: 401 посреди работы — войти снова; корзина уже в черновике и восстановится после входа. */
export function handleError(e: unknown, what: string): void {
  if (e instanceof GitLabError && e.kind === 'auth') {
    persist();
    const btn = h('button', { type: 'button', class: 'primary' }, 'Войти снова');
    btn.addEventListener('click', () => void login());
    $('modal').replaceChildren(h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'modalTitle' },
      h('h2', { id: 'modalTitle' }, 'Сессия истекла — войти снова'),
      h('p', {}, 'Корзина изменений сохранена в черновике и восстановится после входа.'), btn));
    $('modal').hidden = false;
    btn.focus();
    return;
  }
  toast(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'err');
}

// ---- вход ----

function rand(n: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

async function login(): Promise<void> {
  const cfg = app.cfg!;
  const { verifier, challenge } = await createPkce();
  const state = rand(16);
  try {
    deps.session.setItem(SS_VERIFIER, verifier);
    deps.session.setItem(SS_STATE, state);
  } catch {
    showLogin('Хранилище вкладки (sessionStorage) недоступно — вход невозможен.');
    return;
  }
  deps.location.assign(authorizeUrl(cfg, challenge, state));
}

function showLogin(error?: string): void {
  const btn = h('button', { type: 'button', class: 'primary', id: 'login' }, 'Войти через GitLab');
  btn.addEventListener('click', () => void login());
  setScreen('login', h('section', { class: 'login pane' },
    h('h2', {}, 'Редактор модели архитектуры'),
    h('p', {}, 'Правки собираются в корзину и уходят в GitLab одним merge request. Войдите, чтобы прочитать модель из ',
      h('code', {}, app.cfg!.baseBranch), '.'),
    error ? h('p', { class: 'msg err' }, error) : null, btn,
    h('p', { class: 'empty' }, `Проект: ${app.cfg!.projectPath}`)));
}

async function finishLogin(code: string, state: string): Promise<void> {
  const cfg = app.cfg!;
  doc.defaultView?.history.replaceState(null, '', deps.location.pathname);
  let verifier: string | null = null;
  let expected: string | null = null;
  try {
    verifier = deps.session.getItem(SS_VERIFIER);
    expected = deps.session.getItem(SS_STATE);
    deps.session.removeItem(SS_VERIFIER);
    deps.session.removeItem(SS_STATE);
  } catch { /* ниже — ошибка входа */ }
  if (!verifier || state !== expected) return showLogin('Вход начат в другой вкладке или устарел — войдите снова.');
  setScreen('loading', h('p', { class: 'empty center' }, 'Вход…'));
  try {
    const token = await exchangeCode(cfg, code, verifier, deps.fetch);
    app.client = new GitLabClient(cfg, token, deps.fetch);
    app.user = await app.client.user();
  } catch (e) {
    return showLogin(`Вход не удался: ${e instanceof Error ? e.message : String(e)}`);
  }
  await loadFromGitLab();
}

// ---- загрузка модели ----

type CachedModel = { files: FileMap; blobs: Record<string, string>; dirs: string[] };

/** Кэш модели вкладки по baseSha: голова ветки не изменилась — без повторной загрузки. */
function readCache(sha: string): CachedModel | null {
  let out: CachedModel | null = null;
  ss((s) => {
    const raw = s.getItem(cacheKey(sha));
    const v = raw ? (JSON.parse(raw) as Partial<CachedModel>) : null;
    if (v && typeof v.files === 'object' && typeof v.blobs === 'object' && Array.isArray(v.dirs)) out = v as CachedModel;
  });
  return out;
}

async function loadFromGitLab(): Promise<void> {
  const client = app.client!;
  const cfg = app.cfg!;
  setScreen('loading', h('p', { class: 'empty center' }, `Загрузка модели из ${cfg.baseBranch}…`));
  try {
    const head = await client.branchHead(cfg.baseBranch);
    const cached = readCache(head);
    const m = cached ? { ...cached, baseSha: head } : await client.loadModel(cfg.baseBranch);
    const baseSha = m.baseSha;
    Object.assign(app, { files: m.files, blobs: m.blobs, dirs: m.dirs, baseSha });
    if (!cached) {
      ss((s) => {
        const prefix = cacheKey('');
        for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(prefix)) s.removeItem(k); }
        s.setItem(cacheKey(baseSha), JSON.stringify({ files: m.files, blobs: m.blobs, dirs: m.dirs }));
      });
    }
  } catch (e) {
    if (e instanceof GitLabError && e.kind === 'auth') return showLogin('Сессия истекла — войдите снова.');
    setScreen('error', h('p', { class: 'msg err center' }, `Не удалось загрузить модель: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  start();
  client.openMrs(app.user!.username).then((mrs) => { app.openMrs = mrs; renderBanners(); }, (e) => handleError(e, 'Открытые MR'));
}

async function loadOffline(): Promise<void> {
  try {
    const res = await deps.fetch('model.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.json()) as { files: FileMap; builtAt?: string };
    const dirs = new Set<string>();
    for (const p of Object.keys(m.files)) {
      const parts = p.split('/');
      if (parts.length < 2 || /^[_.]/.test(parts[0]!)) continue;
      dirs.add(parts[0]!);
      if (parts.length > 2 && !/^[_.]/.test(parts[1]!)) dirs.add(`${parts[0]}/${parts[1]}`);
    }
    Object.assign(app, { files: m.files, blobs: {}, dirs: [...dirs].sort(), builtAt: m.builtAt });
  } catch (e) {
    setScreen('error', h('p', { class: 'msg err center' }, `Не удалось загрузить model.json: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  start();
}

/** Модель загружена: черновик → корзина (сверка с main), первая проверка, экран. */
function start(): void {
  const draft = loadDraft(deps.storage, projectKey());
  const { applied, conflicts } = app.mode === 'gitlab' ? reconcile(draft, app.blobs) : { applied: draft, conflicts: [] };
  for (const c of applied) app.cart.put(c);
  app.conflicts = conflicts;
  revalidate();
  setScreen('ready', h('aside', { class: 'pane tree', id: 'tree', 'aria-label': 'Модель' }), h('section', { class: 'pane wiz', id: 'wizard' }));
  renderAll();
}

// ---- проверка и корзина ----

function blobOf(path: string): string | null {
  return app.cart.changes().find((c) => c.path === path)?.baseBlobId ?? app.blobs[path] ?? null;
}

/** Правка из формы мастера; error — почему её нельзя построить. */
function currentChange(): { change: Change | null; error: string | null } {
  const st = app.wizard;
  if (!st) return { change: null, error: null };
  if (st.kind === 'service' && !String(st.data.name ?? '')) return { change: null, error: 'Укажите имя сервиса.' };
  if (st.kind === 'product' && !String(st.data.code ?? '')) return { change: null, error: 'Укажите код продукта.' };
  if (st.kind === 'team' && !TEAM_ID_RE.test(st.team)) return { change: null, error: 'Id команды: латиница в нижнем регистре, цифры и дефис, с буквы.' };
  try {
    const change = toChange(st, st.isNew ? null : blobOf(st.path));
    if (st.isNew && change.path !== app.cartPath && change.path in applyCart(app.files, app.cart.changes())) {
      return { change: null, error: `Файл ${change.path} уже есть в модели — откройте его в дереве.` };
    }
    return { change, error: null };
  } catch (e) {
    return { change: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function pendingChanges(): Change[] {
  const { change } = currentChange();
  const rest = app.cart.changes().filter((c) => c.path !== app.cartPath && c.path !== change?.path);
  return change ? [...rest, change] : rest;
}

function revalidate(): void {
  app.validation = validateFiles(applyCart(app.files, pendingChanges()), app.dirs);
  let src = app.validation;
  if (!src.tree) src = validateFiles(applyCart(app.files, app.cart.changes()), app.dirs);
  if (!src.tree) src = validateFiles(app.files, app.dirs);
  if (src.tree) {
    const p = src.tree.platform;
    lists = { picks: pickLists(src), platform: { env: p.env ?? 'prod', domain: p.domain, registry: p.registry, git: p.git } };
  }
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => { revalidate(); wizard?.refresh(); }, DEBOUNCE_MS);
}

function persist(): void {
  if (!saveDraft(deps.storage, projectKey(), [...app.cart.changes(), ...app.conflicts])) {
    toast('Черновик не сохранён: хранилище браузера недоступно или переполнено. Правки живут до закрытия вкладки.', 'warn');
  }
}

function cartChanged(): void {
  persist();
  revalidate();
  renderAll();
}

function toCart(): void {
  const st = app.wizard!;
  const { change, error } = currentChange();
  if (!change) return toast(error ?? 'Правку нельзя положить в корзину', 'err');
  try {
    if (app.cartPath && app.cartPath !== change.path) app.cart.remove(app.cartPath);
    if (change.content === app.files[change.path]) app.cart.remove(change.path); // вернули как в main — правки нет
    else app.cart.put(change);
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e), 'err');
  }
  const step = app.step;
  toast(`В корзине: ${change.label}`);
  cartChanged();
  open(st.kind, change.path, step);
}

function removeService(path: string, id: string): void {
  if (path in app.files) app.cart.put(deleteChange(path, app.blobs[path] ?? null, id));
  else app.cart.remove(path);
  if (app.wizard && (app.wizard.path === path || app.cartPath === path)) closeWizard();
  toast(`В корзине: удаление сервиса ${id}`);
  cartChanged();
}

// ---- мастер ----

const kindOf = (path: string): WizardKind => (path.endsWith('/team.yaml') ? 'team' : path.endsWith('/product.yaml') ? 'product' : 'service');

function open(kind: WizardKind, path: string, step = 'main'): void {
  const inCart = app.cart.changes().find((c) => c.path === path && c.content !== null);
  const text = inCart?.content ?? app.files[path];
  if (text === undefined) return toast(`Файла ${path} нет в модели`, 'err');
  const st = startEdit(kind, path, text);
  if (inCart && !(path in app.files)) st.isNew = true; // новый файл из корзины правится целиком
  app.cartPath = inCart ? path : undefined;
  showWizard(st, step);
}

function create(kind: WizardKind, team = '', product?: string): void {
  app.cartPath = undefined;
  showWizard(startNew(kind, team, product), 'main');
}

function showWizard(st: WizardState, step: string): void {
  app.wizard = st;
  app.step = step;
  revalidate();
  wizard = new Wizard($('wizard'), st, {
    lists: () => lists.picks,
    platform: () => lists.platform,
    validation: () => app.validation,
    current: () => { const { change, error } = currentChange(); return { path: change?.path ?? null, error }; },
    changed: schedule,
    stepChanged: (s) => { app.step = s; },
    toCart,
    close: closeWizard,
  }, step);
  wizard.render();
  renderTree();
}

function closeWizard(): void {
  app.wizard = undefined;
  app.cartPath = undefined;
  wizard = null;
  revalidate();
  renderAll();
}

// ---- отрисовка ----

function renderAll(): void {
  renderHeader();
  renderBanners();
  renderTree();
  if (!wizard) {
    $('wizard').replaceChildren(h('div', { class: 'intro' },
      h('h2', {}, 'Выберите элемент слева'),
      h('p', { class: 'empty' }, 'Откройте сервис, продукт или команду, чтобы изменить их, или создайте новый кнопками «+ команда», «+ продукт», «+ сервис». Изменения копятся в корзине до создания MR.')));
  }
}

function renderHeader(): void {
  const n = app.cart.changes().length;
  const cnt = $('cartCount');
  cnt.hidden = false;
  cnt.textContent = `Изменений: ${n}`;
  cnt.classList.toggle('on', n > 0);
  const u = $('user');
  u.hidden = !app.user;
  u.textContent = app.user ? `${app.user.name} · @${app.user.username}` : '';
  const b = $('builtAt');
  b.hidden = app.mode !== 'offline';
  if (app.mode === 'offline') {
    const d = app.builtAt ? new Date(app.builtAt) : null;
    b.textContent = `Модель от ${d && !isNaN(d.getTime()) ? d.toLocaleString('ru-RU') : 'неизвестной даты'}`;
  }
}

function renderBanners(): void {
  const out: Node[] = [];
  if (app.openMrs.length) {
    out.push(h('div', { class: 'banner' }, h('strong', {}, 'Ваши открытые MR (ещё не в main): '),
      ...app.openMrs.flatMap((m, i) => [i ? ', ' : '', h('a', { href: m.webUrl, target: '_blank', rel: 'noopener' }, `!${m.iid} ${m.title}`)])));
  }
  if (app.conflicts.length) {
    const box = h('div', { class: 'banner conflict', id: 'conflicts' },
      h('strong', {}, 'Черновик: эти файлы изменились в main после вашей правки. Автослияния нет — выберите действие.'));
    for (const c of app.conflicts) {
      const drop = h('button', { type: 'button', class: 'ghost' }, 'Отбросить мою правку');
      drop.addEventListener('click', () => resolveConflict(c, false));
      const reopen = h('button', { type: 'button', class: 'ghost' }, 'Открыть заново');
      reopen.addEventListener('click', () => resolveConflict(c, true));
      box.append(h('div', { class: 'crow' }, h('span', {}, c.label), h('code', {}, c.path), h('span', { class: 'sp' }), drop, reopen));
    }
    out.push(box);
  }
  $('banners').replaceChildren(...out);
}

function resolveConflict(c: Change, reopen: boolean): void {
  app.conflicts = app.conflicts.filter((x) => x !== c);
  cartChanged();
  if (!reopen) return;
  if (c.path in app.files) open(kindOf(c.path), c.path);
  else toast(`Файла ${c.path} больше нет в main — правку повторить нельзя`, 'warn');
}

function btn(label: string, cls: string, onClick: () => void, aria?: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, 'aria-label': aria ?? false, title: aria ?? false }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** Дерево по путям файлов (main + корзина): работает и когда модель не проходит проверку. */
function renderTree(): void {
  const el = doc.getElementById('tree');
  if (!el) return;
  const files = applyCart(app.files, app.cart.changes());
  const changed = new Map(app.cart.changes().map((c) => [c.path, c]));
  const names = new Map<string, string>();
  for (const t of lists.picks.teams) names.set(t.id, t.name);
  for (const p of lists.picks.products) names.set(`${p.team}/${p.code}`, p.name);
  const cur = app.wizard ? (app.cartPath ?? app.wizard.path) : '';
  const tag = (path: string) => {
    const c = changed.get(path);
    return c ? h('span', { class: `chg ${c.content === null ? 'del' : path in app.files ? 'mod' : 'new'}` }, c.content === null ? 'удалён' : path in app.files ? 'изменён' : 'новый') : null;
  };
  const item = (path: string, label: string, sub: string, kind: WizardKind) => {
    const b = h('button', { type: 'button', class: 'node', 'aria-current': cur === path ? 'true' : false }, h('span', { class: 'k' }, sub), label, tag(path));
    b.addEventListener('click', () => open(kind, path));
    return b;
  };

  const teams = [...new Set(Object.keys(files).map((p) => p.split('/')).filter((p) => p.length > 1 && !/^[_.]/.test(p[0]!)).map((p) => p[0]!))].sort();
  const root = h('ul', {});
  for (const team of teams) {
    const tpath = `${team}/team.yaml`;
    const products = [...new Set(Object.keys(files).filter((p) => p.startsWith(`${team}/`) && p.endsWith('/product.yaml') && p.split('/').length === 3).map((p) => p.split('/')[1]!))].sort();
    const pl = h('ul', {});
    for (const code of products) {
      const prefix = `${team}/${code}/services/`;
      const svcs = Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).sort();
      const deleted = [...changed.values()].filter((c) => c.content === null && c.path.startsWith(prefix));
      const sl = h('ul', {});
      for (const p of svcs) {
        const base = p.slice(prefix.length).replace(/\.ya?ml$/, '');
        const id = `${code}-${base}`;
        sl.append(h('li', { class: 'svc' }, item(p, base, 'сервис', 'service'),
          btn('✕', 'ghost icon', () => removeService(p, id), 'Удалить сервис')));
      }
      for (const c of deleted) sl.append(h('li', { class: 'svc gone' }, h('span', {}, c.path.slice(prefix.length).replace(/\.ya?ml$/, '')), tag(c.path)));
      sl.append(h('li', {}, btn('+ сервис', 'ghost add', () => create('service', team, code))));
      pl.append(h('li', {}, item(`${team}/${code}/product.yaml`, names.get(`${team}/${code}`) ?? code, code, 'product'), sl));
    }
    pl.append(h('li', {}, btn('+ продукт', 'ghost add', () => create('product', team))));
    root.append(h('li', {}, tpath in files ? item(tpath, names.get(team) ?? team, team, 'team') : h('span', { class: 'node' }, team), pl));
  }
  el.replaceChildren(
    h('div', { class: 'lvl' }, 'Команды, продукты, сервисы'),
    btn('+ команда', 'ghost add', () => create('team')),
    root,
    h('p', { class: 'shared' }, h('code', {}, '_shared'), ' — сети, платформа, справочники: только чтение, меняют архитекторы.'),
  );
}

// ---- вход в приложение ----

export async function boot(d: Document, dp: Deps): Promise<void> {
  doc = d;
  deps = dp;
  const cfg = await loadConfig(dp.fetch, 'config.json');
  app = {
    mode: cfg ? 'gitlab' : 'offline', cfg: cfg ?? undefined, files: {}, blobs: {}, dirs: [],
    validation: EMPTY, cart: new Cart(), conflicts: [], step: 'main', openMrs: [],
  };
  if (!cfg) return loadOffline();
  const q = new URLSearchParams(dp.location.search);
  const code = q.get('code');
  if (code) return finishLogin(code, q.get('state') ?? '');
  showLogin(q.get('error') ? `GitLab отклонил вход: ${q.get('error_description') ?? q.get('error')}` : undefined);
}

/** Хранилище в памяти — если браузер запрещает localStorage/sessionStorage. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

function storageOr(get: () => Storage): Storage {
  try { return get(); } catch { return memoryStorage(); }
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  void boot(document, {
    fetch: (input, init) => fetch(input, init),
    storage: storageOr(() => localStorage),
    session: storageOr(() => sessionStorage),
    location,
  });
}
