// Корзина изменений редактора: наложение на файлы, черновики, сверка с main.
// Браузерный код: без импортов Node.
import type { FileMap } from '../src/model/loadFiles.js';

export interface Change {
  path: string;
  /** null = удалить файл */
  content: string | null;
  /** blob id файла в main на момент загрузки; null = новый файл */
  baseBlobId: string | null;
  label: string;
}

/** Нормализует путь (\\ → /, убирает ./, ведущий /, сворачивает . и ..) и проверяет принадлежность _shared. */
export function isSharedPath(p: string): boolean {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts[0] === '_shared';
}

const SHARED_ERROR = 'Файлы _shared меняют архитекторы';

export class Cart {
  private items = new Map<string, Change>();

  changes(): Change[] {
    return [...this.items.values()];
  }

  put(c: Change): void {
    if (isSharedPath(c.path)) throw new Error(SHARED_ERROR);
    this.items.set(c.path, c);
  }

  remove(path: string): void {
    this.items.delete(path);
  }

  clear(): void {
    this.items.clear();
  }

  isEmpty(): boolean {
    return this.items.size === 0;
  }
}

export function applyCart(files: FileMap, changes: Change[]): FileMap {
  const out: FileMap = { ...files };
  for (const c of changes) {
    if (isSharedPath(c.path)) throw new Error(SHARED_ERROR);
    if (c.content === null) delete out[c.path];
    else out[c.path] = c.content;
  }
  return out;
}

const draftKey = (projectPath: string) => `arch-editor:draft:${projectPath}`;

/** true = сохранено; false = хранилище недоступно или переполнено. */
export function saveDraft(storage: Storage, projectPath: string, changes: Change[]): boolean {
  try {
    if (changes.length === 0) storage.removeItem(draftKey(projectPath));
    else storage.setItem(draftKey(projectPath), JSON.stringify(changes));
    return true;
  } catch {
    return false;
  }
}

function isChange(v: unknown): v is Change {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.path === 'string' &&
    !isSharedPath(c.path) &&
    (c.content === null || typeof c.content === 'string') &&
    (c.baseBlobId === null || typeof c.baseBlobId === 'string') &&
    typeof c.label === 'string'
  );
}

export function loadDraft(storage: Storage, projectPath: string): Change[] {
  try {
    const raw = storage.getItem(draftKey(projectPath));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChange).map((c) => ({ path: c.path, content: c.content, baseBlobId: c.baseBlobId, label: c.label }));
  } catch {
    return [];
  }
}

export function reconcile(changes: Change[], blobs: Record<string, string>): { applied: Change[]; conflicts: Change[] } {
  const applied: Change[] = [];
  const conflicts: Change[] = [];
  for (const c of changes) {
    if (isSharedPath(c.path)) throw new Error(SHARED_ERROR);
    const current = blobs[c.path];
    const conflict = c.baseBlobId === null ? current !== undefined : current !== c.baseBlobId;
    (conflict ? conflicts : applied).push(c);
  }
  return { applied, conflicts };
}
