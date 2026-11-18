// Шаг «Проверка и MR»: сводка проверок, предпросмотр разрезов, diff файлов корзины, создание MR или zip.
// Браузерный код: без модулей Node; DOM только через createElement/textContent.
import { isSharedPath, saveDraft, type Change } from './cart.js';
import { h } from './fields.js';
import { GitLabError, type GitLabClient } from './gitlab/api.js';
import type { AppState } from './main.js';
import type { Validation } from './model.js';
import { branchName, commitActions, defaultTitle, mrDescription, zipChanges } from './mr.js';
import { GraphView } from '../viewer/render.js';
import { buildView } from '../src/views/index.js';
import type { Scope, ViewKind } from '../src/views/types.js';
import type { LoadError } from '../src/model/raw.js';
import type { Finding, Model } from '../src/model/types.js';

export type DiffLine = { kind: ' ' | '+' | '-'; text: string };

const lines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
/** Выше этого размера середины (после общих начала и конца) LCS не считается: «всё старое −, всё новое +». */
const MAX_CELLS = 4_000_000;

/** Построчный diff (LCS). Общие начало и конец отсекаются сразу; при замене строки «−» идёт перед «+». */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = lines(a);
  const y = lines(b);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const out: DiffLine[] = x.slice(0, pre).map((text) => ({ kind: ' ', text }));
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const n = xs.length;
  const m = ys.length;
  if (n * m > MAX_CELLS) {
    out.push(...xs.map((text): DiffLine => ({ kind: '-', text })), ...ys.map((text): DiffLine => ({ kind: '+', text })));
  } else {
    // dp[i][j] — длина LCS суффиксов xs[i..], ys[j..]
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = xs[i] === ys[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) { out.push({ kind: ' ', text: xs[i]! }); i++; j++; }
      else if (i < n && (j >= m || dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!)) out.push({ kind: '-', text: xs[i++]! });
      else out.push({ kind: '+', text: ys[j++]! });
    }
  }
  out.push(...x.slice(x.length - suf).map((text): DiffLine => ({ kind: ' ', text })));
  return out;
}

/** Ошибки (загрузка + проверки уровня error) блокируют MR, предупреждения — нет; пустую корзину не отправить. */
export function reviewSummary(v: Validation, changes: Change[]): { errors: (Finding | LoadError)[]; warnings: Finding[]; canSubmit: boolean } {
  const errors: (Finding | LoadError)[] = [...v.loadErrors, ...v.findings.filter((f) => f.level === 'error')];
  const warnings = v.findings.filter((f) => f.level === 'warning');
  return { errors, warnings, canSubmit: errors.length === 0 && changes.length > 0 };
}

/** Коммит записан, а MR не создан: ветка уже есть в GitLab. */
export class MrNotCreatedError extends Error {
  constructor(public branch: string, public cause: unknown) {
    super(`Изменения записаны в ветку ${branch}, но MR не создан: ${cause instanceof Error ? cause.message : String(cause)}. `
      + 'Откройте MR из этой ветки в GitLab; корзина сохранена (повторная отправка создаст новую ветку).');
    this.name = 'MrNotCreatedError';
  }
}

const movedMessage = (paths: string[]) => (paths.length === 1
  ? `Файл ${paths[0]} изменён в main после загрузки`
  : paths.length ? `Файлы ${paths.join(', ')} изменены в main после загрузки` : 'Файлы корзины изменены в main после загрузки')
  + ' — обновите модель (кнопка «Обновить»), ваши правки сохранены';

/** Какие файлы корзины разошлись с main: last_commit_id на голове ≠ на момент загрузки, новый файл уже есть, файла уже нет. */
async function movedPaths(client: GitLabClient, changes: Change[], ids: Record<string, string>, head: string): Promise<string[]> {
  const moved = await Promise.all(changes.map(async (c) => {
    let now: string | null;
    try {
      now = await client.lastCommitId(c.path, head);
    } catch (e) {
      if (!(e instanceof GitLabError && e.status === 404)) return false; // не удалось проверить — не утверждаем
      now = null;
    }
    return c.baseBlobId === null ? now !== null : now !== ids[c.path];
  }));
  return changes.filter((_, i) => moved[i]).map((c) => c.path);
}

/**
 * Один коммит в новую ветку и MR. last_commit_id берётся на baseSha (версия, с которой правили), коммит — от текущей
 * головы baseBranch: если файл с тех пор менялся, GitLab отклонит коммит (kind=conflict), ничего не перезаписав.
 * Успех очищает корзину и черновик (в черновике остаются только нерешённые конфликты). Иначе корзина не трогается.
 */
export async function submit(app: AppState, title: string, description: string, rnd: () => string, storage?: Storage): Promise<{ webUrl: string }> {
  const { client, cfg, baseSha } = app;
  if (app.mode !== 'gitlab' || !client || !cfg || !baseSha) throw new Error('В запасном режиме MR не создаётся — скачайте изменения архивом');
  const changes = app.cart.changes();
  if (changes.length === 0) throw new Error('Корзина пуста — нечего отправлять');
  const t = title.trim();
  if (!t) throw new Error('Укажите заголовок MR');

  const ids: Record<string, string> = {};
  await Promise.all(changes.filter((c) => c.baseBlobId !== null).map(async (c) => { ids[c.path] = await client.lastCommitId(c.path, baseSha); }));
  const actions = commitActions(changes, ids);
  const head = await client.branchHead(cfg.baseBranch);
  const branch = branchName(t, rnd);
  try {
    await client.createCommit({ branch, startSha: head, message: `arch: ${t}`, actions });
  } catch (e) {
    if (e instanceof GitLabError && e.kind === 'conflict') {
      throw new GitLabError(e.status, 'conflict', movedMessage(await movedPaths(client, changes, ids, head)));
    }
    throw e;
  }
  let mr: { webUrl: string };
  try {
    mr = await client.createMr({ sourceBranch: branch, title: t, description });
  } catch (e) {
    throw new MrNotCreatedError(branch, e);
  }
  app.cart.clear();
  if (storage) saveDraft(storage, cfg.projectPath, app.conflicts);
  return { webUrl: mr.webUrl };
}

// ---- UI шага ----

export interface ReviewHost {
  app(): AppState;
  /** Изменения для MR: корзина плюс текущая правка мастера (без правок, совпадающих с main). */
  changes(): Change[];
  /** Перейти к шагу мастера, к которому относится находка. */
  openFinding(f: Finding | LoadError): void;
  /** Положить текущую правку мастера в корзину перед отправкой; false — правку построить нельзя. */
  flush(): boolean;
  storage: Storage;
  done(webUrl: string): void;
  /** Ошибка GitLab в общий обработчик (401 → окно «войти снова»). */
  error(e: unknown, what: string): void;
  reload(): void;
}

const VIEWS: [ViewKind, string][] = [
  ['kubernetes', 'Kubernetes'], ['containers', 'Контейнеры'], ['firewall', 'Фаервол'], ['databases', 'БД'], ['dataflows', 'Потоки данных'],
];
const CONTEXT = 3;

/** Правленые вручную заголовок и описание живут между перерисовками шага (до успешной отправки). */
let edited: { title?: string; description?: string } = {};
let view: ViewKind = 'containers';
let scopeIdx = 0;

const rand4 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

/** Охваты предпросмотра: продукт изменяемого файла; для team.yaml — команда. */
export function previewScopes(changes: Change[], model: Model): { scope: Scope; label: string }[] {
  const out = new Map<string, { scope: Scope; label: string }>();
  for (const c of changes) {
    const [team, dir, ...rest] = c.path.split('/');
    if (!team || !dir) continue;
    if (dir === 'team.yaml' && rest.length === 0) {
      const t = model.teams.find((x) => x.id === team);
      if (t) out.set(`team:${team}`, { scope: { kind: 'team', id: team }, label: `команда ${t.name}` });
      continue;
    }
    const p = model.products.find((x) => x.file === `${team}/${dir}/product.yaml`) ?? model.products.find((x) => x.code === dir);
    if (p) out.set(`product:${p.code}`, { scope: { kind: 'product', id: p.code }, label: `продукт ${p.code} — ${p.name}` });
  }
  return [...out.values()];
}

export function renderReview(root: HTMLElement, host: ReviewHost): void {
  const app = host.app();
  const changes = host.changes();
  const v = app.validation;
  const sum = reviewSummary(v, changes);
  root.replaceChildren(
    ...checksBlock(sum, host),
    ...previewBlock(changes, v),
    ...diffBlock(changes, app.files),
    ...mrBlock(changes, v, sum.canSubmit, host),
  );
}

function checksBlock(sum: ReturnType<typeof reviewSummary>, host: ReviewHost): Node[] {
  const row = (f: Finding | LoadError, level: 'error' | 'warning') => {
    const code = 'rule' in f ? f.rule : f.line !== undefined ? `строка ${f.line}` : 'файл';
    const canOpen = !!f.file && !isSharedPath(f.file) && /\.ya?ml$/.test(f.file) && f.file.includes('/');
    let go: HTMLElement | null = null;
    if (canOpen) {
      go = h('button', { type: 'button', class: 'ghost' }, 'К шагу');
      go.addEventListener('click', () => host.openFinding(f));
    }
    return h('div', { class: 'find' },
      h('span', { class: `pill ${level === 'error' ? 'p-err' : 'p-warn'}` }, level === 'error' ? 'ошибка' : 'предупр.'),
      h('code', {}, code),
      h('span', {}, f.message, f.file ? h('span', { class: 'ffile' }, f.file) : null),
      go ?? h('span', {}));
  };
  const head = sum.errors.length
    ? h('p', { class: 'msg err', id: 'reviewStatus' }, `Ошибок: ${sum.errors.length} — MR не создаётся, пока они не исправлены. Предупреждений: ${sum.warnings.length}.`)
    : h('p', { class: 'msg ok', id: 'reviewStatus' }, `Ошибок нет. Предупреждений: ${sum.warnings.length}.`);
  return [
    h('h3', {}, 'Проверки модели с изменениями'), head,
    h('div', { class: 'findings' }, ...sum.errors.map((f) => row(f, 'error')), ...sum.warnings.map((f) => row(f, 'warning'))),
  ];
}

function previewBlock(changes: Change[], v: Validation): Node[] {
  const title = h('h3', {}, 'Предпросмотр');
  if (!v.model) return [title, h('p', { class: 'empty' }, 'Предпросмотр недоступен: модель с изменениями не собирается — исправьте ошибки выше.')];
  const model = v.model;
  const scopes = previewScopes(changes, model);
  if (!scopes.length) return [title, h('p', { class: 'empty' }, 'Нет изменённого продукта или команды для предпросмотра.')];
  if (scopeIdx >= scopes.length) scopeIdx = 0;

  const box = h('div', { class: 'preview' });
  const cyEl = h('div', { class: 'cy' });
  const empty = h('p', { class: 'empty center', hidden: true });
  box.append(cyEl, empty);
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Разрез' });
  const sensitiveSegments = new Set(model.segments.filter((s) => s.sensitive).map((s) => s.id));
  let graph: GraphView | null = null;
  let tries = 0;

  const draw = () => {
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.v === view));
    const { scope } = scopes[scopeIdx]!;
    const g = buildView(model, v.findings, scope, view);
    empty.hidden = g.nodes.length > 0;
    empty.textContent = 'В этом разрезе для охвата нет элементов.';
    // Cytoscape нужен контейнер в документе с размером: граф создаётся после вставки шага в страницу
    if (!cyEl.isConnected) {
      if (tries++ < 10) requestAnimationFrame(draw); // шаг перерисован раньше вставки — не крутимся вечно
      return;
    }
    graph ??= new GraphView(document, cyEl, { onSelect: () => {}, onExpand: () => {} });
    const key = `${view}|${scope.kind}:${'id' in scope ? scope.id : ''}|${changes.map((c) => c.path).join(',')}`;
    graph.show(key, g, { view, sensitiveSegments }, () => { document.body.dataset.preview = `${view}|${g.nodes.length}`; });
  };
  for (const [k, label] of VIEWS) {
    const b = h('button', { type: 'button', role: 'tab', 'data-v': k }, label);
    b.addEventListener('click', () => { view = k; draw(); });
    tabs.append(b);
  }
  const head = h('div', { class: 'prev-head' }, tabs);
  if (scopes.length > 1) {
    const sel = h('select', { class: 'in', 'aria-label': 'Охват предпросмотра' });
    scopes.forEach((s, i) => sel.append(h('option', { value: String(i), selected: i === scopeIdx }, s.label)));
    sel.addEventListener('change', () => { scopeIdx = Number(sel.value); draw(); });
    head.append(sel);
  } else {
    head.append(h('span', { class: 'hint' }, `Охват: ${scopes[0]!.label}`));
  }
  draw();
  return [title, head, box];
}

function diffBlock(changes: Change[], files: Record<string, string>): Node[] {
  const out: Node[] = [h('h3', {}, `Изменённые файлы (${changes.length})`)];
  if (!changes.length) out.push(h('p', { class: 'empty' }, 'Корзина пуста: положите правку в корзину кнопкой «В корзину».'));
  for (const c of changes) {
    const old = files[c.path] ?? '';
    const d = lineDiff(old, c.content ?? '');
    const add = d.filter((l) => l.kind === '+').length;
    const del = d.filter((l) => l.kind === '-').length;
    const [cls, tag] = c.content === null ? ['del', 'удалён'] : c.path in files ? ['mod', 'изменён'] : ['new', 'новый'];
    const pre = h('pre', { class: 'diff' });
    // длинные неизменные участки сворачиваются, по CONTEXT строк вокруг правок
    const near = d.map((l, i) => l.kind !== ' ' || d.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== ' '));
    for (let i = 0; i < d.length;) {
      if (near[i]) {
        const l = d[i++]!;
        pre.append(h('span', { class: l.kind === '+' ? 'add' : l.kind === '-' ? 'rm' : 'ctx' }, `${l.kind} ${l.text}`));
        continue;
      }
      let j = i;
      while (j < d.length && !near[j]) j++;
      if (j - i <= 2) { // короткий участок показывается целиком
        for (; i < j; i++) pre.append(h('span', { class: 'ctx' }, `  ${d[i]!.text}`));
        continue;
      }
      pre.append(h('span', { class: 'skip' }, `… без изменений: ${j - i} стр.`));
      i = j;
    }
    out.push(h('details', { class: 'file', open: true },
      h('summary', {}, h('span', { class: `chg ${cls}` }, tag), h('span', {}, c.label), h('code', {}, c.path),
        h('span', { class: 'stat' }, h('span', { class: 'add' }, `+${add}`), ' ', h('span', { class: 'rm' }, `−${del}`))),
      pre));
  }
  return out;
}

function mrBlock(changes: Change[], v: Validation, canSubmit: boolean, host: ReviewHost): Node[] {
  const app = host.app();
  const offline = app.mode !== 'gitlab';
  const title = h('input', { class: 'in', id: 'mrTitle', 'aria-label': 'Заголовок' });
  title.value = edited.title ?? defaultTitle(changes);
  title.addEventListener('input', () => { edited.title = title.value; });
  const desc = h('textarea', { class: 'in', id: 'mrDesc', rows: '9', 'aria-label': 'Описание' });
  desc.value = edited.description ?? mrDescription(changes, v.findings);
  desc.addEventListener('input', () => { edited.description = desc.value; });
  const status = h('div', { class: 'mr-status', id: 'mrStatus', 'aria-live': 'polite' });
  const say = (kind: 'err' | 'warn' | 'ok', ...msg: (Node | string)[]) => status.replaceChildren(h('p', { class: `msg ${kind}` }, ...msg));
  const btn = h('button', { type: 'button', class: 'primary', id: offline ? 'download' : 'createMr', disabled: !canSubmit },
    offline ? 'Скачать изменения' : 'Создать MR');
  const why = !changes.length ? 'Корзина пуста.' : !canSubmit ? 'Исправьте ошибки выше, чтобы создать MR.' : '';

  btn.addEventListener('click', () => void (async () => {
    if (!title.value.trim()) return say('err', 'Укажите заголовок MR.');
    if (!host.flush()) return say('err', 'Текущую правку мастера нельзя положить в корзину — исправьте её или закройте мастер.');
    const now = host.app();
    if (!reviewSummary(now.validation, now.cart.changes()).canSubmit) return say('err', 'После добавления правки в корзину появились ошибки — проверьте сводку.');
    if (offline) return download(now.cart.changes(), title.value.trim(), desc.value, say);
    btn.disabled = true;
    say('warn', 'Создание MR…');
    try {
      const { webUrl } = await submit(now, title.value, desc.value, rand4, host.storage);
      edited = {};
      host.done(webUrl);
    } catch (e) {
      btn.disabled = false;
      const auth = (x: unknown) => x instanceof GitLabError && x.kind === 'auth';
      if (auth(e)) {
        say('err', 'Сессия GitLab истекла — войдите снова; корзина сохранена.');
        return host.error(e, 'Создание MR');
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof GitLabError && e.kind === 'conflict') {
        const r = h('button', { type: 'button', class: 'ghost', id: 'reloadModel' }, 'Обновить');
        r.addEventListener('click', () => host.reload());
        return say('err', msg, ' ', r);
      }
      say('err', e instanceof GitLabError ? `Не удалось создать MR: ${msg}` : msg);
      if (e instanceof MrNotCreatedError && auth(e.cause)) host.error(e.cause, 'Создание MR');
    }
  })());

  const out: (Node | null)[] = [
    h('h3', {}, offline ? 'Изменения архивом' : 'Merge request'),
    offline ? h('p', { class: 'hint' }, 'Запасной режим без GitLab: архив с изменёнными файлами по их путям и MR.md с описанием. Создайте MR вручную.') : null,
    h('label', { class: 'fld' }, h('span', { class: 'fl' }, 'Заголовок'), title),
    h('label', { class: 'fld' }, h('span', { class: 'fl' }, 'Описание'), desc),
    h('div', { class: 'mr-actions' }, btn, why ? h('span', { class: 'hint' }, why) : null),
    status,
  ];
  return out.filter((n): n is Node => n !== null);
}

function download(changes: Change[], title: string, description: string, say: (k: 'ok', ...m: (Node | string)[]) => void): void {
  const bytes = zipChanges(changes, `# ${title}\n\n${description}`);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const name = `${branchName(title, () => '').slice('arch/'.length).replace(/-$/, '')}.zip`;
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  say('ok', `Архив ${name} скачан: ${changes.length} файл(ов) и MR.md. Корзина сохранена до создания MR.`);
}

/** Экран после создания MR. */
export function doneView(webUrl: string): HTMLElement {
  const link = /^https?:\/\//i.test(webUrl)
    ? h('a', { href: webUrl, target: '_blank', rel: 'noopener', id: 'mrLink' }, webUrl)
    : h('code', {}, webUrl);
  return h('div', { class: 'intro done' },
    h('h2', {}, 'MR создан'),
    h('p', {}, 'Ссылка: ', link),
    h('p', { class: 'empty' }, 'Корзина очищена. Модель в редакторе — из main: изменения появятся после мержа MR; до этого MR виден в баннере вверху.'));
}
