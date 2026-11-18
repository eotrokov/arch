import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { loadTreeFromFiles, type FileMap } from './loadFiles.js';
import type { LoadError, RawTree } from './raw.js';

export type { LoadError, RawTree } from './raw.js';
export type { FileMap } from './loadFiles.js';

export interface ModelFiles {
  files: FileMap;
  /** Каталоги команд и `команда/продукт` (без `_`/`.`), включая те, где нет YAML. */
  dirs: string[];
  /** Файлы модели, которые не удалось прочитать: путь → причина. */
  unreadable: Record<string, string>;
}

const isYaml = (n: string) => n.endsWith('.yaml') || n.endsWith('.yml');
const visibleDir = (n: string) => !n.startsWith('_') && !n.startsWith('.');

/**
 * Читает с диска только файлы модели: `_shared/*.yaml`, `<команда>/team.yaml`, `<команда>/<продукт>/product.yaml`,
 * `<команда>/<продукт>/services/*.yaml|yml`. Не-обычные файлы и всё, что ведёт за пределы корня (симлинки), пропускается.
 */
export function readModel(root: string): ModelFiles {
  const out: ModelFiles = { files: {}, dirs: [], unreadable: {} };
  const realRoot = realpathSync(root);
  const ls = (rel: string) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const subdirs = (rel: string) => ls(rel).filter((d) => d.isDirectory() && visibleDir(d.name)).map((d) => d.name).sort();
  const take = (rel: string) => {
    const abs = join(root, rel);
    try {
      const real = realpathSync(abs);
      if (!real.startsWith(realRoot + sep) || !statSync(real).isFile()) return;
    } catch {
      return;
    }
    try {
      out.files[rel] = readFileSync(abs, 'utf8');
    } catch (e) {
      out.unreadable[rel] = (e as Error).message;
    }
  };
  const takeYaml = (dir: string) => {
    for (const d of ls(dir)) if (isYaml(d.name)) take(`${dir}/${d.name}`);
  };

  takeYaml('_shared');
  for (const team of subdirs('')) {
    out.dirs.push(team);
    take(`${team}/team.yaml`);
    for (const prod of subdirs(team)) {
      out.dirs.push(`${team}/${prod}`);
      take(`${team}/${prod}/product.yaml`);
      takeYaml(`${team}/${prod}/services`);
    }
  }
  return out;
}

/** Карта «путь от корня через `/` → текст» для файлов модели. */
export function readModelFiles(root: string): FileMap {
  return readModel(root).files;
}

export function loadTree(root: string): { tree: RawTree | null; errors: LoadError[] } {
  const m = readModel(root);
  return loadTreeFromFiles(m.files, root, m.dirs, m.unreadable);
}
