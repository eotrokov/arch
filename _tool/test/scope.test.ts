import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { project } from '../src/views/scope.js';
import type { Model } from '../src/model/types.js';

describe('project (scope)', () => {
  let m: Model;
  beforeAll(() => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    m = resolveModel(tree!).model!;
  });

  it('product scope: own, collapsed neighbour, non-neighbour', () => {
    const p = project(m, { kind: 'product', id: 'crm' });
    expect(p.visible('crm-orders')).toMatchObject({ id: 'crm-orders', muted: false });
    expect(p.visible('db:crm_orders')).toMatchObject({ muted: false, collapsed: false });
    expect(p.visible('pay-billing')).toEqual({ id: 'product:pay', muted: true, collapsed: true });
    expect(p.visible('ext:dwh')).toBeNull();
    expect(p.visible('nope')).toBeNull();
    expect(p.visible('platform:kafka')).toEqual({ id: 'platform:kafka', muted: true, collapsed: false });
  });

  it('collapseBySegment', () => {
    const p = project(m, { kind: 'product', id: 'crm' }, { collapseBySegment: true });
    expect(p.visible('pay-billing')!.id).toBe('product:pay@app');
  });

  it('company scope', () => {
    expect(project(m, { kind: 'company', expanded: [] }).visible('crm-orders')).toEqual({ id: 'product:crm', muted: false, collapsed: true });
    expect(project(m, { kind: 'company', expanded: ['crm'] }).visible('crm-orders')!.id).toBe('crm-orders');
    expect(project(m, { kind: 'company', expanded: [] }).visible('platform:kafka')).toEqual({ id: 'platform:kafka', muted: false, collapsed: false });
  });

  it('service scope: neighbours not collapsed', () => {
    const p = project(m, { kind: 'service', id: 'crm-orders-ui' });
    expect(p.visible('crm-orders-ui')).toMatchObject({ muted: false });
    expect(p.visible('crm-orders')).toEqual({ id: 'crm-orders', muted: true, collapsed: false });
    expect(p.visible('pay-billing')).toBeNull();
  });

  it('team scope', () => {
    const p = project(m, { kind: 'team', id: 'sales' });
    for (const s of ['crm-orders', 'crm-orders-ui', 'crm-orders-job', 'crm-notify-worker', 'pay-billing']) {
      expect(p.visible(s)!.muted, s).toBe(false);
    }
  });

  it('publication path of in-scope service', () => {
    const p = project(m, { kind: 'product', id: 'crm' });
    expect(p.visible('actor:internet')).toEqual({ id: 'actor:internet', muted: true, collapsed: false });
    expect(p.visible('platform:waf-main')).toMatchObject({ muted: true, collapsed: false });
    expect(p.visible('actor:office')).toBeNull();
  });

  it('dbserver follows its visible database', () => {
    const p = project(m, { kind: 'product', id: 'crm' });
    expect(p.visible('dbserver:pg-crm')).toEqual({ id: 'dbserver:pg-crm', muted: false, collapsed: false });
    expect(p.visible('dbserver:pg-shared')).toBeNull();
  });

  it('R7: product-owned external is in scope and never collapsed', () => {
    expect(project(m, { kind: 'product', id: 'pay' }).visible('ext:dwh')).toEqual({ id: 'ext:dwh', muted: false, collapsed: false });
    expect(project(m, { kind: 'team', id: 'sales' }).visible('ext:dwh')).toEqual({ id: 'ext:dwh', muted: false, collapsed: false });
    expect(project(m, { kind: 'company', expanded: [] }).visible('ext:dwh')).toEqual({ id: 'ext:dwh', muted: false, collapsed: false });
    expect(project(m, { kind: 'service', id: 'pay-billing' }).visible('ext:dwh')).toEqual({ id: 'ext:dwh', muted: true, collapsed: false });
    expect(project(m, { kind: 'product', id: 'crm' }).visible('ext:dwh')).toBeNull();
  });
});
