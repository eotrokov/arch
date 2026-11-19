// Восстановление корзины из черновика после загрузки модели.
import { isSharedPath, loadDraft, reconcile } from './cart.js';
import type { Env } from './state.js';

/** Черновик мог устареть или быть испорчен: плохие записи отбрасываются, старт не прерывается. */
export function restoreDraft(env: Env, toast: (msg: string, kind: 'ok' | 'warn' | 'err') => void, projectKey: string): void {
  const { deps, app } = env;
  try {
    const all = loadDraft(deps.storage, projectKey);
    const draft = all.filter((c) => !isSharedPath(c.path));
    if (draft.length < all.length) toast('Из черновика отброшены правки файлов _shared — их меняют архитекторы.', 'warn');
    const { applied, conflicts } = app.mode === 'gitlab' ? reconcile(draft, app.blobs) : { applied: draft, conflicts: [] };
    for (const c of applied) app.cart.put(c);
    app.conflicts = conflicts;
  } catch (e) {
    app.cart.clear();
    app.conflicts = [];
    toast(`Черновик не восстановлен: ${e instanceof Error ? e.message : String(e)}`, 'warn');
  }
}
