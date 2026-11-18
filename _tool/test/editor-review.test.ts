import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { readModelFiles } from '../src/model/load.js';
import { GitLabClient, GitLabError } from '../editor/gitlab/api.js';
import type { EditorConfig } from '../editor/config.js';
import { Cart, applyCart, loadDraft, reconcile, saveDraft, type Change } from '../editor/cart.js';
import { validateFiles } from '../editor/model.js';
import type { Validation } from '../editor/model.js';
import type { AppState } from '../editor/main.js';
import type { Finding } from '../src/model/types.js';
import { MAIN_MOVED_MESSAGE, MainMovedError, lineDiff, reviewSummary, submit, submitting } from '../editor/review.js';
import { FAKE_TOKEN, startFakeGitLab, type FakeGitLab } from './fake-gitlab.js';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

const diffText = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.kind}${l.text}`);

describe('lineDiff', () => {
  it('добавление строки', () => {
    expect(diffText('a\nb\n', 'a\nb\nc\n')).toEqual([' a', ' b', '+c']);
  });
  it('удаление строки', () => {
    expect(diffText('a\nb\nc\n', 'a\nc\n')).toEqual([' a', '-b', ' c']);
  });
  it('замена одной строки: сначала -, потом +', () => {
    expect(diffText('a\nb\nc\n', 'a\nB\nc\n')).toEqual([' a', '-b', '+B', ' c']);
  });
  it('новый файл — всё +, удалённый — всё -', () => {
    expect(diffText('', 'x\ny\n')).toEqual(['+x', '+y']);
    expect(diffText('x\ny\n', '')).toEqual(['-x', '-y']);
  });
  it('файл в несколько сотен строк — быстро и точно', () => {
    const a = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[100] = 'changed';
    b.splice(400, 0, 'inserted');
    const t = performance.now();
    const d = lineDiff(a.join('\n') + '\n', b.join('\n') + '\n');
    expect(performance.now() - t).toBeLessThan(500);
    expect(d.filter((l) => l.kind !== ' ').map((l) => `${l.kind}${l.text}`)).toEqual(['-line 100', '+changed', '+inserted']);
    expect(d.filter((l) => l.kind === ' ')).toHaveLength(599);
  });
});

const finding = (level: Finding['level'], message = 'm'): Finding => ({ rule: 'r.x', level, message, nodeIds: [], edgeIds: [], file: 'a.yaml' });
const val = (over: Partial<Validation>): Validation => ({ tree: null, model: null, loadErrors: [], findings: [], ok: true, ...over });
const one: Change[] = [{ path: 't/p/services/a.yaml', content: 'name: a\n', baseBlobId: null, label: 'Новый сервис p-a' }];

describe('reviewSummary', () => {
  it('ошибка проверки блокирует MR', () => {
    const s = reviewSummary(val({ findings: [finding('error', 'плохо'), finding('warning')], ok: false }), one);
    expect(s.canSubmit).toBe(false);
    expect(s.errors.map((e) => e.message)).toEqual(['плохо']);
    expect(s.warnings).toHaveLength(1);
  });
  it('ошибка загрузки блокирует MR', () => {
    const s = reviewSummary(val({ loadErrors: [{ file: 'a.yaml', message: 'Схема: /name' }], ok: false }), one);
    expect(s.canSubmit).toBe(false);
    expect(s.errors).toHaveLength(1);
  });
  it('только предупреждения — можно', () => {
    const s = reviewSummary(val({ findings: [finding('warning'), finding('attention')] }), one);
    expect(s.canSubmit).toBe(true);
    expect(s.errors).toEqual([]);
    expect(s.warnings).toHaveLength(1);
  });
  it('пустая корзина — нельзя', () => {
    expect(reviewSummary(val({}), []).canSubmit).toBe(false);
  });
  it('файл вне раскладки модели (его не читают проверки) блокирует MR; удаление — нет', () => {
    const files = readModelFiles(resolve(__dirname, '../examples/demo'));
    for (const path of ['sales/crm/services/Foo/bar.yaml', 'sales/crm/services/../evil.yaml', 'sales/crm/evil.yaml', 'sales/crm/services/x.txt']) {
      const changes: Change[] = [{ path, content: 'name: x\nsegment: app\ncluster: k8s-prod-1\n', baseBlobId: null, label: 'Новый сервис' }];
      const v = validateFiles(applyCart(files, changes));
      expect(v.ok, path).toBe(true); // проверки этот файл не видят
      const s = reviewSummary(v, changes);
      expect(s.canSubmit, path).toBe(false);
      expect(s.errors.map((e) => e.file), path).toEqual([path]);
    }
    const del: Change[] = [{ path: 'sales/crm/services/orders-job.yaml', content: null, baseBlobId: 'b', label: 'Удаление' }];
    expect(reviewSummary(validateFiles(applyCart(files, del)), del).canSubmit).toBe(true);
    const ok: Change[] = [{ path: 'sales/crm/services/orders.yaml', content: files['sales/crm/services/orders.yaml'] + '# x\n', baseBlobId: 'b', label: 'Изменение' }];
    expect(reviewSummary(validateFiles(applyCart(files, ok)), ok).canSubmit).toBe(true);
  });
});

const ORDERS = 'sales/crm/services/orders.yaml';
const NEW_SVC = 'sales/crm/services/audit-worker.yaml';
const JOB = 'sales/crm/services/orders-job.yaml';
const demo = readModelFiles(resolve(__dirname, '../examples/demo'));
const rnd = () => 'ab12';

describe('submit с фейковым GitLab', () => {
  let fake: FakeGitLab;
  let cfg: EditorConfig;
  let storage: MemStorage;

  beforeEach(async () => {
    fake = await startFakeGitLab({ files: demo });
    cfg = { gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'cid', redirectUri: 'http://localhost/', baseBranch: 'main' };
    storage = new MemStorage();
  });
  afterEach(() => fake.close());

  async function loadApp(fetchFn: typeof fetch = fetch, token = FAKE_TOKEN): Promise<AppState> {
    const loader = new GitLabClient(cfg, FAKE_TOKEN, fetch);
    const m = await loader.loadModel('main');
    return {
      mode: 'gitlab', cfg, client: new GitLabClient(cfg, token, fetchFn), files: m.files, blobs: m.blobs, dirs: m.dirs, baseSha: m.baseSha,
      validation: val({}), cart: new Cart(), conflicts: [], step: 'review', openMrs: [],
    };
  }
  const put = (app: AppState, c: Omit<Change, 'baseBlobId'>) => {
    app.cart.put({ ...c, baseBlobId: c.path in app.files ? app.blobs[c.path]! : null });
    saveDraft(storage, cfg.projectPath, app.cart.changes());
  };
  const posts = (suffix: string) => fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));

  it('успех: коммит от start_branch=main (не start_sha) с last_commit_id на baseSha, MR, корзина и черновик очищены', async () => {
    const app = await loadApp();
    put(app, { path: ORDERS, content: demo[ORDERS] + '# правка\n', label: 'Изменение сервиса crm-orders' });
    put(app, { path: NEW_SVC, content: 'name: audit\ntype: worker\n', label: 'Новый сервис crm-audit-worker' });
    put(app, { path: JOB, content: null, label: 'Удаление сервиса crm-orders-job' });

    const res = await submit(app, 'CRM: аудит', 'описание', rnd, storage);

    expect(res.webUrl).toMatch(/^http:\/\/.+\/merge_requests\/1$/);
    const commit = posts('/repository/commits')[0]!.body as { branch: string; start_branch?: string; start_sha?: string; commit_message: string; actions: Record<string, string>[] };
    expect(commit.branch).toBe('arch/crm-audit-ab12');
    expect(commit.start_branch).toBe('main');
    expect(commit.start_sha).toBeUndefined();
    expect(commit.commit_message).toBe('arch: CRM: аудит');
    const upd = commit.actions.find((a) => a.file_path === ORDERS)!;
    expect(upd.action).toBe('update');
    expect(upd.last_commit_id).toBeTruthy();
    expect(commit.actions.find((a) => a.file_path === JOB)).toMatchObject({ action: 'delete', last_commit_id: upd.last_commit_id });
    expect(commit.actions.find((a) => a.file_path === NEW_SVC)).toMatchObject({ action: 'create' });
    const mr = posts('/merge_requests')[0]!.body as Record<string, unknown>;
    expect(mr).toMatchObject({ source_branch: 'arch/crm-audit-ab12', title: 'CRM: аудит', description: 'описание', target_branch: 'main' });
    expect(app.cart.isEmpty()).toBe(true);
    expect(loadDraft(storage, cfg.projectPath)).toEqual([]);
  });

  it('main ушёл вперёд (другой файл) до отправки: ничего не пишется, MainMovedError, корзина и черновик целы', async () => {
    const app = await loadApp();
    put(app, { path: ORDERS, content: demo[ORDERS] + '# правка\n', label: 'Изменение сервиса crm-orders' });
    fake.setFile('sales/pay/services/billing.yaml', demo['sales/pay/services/billing.yaml'] + '# чужая правка\n');

    const err = await submit(app, 'Правка', 'd', rnd, storage).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MainMovedError);
    expect((err as Error).message).toBe(MAIN_MOVED_MESSAGE);
    expect(posts('/repository/commits')).toHaveLength(0);
    expect(posts('/merge_requests')).toHaveLength(0);
    expect(app.cart.changes()).toHaveLength(1);
    expect(loadDraft(storage, cfg.projectPath)).toHaveLength(1);
    expect(submitting()).toBe(false); // «Обновить» после ошибки не заблокирован
  });

  it('файл изменён в main до отправки: ничего не пишется; после перезагрузки модели правка — конфликт, прочие правки на месте', async () => {
    const app = await loadApp();
    put(app, { path: ORDERS, content: demo[ORDERS] + '# моя правка\n', label: 'Изменение сервиса crm-orders' });
    put(app, { path: NEW_SVC, content: 'name: audit\ntype: worker\n', label: 'Новый сервис crm-audit-worker' });
    const theirs = demo[ORDERS] + '# чужая правка\n';
    fake.setFile(ORDERS, theirs);

    const err = await submit(app, 'Правка', 'd', rnd, storage).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MainMovedError);
    expect(posts('/repository/commits')).toHaveLength(0);

    // путь reload() в main.ts: черновик → модель на новой голове → сверка по blob id
    const m = await new GitLabClient(cfg, FAKE_TOKEN, fetch).loadModel('main');
    const { applied, conflicts } = reconcile(loadDraft(storage, cfg.projectPath), m.blobs);
    expect(conflicts.map((c) => c.path)).toEqual([ORDERS]);
    expect(applied.map((c) => c.path)).toEqual([NEW_SVC]);
    expect(await new GitLabClient(cfg, FAKE_TOKEN, fetch).rawFile(ORDERS, 'main')).toBe(theirs);
  });

  /** main меняется между branchHead и коммитом: правку вносит fetch прямо перед POST /repository/commits. */
  const raceFetch = (mutate: () => void): typeof fetch => (input, init) => {
    if (String(input).endsWith('/repository/commits') && init?.method === 'POST') mutate();
    return fetch(input, init);
  };

  it('гонка: файл изменён в main после проверки головы — GitLab отклоняет по start_branch, main не перезаписан, MR нет', async () => {
    const theirs = demo[ORDERS] + '# чужая правка\n';
    const app = await loadApp(raceFetch(() => fake.setFile(ORDERS, theirs)));
    put(app, { path: ORDERS, content: demo[ORDERS] + '# моя правка\n', label: 'Изменение сервиса crm-orders' });

    const err = await submit(app, 'Правка', 'd', rnd, storage).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitLabError);
    expect((err as GitLabError).kind).toBe('conflict');
    expect((err as Error).message).toBe(`Файл ${ORDERS} изменён в main после загрузки — обновите модель (кнопка «Обновить»), ваши правки сохранены`);
    expect(await new GitLabClient(cfg, FAKE_TOKEN, fetch).rawFile(ORDERS, 'main')).toBe(theirs);
    expect(app.cart.changes()).toHaveLength(1);
    expect(loadDraft(storage, cfg.projectPath)).toHaveLength(1);
    expect(posts('/merge_requests')).toHaveLength(0);
  });

  it('гонка: новый файл появился в main (already exists) — тот же конфликт', async () => {
    const app = await loadApp(raceFetch(() => fake.setFile(NEW_SVC, 'name: audit\ntype: worker\n# чужой\n')));
    put(app, { path: NEW_SVC, content: 'name: audit\ntype: worker\n', label: 'Новый сервис crm-audit-worker' });

    const err = await submit(app, 'Новый', 'd', rnd, storage).catch((e: unknown) => e);

    expect((err as GitLabError).kind).toBe('conflict');
    expect((err as Error).message).toContain(`Файл ${NEW_SVC} изменён в main после загрузки`);
    expect(app.cart.isEmpty()).toBe(false);
  });

  it('гонка: удаляемый файл уже удалён в main (doesn\'t exist) — тот же конфликт', async () => {
    const app = await loadApp(raceFetch(() => fake.deleteFile(JOB)));
    put(app, { path: ORDERS, content: demo[ORDERS] + '# ок\n', label: 'Изменение сервиса crm-orders' });
    put(app, { path: JOB, content: null, label: 'Удаление сервиса crm-orders-job' });

    const err = await submit(app, 'Удаление', 'd', rnd, storage).catch((e: unknown) => e);

    expect((err as GitLabError).kind).toBe('conflict');
    expect((err as Error).message).toContain(`Файл ${JOB} изменён в main после загрузки`);
    expect((err as Error).message).not.toContain(ORDERS);
    expect(app.cart.changes()).toHaveLength(2);
  });

  it('коммит создан, MR — нет: ошибка называет ветку, корзина не очищена', async () => {
    const failMr: typeof fetch = (input, init) =>
      String(input).endsWith('/merge_requests') && init?.method === 'POST'
        ? Promise.resolve(new Response(JSON.stringify({ message: '500 Internal Server Error' }), { status: 500, headers: { 'content-type': 'application/json' } }))
        : fetch(input, init);
    const app = await loadApp(failMr);
    put(app, { path: ORDERS, content: demo[ORDERS] + '# правка\n', label: 'Изменение сервиса crm-orders' });

    const err = await submit(app, 'Правка', 'd', rnd, storage).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('arch/pravka-ab12');
    expect((err as Error).message).toContain('500 Internal Server Error');
    expect(posts('/repository/commits')).toHaveLength(1);
    expect(app.cart.isEmpty()).toBe(false);
    expect(loadDraft(storage, cfg.projectPath)).toHaveLength(1);
  });

  it('401: GitLabError kind=auth (модальное окно в UI), корзина сохранена', async () => {
    const app = await loadApp(fetch, 'expired');
    put(app, { path: ORDERS, content: demo[ORDERS] + '# правка\n', label: 'Изменение сервиса crm-orders' });

    const err = await submit(app, 'Правка', 'd', rnd, storage).catch((e: unknown) => e);

    expect((err as GitLabError).kind).toBe('auth');
    expect(app.cart.isEmpty()).toBe(false);
  });

  it('вторая отправка во время первой отклоняется: одна ветка, один MR', async () => {
    const app = await loadApp();
    put(app, { path: ORDERS, content: demo[ORDERS] + '# правка\n', label: 'Изменение сервиса crm-orders' });
    expect(submitting()).toBe(false);
    const first = submit(app, 'Правка', 'd', rnd, storage);
    expect(submitting()).toBe(true);
    await expect(submit(app, 'Правка', 'd', rnd, storage)).rejects.toThrow(/уже создаётся/);
    expect((await first).webUrl).toContain('/merge_requests/1');
    expect(submitting()).toBe(false);
    expect(posts('/repository/commits')).toHaveLength(1);
    expect(posts('/merge_requests')).toHaveLength(1);
  });

  it('после ошибки отправки флаг снят', async () => {
    const app = await loadApp(fetch, 'expired');
    put(app, { path: ORDERS, content: 'x: 1\n', label: 'l' });
    await expect(submit(app, 't', 'd', rnd, storage)).rejects.toBeInstanceOf(GitLabError);
    expect(submitting()).toBe(false);
  });

  it('пустая корзина или запасной режим — ошибка без запросов', async () => {
    const app = await loadApp();
    const before = fake.requests.length;
    await expect(submit(app, 't', 'd', rnd, storage)).rejects.toThrow(/Корзина пуста/);
    put(app, { path: ORDERS, content: 'x: 1\n', label: 'l' });
    await expect(submit({ ...app, mode: 'offline', client: undefined }, 't', 'd', rnd, storage)).rejects.toThrow(/запасном режиме/);
    expect(fake.requests.length).toBe(before);
  });
});
