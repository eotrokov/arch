// Сборка MR: имя ветки, actions коммита, заголовок и описание, zip. Браузерный код: без импортов Node.
import { strToU8, zipSync } from 'fflate';
import type { Change } from './cart.js';
import type { CommitAction } from './gitlab/api.js';
import type { Finding } from '../src/model/types.js';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '',
};

/** n случайных символов [a-z0-9] (crypto): суффикс ветки MR, state OAuth. */
export function randomSuffix(n = 4): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/** `arch/<slug>-<rnd()>`: slug — транслит заголовка, только [a-z0-9-], до 40 символов, не пустой. */
export function branchName(title: string, rnd: () => string): string {
  const slug = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `arch/${slug || 'change'}-${rnd()}`;
}

/** create — для новых файлов; update/delete всегда с last_commit_id. */
export function commitActions(changes: Change[], lastCommitIds: Record<string, string>): CommitAction[] {
  return changes.map((c): CommitAction => {
    if (c.baseBlobId === null) {
      if (c.content === null) throw new Error(`Нечего удалять: файл ${c.path} новый`);
      return { action: 'create', file_path: c.path, content: c.content };
    }
    const id = lastCommitIds[c.path];
    if (!id) throw new Error(`Нет last_commit_id для ${c.path}`);
    return c.content === null
      ? { action: 'delete', file_path: c.path, last_commit_id: id }
      : { action: 'update', file_path: c.path, content: c.content, last_commit_id: id };
  });
}

export function defaultTitle(changes: Change[]): string {
  const first = changes[0]?.label ?? '';
  return changes.length <= 1 ? first : `«${first}» и ещё ${changes.length - 1}`;
}

export function mrDescription(changes: Change[], findings: Finding[]): string {
  const warnings = findings.filter((f) => f.level === 'warning');
  const lines = ['## Изменения', '', ...changes.map((c) => `- ${c.label} (\`${c.path}\`)`), '', '## Проверки', '', `Ошибок: 0, предупреждений: ${warnings.length}`];
  if (warnings.length > 0) lines.push('', ...warnings.map((w) => `- ${w.message}`));
  lines.push('', '---', 'Создано в редакторе arch', '');
  return lines.join('\n');
}

/** Запасной путь без GitLab: файлы по своим путям, удалённые — списком в DELETED.txt, плюс MR.md. */
export function zipChanges(changes: Change[], mrText: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const deleted: string[] = [];
  for (const c of changes) {
    if (c.content === null) deleted.push(c.path);
    else entries[c.path] = strToU8(c.content);
  }
  if (deleted.length > 0) entries['DELETED.txt'] = strToU8(deleted.join('\n') + '\n');
  entries['MR.md'] = strToU8(mrText);
  return zipSync(entries);
}
