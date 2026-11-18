import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitLabClient, GitLabError } from '../editor/gitlab/api.js';
import { exchangeCode, createPkce, authorizeUrl } from '../editor/gitlab/oauth.js';
import type { EditorConfig } from '../editor/config.js';
import { FAKE_TOKEN, startFakeGitLab } from './fake-gitlab.js';

type Fake = Awaited<ReturnType<typeof startFakeGitLab>>;
let fake: Fake;
let cfg: EditorConfig;

const files: Record<string, string> = { 'a.yaml': 'k: v\n', 'описание.txt': 'Привет, мир' };
for (let i = 0; i < 150; i++) files[`dir/f${i}.yaml`] = `n: ${i}\n`;

beforeAll(async () => {
  fake = await startFakeGitLab({ files });
  cfg = { gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'cid', redirectUri: 'http://localhost:5310/', baseBranch: 'main' };
});
afterAll(() => fake.close());

const client = (token = FAKE_TOKEN) => new GitLabClient(cfg, token, fetch);

describe('GitLabClient', () => {
  it('user() возвращает username', async () => {
    expect((await client().user()).username).toBe('tester');
  });

  it('tree() собирает две страницы', async () => {
    const before = fake.requests.length;
    const t = await client().tree('main');
    expect(t.filter((e) => e.type === 'blob')).toHaveLength(152);
    const treeReqs = fake.requests.slice(before).filter((r) => r.path.endsWith('/repository/tree'));
    expect(treeReqs).toHaveLength(2);
  });

  it('rawFile читает кириллицу в UTF-8', async () => {
    expect(await client().rawFile('описание.txt', 'main')).toBe('Привет, мир');
  });

  it('неверный токен даёт kind=auth', async () => {
    const err = await client('bad').user().catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
  });

  it('недоступный сервер даёт kind=cors-or-network', async () => {
    const c = new GitLabClient({ ...cfg, gitlabUrl: 'http://127.0.0.1:1' }, FAKE_TOKEN, fetch);
    const err = await c.user().catch((e) => e);
    expect(err.kind).toBe('cors-or-network');
  });

  it('createCommit шлёт start_branch (не start_sha); устаревший last_commit_id даёт kind=conflict', async () => {
    const c = client();
    const err = await c
      .createCommit({ branch: 'arch/x-0001', startBranch: 'main', message: 'm', actions: [{ action: 'update', file_path: 'a.yaml', content: 'k: w\n', last_commit_id: 'stale' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.kind).toBe('conflict');
    const body = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/repository/commits')).at(-1)!.body as Record<string, unknown>;
    expect(body).toMatchObject({ branch: 'arch/x-0001', start_branch: 'main' });
    expect(body).not.toHaveProperty('start_sha');
  });

  it('фейк как GitLab: с start_sha last_commit_id не проверяется, с start_branch — по текущим файлам ветки', async () => {
    const head = await client().branchHead('main');
    const post = (payload: unknown) => fetch(`${fake.url}/api/v4/projects/grp%2Farch/repository/commits`, {
      method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const upd = [{ action: 'update', file_path: 'a.yaml', content: 'k: s\n', last_commit_id: 'stale' }];
    expect((await post({ branch: 'arch/sha-0001', start_sha: head, commit_message: 'm', actions: upd })).status).toBe(201);
    expect((await post({ branch: 'arch/br-0001', start_branch: 'main', commit_message: 'm', actions: upd })).status).toBe(400);
  });

  it('createCommit: «файл уже есть / файла нет» — conflict, «ветка уже есть» — other', async () => {
    const reply = (message: string): typeof fetch => async () =>
      new Response(JSON.stringify({ message }), { status: 400, headers: { 'content-type': 'application/json' } });
    const commit = (message: string) => new GitLabClient(cfg, FAKE_TOKEN, reply(message))
      .createCommit({ branch: 'arch/z-0003', startBranch: 'main', message: 'm', actions: [] }).catch((e: GitLabError) => e.kind);
    expect(await commit('A file with this name already exists')).toBe('conflict');
    expect(await commit("A file with this name doesn't exist")).toBe('conflict');
    expect(await commit('A file with this name does not exist')).toBe('conflict');
    expect(await commit("A branch called 'arch/z-0003' already exists")).toBe('other');
    expect(await commit('Branch arch/z-0003 does not exist')).toBe('other');
  });

  it('createCommit + createMr: коммит в новую ветку и MR', async () => {
    const c = client();
    const commit = await c.createCommit({ branch: 'arch/y-0002', startBranch: 'main', message: 'arch: тест', actions: [{ action: 'create', file_path: 'n.txt', content: 'x' }] });
    expect(commit.id).toBeTruthy();
    const mr = await c.createMr({ sourceBranch: 'arch/y-0002', title: 'тест', description: 'd', draft: true });
    expect(mr.iid).toBeGreaterThan(0);
    expect(mr.webUrl).toContain('/merge_requests/');
    const post = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/merge_requests'))!;
    expect(post.body).toMatchObject({ title: 'Draft: тест', target_branch: 'main', labels: 'arch-editor', remove_source_branch: true });
  });
});

describe('exchangeCode + фейк', () => {
  it('PKCE: верный verifier даёт токен, неверный — ошибку', async () => {
    const { verifier, challenge } = await createPkce();
    const res = await fetch(authorizeUrl(cfg, challenge, 'st'), { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('state')).toBe('st');
    const code = loc.searchParams.get('code')!;
    await expect(exchangeCode(cfg, code, 'x'.repeat(64), fetch)).rejects.toMatchObject({ kind: 'auth' });
    expect(await exchangeCode(cfg, code, verifier, fetch)).toBe(FAKE_TOKEN);
  });

  it('неверный client_id даёт GitLabError kind=auth', async () => {
    const { verifier, challenge } = await createPkce();
    const res = await fetch(authorizeUrl(cfg, challenge, 's'), { redirect: 'manual' });
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const err = await exchangeCode({ ...cfg, oauthClientId: 'wrong' }, code, verifier, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.kind).toBe('auth');
  });

  it('недоступный хост даёт GitLabError kind=cors-or-network', async () => {
    const err = await exchangeCode({ ...cfg, gitlabUrl: 'http://127.0.0.1:1' }, 'c', 'v', fetch).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.kind).toBe('cors-or-network');
  });
});
