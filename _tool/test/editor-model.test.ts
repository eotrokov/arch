import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readModel, loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { validateFiles, pickLists } from '../editor/model.js';

const demo = readModel(resolve('examples/demo'));
const key = (fs: { rule: string; nodeIds: string[] }[]) => fs.map((f) => `${f.rule}|${f.nodeIds.join(',')}`);

describe('validateFiles', () => {
  it('equals the CLI pipeline on demo', () => {
    const v = validateFiles(demo.files, demo.dirs);
    const { tree } = loadTree(resolve('examples/demo'));
    const { model } = resolveModel(tree!);
    expect(v.loadErrors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(key(v.findings)).toEqual(key(runChecks(tree!, model!)));
  });

  it('deleting a referenced service blocks with the referrer file', () => {
    const files = { ...demo.files };
    delete files['sales/pay/services/billing.yaml'];
    const v = validateFiles(files, demo.dirs);
    expect(v.ok).toBe(false);
    expect(v.model).toBeNull();
    expect(v.loadErrors.some((e) => e.file.endsWith('sales/crm/services/orders.yaml') && e.message.includes('pay-billing'))).toBe(true);
  });
});

describe('pickLists: запасной путь без модели', () => {
  it('учитывает overrides сервиса в id', () => {
    const files = { ...demo.files };
    delete files['sales/pay/services/billing.yaml']; // ссылка в orders.yaml ломается: модели нет, дерево есть
    files['sales/crm/services/orders.yaml'] += 'overrides:\n  id: { value: crm-orders-custom, reason: test }\n';
    const v = validateFiles(files, demo.dirs);
    expect(v.model).toBeNull();
    expect(v.tree).not.toBeNull();
    const l = pickLists(v);
    expect(l.services).toContain('crm-orders-custom');
    expect(l.services).not.toContain('crm-orders');
  });
});

describe('pickLists', () => {
  const l = pickLists(validateFiles(demo.files, demo.dirs));
  it('lists demo values', () => {
    expect(l.segments.map((s) => s.id)).toContain('pdn');
    expect(l.resources).toContainEqual({ id: 'waf-main', kind: 'waf', name: 'WAF' });
    expect(l.topics).toEqual(['crm.orders.order.created.v1']);
    expect(l.services).toHaveLength(5);
    expect(l.services).toContain('pay-billing');
    expect(l.externals).toContainEqual(expect.objectContaining({ id: 'bank' }));
    expect(l.externals).toContainEqual({ id: 'dwh', name: 'DWH', product: 'pay' });
    expect(l.entities).toContainEqual({ name: 'payment', product: 'pay', classification: 'kt' });
    expect(l.teams.length).toBe(1);
    expect(l.products.map((p) => p.code).sort()).toEqual(['crm', 'pay']);
    expect(l.dbservers[0]).toMatchObject({ id: 'pg-shared', engine: 'postgres' });
  });

  it('falls back to the tree when the model does not resolve', () => {
    const files = { ...demo.files };
    delete files['sales/pay/services/billing.yaml'];
    const l2 = pickLists(validateFiles(files, demo.dirs));
    expect(l2.services).toHaveLength(4);
    expect(l2.segments.map((s) => s.id)).toContain('pdn');
  });

  it('is empty without tree', () => {
    const l3 = pickLists(validateFiles({}));
    expect(l3.segments).toEqual([]);
    expect(l3.services).toEqual([]);
  });
});
