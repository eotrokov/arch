import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import type { Model, ModelEdge } from '../src/model/types.js';

const fx = (n: string) => `test/fixtures/${n}`;
function resolveDir(dir: string) {
  const { tree, errors } = loadTree(dir);
  expect(errors).toEqual([]);
  return resolveModel(tree!);
}

describe('resolveModel demo', () => {
  let m: Model;
  const edge = (kind: string, from: string, to: string): ModelEdge => {
    const e = m.edges.find((x) => x.kind === kind && x.from === from && x.to === to);
    expect(e, `${kind} ${from} -> ${to}`).toBeDefined();
    return e!;
  };
  beforeAll(() => {
    const r = resolveDir('examples/demo');
    expect(r.errors).toEqual([]);
    m = r.model!;
  });

  it('has expected nodes', () => {
    for (const id of ['crm-orders', 'crm-orders-ui', 'crm-notify-worker', 'crm-orders-job', 'pay-billing', 'db:crm_orders',
      'db:pay_billing', 'topic:crm.orders.order.created.v1', 'platform:kafka', 'ext:bank', 'ext:dwh', 'dbserver:pg-crm', 'actor:internet']) {
      expect(m.nodes[id], id).toBeDefined();
    }
    expect(m.nodes['db:crm_orders_job']).toBeUndefined();
  });

  it('fills system, serviceName, ownerService', () => {
    expect(m.nodes['crm-orders-job']).toMatchObject({ system: 'crm', serviceName: 'orders', serviceType: 'job' });
    expect(m.nodes['db:crm_orders']!.ownerService).toBe('crm-orders');
    expect(m.nodes['topic:crm.orders.order.created.v1']!.ownerService).toBe('crm-orders');
  });

  it('published via ingress', () => {
    expect(m.nodes['crm-orders-ui']).toMatchObject({ published: true });
    expect(m.nodes['crm-orders-ui']!.names!.ingressHost).toBeTruthy();
    expect(m.nodes['pay-billing']!.published).toBe(true);
    expect(m.nodes['crm-orders']!.published).toBe(false);
  });

  it('call edge', () => {
    expect(edge('call', 'crm-orders', 'pay-billing')).toMatchObject({ port: 9090, protocol: 'grpc', classification: 'pdn' });
  });

  it('db edges and nodes', () => {
    expect(edge('db', 'crm-orders', 'db:crm_orders')).toMatchObject({ role: 'rw', port: 5432 });
    expect(m.nodes['db:crm_orders']).toMatchObject({ segment: 'pdn', server: 'dbserver:pg-crm' });
    expect(m.nodes['db:pay_billing']!.segment).toBe('db');
    expect(edge('db', 'crm-orders-job', 'db:crm_orders').role).toBe('migr');
    const dbs = m.nodes['dbserver:pg-crm']!;
    expect(dbs.hosts).toHaveLength(2);
    expect(dbs.endpoint).toBe('pg-crm.db.company.ru');
  });

  it('expose chain', () => {
    const ex = m.edges.filter((e) => e.kind === 'expose' && e.exposedService === 'crm-orders-ui');
    expect(ex.map((e) => `${e.from}>${e.to}`)).toEqual([
      'actor:internet>platform:waf-main', 'platform:waf-main>platform:ingress', 'platform:ingress>crm-orders-ui']);
    expect(ex.map((e) => e.port)).toEqual([443, 443, 8080]);
    expect(ex.every((e) => e.audience === 'internet')).toBe(true);
  });

  it('use edges', () => {
    expect(edge('use', 'crm-orders', 'platform:s3-main')).toMatchObject({
      bucket: 'crm-orders-prod-files', access: 'rw', port: 443, classification: 'pdn' });
    expect(edge('use', 'crm-notify-worker', 'platform:ya-messenger')).toMatchObject({ entities: [], classification: 'open' });
  });

  it('topic edges', () => {
    expect(edge('consume', 'crm-notify-worker', 'topic:crm.orders.order.created.v1')).toMatchObject({ port: 9093, classification: 'pdn' });
    expect(edge('publish', 'crm-orders', 'topic:crm.orders.order.created.v1').port).toBe(9093);
  });

  it('export edge', () => {
    expect(edge('export', 'pay-billing', 'ext:dwh')).toMatchObject({ channel: 'cdc', classification: 'kt' });
  });

  it('links and owners', () => {
    const links = m.nodes['crm-orders']!.links;
    expect(links[0]).toEqual({ kind: 'repo', url: 'https://gitlab.company.ru/crm/crm-orders', title: 'crm-orders' });
    expect(links.slice(1).map((l) => l.kind)).toEqual(['api', 'dashboard']);
    const w = m.nodes['crm-notify-worker']!;
    expect(w.ownersInherited).toBe(true);
    expect(w.owners).toEqual(m.products.find((p) => p.code === 'crm')!.owners);
    expect(m.nodes['crm-orders']!.ownersInherited).toBe(false);
  });

  it('explicit connection', () => {
    const e = m.edges.find((x) => x.kind === 'explicit')!;
    expect(e).toMatchObject({ from: 'seg:mgmt', to: 'seg:app', port: 9100, reason: 'Мониторинг' });
  });

  it('edge ids are unique', () => {
    expect(new Set(m.edges.map((e) => e.id)).size).toBe(m.edges.length);
  });
});

describe('resolveModel repo link', () => {
  it('explicit repo link replaces derived one', () => {
    const { tree } = loadTree('examples/demo');
    const svc = tree!.teams[0]!.products[0]!.services.find((x) => x.data.name === 'orders' && !x.data.type)!;
    svc.data.links = [{ kind: 'repo', url: 'https://git.example.org/x' }, { kind: 'api', url: 'https://a.b/c' }];
    const links = resolveModel(tree!).model!.nodes['crm-orders']!.links;
    expect(links.filter((l) => l.kind === 'repo')).toEqual([{ kind: 'repo', url: 'https://git.example.org/x' }]);
  });
});

describe('resolveModel errors', () => {
  it('dup-product', () => {
    const r = resolveDir(fx('dup-product'));
    expect(r.model).toBeNull();
    const e = r.errors.find((x) => x.message.includes('crm'))!;
    expect(e.message).toContain('sales/crm/product.yaml');
    expect(e.message).toContain('pay/crm/product.yaml');
  });

  it('dup-service', () => {
    const r = resolveDir(fx('dup-service'));
    expect(r.model).toBeNull();
    const e = r.errors.find((x) => x.message.includes('crm-orders'))!;
    expect(e.message).toContain('orders.yaml');
    expect(e.message).toContain('orders-copy.yaml');
  });

  it('bad-ref reports every reference', () => {
    const r = resolveDir(fx('bad-ref'));
    expect(r.model).toBeNull();
    const all = r.errors.map((e) => e.message).join('\n');
    for (const needle of ['nope', 'bucket', 'pg-nope', 'crm-nope', 'crm.nothing.order.created.v1', 'ghost']) expect(all).toContain(needle);
    const expectCount = (re: RegExp) => expect(r.errors.filter((e) => re.test(e.message)).length).toBeGreaterThan(0);
    expectCount(/uses\.resource nope/);
    expectCount(/bucket/);
    expectCount(/exposure\.via nope/);
    expectCount(/exposure\.audience nope/);
    expectCount(/pg-nope/);
    expectCount(/calls\.target crm-nope/);
    expectCount(/сегмент nope/);
    expectCount(/кластер nope/);
    expectCount(/crm\.nothing/);
    expectCount(/ghost/);
    expect(r.errors.every((e) => e.file)).toBe(true);
  });
});
