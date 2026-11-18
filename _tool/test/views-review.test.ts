import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { containersView } from '../src/views/containers.js';
import { firewallView } from '../src/views/firewall.js';
import { dataflowsView } from '../src/views/dataflows.js';
import { exportMermaid } from '../src/export/mermaid.js';
import type { Finding, Model } from '../src/model/types.js';
import type { Scope, ViewGraph } from '../src/views/types.js';

const crm: Scope = { kind: 'product', id: 'crm' };
const pay: Scope = { kind: 'product', id: 'pay' };
const company: Scope = { kind: 'company', expanded: [] };
const byId = (g: ViewGraph, id: string) => g.nodes.find((n) => n.id === id);

describe('review fixes (demo)', () => {
  let m: Model;
  let findings: Finding[];
  beforeAll(() => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    m = resolveModel(tree!).model!;
    findings = runChecks(tree!, m);
  });
  const exposeOf = (g: ViewGraph, svc: string) =>
    g.edges.filter((e) => e.modelEdgeIds.some((id) => m.edges.find((x) => x.id === id)?.exposedService === svc));

  describe('publication only in a scope that contains the published service', () => {
    it('containers: no pay-billing publication in product:crm, present in product:pay', () => {
      const g = containersView(m, findings, crm);
      expect(exposeOf(g, 'pay-billing')).toEqual([]);
      expect(g.edges.some((e) => e.from === 'platform:ingress' && e.to === 'product:pay')).toBe(false);
      expect(exposeOf(g, 'crm-orders-ui').length).toBeGreaterThan(0);
      const gp = containersView(m, findings, pay);
      expect(gp.edges.some((e) => e.from === 'platform:ingress' && e.to === 'pay-billing')).toBe(true);
    });
    it('firewall: no pay-billing publication row in product:crm, present in product:pay', () => {
      const g = firewallView(m, findings, crm);
      expect(g.table!.some((r) => r.reason.includes('публикация pay-billing'))).toBe(false);
      expect(g.table!.some((r) => r.toNode.startsWith('product:pay') && r.fromNode === 'platform:ingress')).toBe(false);
      expect(exposeOf(g, 'pay-billing')).toEqual([]);
      const gp = firewallView(m, findings, pay);
      expect(gp.table!.some((r) => r.fromNode === 'platform:ingress' && r.toNode === 'pay-billing'
        && r.reason.includes('публикация pay-billing'))).toBe(true);
    });
    it('company scope keeps publication to a collapsed product', () => {
      const g = containersView(m, findings, company);
      expect(g.edges.some((e) => e.from === 'platform:ingress' && e.to === 'product:pay')).toBe(true);
    });
    it('mermaid: crm files do not mention pay-billing publication, pay files do', () => {
      const files = exportMermaid(m, findings);
      const get = (p: string) => files.find((f) => f.path === p)!.content;
      expect(get('mermaid/crm/firewall.md')).not.toContain('публикация pay-billing');
      expect(get('mermaid/crm/containers.md')).not.toMatch(/n_platform_ingress -->[^\n]*n_product_pay\b/);
      expect(get('mermaid/crm/firewall.md')).not.toMatch(/n_platform_ingress -->[^\n]*n_product_pay_app\b/);
      expect(get('mermaid/pay/firewall.md')).toContain('публикация pay-billing');
      expect(get('mermaid/pay/containers.md')).toMatch(/n_platform_ingress -->[^\n]*n_pay_billing\b/);
    });
  });

  describe('landing clutter', () => {
    for (const [name, view] of [['containers', containersView], ['dataflows', dataflowsView]] as const) {
      it(`${name}: no frame for a collapsed product; its external sits in the team frame`, () => {
        const g = view(m, findings, company);
        expect(byId(g, 'product:pay')).toBeDefined();
        expect(byId(g, 'frame:product:pay')).toBeUndefined();
        expect(byId(g, 'frame:product:crm')).toBeUndefined();
        expect(byId(g, 'ext:dwh')!.parent).toBe('frame:team:sales');
      });
      it(`${name}: product:crm scope keeps frame:product:crm`, () => {
        const g = view(m, findings, crm);
        expect(byId(g, 'frame:product:crm')).toBeDefined();
      });
    }
    it('containers: own external in expanded product sits in product frame', () => {
      const g = containersView(m, findings, { kind: 'company', expanded: ['pay'] });
      expect(byId(g, 'ext:dwh')!.parent).toBe('frame:product:pay');
    });
    for (const scope of [company, crm]) {
      it(`containers ${JSON.stringify(scope)}: no dbserver nodes`, () => {
        const g = containersView(m, findings, scope);
        expect(g.nodes.filter((n) => n.kind === 'dbserver')).toEqual([]);
      });
      it(`dataflows ${JSON.stringify(scope)}: every node takes part in an edge (frames aside)`, () => {
        const g = dataflowsView(m, findings, scope);
        const used = new Set(g.edges.flatMap((e) => [e.from, e.to]));
        const loose = g.nodes.filter((n) => n.kind !== 'frame' && !used.has(n.id)).map((n) => n.id);
        expect(loose).toEqual([]);
        const parents = new Set(g.nodes.map((n) => n.parent).filter(Boolean));
        expect(g.nodes.filter((n) => n.kind === 'frame' && !parents.has(n.id)).map((n) => n.id)).toEqual([]);
        expect(g.edges.length).toBeGreaterThan(0);
      });
    }
  });
});
