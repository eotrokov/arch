import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { checkOwnership } from '../src/checks/ownership.js';
import { containersView } from '../src/views/containers.js';
import { kubernetesView } from '../src/views/kubernetes.js';
import { databasesView } from '../src/views/databases.js';
import { buildView } from '../src/views/index.js';
import { makeModel } from './helpers.js';
import type { Finding, Model } from '../src/model/types.js';
import type { ViewGraph, Scope } from '../src/views/types.js';

const crm: Scope = { kind: 'product', id: 'crm' };
const byId = (g: ViewGraph, id: string) => g.nodes.find((n) => n.id === id);

describe('basic views (demo)', () => {
  let m: Model;
  let findings: Finding[];
  beforeAll(() => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    m = resolveModel(tree!).model!;
    findings = runChecks(tree!, m);
  });

  describe('containers', () => {
    it('company scope groups collapsed products by team', () => {
      const g = containersView(m, findings, { kind: 'company', expanded: [] });
      expect(byId(g, 'product:crm')!.parent).toBe('frame:team:sales');
      expect(byId(g, 'frame:team:sales')).toBeDefined();
    });
    it('product frames, edges and labels', () => {
      const g = containersView(m, findings, crm);
      expect(byId(g, 'frame:product:crm')).toBeDefined();
      expect(byId(g, 'crm-orders')).toMatchObject({ parent: 'frame:product:crm', modelId: 'crm-orders' });
      expect(g.edges.find((e) => e.from === 'crm-orders-ui' && e.to === 'crm-orders')!.label).toBe('http');
      expect(g.edges.find((e) => e.from === 'crm-orders' && e.to === 'product:pay')!.label).toBe('grpc');
      expect(g.edges.find((e) => e.to === 'db:crm_orders' && e.from === 'crm-orders-job')!.label).toBe('sql migr');
      expect(g.edges.find((e) => e.to === 'topic:crm.orders.order.created.v1' && e.from === 'crm-orders')!.label).toBe('pub');
      expect(g.edges.find((e) => e.from === 'crm-notify-worker' && e.to === 'topic:crm.orders.order.created.v1')!.label).toBe('sub');
    });
    it('classes: muted, attention, cls; no self-loops', () => {
      const g = containersView(m, findings, crm);
      expect(byId(g, 'product:pay')!.classes).toContain('muted');
      const e = g.edges.find((x) => x.from === 'crm-orders' && x.to === 'product:pay')!;
      expect(e.classes).toEqual(expect.arrayContaining(['muted', 'cls-pdn', 'attention-cross-product']));
      expect(g.edges.every((x) => x.from !== x.to)).toBe(true);
      expect(g.edges.find((x) => x.to === 'db:crm_orders' && x.from === 'crm-orders')!.classes).toContain('attention-sensitive');
    });
    it('external of a product sits in its frame', () => {
      const g = containersView(m, findings, { kind: 'product', id: 'pay' });
      expect(byId(g, 'ext:dwh')).toMatchObject({ parent: 'frame:product:pay', modelId: 'ext:dwh' });
      expect(byId(g, 'ext:dwh')!.classes).not.toContain('muted');
    });
  });

  describe('kubernetes', () => {
    it('clusters, namespaces, services', () => {
      const g = kubernetesView(m, findings, crm);
      for (const c of ['k8s-prod-1', 'k8s-prod-2']) {
        expect(byId(g, `cluster:${c}`)).toBeDefined();
        expect(byId(g, `ns:${c}/crm-prod`)!.parent).toBe(`cluster:${c}`);
      }
      expect(byId(g, 'crm-orders-job')!.classes).toContain('cronjob');
      expect(byId(g, 'crm-orders')!.classes).toContain('deployment');
      expect(byId(g, 'crm-orders')!.parent).toBe('ns:k8s-prod-1/crm-prod');
      expect(byId(g, 'crm-orders')!.label).toContain('crm-orders');
      for (const id of ['crm-orders', 'crm-orders-ui', 'crm-orders-job', 'crm-notify-worker']) {
        expect(byId(g, id)!.label, id).toContain(`SA: ${id}`);
      }
      expect(byId(g, 'pay-billing')).toBeUndefined();
    });
    it('ingress only for published services', () => {
      const g = kubernetesView(m, findings, crm);
      expect(byId(g, 'ingress:orders.crm.company.ru')).toBeDefined();
      expect(g.edges.some((e) => e.from === 'ingress:orders.crm.company.ru' && e.to === 'crm-orders-ui')).toBe(true);
      expect(g.edges.some((e) => e.to === 'crm-orders')).toBe(false);
    });
    it('pay scope has billing ingress', () => {
      const g = kubernetesView(m, findings, { kind: 'product', id: 'pay' });
      expect(byId(g, 'ingress:billing.pay.company.ru')).toBeDefined();
    });
    it('company scope: only expanded products', () => {
      const g = kubernetesView(m, findings, { kind: 'company', expanded: ['pay'] });
      expect(g.nodes.filter((n) => n.modelId).map((n) => n.id)).toEqual(['pay-billing']);
    });
  });

  describe('databases', () => {
    it('server frame, hosts, db frame, users', () => {
      const g = databasesView(m, findings, crm);
      const srv = byId(g, 'dbserver:pg-crm')!;
      expect(srv.label).toContain('postgres 16');
      expect(srv.label).toContain('pg-crm.db.company.ru');
      expect(byId(g, 'host:pg-crm-01.db.company.ru')).toMatchObject({ parent: 'dbserver:pg-crm' });
      expect(byId(g, 'host:pg-crm-01.db.company.ru')!.label).toBe('pg-crm-01.db.company.ru\nprimary');
      expect(byId(g, 'host:pg-crm-01.db.company.ru')!.classes).toContain('primary');
      expect(byId(g, 'host:pg-crm-02.db.company.ru')!.classes).toContain('replica');
      expect(byId(g, 'db:crm_orders')).toMatchObject({ parent: 'dbserver:pg-crm', modelId: 'db:crm_orders' });
      for (const r of ['rw', 'ro', 'migr']) expect(byId(g, `user:crm_orders_${r}`)!.parent).toBe('db:crm_orders');
      expect(g.edges.find((e) => e.from === 'crm-orders-job' && e.to === 'user:crm_orders_migr')).toBeDefined();
      expect(g.edges.find((e) => e.from === 'crm-orders' && e.to === 'user:crm_orders_rw')).toBeDefined();
      expect(byId(g, 'dbserver:pg-shared')).toBeUndefined();
    });
    it('violation only on the foreign-access edge', () => {
      const m2: Model = { ...m, edges: [...m.edges, {
        id: 'db:crm-notify-worker->db:crm_orders', kind: 'db', from: 'crm-notify-worker', to: 'db:crm_orders',
        role: 'ro', entities: [], classification: 'pdn', reason: 'test',
      }] };
      const f = checkOwnership(m2);
      const g = databasesView(m2, f, crm);
      const viol = g.edges.filter((e) => e.classes.includes('violation'));
      expect(viol.map((e) => `${e.from}->${e.to}`)).toEqual(['crm-notify-worker->user:crm_orders_ro']);
      for (const n of g.nodes.filter((x) => x.kind === 'host' || x.kind === 'user')) expect(n.classes).not.toContain('violation');
    });
  });

  describe('buildView', () => {
    it('dispatches', () => {
      expect(buildView(m, findings, crm, 'containers')).toEqual(containersView(m, findings, crm));
      expect(buildView(m, findings, crm, 'kubernetes')).toEqual(kubernetesView(m, findings, crm));
      expect(buildView(m, findings, crm, 'databases')).toEqual(databasesView(m, findings, crm));
    });
  });
});

describe('edge aggregation (synthetic)', () => {
  const m = makeModel({
    services: ['crm-a', 'crm-b', 'pay-x', 'pay-y'],
    edges: [
      { kind: 'call', from: 'crm-a', to: 'pay-x', protocol: 'http' },
      { kind: 'call', from: 'crm-b', to: 'pay-y', protocol: 'grpc' },
      { kind: 'call', from: 'crm-b', to: 'pay-x', protocol: 'http' },
      { kind: 'call', from: 'crm-a', to: 'crm-b', protocol: 'http' },
      { kind: 'call', from: 'crm-b', to: 'crm-a', protocol: 'http' },
    ],
  });
  it('merges parallel edges between collapsed products', () => {
    const g = containersView(m, [], { kind: 'company', expanded: [] });
    const es = g.edges.filter((e) => e.from === 'product:crm' && e.to === 'product:pay');
    expect(es).toHaveLength(1);
    expect(es[0]!.modelEdgeIds).toHaveLength(3);
    expect(es[0]!.label).toBe('http, grpc');
  });
  it('drops loops created by collapsing', () => {
    const g = containersView(m, [], { kind: 'company', expanded: [] });
    expect(g.edges.some((e) => e.from === e.to)).toBe(false);
    expect(g.edges).toHaveLength(1);
  });
});

describe('referential integrity', () => {
  const { tree } = loadTree('examples/demo');
  const m = resolveModel(tree!).model!;
  const findings = runChecks(tree!, m);
  const scopes: Scope[] = [
    { kind: 'company', expanded: [] }, { kind: 'company', expanded: ['crm', 'pay'] },
    { kind: 'team', id: 'sales' }, { kind: 'product', id: 'crm' }, { kind: 'product', id: 'pay' },
    ...Object.values(m.nodes).filter((n) => n.kind === 'service').map((n) => ({ kind: 'service' as const, id: n.id })),
  ];
  for (const view of ['containers', 'kubernetes', 'databases'] as const) {
    for (const scope of scopes) {
      it(`${view} / ${JSON.stringify(scope)}`, () => {
        const g = buildView(m, findings, scope, view);
        const ids = g.nodes.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        const set = new Set(ids);
        for (const e of g.edges) {
          expect(set.has(e.from), `edge from ${e.from}`).toBe(true);
          expect(set.has(e.to), `edge to ${e.to}`).toBe(true);
        }
        for (const n of g.nodes) if (n.parent) expect(set.has(n.parent), `parent ${n.parent}`).toBe(true);
      });
    }
  }
});

describe('empty model', () => {
  const company: Scope = { kind: 'company', expanded: [] };
  it('model without nodes: all views are empty', () => {
    for (const f of [containersView, kubernetesView, databasesView]) {
      expect(f(makeModel({}), [], company)).toEqual({ nodes: [], edges: [] });
    }
  });
  it('fixtures/empty (shared platform only): no services, no databases', () => {
    const { tree } = loadTree('test/fixtures/empty');
    const model = resolveModel(tree!).model!;
    expect(kubernetesView(model, [], company)).toEqual({ nodes: [], edges: [] });
    expect(databasesView(model, [], company)).toEqual({ nodes: [], edges: [] });
    // containers shows shared platform resources and actors, but no edges
    expect(containersView(model, [], company).edges).toEqual([]);
  });
});
