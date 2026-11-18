import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { readModel } from '../src/model/load.js';
import { GitLabClient, GitLabError } from '../editor/gitlab/api.js';
import type { EditorConfig } from '../editor/config.js';
import type { Change } from '../editor/cart.js';
import type { Finding } from '../src/model/types.js';
import { branchName, commitActions, defaultTitle, mrDescription, zipChanges } from '../editor/mr.js';
import { FAKE_TOKEN, startFakeGitLab } from './fake-gitlab.js';

const rnd = () => 'ab12';
const ch = (path: string, content: string | null, baseBlobId: string | null, label: string): Change => ({ path, content, baseBlobId, label });
const changes: Change[] = [
  ch('t/p/services/new.yaml', 'a: 1\n', null, 'Новый сервис new'),
  ch('t/p/services/upd.yaml', 'b: 2\n', 'blob1', 'Правка upd'),
  ch('t/p/services/old.yaml', null, 'blob2', 'Удаление old'),
];

describe('branchName', () => {
  it('транслитерирует кириллицу', () => {
    expect(branchName('CRM: новый сервис crm-notify-worker', rnd)).toBe('arch/crm-novyy-servis-crm-notify-worker-ab12');
  });
  it('пустой заголовок даёт change', () => {
    expect(branchName('   ', rnd)).toBe('arch/change-ab12');
  });
  it('slug не длиннее 40', () => {
    const b = branchName('Очень '.repeat(20), rnd);
    expect(b).toMatch(/^arch\/[a-z0-9-]+-ab12$/);
    expect(b.length - 'arch/'.length - '-ab12'.length).toBeLessThanOrEqual(40);
  });
  it('таблица: ж х ц ч ш щ ы э ю я ь ъ', () => {
    expect(branchName('жхцчшщыэюяьъ', rnd)).toBe('arch/zhkhtschshshchyeyuya-ab12');
  });
});

describe('commitActions', () => {
  it('create / update / delete', () => {
    expect(commitActions(changes, { 't/p/services/upd.yaml': 'c1', 't/p/services/old.yaml': 'c2' })).toEqual([
      { action: 'create', file_path: 't/p/services/new.yaml', content: 'a: 1\n' },
      { action: 'update', file_path: 't/p/services/upd.yaml', content: 'b: 2\n', last_commit_id: 'c1' },
      { action: 'delete', file_path: 't/p/services/old.yaml', last_commit_id: 'c2' },
    ]);
  });
  it('без last_commit_id для update/delete — ошибка', () => {
    expect(() => commitActions(changes, { 't/p/services/upd.yaml': 'c1' })).toThrow(/old\.yaml/);
    expect(() => commitActions(changes, { 't/p/services/old.yaml': 'c2' })).toThrow(/upd\.yaml/);
  });
});

describe('defaultTitle', () => {
  it('один и несколько', () => {
    expect(defaultTitle([changes[0]!])).toBe('Новый сервис new');
    expect(defaultTitle(changes)).toBe('«Новый сервис new» и ещё 2');
  });
});

describe('mrDescription', () => {
  const findings: Finding[] = [{ rule: 'r', level: 'warning', message: 'Что-то странное', nodeIds: [], edgeIds: [] }];
  it('содержит пути, проверки и подпись', () => {
    const d = mrDescription(changes, findings);
    for (const c of changes) expect(d).toContain(c.path);
    expect(d).toContain('Ошибок: 0, предупреждений: 1');
    expect(d).toContain('Что-то странное');
    expect(d).toContain('Создано в редакторе arch');
  });
  it('считает только предупреждения', () => {
    const d = mrDescription(changes, [{ ...findings[0]!, level: 'attention' }]);
    expect(d).toContain('Ошибок: 0, предупреждений: 0');
  });
});

describe('zipChanges', () => {
  it('файлы, DELETED.txt и MR.md', () => {
    const z = unzipSync(zipChanges(changes, '# MR\n'));
    expect(Object.keys(z).sort()).toEqual(['DELETED.txt', 'MR.md', 't/p/services/new.yaml', 't/p/services/upd.yaml']);
    expect(strFromU8(z['t/p/services/new.yaml']!)).toBe('a: 1\n');
    expect(strFromU8(z['DELETED.txt']!)).toBe('t/p/services/old.yaml\n');
    expect(strFromU8(z['MR.md']!)).toBe('# MR\n');
  });
  it('без удалений нет DELETED.txt', () => {
    expect(Object.keys(unzipSync(zipChanges([changes[0]!], 'x')))).not.toContain('DELETED.txt');
  });
});

describe('GitLab: загрузка модели и MR', () => {
  const demo = readModel(resolve('examples/demo'));
  let fake: Awaited<ReturnType<typeof startFakeGitLab>>;
  let client: GitLabClient;
  beforeAll(async () => {
    fake = await startFakeGitLab({ files: { ...demo.files, 'README.md': 'x', 'sales/notes.yaml': 'k: v\n', 'sales/crm/services/sub/deep.yaml': 'k: v\n' } });
    const cfg: EditorConfig = { gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'c', redirectUri: 'http://x/', baseBranch: 'main' };
    client = new GitLabClient(cfg, FAKE_TOKEN, fetch);
  });
  afterAll(() => fake.close());

  it('loadModel(main) на демо', async () => {
    const m = await client.loadModel('main');
    expect(m.files).toEqual(demo.files);
    expect(Object.keys(m.blobs).sort()).toEqual(Object.keys(demo.files).sort());
    expect(m.baseSha).toBe(await client.branchHead('main'));
    expect(m.dirs).toEqual(demo.dirs);
  });

  it('loadModel читает файлы по baseSha, а не по имени ветки', async () => {
    const before = fake.requests.length;
    const m = await client.loadModel('main');
    const raws = fake.requests.slice(before).filter((r) => r.path.endsWith('/raw'));
    expect(raws.length).toBe(Object.keys(m.files).length);
  });

  it('lastCommitId из заголовка', async () => {
    const id = await client.lastCommitId('_shared/network.yaml', 'main');
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('openMrs: свои открытые MR с меткой', async () => {
    expect(await client.openMrs('tester')).toEqual([]);
    await client.createCommit({ branch: 'arch/x-ab12', startBranch: 'main', message: 'arch: t', actions: [{ action: 'create', file_path: 'n.txt', content: 'x' }] });
    const mr = await client.createMr({ sourceBranch: 'arch/x-ab12', title: 'T', description: 'D' });
    expect(await client.openMrs('tester')).toEqual([{ iid: mr.iid, title: 'T', webUrl: mr.webUrl }]);
    expect(await client.openMrs('other')).toEqual([]);
  });

  it('createMr на несуществующую ветку — ошибка', async () => {
    const err = await client.createMr({ sourceBranch: 'arch/nope-0000', title: 'T', description: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.status).toBe(400);
  });

  it('файл изменён в main после загрузки — conflict', async () => {
    const m = await client.loadModel('main');
    const path = Object.keys(m.files).find((p) => p.endsWith('product.yaml'))!;
    const lastId = await client.lastCommitId(path, m.baseSha);
    fake.setFile(path, m.files[path]! + '# чужая правка\n');
    // ветка MR создаётся от start_branch=main: GitLab сверяет last_commit_id с текущими файлами main
    const err = await client
      .createCommit({ branch: 'arch/y-ab12', startBranch: 'main', message: 'm', actions: commitActions([ch(path, 'z: 1\n', m.blobs[path]!, 'l')], { [path]: lastId }) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.kind).toBe('conflict');
  });
});
