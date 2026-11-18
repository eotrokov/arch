// Загрузка модели: GitLab (с кэшем в sessionStorage по baseSha) или офлайн model.json; экран ошибки «Повторить».
import { GitLabError } from './gitlab/api.js';
import type { FileMap } from './model.js';
import { h } from './fields.js';
import { setScreen } from './ui.js';
import { showLogin } from './auth.js';
import { projectKey, type Env } from './state.js';

/** Что делать после загрузки: показать приложение, обновить баннеры, обработать ошибку запроса MR. */
export interface LoadHooks { start(): void; banners(): void; error(e: unknown, what: string): void }

type CachedModel = { files: FileMap; blobs: Record<string, string>; dirs: string[] };

const cacheKey = (env: Env, sha: string) => `arch-editor:model:${projectKey(env.app, env.deps.location)}:${sha}`;

function ss(env: Env, fn: (s: Storage) => void): void {
  try { fn(env.deps.session); } catch { /* хранилище недоступно — без кэша */ }
}

/** Кэш модели вкладки по baseSha: голова ветки не изменилась — без повторной загрузки. */
function readCache(env: Env, sha: string): CachedModel | null {
  let out: CachedModel | null = null;
  ss(env, (s) => {
    const raw = s.getItem(cacheKey(env, sha));
    const v = raw ? (JSON.parse(raw) as Partial<CachedModel>) : null;
    if (v && typeof v.files === 'object' && typeof v.blobs === 'object' && Array.isArray(v.dirs)) out = v as CachedModel;
  });
  return out;
}

function errorScreen(msg: string, retry: () => void): HTMLElement {
  const b = h('button', { type: 'button', class: 'primary', id: 'retry' }, 'Повторить');
  b.addEventListener('click', retry);
  return h('section', { class: 'login pane' }, h('p', { class: 'msg err' }, msg), b);
}

/** Открытые MR пользователя → баннер. */
export function refreshOpenMrs(env: Env, hooks: LoadHooks): void {
  const { app } = env;
  app.client!.openMrs(app.user!.username).then((mrs) => { app.openMrs = mrs; hooks.banners(); }, (e) => hooks.error(e, 'Открытые MR'));
}

export async function loadFromGitLab(env: Env, hooks: LoadHooks): Promise<void> {
  const { doc, app } = env;
  const client = app.client!;
  const cfg = app.cfg!;
  setScreen(doc, 'loading', h('p', { class: 'empty center' }, `Загрузка модели из ${cfg.baseBranch}…`));
  try {
    const head = await client.branchHead(cfg.baseBranch);
    const cached = readCache(env, head);
    const m = cached ? { ...cached, baseSha: head } : await client.loadModel(cfg.baseBranch);
    const baseSha = m.baseSha;
    Object.assign(app, { files: m.files, blobs: m.blobs, dirs: m.dirs, baseSha });
    if (!cached) {
      ss(env, (s) => {
        const prefix = cacheKey(env, '');
        for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(prefix)) s.removeItem(k); }
        s.setItem(cacheKey(env, baseSha), JSON.stringify({ files: m.files, blobs: m.blobs, dirs: m.dirs }));
      });
    }
  } catch (e) {
    if (e instanceof GitLabError && e.kind === 'auth') return showLogin(env, 'Сессия истекла — войдите снова.');
    setScreen(doc, 'error', errorScreen(`Не удалось загрузить модель: ${e instanceof Error ? e.message : String(e)}`, () => void loadFromGitLab(env, hooks)));
    return;
  }
  hooks.start();
  refreshOpenMrs(env, hooks);
}

export async function loadOffline(env: Env, start: () => void): Promise<void> {
  const { doc, deps, app } = env;
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
    setScreen(doc, 'error', errorScreen(`Не удалось загрузить model.json: ${e instanceof Error ? e.message : String(e)}`, () => void loadOffline(env, start)));
    return;
  }
  start();
}
