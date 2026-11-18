#!/usr/bin/env node
// Командная строка: `arch-views validate|build [--root <dir>] [--out <dir>]`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTree, readModelFiles, type LoadError } from './model/load.js';
import { resolveModel } from './model/resolve.js';
import { hasErrors, runChecks } from './checks/index.js';
import { exportMermaid } from './export/mermaid.js';
import { buildHtml } from './build/html.js';

export interface Io { stdout: (s: string) => void; stderr: (s: string) => void }

const USAGE = 'Использование: arch-views <validate|build> [--root <каталог>] [--out <каталог>]';

/** Корень репозитория arch/ — на два уровня выше src/ и dist/. */
const defaultRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function printLoadErrors(errors: LoadError[], io: Io): void {
  for (const e of errors) io.stderr(`ERROR ${e.file}${e.line !== undefined ? `:${e.line}` : ''}: ${e.message}\n`);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'validate' && cmd !== 'build') {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if ((k !== '--root' && k !== '--out') || v === undefined) {
      io.stderr(`Неизвестный или неполный параметр: ${k}\n${USAGE}\n`);
      return 2;
    }
    opts.set(k, v);
  }
  const root = resolve(opts.get('--root') ?? defaultRoot());
  const out = resolve(opts.get('--out') ?? join(root, '_dist'));

  if (!existsSync(root)) {
    io.stderr(`ERROR ${root}: каталог модели не найден\n`);
    return 2;
  }
  const { tree, errors } = loadTree(root);
  if (!tree) {
    printLoadErrors(errors, io);
    return 2;
  }
  const { model, errors: resolveErrors } = resolveModel(tree);
  if (!model) {
    printLoadErrors(resolveErrors, io);
    return 2;
  }
  const findings = runChecks(tree, model);
  let errCount = 0;
  let warnCount = 0;
  for (const f of findings) {
    if (f.level === 'attention') continue;
    if (f.level === 'error') errCount++; else warnCount++;
    io.stdout(`${f.level === 'error' ? 'ERROR' : 'WARN'} ${f.rule} ${f.file ?? ''}: ${f.message}\n`);
  }
  io.stdout(`Ошибок: ${errCount}, предупреждений: ${warnCount}\n`);

  if (cmd === 'build') {
    const write = (rel: string, content: string) => {
      const file = join(out, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    };
    const builtAt = new Date().toISOString();
    write('index.html', await buildHtml({ model, findings, builtAt }));
    write('model.json', JSON.stringify({ files: readModelFiles(root), builtAt, ...(process.env.CI_COMMIT_SHA ? { commit: process.env.CI_COMMIT_SHA } : {}) }));
    for (const f of exportMermaid(model, findings)) write(f.path, f.content);
    io.stdout(`Собрано: ${join(out, 'index.html')}\n`);
  }
  return hasErrors(findings) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) })
    .then((code) => process.exit(code), (e) => { process.stderr.write(`ERROR ${(e as Error).message}\n`); process.exit(2); });
}
