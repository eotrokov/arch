// Страница проверки: вход через OAuth, чтение модели, тестовый MR. Токен — только в памяти вкладки.
import { loadConfig, type EditorConfig } from '../config.js';
import { GitLabClient, GitLabError } from '../gitlab/api.js';
import { authorizeUrl, createPkce, exchangeCode } from '../gitlab/oauth.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const f: typeof fetch = (input, init) => fetch(input, init);
const SS_VERIFIER = 'arch-spike-verifier';
const SS_STATE = 'arch-spike-state';

let cfg: EditorConfig | null = null;
let client: GitLabClient | null = null;

function log(ok: boolean, text: string, link?: string): void {
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'bad';
  li.textContent = `${ok ? '✓' : '✗'} ${text}`;
  if (link) {
    li.append(' ');
    const a = document.createElement('a');
    a.href = link;
    a.textContent = link;
    a.target = '_blank';
    a.rel = 'noopener';
    li.append(a);
  }
  $('log').append(li);
}

function fail(step: string, e: unknown): void {
  const kind = e instanceof GitLabError ? e.kind : 'other';
  log(false, `${step}: ${kind} — ${e instanceof Error ? e.message : String(e)}`);
}

function rand4(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

async function login(): Promise<void> {
  if (!cfg) return;
  const { verifier, challenge } = await createPkce();
  const state = rand4() + rand4() + rand4();
  sessionStorage.setItem(SS_VERIFIER, verifier);
  sessionStorage.setItem(SS_STATE, state);
  location.href = authorizeUrl(cfg, challenge, state);
}

async function finishLogin(code: string, state: string): Promise<void> {
  if (!cfg) return;
  history.replaceState(null, '', location.pathname);
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  const expected = sessionStorage.getItem(SS_STATE);
  sessionStorage.removeItem(SS_VERIFIER);
  sessionStorage.removeItem(SS_STATE);
  try {
    if (!verifier || state !== expected) throw new Error('state не совпал или вход начат в другой вкладке');
    const token = await exchangeCode(cfg, code, verifier, f);
    client = new GitLabClient(cfg, token, f);
    const u = await client.user();
    log(true, `Вход: ${u.name}`);
    $<HTMLButtonElement>('read').disabled = false;
    $<HTMLButtonElement>('mr').disabled = false;
  } catch (e) {
    fail('Вход', e);
  }
}

async function readModel(): Promise<void> {
  if (!client || !cfg) return;
  let step = 'Дерево';
  try {
    const tree = await client.tree(cfg.baseBranch);
    const blobs = tree.filter((e) => e.type === 'blob');
    log(true, `Дерево: ${blobs.length} файлов`);
    const first = blobs.find((e) => /\.ya?ml$/.test(e.path)) ?? blobs[0];
    if (!first) return;
    step = `Файл ${first.path}`;
    const text = await client.rawFile(first.path, cfg.baseBranch);
    log(true, `Файл ${first.path}: ${new TextEncoder().encode(text).length} байт`);
  } catch (e) {
    fail(step, e);
  }
}

async function createMr(): Promise<void> {
  if (!client || !cfg) return;
  let step = 'Ветка';
  try {
    const head = await client.branchHead(cfg.baseBranch);
    const branch = `arch/spike-${rand4()}`;
    const iso = new Date().toISOString();
    step = 'Коммит';
    await client.createCommit({
      branch, startSha: head, message: 'arch: проверка редактора',
      actions: [{ action: 'create', file_path: `_spike/${iso}.txt`, content: `Проверка редактора arch, ${iso}\n` }],
    });
    step = 'MR';
    const mr = await client.createMr({ sourceBranch: branch, title: 'Draft: проверка редактора arch', description: 'Тестовый MR из страницы проверки. Можно закрыть.', draft: true });
    log(true, 'MR:', mr.webUrl);
  } catch (e) {
    fail(step, e);
  }
}

async function main(): Promise<void> {
  $('login').addEventListener('click', () => void login());
  $('read').addEventListener('click', () => void readModel());
  $('mr').addEventListener('click', () => void createMr());
  cfg = await loadConfig(f);
  if (!cfg) {
    log(false, 'config.json: other — файл не найден или пуст oauthClientId (см. editor/SPIKE.md)');
    $<HTMLButtonElement>('login').disabled = true;
    return;
  }
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (code) await finishLogin(code, q.get('state') ?? '');
}

void main();
