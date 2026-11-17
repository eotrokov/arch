import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { firewallView } from '../src/views/firewall.js';
import { dataflowsView } from '../src/views/dataflows.js';
import { buildView } from '../src/views/index.js';
import type { Finding, Model } from '../src/model/types.js';
import type { Scope, ViewGraph } from '../src/views/types.js';

const crm: Scope = { kind: 'product', id: 'crm' };
const byId = (g: ViewGraph, id: string) => g.nodes.find((n) => n.id === id);
const edge = (g: ViewGraph, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe('firewall / dataflows (demo)', () => {
  let m: Model;
  let findings: Finding[];
  beforeAll(() => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    m = resolveModel(tree!).model!;
    findings = runChecks(tree!, m);
  });
  const row = (g: ViewGraph, from: string, to: string) => g.table!.find((r) => r.fromNode === from && r.toNode === to);

  it('table rows', () => {
    const g = firewallView(m, findings, crm);
    expect(row(g, 'crm-orders', 'db:crm_orders')).toMatchObject({
      fromSegment: 'app', toSegment: 'pdn', port: '5432', protocol: 'tcp', intraSegment: false, attention: ['sensitive'],
      toHosts: ['pg-crm.db.company.ru', 'pg-crm-01.db.company.ru', 'pg-crm-02.db.company.ru'],
    });
    expect(row(g, 'crm-orders', 'platform:kafka')!.intraSegment).toBe(true);
    const pay = row(g, 'crm-orders', 'product:pay@app')!;
    expect(pay.port).toBe('9090');
    expect(pay.attention).toContain('cross-product');
    expect(row(g, 'seg:mgmt', 'seg:app')).toMatchObject({ port: '9100', reason: 'Мониторинг' });
  });
  it('segment frames as parents', () => {
    const g = firewallView(m, findings, crm);
    expect(byId(g, 'crm-orders')!.parent).toBe('seg:app');
    expect(byId(g, 'db:crm_orders')!.parent).toBe('seg:pdn');
  });
  it('publication chain', () => {
    const g = firewallView(m, findings, crm);
    expect(row(g, 'actor:internet', 'platform:waf-main')).toMatchObject({ fromSegment: 'external', toSegment: 'dmz', port: '443' });
    expect(row(g, 'platform:waf-main', 'platform:ingress')).toMatchObject({ port: '443', intraSegment: true });
    expect(row(g, 'platform:ingress', 'crm-orders-ui')!.port).toBe('8080');
    expect(g.table!.some((r) => r.fromNode === 'actor:office' || r.toNode === 'actor:office')).toBe(false);
  });
  it('external platform resource', () => {
    const g = firewallView(m, findings, crm);
    expect(row(g, 'crm-notify-worker', 'platform:ya-messenger')).toMatchObject({
      toSegment: 'external', toHosts: ['botapi.messenger.yandex.net'], port: '443',
    });
  });
  it('explicit connection keeps empty segment frame', () => {
    const g = firewallView(m, findings, crm);
    expect(byId(g, 'seg:mgmt')).toBeDefined();
    expect(edge(g, 'seg:mgmt', 'seg:app')).toBeDefined();
  });
  it('buildView dispatch', () => {
    expect(buildView(m, findings, crm, 'firewall')).toEqual(firewallView(m, findings, crm));
    expect(buildView(m, findings, crm, 'dataflows')).toEqual(dataflowsView(m, findings, crm));
  });

  describe('dataflows', () => {
    const company: Scope = { kind: 'company', expanded: ['crm', 'pay'] };
    it('direction follows data', () => {
      const g = dataflowsView(m, findings, company);
      expect(edge(g, 'topic:crm.orders.order.created.v1', 'crm-notify-worker')!.classes).toContain('cls-pdn');
      expect(edge(g, 'crm-notify-worker', 'topic:crm.orders.order.created.v1')).toBeUndefined();
      const e = edge(g, 'pay-billing', 'ext:dwh')!;
      expect(e.label).toContain('payment');
      expect(e.label).toContain('cdc');
      expect(e.classes).toContain('cls-kt');
    });
    it('no expose edges; resource labels', () => {
      const g = dataflowsView(m, findings, crm);
      expect(g.edges.some((e) => e.from === 'actor:internet' || e.to === 'crm-orders-ui')).toBe(false);
      const smtp = edge(g, 'crm-notify-worker', 'platform:smtp-relay')!;
      expect(smtp.label).toContain('order');
      expect(smtp.label).toContain('SMTP');
      expect(smtp.classes).toContain('cls-pdn');
      expect(edge(g, 'crm-notify-worker', 'platform:ya-messenger')).toBeUndefined();
    });
  });

  describe('referential integrity (all views)', () => {
    const scopes: Scope[] = [
      { kind: 'company', expanded: [] }, { kind: 'company', expanded: ['crm', 'pay'] },
      { kind: 'team', id: 'sales' }, { kind: 'product', id: 'crm' }, { kind: 'product', id: 'pay' },
    ];
    for (const view of ['containers', 'kubernetes', 'firewall', 'databases', 'dataflows'] as const) {
      it(view, () => {
        const all = [...scopes, ...Object.values(m.nodes).filter((n) => n.kind === 'service').map((n) => ({ kind: 'service' as const, id: n.id }))];
        for (const scope of all) {
          const g = buildView(m, findings, scope, view);
          const ids = g.nodes.map((n) => n.id);
          expect(new Set(ids).size, `${view} ${JSON.stringify(scope)} unique`).toBe(ids.length);
          const set = new Set(ids);
          for (const e of g.edges) {
            expect(set.has(e.from), `${view} ${JSON.stringify(scope)} from ${e.from}`).toBe(true);
            expect(set.has(e.to), `${view} ${JSON.stringify(scope)} to ${e.to}`).toBe(true);
          }
          for (const n of g.nodes) if (n.parent) expect(set.has(n.parent), `${view} parent ${n.parent}`).toBe(true);
        }
      });
    }
  });
});
