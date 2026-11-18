import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { readModel } from '../src/model/load.js';
import { newYaml, patchYaml, servicePath, productPath, teamPath } from '../editor/yamlEdit.js';

const demo = readModel('examples/demo').files;
const file = (p: string) => demo[p]!;

const SERVICE_ORDER = ['name', 'type', 'segment', 'cluster', 'criticality', 'port', 'protocol', 'databases', 'publishes', 'consumes', 'calls', 'uses', 'exports', 'exposure', 'owners', 'links', 'overrides'];
const PRODUCT_ORDER = ['code', 'name', 'criticality', 'nfr', 'owners', 'links', 'entities', 'externals', 'dbservers', 'resources'];

/** Построчный diff (LCS): строки, удалённые из a, и строки, добавленные в b. */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const removed: string[] = [], added: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { i++; j++; } else if (t[i + 1]![j]! >= t[i]![j + 1]!) removed.push(x[i++]!); else added.push(y[j++]!);
  }
  while (i < n) removed.push(x[i++]!);
  while (j < m) added.push(y[j++]!);
  return { removed, added };
}

describe('newYaml', () => {
  it('service crm-orders: round-trips, canonical key order, block list of flow items', () => {
    const data = parse(file('sales/crm/services/orders.yaml'));
    const text = newYaml('service', { ...data, exports: [], overrides: undefined });
    expect(parse(text)).toEqual(data);
    const keys = Object.keys(parse(text));
    expect(keys).toEqual(SERVICE_ORDER.filter((k) => k in data));
    expect(text).not.toContain('[]');
    expect(text).not.toContain('exports');
    expect(text).toContain('uses:\n  - { resource: kafka }\n  - { resource: s3-main, bucket: files, access: rw, entities: [order], purpose: Вложения к заказам }\n');
    expect(text).toContain('owners:\n  - { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" }\n');
  });

  it('orders keys canonically regardless of input order', () => {
    const text = newYaml('service', { owners: [{ role: 'techlead', name: 'X' }], cluster: 'k8s-prod-1', segment: 'app', type: 'worker', name: 'notify' });
    expect(text).toBe('name: notify\ntype: worker\nsegment: app\ncluster: k8s-prod-1\nowners:\n  - { role: techlead, name: X }\n');
  });

  it('product: nested objects go block, flat maps flow, empty arrays omitted', () => {
    const data = parse(file('sales/crm/product.yaml'));
    const text = newYaml('product', data);
    const { externals: _omit, ...rest } = data;
    expect(parse(text)).toEqual(rest);
    expect(Object.keys(parse(text))).toEqual(PRODUCT_ORDER.filter((k) => k in rest));
    expect(text).toContain('nfr: { slo: 99.9% }\n');
    expect(text).toContain('dbservers:\n  - id: pg-crm\n    engine: postgres\n    version: "16"\n');
    expect(text).toContain('    hosts:\n      - { fqdn: pg-crm-01.db.company.ru, role: primary }\n');
  });

  it('team', () => {
    expect(newYaml('team', { links: [], owners: [{ role: 'owner', name: 'И.' }], name: 'Продажи' })).toBe('name: Продажи\nowners:\n  - { role: owner, name: И. }\n');
  });
});

describe('patchYaml', () => {
  const commented = [
    '# главный сервис',
    'name: orders # имя',
    'segment: app',
    'cluster: k8s-prod-1',
    'port: 8080',
    'owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" } ]',
    '',
    '# зависимости',
    'uses:',
    '  - { resource: kafka }',
    '  - {resource: adfs,   purpose: "Проверка токенов"}',
    'exports: [ { channel: cdc, target: dwh } ]',
    'links:',
    '- { kind: api, url: https://x }',
    '',
  ].join('\n');

  it('Review Focus 1: changing only cluster changes exactly one line, comments survive', () => {
    const next = { ...parse(commented), cluster: 'k8s-prod-2' };
    const out = patchYaml(commented, next);
    expect(lineDiff(commented, out)).toEqual({ removed: ['cluster: k8s-prod-1'], added: ['cluster: k8s-prod-2'] });
    expect(out).toContain('# главный сервис\nname: orders # имя\n');
    expect(parse(out)).toEqual(next);
  });

  it('changed scalar keeps a trailing comment and quoting style', () => {
    const out = patchYaml('name: orders # имя\nsegment: "app"\n', { name: 'billing', segment: 'dmz' });
    expect(out).toBe('name: billing # имя\nsegment: "dmz"\n');
  });

  it('adding an item to uses changes only the uses block', () => {
    const before = parse(commented);
    const next = { ...before, uses: [...before.uses, { resource: 's3-main', bucket: 'files', access: 'rw' }] };
    const out = patchYaml(commented, next);
    const head = commented.slice(0, commented.indexOf('uses:'));
    const tail = commented.slice(commented.indexOf('exports:'));
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(parse(out)).toEqual(next);
    const d = lineDiff(commented, out);
    expect([...d.removed, ...d.added].every((l) => l.startsWith('  - '))).toBe(true);
    expect(d.added).toContain('  - { resource: s3-main, bucket: files, access: rw }');
  });

  it('removing exports deletes exactly its lines', () => {
    const { exports: _x, ...next } = parse(commented);
    const out = patchYaml(commented, next);
    expect(out).toBe(commented.replace('exports: [ { channel: cdc, target: dwh } ]\n', ''));
    const billing = file('sales/pay/services/billing.yaml');
    const { exports: _y, ...nb } = parse(billing);
    expect(patchYaml(billing, nb)).toBe(billing.replace('exports: [ { channel: cdc, target: dwh, entities: [payment] } ]\n', ''));
  });

  it('empty array in next removes the key', () => {
    const out = patchYaml(commented, { ...parse(commented), exports: [] });
    expect(out).not.toContain('exports');
  });

  it('a changed flow list stays flow; a block list with "- " at column 0 keeps its indent', () => {
    const before = parse(commented);
    const out = patchYaml(commented, { ...before, owners: [...before.owners, { role: 'owner', name: 'И.' }], links: [{ kind: 'api', url: 'https://y' }] });
    const d = lineDiff(commented, out);
    expect(d.removed).toEqual(['owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" } ]', '- { kind: api, url: https://x }']);
    expect(d.added).toEqual(['owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" }, { role: owner, name: И. } ]', '- { kind: api, url: https://y }']);
  });

  it('a nested scalar change inside a block list of block items changes only that line', () => {
    const src = file('sales/crm/product.yaml');
    const next = parse(src);
    next.dbservers[0].hosts[1].role = 'arbiter';
    const out = patchYaml(src, next);
    expect(lineDiff(src, out)).toEqual({
      removed: ['      - { fqdn: pg-crm-02.db.company.ru, role: replica }'],
      added: ['      - { fqdn: pg-crm-02.db.company.ru, role: arbiter }'],
    });
  });

  it('new keys are inserted in canonical position', () => {
    const src = file('sales/crm/services/notify-worker.yaml');
    const next = { ...parse(src), port: 8081, owners: [{ role: 'techlead', name: 'X' }], criticality: 'low' };
    const out = patchYaml(src, next);
    expect(out).toBe(src
      .replace('cluster: k8s-prod-2\n', 'cluster: k8s-prod-2\ncriticality: low\nport: 8081\n')
      .concat('owners:\n  - { role: techlead, name: X }\n'));
    expect(Object.keys(parse(out))).toEqual(SERVICE_ORDER.filter((k) => k in next));
  });

  it('new key at the end of a file without trailing newline', () => {
    expect(patchYaml('name: a\nsegment: app', { name: 'a', segment: 'app', cluster: 'c' })).toBe('name: a\nsegment: app\ncluster: c\n');
  });

  it.each(Object.keys(demo).filter((p) => p.endsWith('.yaml')))('is idempotent on demo %s', (p) => {
    const x = file(p);
    expect(patchYaml(x, parse(x))).toBe(x);
  });
});

describe('paths', () => {
  it('servicePath', () => {
    expect(servicePath('sales', 'crm', 'notify', 'worker')).toBe('sales/crm/services/notify-worker.yaml');
    expect(servicePath('sales', 'crm', 'orders', 'ui')).toBe('sales/crm/services/orders-ui.yaml');
    expect(servicePath('sales', 'crm', 'orders', 'backend')).toBe('sales/crm/services/orders.yaml');
    expect(servicePath('sales', 'crm', 'orders', '')).toBe('sales/crm/services/orders.yaml');
  });
  it('productPath / teamPath', () => {
    expect(productPath('sales', 'crm')).toBe('sales/crm/product.yaml');
    expect(teamPath('sales')).toBe('sales/team.yaml');
  });
});
