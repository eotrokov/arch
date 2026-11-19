import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { chmodSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readModel, loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { validateFiles } from '../editor/model.js';
import type { LoadError } from '../src/model/raw.js';

const FIXTURES = ['violations', 'foreign-bucket', 'no-product-owner', 'bad-ref', 'bad-link', 'bad-schema', 'team-no-yaml'];

// редактор работает с корнем '', CLI — с абсолютным: пути приводим к относительным
const rel = (root: string, s: string) => (root === '' ? s : s.split(root + '/').join('').split(root).join(''));
const errKey = (root: string, es: LoadError[]) => es.map((e) => `${rel(root, e.file)}|${rel(root, e.message)}`).sort();
const findKey = (root: string, fs: { rule: string; level: string; message: string; file?: string }[]) =>
  fs.map((f) => `${f.rule}|${f.level}|${rel(root, f.message)}|${f.file ? rel(root, f.file) : ''}`).sort();

describe('validateFiles равен конвейеру CLI на фикстурах', () => {
  for (const name of FIXTURES) {
    it(name, () => {
      const root = resolve('test/fixtures', name);
      const m = readModel(root);
      const v = validateFiles(m.files, m.dirs);
      const { tree, errors } = loadTree(root);
      if (!tree) {
        expect(v.tree).toBeNull();
        expect(errKey('', v.loadErrors)).toEqual(errKey(root, errors));
        return;
      }
      const { model, errors: resErrors } = resolveModel(tree);
      expect(errKey('', v.loadErrors)).toEqual(errKey(root, [...errors, ...resErrors]));
      expect(v.model === null).toBe(model === null);
      if (model) expect(findKey('', v.findings)).toEqual(findKey(root, runChecks(tree, model)));
    });
  }
});

describe('нечитаемый файл', () => {
  let tmp = '';
  let victim = '';
  afterEach(() => {
    if (victim) try { chmodSync(victim, 0o644); } catch { /* уже удалён */ }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = victim = '';
  });
  it.skipIf(process.getuid?.() === 0)('chmod 000 → LoadError «Не удалось прочитать файл»', () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'arch-unreadable-'));
    cpSync(resolve('examples/demo'), tmp, { recursive: true });
    victim = resolve(tmp, 'sales/crm/services/orders.yaml');
    chmodSync(victim, 0o000);
    const { tree, errors } = loadTree(tmp);
    expect(tree).toBeNull();
    const e = errors.find((x) => x.file.endsWith('sales/crm/services/orders.yaml'));
    expect(e?.message).toMatch(/^Не удалось прочитать файл: /);
  });
});
