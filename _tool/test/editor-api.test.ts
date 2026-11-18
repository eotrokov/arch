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

  it('createCommit с устаревшим last_commit_id даёт kind=conflict', async () => {
    const c = client();
    const head = await c.branchHead('main');
    const err = await c
      .createCommit({ branch: 'arch/x-0001', startSha: head, message: 'm', actions: [{ action: 'update', file_path: 'a.yaml', content: 'k: w\n', last_commit_id: 'stale' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.kind).toBe('conflict');
  });

  it('createCommit + createMr: коммит в новую ветку и MR', async () => {
    const c = client();
    const head = await c.branchHead('main');
    const commit = await c.createCommit({ branch: 'arch/y-0002', startSha: head, message: 'arch: тест', actions: [{ action: 'create', file_path: 'n.txt', content: 'x' }] });
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
    await expect(exchangeCode(cfg, code, 'x'.repeat(64), fetch)).rejects.toThrow();
    expect(await exchangeCode(cfg, code, verifier, fetch)).toBe(FAKE_TOKEN);
  });
});
