// Фальшивый GitLab (Node http) для unit- и e2e-тестов редактора: OAuth+PKCE и нужная часть REST API v4.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_TOKEN = 'fake-token';

export interface FakeRequest { method: string; path: string; body?: unknown }
export interface FakeGitLab {
  url: string;
  requests: FakeRequest[];
  setFile(path: string, content: string): void;
  close(): Promise<void>;
}

interface FileEntry { content: string; commit: string }
interface Branch { head: string; files: Map<string, FileEntry> }
interface Mr { iid: number; title: string; description: string; source_branch: string; target_branch: string; labels: string[]; author_username: string; state: string; web_url: string }

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

export async function startFakeGitLab(opts: { files: Record<string, string>; port?: number }): Promise<FakeGitLab> {
  let counter = 0;
  const nextId = () => sha(`c${++counter}`);
  const mainFiles = new Map<string, FileEntry>();
  const initial = nextId();
  for (const [p, c] of Object.entries(opts.files)) mainFiles.set(p, { content: c, commit: initial });
  const branches = new Map<string, Branch>([['main', { head: initial, files: mainFiles }]]);
  const mrs: Mr[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const requests: FakeRequest[] = [];
  let baseUrl = '';

  const resolveRef = (ref: string): Branch | undefined =>
    branches.get(ref) ?? [...branches.values()].find((b) => b.head === ref);

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
      'access-control-expose-headers': 'x-next-page, x-page, x-total, x-gitlab-last-commit-id, x-gitlab-blob-id',
      ...(body === undefined ? {} : { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json' }),
      ...headers,
    });
    res.end(body === undefined ? undefined : isText ? body : JSON.stringify(body));
  };

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return undefined;
    if ((req.headers['content-type'] ?? '').includes('application/json')) return JSON.parse(raw);
    return Object.fromEntries(new URLSearchParams(raw));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const method = req.method ?? 'GET';
      const path = url.pathname;
      if (method === 'OPTIONS') return send(res, 204);
      const body = method === 'POST' ? await readBody(req) : undefined;
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });

      if (path === '/oauth/authorize') {
        const code = 'c1';
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          clientId: url.searchParams.get('client_id') ?? '',
          redirectUri: url.searchParams.get('redirect_uri') ?? '',
        });
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        return send(res, 302, undefined, { location: back.toString() });
      }
      if (path === '/oauth/token' && method === 'POST') {
        const b = (body ?? {}) as Record<string, string>;
        const expected = codes.get(b.code ?? '');
        if (expected && (b.client_id !== expected.clientId || b.redirect_uri !== expected.redirectUri)) {
          return send(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed: неверный client_id или redirect_uri' });
        }
        const ok = b.grant_type === 'authorization_code' && expected !== undefined
          && b64url(createHash('sha256').update(b.code_verifier ?? '').digest()) === expected.challenge;
        if (!ok) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE: code_verifier не соответствует code_challenge' });
        return send(res, 200, { access_token: FAKE_TOKEN, token_type: 'Bearer', scope: 'api' });
      }

      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return send(res, 401, { message: '401 Unauthorized' });
      if (path === '/api/v4/user') return send(res, 200, { id: 1, username: 'tester', name: 'Тестовый Пользователь' });

      const m = /^\/api\/v4\/projects\/[^/]+\/(.*)$/.exec(path);
      if (!m) return send(res, 404, { message: '404 Not Found' });
      const rest = m[1]!;
      const project = (p: string) => `${baseUrl}/${p}`;

      const br = /^repository\/branches\/(.+)$/.exec(rest);
      if (br && method === 'GET') {
        const name = decodeURIComponent(br[1]!);
        const b = branches.get(name);
        return b ? send(res, 200, { name, commit: { id: b.head } }) : send(res, 404, { message: '404 Branch Not Found' });
      }

      if (rest === 'repository/tree' && method === 'GET') {
        const b = resolveRef(url.searchParams.get('ref') ?? 'main');
        if (!b) return send(res, 404, { message: '404 Tree Not Found' });
        const dirs = new Set<string>();
        for (const p of b.files.keys()) {
          const parts = p.split('/');
          for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        const all = [
          ...[...dirs].sort().map((p) => ({ id: sha(`tree:${p}`), path: p, type: 'tree' as const })),
          ...[...b.files.keys()].sort().map((p) => ({ id: sha(`blob:${p}:${b.files.get(p)!.content}`), path: p, type: 'blob' as const })),
        ];
        const per = Number(url.searchParams.get('per_page') ?? 20);
        const page = Number(url.searchParams.get('page') ?? 1);
        const next = page * per < all.length ? String(page + 1) : '';
        return send(res, 200, all.slice((page - 1) * per, page * per), { 'x-next-page': next, 'x-page': String(page), 'x-total': String(all.length) });
      }

      const fl = /^repository\/files\/([^/]+?)(\/raw)?$/.exec(rest);
      if (fl && (method === 'GET' || method === 'HEAD')) {
        const b = resolveRef(url.searchParams.get('ref') ?? 'main');
        const f = b?.files.get(decodeURIComponent(fl[1]!));
        if (!f) return send(res, 404, { message: '404 File Not Found' });
        const meta = { 'x-gitlab-last-commit-id': f.commit, 'x-gitlab-blob-id': sha(f.content) };
        if (method === 'HEAD') return send(res, 200, undefined, meta);
        if (fl[2]) return send(res, 200, f.content, meta);
        return send(res, 200, { file_path: decodeURIComponent(fl[1]!), content: Buffer.from(f.content).toString('base64'), encoding: 'base64', last_commit_id: f.commit });
      }

      if (rest === 'repository/commits' && method === 'POST') {
        const b = (body ?? {}) as { branch: string; start_sha?: string; start_branch?: string; actions: { action: string; file_path: string; content?: string; last_commit_id?: string }[] };
        let target = branches.get(b.branch);
        const created = !target;
        if (!target) {
          const start = resolveRef(b.start_sha ?? b.start_branch ?? '');
          if (!start) return send(res, 400, { message: 'start_sha не найден' });
          target = { head: start.head, files: new Map(start.files) };
        }
        const draft = new Map(target.files);
        const id = nextId();
        for (const a of b.actions) {
          const cur = draft.get(a.file_path);
          if (a.action === 'create') {
            if (cur) return send(res, 400, { message: `A file with this name already exists: ${a.file_path}` });
            draft.set(a.file_path, { content: a.content ?? '', commit: id });
            continue;
          }
          if (!cur) return send(res, 400, { message: `A file with this name doesn't exist: ${a.file_path}` });
          if (a.last_commit_id !== cur.commit) {
            return send(res, 400, { message: 'You are attempting to update a file that has changed since you started editing it.' });
          }
          if (a.action === 'delete') draft.delete(a.file_path);
          else draft.set(a.file_path, { content: a.content ?? '', commit: id });
        }
        target.files = draft;
        target.head = id;
        if (created) branches.set(b.branch, target);
        return send(res, 201, { id });
      }

      if (rest === 'merge_requests' && method === 'POST') {
        const b = (body ?? {}) as { source_branch: string; target_branch: string; title: string; description?: string; labels?: string };
        const iid = mrs.length + 1;
        const mr: Mr = {
          iid, title: b.title, description: b.description ?? '', source_branch: b.source_branch, target_branch: b.target_branch,
          labels: (b.labels ?? '').split(',').filter(Boolean), author_username: 'tester', state: 'opened',
          web_url: project(`grp/arch/-/merge_requests/${iid}`),
        };
        mrs.push(mr);
        return send(res, 201, mr);
      }
      if (rest === 'merge_requests' && method === 'GET') {
        const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
        const author = url.searchParams.get('author_username');
        const state = url.searchParams.get('state');
        return send(res, 200, mrs.filter((x) =>
          labels.every((l) => x.labels.includes(l)) && (!author || x.author_username === author) && (!state || x.state === state)));
      }
      return send(res, 404, { message: '404 Not Found' });
    } catch (e) {
      send(res, 500, { message: String(e) });
    }
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 0, '127.0.0.1', ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: baseUrl,
    requests,
    setFile(path, content) {
      const main = branches.get('main')!;
      const id = nextId();
      main.files.set(path, { content, commit: id });
      main.head = id;
    },
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}
