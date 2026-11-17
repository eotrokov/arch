import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTree } from '../src/model/load.js';

const fx = (n: string) => join('test/fixtures', n);
const tmps: string[] = [];

/** Копия минимальной модели (empty) с одним сервисом во временном каталоге. */
function withService(yamlText: string, product = 'code: crm\nname: CRM\n') {
  const root = mkdtempSync(join(tmpdir(), 'arch-views-'));
  tmps.push(root);
  cpSync(fx('empty'), root, { recursive: true });
  mkdirSync(join(root, 'sales/crm/services'), { recursive: true });
  writeFileSync(join(root, 'sales/team.yaml'), 'name: Продажи\n');
  writeFileSync(join(root, 'sales/crm/product.yaml'), product);
  writeFileSync(join(root, 'sales/crm/services/x.yaml'), yamlText);
  return root;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadTree', () => {
  it('loads demo tree', () => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    expect(tree!.teams).toHaveLength(1);
    expect(tree!.teams[0]!.dir).toBe('sales');
    const products = tree!.teams[0]!.products;
    expect(products.map((p) => p.data.code)).toEqual(['crm', 'pay']);
    expect(products[0]!.services).toHaveLength(4);
    expect(products[1]!.services).toHaveLength(1);
  });

  it('skips underscore dirs', () => {
    const { tree, errors } = loadTree(fx('underscore'));
    expect(errors).toEqual([]);
    expect(tree!.teams).toHaveLength(0);
  });

  it('empty model', () => {
    const { tree, errors } = loadTree(fx('empty'));
    expect(errors).toEqual([]);
    expect(tree!.teams).toHaveLength(0);
  });

  it('missing _shared files are errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-views-'));
    tmps.push(root);
    const { tree, errors } = loadTree(root);
    expect(tree).toBeNull();
    expect(errors.map((e) => e.file.split('/').pop()).sort()).toEqual(['network.yaml', 'platform.yaml']);
  });

  it('bad yaml has file and line', () => {
    const { tree, errors } = loadTree(fx('bad-yaml'));
    expect(tree).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file.endsWith('services/orders.yaml')).toBe(true);
    expect(errors[0]!.line).toBe(3);
  });

  it('link url must be http(s)', () => {
    const { tree, errors } = loadTree(fx('bad-link'));
    expect(tree).toBeNull();
    expect(errors.some((e) => e.message.includes('links'))).toBe(true);
  });

  it('dbserver without hosts', () => {
    const { tree, errors } = loadTree(fx('bad-dbserver'));
    expect(tree).toBeNull();
    expect(errors.some((e) => e.message.includes('hosts'))).toBe(true);
  });

  it('schema error names field', () => {
    const { tree, errors } = loadTree(fx('bad-schema'));
    expect(tree).toBeNull();
    expect(errors.some((e) => e.message.includes('cluster'))).toBe(true);
    expect(errors[0]!.message.startsWith('Схема:')).toBe(true);
  });

  it('uses forms', () => {
    const base = 'name: x\nsegment: app\ncluster: k8s-prod-1\nuses:\n';
    const ok = [
      '  - { resource: kafka, purpose: p, entities: [order] }',
      '  - { resource: s3-main, bucket: files, access: rw }',
      '  - { db: crm_orders, role: migr }',
    ];
    for (const line of ok) {
      const { errors } = loadTree(withService(base + line + '\n'));
      expect(errors, line).toEqual([]);
    }
    const { tree, errors } = loadTree(withService(base + '  - { resource: x, db: y }\n'));
    expect(tree).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('defaults', () => {
    const { tree, errors } = loadTree(withService('name: x\nsegment: app\ncluster: k8s-prod-1\n'));
    expect(errors).toEqual([]);
    expect(tree!.teams[0]!.products[0]!.services[0]!.data.port).toBeUndefined();
  });

  it('product without services dir', () => {
    const root = withService('name: x\nsegment: app\ncluster: c\n');
    rmSync(join(root, 'sales/crm/services'), { recursive: true });
    const { tree, errors } = loadTree(root);
    expect(errors).toEqual([]);
    expect(tree!.teams[0]!.products[0]!.services).toEqual([]);
  });
});
