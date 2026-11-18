import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTreeFromFiles, type FileMap } from './loadFiles.js';
import type { LoadError, RawTree } from './raw.js';

export type { LoadError, RawTree } from './raw.js';
export type { FileMap } from './loadFiles.js';

/** Читает все YAML-файлы модели с диска в карту «путь от корня через `/` → текст»; каталоги на `_` и `.` пропускаются. */
export function readModelFiles(root: string): FileMap {
  const files: FileMap = {};
  const walk = (rel: string) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (rel === '' && d.name === '_shared') walkAll(path);
        else if (!d.name.startsWith('_') && !d.name.startsWith('.')) walk(path);
      } else if (/\.ya?ml$/.test(d.name)) files[path] = readFileSync(join(root, path), 'utf8');
    }
  };
  const walkAll = (rel: string) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${d.name}`;
      if (!d.isDirectory() && /\.ya?ml$/.test(d.name)) files[path] = readFileSync(join(root, path), 'utf8');
    }
  };
  walk('');
  return files;
}

export function loadTree(root: string): { tree: RawTree | null; errors: LoadError[] } {
  return loadTreeFromFiles(readModelFiles(root), root);
}
