import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { loadTree, readModel } from '../src/model/load.js';
import { loadTreeFromFiles } from '../src/model/loadFiles.js';

const fixtures = ['empty', 'underscore', 'bad-yaml', 'bad-link', 'bad-dbserver', 'bad-schema', 'bad-ref', 'dup-product', 'dup-service', 'violations', 'foreign-bucket', 'no-product-owner', 'team-no-yaml'];

describe('loadTreeFromFiles', () => {
  it('equals loadTree on demo', () => {
    const abs = resolve('examples/demo');
    expect(loadTreeFromFiles(readModel('examples/demo').files, abs, readModel('examples/demo').dirs)).toEqual(loadTree(abs));
  });

  it.each(fixtures)('equals loadTree on fixture %s', (name) => {
    const dir = join('test/fixtures', name);
    expect((() => { const m = readModel(dir); return loadTreeFromFiles(m.files, dir, m.dirs, m.unreadable); })()).toEqual(loadTree(dir));
  });

  it('bad-yaml reports line 3', () => {
    const dir = 'test/fixtures/bad-yaml';
    const { errors } = loadTreeFromFiles(readModel(dir).files);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(3);
    expect(errors[0]!.file).toMatch(/^[^/].*services\/orders\.yaml$/);
  });

  it('missing _shared files are errors with relative paths', () => {
    const { tree, errors } = loadTreeFromFiles({});
    expect(tree).toBeNull();
    expect(errors.map((e) => e.file).sort()).toEqual(['_shared/network.yaml', '_shared/platform.yaml']);
  });

  it('ignores keys under _ and . dirs', () => {
    const files = readModel('test/fixtures/empty').files;
    const { tree, errors } = loadTreeFromFiles({ ...files, '_tool/x.yaml': 'a: [', '.git/x.yaml': 'a: [' });
    expect(errors).toEqual([]);
    expect(tree!.teams).toHaveLength(0);
  });

  it('prefixes file with root', () => {
    const { errors } = loadTreeFromFiles({}, 'a/b');
    expect(errors.map((e) => e.file).sort()).toEqual(['a/b/_shared/network.yaml', 'a/b/_shared/platform.yaml']);
  });

  it('bundles for the browser without Node modules', async () => {
    const r = await build({
      entryPoints: ['src/model/loadFiles.ts', 'src/model/resolve.ts'],
      bundle: true, platform: 'browser', write: false, outdir: 'out', logLevel: 'silent',
    });
    expect(r.errors).toEqual([]);
  });
});
