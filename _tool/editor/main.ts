// Оболочка редактора: связывает вход, загрузку модели, дерево, мастер, корзину и черновик.
// Токен GitLab живёт только в памяти (в GitLabClient); в хранилищах — черновик (localStorage) и кэш модели (sessionStorage).
import { loadConfig } from './config.js';
import { GitLabError } from './gitlab/api.js';
import { pickLists, validateFiles, type PickLists, type Validation } from './model.js';
import { Cart, applyCart, isSharedPath, loadDraft, reconcile, saveDraft, type Change } from './cart.js';
import { deleteChange, nameError, startEdit, startNew, toChange, type WizardKind, type WizardState } from './forms.js';
import { h } from './fields.js';
import { Wizard } from './wizard.js';
import { doneView, renderReview, resetReviewEdits, submitting, type ReviewHost, type Status } from './review.js';
import type { Finding } from '../src/model/types.js';
import type { LoadError } from '../src/model/raw.js';
import { stepOfFinding } from './forms.js';
import { platformNames, type PlatformNames } from '../src/model/names.js';
import { projectKey as projectKeyOf, type AppState, type Deps, type Env } from './state.js';
import { btn, byId, setScreen as setScreenIn, toast as toastIn } from './ui.js';
import { finishLogin, showLogin, showSessionExpired } from './auth.js';
import { loadFromGitLab as loadFromGitLabIn, loadOffline as loadOfflineIn, refreshOpenMrs, type LoadHooks } from './loading.js';
import { renderBanners as renderBannersIn, renderHeader } from './banners.js';
import { restoreDraft } from './draft.js';
import { autoBoot } from './browser.js';
import { renderTree as renderTreeIn, type TreeActions } from './tree.js';

export type { AppState, Deps };

const DEBOUNCE_MS = 300;
const EMPTY: Validation = { tree: null, model: null, loadErrors: [], findings: [], ok: false };

let doc: Document;
let deps: Deps;
let app: AppState;
let env: Env;
let wizard: Wizard | null = null;
/** Шаг «Проверка и MR» открыт без мастера (кнопкой счётчика корзины). */
let standalone = false;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Последние непустые списки для полей: при ошибке схемы в правке дерево не строится, а списки нужны. */
let lists: { picks: PickLists; platform: PlatformNames } = { picks: pickLists(EMPTY), platform: { env: 'prod', domain: '', registry: '', git: '' } };


const $ = (id: string) => byId(doc, id);
const projectKey = () => projectKeyOf(app, deps.location);

// ---- статус, тосты, модальное окно ----

const setScreen = (state: 'login' | 'loading' | 'ready' | 'error', ...content: Node[]) => setScreenIn(doc, state, ...content);
const toast = (msg: string, kind: 'ok' | 'warn' | 'err' = 'ok') => toastIn(doc, msg, kind);

/** Review Focus 3: 401 посреди работы — войти снова; корзина уже в черновике и восстановится после входа. */
export function handleError(e: unknown, what: string): void {
  if (e instanceof GitLabError && e.kind === 'auth') { persist(); return showSessionExpired(env); }
  toast(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'err');
}

// ---- вход и загрузка модели (auth.ts, loading.ts) ----

const loadHooks: LoadHooks = { start, banners: () => renderBanners(), error: handleError };
const loadFromGitLab = () => loadFromGitLabIn(env, loadHooks);

/** Модель загружена: черновик → корзина (сверка с main), первая проверка, экран. */
function start(): void {
  restoreDraft(env, toast, projectKey());
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
  const bad = nameError(st); // имя/код/id — часть пути файла: «Foo/bar», «../evil» вывели бы файл из раскладки модели
  if (bad) return { change: null, error: bad };
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
    lists = { picks: pickLists(src), platform: platformNames(src.tree.platform) };
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

/** Текущая правка мастера → корзина; null — правку построить нельзя (тост с причиной). */
function putCurrent(): Change | null {
  const { change, error } = currentChange();
  if (!change) { toast(error ?? 'Правку нельзя положить в корзину', 'err'); return null; }
  try {
    if (app.cartPath && app.cartPath !== change.path) app.cart.remove(app.cartPath);
    if (change.content === app.files[change.path]) app.cart.remove(change.path); // вернули как в main — правки нет
    else app.cart.put(change);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'err');
    return null;
  }
  app.cartPath = app.cart.changes().some((c) => c.path === change.path) ? change.path : undefined;
  cartChanged();
  return change;
}

function toCart(): void {
  const st = app.wizard!;
  const step = app.step;
  const change = putCurrent();
  if (!change) return;
  toast(`В корзине: ${change.label}`);
  open(st.kind, change.path, step);
}

function removeService(path: string, id: string): void {
  if (!doc.defaultView?.confirm(`Удалить сервис ${id}? Удаление попадёт в корзину; убрать его можно до создания MR.`)) return;
  if (path in app.files) app.cart.put(deleteChange(path, app.blobs[path] ?? null, id));
  else app.cart.remove(path);
  if (app.wizard && (app.wizard.path === path || app.cartPath === path)) closeWizard();
  toast(`В корзине: удаление сервиса ${id}`);
  cartChanged();
}

/** «Убрать из корзины»: правка файла отменяется; открытый на этом файле мастер закрывается, шаг проверки остаётся. */
function removeFromCart(path: string): void {
  if (submitting()) return toast('Дождитесь окончания создания MR', 'warn');
  const label = pendingChanges().find((c) => c.path === path)?.label ?? path;
  const editing = !!app.wizard && (app.cartPath === path || app.wizard.path === path || currentChange().change?.path === path);
  app.cart.remove(path);
  if (editing) {
    app.wizard = undefined;
    app.cartPath = undefined;
    wizard = null;
    standalone = true;
  }
  cartChanged();
  if (wizard && app.step === 'review') wizard.go('review');
  else wizard?.refresh();
  toast(`Убрано из корзины: ${label}`);
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
  standalone = false;
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
    review: (el) => {
      // сводка и кнопка — по проверке текущих полей, а не по отложенной (debounce) проверке
      clearTimeout(timer);
      revalidate();
      renderReview(el, reviewHost());
    },
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

// ---- проверка и MR ----

function reviewHost(): ReviewHost {
  return {
    app: () => app,
    changes: () => pendingChanges().filter((c) => c.content !== app.files[c.path]),
    openFinding,
    flush: () => !app.wizard || putCurrent() !== null,
    storage: deps.storage,
    done: mrCreated,
    error: handleError,
    reload: (notice) => void reload(notice),
    remove: removeFromCart,
    busy: (on) => { ($('reload') as HTMLButtonElement).disabled = on; },
  };
}

function openFinding(f: Finding | LoadError): void {
  const path = f.file!;
  const kind = kindOf(path);
  const step = stepOfFinding(kind, f, path) ?? 'main';
  if (app.wizard && (app.cartPath ?? app.wizard.path) === path && wizard) return wizard.go(step);
  standalone = false;
  open(kind, path, step);
}

function openReview(): void {
  if (wizard) return wizard.go('review');
  standalone = true;
  renderAll();
}

function mrCreated(webUrl: string): void {
  app.wizard = undefined;
  app.cartPath = undefined;
  wizard = null;
  standalone = false;
  revalidate();
  renderAll();
  $('wizard').replaceChildren(doneView(webUrl));
  toast('MR создан');
  if (app.client) refreshOpenMrs(env, loadHooks);
}

/**
 * «Обновить»: модель заново из main; черновик сверяется с новым main (изменённые там файлы — в баннер конфликтов).
 * notice — main ушёл вперёд при отправке: после перезагрузки открыть «Проверка и MR» с этим сообщением.
 */
async function reload(notice?: string): Promise<void> {
  if (app.mode !== 'gitlab' || !app.client) return;
  if (submitting()) return toast('Дождитесь окончания создания MR', 'warn');
  // несохранённые поля мастера: в корзину (дальше сверка с main как у любой правки), иначе — с подтверждением
  if (app.wizard) {
    clearTimeout(timer);
    const built = currentChange().change ? putCurrent() : null;
    if (!built && !doc.defaultView?.confirm('Несохранённые поля мастера будут потеряны. Обновить модель?')) return;
  }
  persist();
  app.cart.clear(); resetReviewEdits();
  app.conflicts = [];
  app.wizard = undefined;
  app.cartPath = undefined;
  wizard = null;
  standalone = false;
  await loadFromGitLab();
  if (notice && doc.body.dataset.state === 'ready') {
    standalone = true;
    renderAll({ kind: 'warn', msg: [notice] });
  }
}

const renderBanners = () => renderBannersIn(env, resolveConflict);

// ---- отрисовка ----

function renderAll(reviewStatus?: Status): void {
  renderHeader(env);
  renderBanners();
  renderTree();
  if (!wizard && standalone) {
    const close = btn('Закрыть', 'ghost', () => { standalone = false; renderAll(); });
    const box = h('div', { class: 'review', id: 'review' });
    $('wizard').replaceChildren(h('div', { class: 'wiz-head' }, h('h2', {}, 'Проверка и MR'), h('span', { class: 'sp' }), close), box);
    renderReview(box, reviewHost(), reviewStatus);
  } else if (!wizard) {
    $('wizard').replaceChildren(h('div', { class: 'intro' },
      h('h2', {}, 'Выберите элемент слева'),
      h('p', { class: 'empty' }, 'Откройте сервис, продукт или команду, чтобы изменить их, или создайте новый кнопками «+ команда», «+ продукт», «+ сервис». Изменения копятся в корзине до создания MR.')));
  }
}

function resolveConflict(c: Change, reopen: boolean): void {
  app.conflicts = app.conflicts.filter((x) => x !== c);
  cartChanged();
  if (!reopen) return;
  if (c.path in app.files) open(kindOf(c.path), c.path);
  else toast(`Файла ${c.path} больше нет в main — правку повторить нельзя`, 'warn');
}
const treeActions: TreeActions = { open, create, removeService, removeFromCart };
const renderTree = () => renderTreeIn(env, lists.picks, treeActions);

// ---- вход в приложение ----

export async function boot(d: Document, dp: Deps): Promise<void> {
  doc = d;
  deps = dp;
  const cfg = await loadConfig(dp.fetch, 'config.json');
  $('cartCount').addEventListener('click', () => { if (doc.body.dataset.state === 'ready') openReview(); });
  $('reload').addEventListener('click', () => void reload());
  app = {
    mode: cfg ? 'gitlab' : 'offline', cfg: cfg ?? undefined, files: {}, blobs: {}, dirs: [],
    validation: EMPTY, cart: new Cart(), conflicts: [], step: 'main', openMrs: [],
  };
  env = { doc, deps, app };
  if (!cfg) return loadOfflineIn(env, start);
  const q = new URLSearchParams(dp.location.search);
  const code = q.get('code');
  if (code) return finishLogin(env, code, q.get('state') ?? '', loadFromGitLab);
  showLogin(env, q.get('error') ? `GitLab отклонил вход: ${q.get('error_description') ?? q.get('error')}` : undefined);
}

autoBoot(boot);
