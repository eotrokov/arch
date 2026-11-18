// Клиент GitLab REST API v4. fetch внедряется (тесты и браузер).
import type { EditorConfig } from '../config.js';

export type CommitAction = {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content?: string;
  last_commit_id?: string;
};

export type GitLabErrorKind = 'auth' | 'forbidden' | 'conflict' | 'cors-or-network' | 'other';

export class GitLabError extends Error {
  constructor(public status: number, public kind: GitLabErrorKind, message: string) {
    super(message);
    this.name = 'GitLabError';
  }
}

const CHANGED_RE = /changed since|has changed|last_commit_id|was changed/i;

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const m = b.message ?? b.error_description ?? b.error;
    if (typeof m === 'string') return m;
    if (m !== undefined) return JSON.stringify(m);
  }
  return fallback;
}

export function networkError(): GitLabError {
  return new GitLabError(0, 'cors-or-network', 'нет ответа от GitLab: сеть недоступна или GitLab не разрешает CORS с этого адреса');
}

/** Разбор ответа с ошибкой: общий для клиента API и обмена кода OAuth. */
export async function httpError(res: Response): Promise<GitLabError> {
  const body: unknown = await res.json().catch(() => null);
  const msg = errorMessage(body, `HTTP ${res.status}`);
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const oauthReject = (res.status === 400 || res.status === 401) && (code === 'invalid_client' || code === 'invalid_grant');
  const kind: GitLabErrorKind =
    res.status === 401 || oauthReject ? 'auth'
    : res.status === 403 ? 'forbidden'
    : (res.status === 400 || res.status === 409) && CHANGED_RE.test(msg) ? 'conflict'
    : 'other';
  return new GitLabError(res.status, kind, msg);
}

export class GitLabClient {
  private readonly base: string;
  constructor(private cfg: EditorConfig, private token: string, private fetchFn: typeof fetch) {
    this.base = `${cfg.gitlabUrl}/api/v4/projects/${encodeURIComponent(cfg.projectPath)}`;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const f = this.fetchFn; // вызов без this: иначе window.fetch бросит Illegal invocation
    let res: Response;
    try {
      res = await f(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.token}` } });
    } catch (e) {
      if (e instanceof TypeError) throw networkError();
      throw e;
    }
    if (res.ok) return res;
    throw await httpError(res);
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(url, init)).json()) as T;
  }

  private post<T>(url: string, payload: unknown): Promise<T> {
    return this.json<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  }

  user(): Promise<{ username: string; name: string }> {
    return this.json(`${this.cfg.gitlabUrl}/api/v4/user`);
  }

  async branchHead(branch: string): Promise<string> {
    const b = await this.json<{ commit: { id: string } }>(`${this.base}/repository/branches/${encodeURIComponent(branch)}`);
    return b.commit.id;
  }

  async tree(ref: string): Promise<{ path: string; type: 'blob' | 'tree'; id: string }[]> {
    const out: { path: string; type: 'blob' | 'tree'; id: string }[] = [];
    let page = '1';
    while (page) {
      const res = await this.request(`${this.base}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`);
      for (const e of (await res.json()) as { path: string; type: 'blob' | 'tree'; id: string }[]) {
        out.push({ path: e.path, type: e.type, id: e.id });
      }
      page = res.headers.get('x-next-page') ?? '';
    }
    return out;
  }

  async rawFile(path: string, ref: string): Promise<string> {
    const res = await this.request(`${this.base}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`);
    return res.text();
  }

  createCommit(p: { branch: string; startSha: string; message: string; actions: CommitAction[] }): Promise<{ id: string }> {
    return this.post(`${this.base}/repository/commits`, {
      branch: p.branch,
      start_sha: p.startSha,
      commit_message: p.message,
      actions: p.actions,
    });
  }

  async createMr(p: { sourceBranch: string; title: string; description: string; draft?: boolean }): Promise<{ iid: number; webUrl: string }> {
    const title = p.draft && !/^draft:/i.test(p.title) ? `Draft: ${p.title}` : p.title;
    const mr = await this.post<{ iid: number; web_url: string }>(`${this.base}/merge_requests`, {
      source_branch: p.sourceBranch,
      target_branch: this.cfg.baseBranch,
      title,
      description: p.description,
      labels: 'arch-editor',
      remove_source_branch: true,
    });
    return { iid: mr.iid, webUrl: mr.web_url };
  }
}
