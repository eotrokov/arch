// Вход через GitLab (PKCE): переход на авторизацию, экран входа, возврат с ?code.
import { GitLabClient } from './gitlab/api.js';
import { authorizeUrl, createPkce, exchangeCode } from './gitlab/oauth.js';
import { randomSuffix } from './mr.js';
import { h } from './fields.js';
import { byId, setScreen } from './ui.js';
import type { Env } from './state.js';

const SS_VERIFIER = 'arch-editor:verifier';
const SS_STATE = 'arch-editor:state';

export async function login(env: Env): Promise<void> {
  const { deps, app } = env;
  const cfg = app.cfg!;
  const { verifier, challenge } = await createPkce();
  const state = randomSuffix(16);
  try {
    deps.session.setItem(SS_VERIFIER, verifier);
    deps.session.setItem(SS_STATE, state);
  } catch {
    showLogin(env, 'Хранилище вкладки (sessionStorage) недоступно — вход невозможен.');
    return;
  }
  deps.location.assign(authorizeUrl(cfg, challenge, state));
}

export function showLogin(env: Env, error?: string): void {
  const btn = h('button', { type: 'button', class: 'primary', id: 'login' }, 'Войти через GitLab');
  btn.addEventListener('click', () => void login(env));
  setScreen(env.doc, 'login', h('section', { class: 'login pane' },
    h('h2', {}, 'Редактор модели архитектуры'),
    h('p', {}, 'Правки собираются в корзину и уходят в GitLab одним merge request. Войдите, чтобы прочитать модель из ',
      h('code', {}, env.app.cfg!.baseBranch), '.'),
    error ? h('p', { class: 'msg err' }, error) : null, btn,
    h('p', { class: 'empty' }, `Проект: ${env.app.cfg!.projectPath}`)));
}

/** Возврат с ?code: обмен кода на токен, затем loaded() — загрузка модели. */
export async function finishLogin(env: Env, code: string, state: string, loaded: () => Promise<void>): Promise<void> {
  const { doc, deps, app } = env;
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
  if (!verifier || state !== expected) return showLogin(env, 'Вход начат в другой вкладке или устарел — войдите снова.');
  setScreen(doc, 'loading', h('p', { class: 'empty center' }, 'Вход…'));
  try {
    const token = await exchangeCode(cfg, code, verifier, deps.fetch);
    app.client = new GitLabClient(cfg, token, deps.fetch);
    app.user = await app.client.user();
  } catch (e) {
    return showLogin(env, `Вход не удался: ${e instanceof Error ? e.message : String(e)}`);
  }
  await loaded();
}

/** Review Focus 3: 401 посреди работы — окно «Войти снова»; корзина уже в черновике и восстановится после входа. */
export function showSessionExpired(env: Env): void {
  const modal = byId(env.doc, 'modal');
  const btn = h('button', { type: 'button', class: 'primary' }, 'Войти снова');
  btn.addEventListener('click', () => void login(env));
  modal.replaceChildren(h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'modalTitle' },
    h('h2', { id: 'modalTitle' }, 'Сессия истекла — войти снова'),
    h('p', {}, 'Корзина изменений сохранена в черновике и восстановится после входа.'), btn));
  modal.hidden = false;
  btn.focus();
}
