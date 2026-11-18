// Клиент GitLab REST API v4. fetch внедряется (тесты и браузер).
import type { EditorConfig } from '../config.js';
import type { FileMap } from '../../src/model/loadFiles.js';

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
/** Только о файле: «A file with this name already exists / doesn't exist»; «A branch called … already exists» сюда не попадает. */
const FILE_GONE_RE = /^A file with this name (already exists|doesn'?t exist|does not exist)/i;

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

  /**
   * Коммит в новую ветку от startBranch. Именно start_branch, а не start_sha: GitLab сверяет last_commit_id с файлами
   * start_branch, а при start_sha проверку пропускает (start_branch остаётся пустым) — чужая правка перезаписалась бы молча.
   * «main ушёл вперёд» — kind=conflict: устаревший last_commit_id у update/delete,
   * а также create файла, который уже появился («already exists»), и update/delete уже удалённого («doesn't exist»).
   */
  async createCommit(p: { branch: string; startBranch: string; message: string; actions: CommitAction[] }): Promise<{ id: string }> {
    try {
      return await this.post(`${this.base}/repository/commits`, {
        branch: p.branch,
        start_branch: p.startBranch,
        commit_message: p.message,
        actions: p.actions,
      });
    } catch (e) {
      if (e instanceof GitLabError && e.kind === 'other' && e.status === 400 && FILE_GONE_RE.test(e.message)) {
        throw new GitLabError(e.status, 'conflict', e.message);
      }
      throw e;
    }
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

  /** Последний коммит, менявший файл на ref (для last_commit_id). */
  async lastCommitId(path: string, ref: string): Promise<string> {
    const res = await this.request(`${this.base}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { method: 'HEAD' });
    const id = res.headers.get('x-gitlab-last-commit-id');
    if (!id) throw new GitLabError(res.status, 'other', 'GitLab не вернул X-Gitlab-Last-Commit-Id');
    return id;
  }

  /** Открытые MR пользователя с меткой arch-editor. */
  async openMrs(username: string): Promise<{ iid: number; title: string; webUrl: string }[]> {
    const q = `labels=arch-editor&state=opened&author_username=${encodeURIComponent(username)}&per_page=100`;
    const list = await this.json<{ iid: number; title: string; web_url: string }[]>(`${this.base}/merge_requests?${q}`);
    return list.map((m) => ({ iid: m.iid, title: m.title, webUrl: m.web_url }));
  }

  /**
   * Загружает файлы модели (как CLI: _shared, team.yaml, product.yaml, services/*.yaml|yml) на зафиксированной голове ветки.
   * dirs — каталоги команд и команда/продукт (без `_`/`.`), чтобы пустые каталоги давали «Файл не найден».
   */
  async loadModel(ref: string, concurrency = 8): Promise<{ files: FileMap; blobs: Record<string, string>; baseSha: string; dirs: string[] }> {
    const baseSha = await this.branchHead(ref);
    const tree = await this.tree(baseSha);
    const wanted = tree.filter((e) => e.type === 'blob' && MODEL_FILE_RE.test(e.path));
    const files: FileMap = {};
    const blobs: Record<string, string> = {};
    let next = 0;
    const worker = async () => {
      for (let e = wanted[next++]; e; e = wanted[next++]) {
        files[e.path] = await this.rawFile(e.path, baseSha);
        blobs[e.path] = e.id;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, wanted.length)) }, worker));
    const visible = (n: string) => !n.startsWith('_') && !n.startsWith('.');
    const treeDirs = new Set(tree.filter((e) => e.type === 'tree').map((e) => e.path));
    const dirs: string[] = [];
    for (const team of [...treeDirs].filter((d) => !d.includes('/') && visible(d)).sort()) {
      dirs.push(team);
      const prefix = `${team}/`;
      for (const d of [...treeDirs].filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes('/')).sort()) {
        if (visible(d.slice(prefix.length))) dirs.push(d);
      }
    }
    return { files: sortKeys(files), blobs: sortKeys(blobs), baseSha, dirs };
  }
}

const MODEL_FILE_RE = /^(_shared\/[^/]+\.ya?ml|[^/_.][^/]*\/team\.yaml|[^/_.][^/]*\/[^/_.][^/]*\/product\.yaml|[^/_.][^/]*\/[^/_.][^/]*\/services\/[^/]+\.ya?ml)$/;
const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
