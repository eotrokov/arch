import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { run } from '../src/cli.js';
import { generate } from '../scripts/gen-synthetic.js';

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'arch-cli-')); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function exec(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

describe('cli', () => {
  it('build demo', async () => {
    const out = join(tmp, 'demo');
    const r = await exec(['build', '--root', 'examples/demo', '--out', out]);
    expect(r.code).toBe(0);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(existsSync(join(out, 'mermaid/crm/firewall.md'))).toBe(true);
    expect(html.match(/\b(?:src|href)\s*=\s*["']?\s*https?:/gi) ?? []).toEqual([]);
    const m = /<script id="arch-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!.replace(/<\\\//g, '</')).model.nodes['crm-orders']).toBeDefined();
    expect(r.stdout).toMatch(/Ошибок: 0, предупреждений: \d+/);
  });

  it('build does not depend on cwd', async () => {
    const demo = resolve('examples/demo');
    const out = join(tmp, 'cwd');
    const prev = process.cwd();
    process.chdir(tmp);
    try {
      expect((await exec(['build', '--root', demo, '--out', out])).code).toBe(0);
    } finally { process.chdir(prev); }
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  });

  it('compiled dist/cli.js builds from another cwd', () => {
    const pkg = process.cwd();
    execFileSync('npm', ['run', 'build'], { cwd: pkg, stdio: 'pipe' });
    const out = join(tmp, 'dist-out');
    execFileSync('node', [join(pkg, 'dist/cli.js'), 'build', '--root', join(pkg, 'examples/demo'), '--out', out], { cwd: tmp, stdio: 'pipe' });
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  }, 60_000);

  it('build empty model', async () => {
    const out = join(tmp, 'empty');
    expect((await exec(['build', '--root', 'test/fixtures/empty', '--out', out])).code).toBe(0);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  });

  it('bad yaml: exit 2, nothing written', async () => {
    const out = join(tmp, 'bad');
    const r = await exec(['build', '--root', 'test/fixtures/bad-yaml', '--out', out]);
    expect(r.code).toBe(2);
    expect(existsSync(join(out, 'index.html'))).toBe(false);
    expect(r.stderr).toContain('orders.yaml:3');
    expect(r.stderr).toContain('ERROR');
  });

  it('missing root: exit 2 with message', async () => {
    const r = await exec(['validate', '--root', join(tmp, 'nope')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ERROR');
  });

  it('A-1 violation: exit 1, html still written', async () => {
    const out = join(tmp, 'viol');
    const r = await exec(['build', '--root', 'test/fixtures/violations', '--out', out]);
    expect(r.code).toBe(1);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(r.stdout).toContain('a1.foreign-db');
    expect(r.stdout).toMatch(/^ERROR a1\.foreign-db /m);
  });

  it('validate writes nothing', async () => {
    const out = join(tmp, 'val');
    const r = await exec(['validate', '--root', 'examples/demo', '--out', out]);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('unknown command: exit 2', async () => {
    expect((await exec(['wat'])).code).toBe(2);
  });

  it('scale: 10 teams / 30 products / 300 services builds in < 5 s', async () => {
    const root = join(tmp, 'big');
    generate({ teams: 10, products: 30, services: 300, out: root });
    const t0 = performance.now();
    const r = await exec(['build', '--root', root, '--out', join(tmp, 'big-out')]);
    const ms = performance.now() - t0;
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(ms).toBeLessThan(5000);
  }, 30_000);
});
