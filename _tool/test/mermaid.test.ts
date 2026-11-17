import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { exportMermaid, toMermaid } from '../src/export/mermaid.js';
import type { Finding, Model } from '../src/model/types.js';

describe('mermaid export', () => {
  let m: Model;
  let findings: Finding[];
  beforeAll(() => {
    const { tree } = loadTree('examples/demo');
    m = resolveModel(tree!).model!;
    findings = runChecks(tree!, m);
  });

  it('14 files with expected paths', () => {
    const files = exportMermaid(m, findings);
    expect(files).toHaveLength(14);
    const paths = files.map((f) => f.path);
    for (const p of ['crm', 'pay']) {
      expect(paths).toContain(`mermaid/${p}/containers.md`);
      expect(paths).toContain(`mermaid/${p}/firewall.md`);
    }
    expect(paths.filter((p) => p.split('/').length === 4)).toHaveLength(10);
  });

  it('crm firewall has segment subgraph and table row', () => {
    const f = exportMermaid(m, findings).find((x) => x.path === 'mermaid/crm/firewall.md')!;
    expect(f.content).toMatch(/subgraph \w*seg_pdn/);
    expect(f.content).toContain('# Продукт crm — Фаервол');
    expect(f.content).toMatch(/\|[^\n]*5432\/tcp[^\n]*\|/);
  });

  it('escapes ids and is stable on collisions', () => {
    const out = toMermaid({
      nodes: [
        { id: 'topic:crm.orders.order.created.v1', label: 'a"b\nc', kind: 'topic', classes: [] },
        { id: 'topic:crm_orders_order_created_v1', label: 'x', kind: 'topic', classes: [] },
      ],
      edges: [],
    }, 'T');
    expect(out).toContain('n_topic_crm_orders_order_created_v1["a#quot;b<br/>c"]');
    expect(out).toContain('n_topic_crm_orders_order_created_v1_2["x"]');
  });

  it('empty graph is a valid block', () => {
    expect(toMermaid({ nodes: [], edges: [] }, 'E')).toBe('# E\n\n```mermaid\nflowchart LR\n```\n');
  });
});
