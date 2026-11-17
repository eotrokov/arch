import type { Finding, Model, ModelEdge, ModelNode } from '../model/types.js';
import type { FirewallRow, Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { FindingIndex, GraphBuilder, modelNodeClasses, productName } from './common.js';

interface Acc { row: FirewallRow; reasons: string[]; attention: Set<string> }

/** Разрез «фаервол»: рамки сегментов, узлы внутри, рёбра-соединения и таблица правил. */
export function firewallView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
  const idx = new FindingIndex(findings);
  const g = new GraphBuilder(idx);
  const proj = project(model, scope, { collapseBySegment: true });
  const segName = new Map(model.segments.map((s) => [s.id, s.name]));
  const nodeSegment = new Map<string, string>(); // id узла вида -> сегмент

  const frame = (seg: string, muted: boolean) =>
    g.addNode({ id: `seg:${seg}`, label: segName.get(seg) ?? seg, kind: 'segment', muted });

  const addViewNode = (n: ModelNode, v: { id: string; muted: boolean; collapsed: boolean }) => {
    if (v.collapsed) {
      // свёрнутый продукт живёт в рамке сегмента
      frame(n.segment, v.muted);
      g.addNode({
        id: v.id, label: `${productName(model, n.product)} (${n.segment})`, kind: 'product', collapsed: true,
        muted: v.muted, parent: `seg:${n.segment}`,
      });
    } else {
      frame(n.segment, v.muted);
      g.addNode({
        id: n.id, label: n.label, kind: n.kind, parent: `seg:${n.segment}`, muted: v.muted, collapsed: false,
        classes: modelNodeClasses(idx, n), modelId: n.id,
      });
    }
    nodeSegment.set(v.id, n.segment);
  };

  for (const n of Object.values(model.nodes)) {
    if (n.kind === 'topic' || n.kind === 'dbserver') continue;
    const v = proj.visible(n.id);
    if (v) addViewNode(n, v);
  }

  const broker = Object.values(model.nodes).find((n) => n.kind === 'platform' && n.resourceKind === 'kafka');
  const ensureBroker = (): string | null => {
    if (!broker) return null;
    if (!g.has(broker.id)) addViewNode(broker, { id: broker.id, muted: false, collapsed: false });
    return broker.id;
  };

  const hostsOf = (n: ModelNode | undefined): string[] => {
    if (!n) return [];
    if (n.kind === 'database') {
      const server = n.server ? model.nodes[n.server] : undefined;
      return [...(server?.endpoint ? [server.endpoint] : []), ...(server?.hosts ?? []).map((h) => h.fqdn)];
    }
    if (n.kind === 'platform') return n.endpoint ? [n.endpoint] : [];
    return [];
  };

  const rows = new Map<string, Acc>();
  const addRow = (from: string, to: string, toModel: ModelNode | undefined, e: ModelEdge) => {
    if (from === to || e.port === undefined) return;
    const port = String(e.port);
    const protocol = e.protocol ?? '';
    const key = `${from}|${to}|${port}|${protocol}`;
    let acc = rows.get(key);
    if (!acc) {
      const fromSegment = segOf(from);
      const toSegment = segOf(to);
      acc = {
        row: {
          fromNode: from, fromSegment, toNode: to, toSegment, toHosts: hostsOf(toModel), port, protocol,
          reason: '', intraSegment: fromSegment === toSegment, attention: [],
        },
        reasons: [], attention: new Set(),
      };
      rows.set(key, acc);
    }
    if (!acc.reasons.includes(e.reason)) acc.reasons.push(e.reason);
    for (const c of idx.edge(e.id)) if (c.startsWith('attention-')) acc.attention.add(c.slice('attention-'.length));
    g.addEdge(from, to, e);
  };
  const segOf = (id: string): string => (id.startsWith('seg:') ? id.slice(4) : nodeSegment.get(id) ?? '');

  for (const e of model.edges) {
    if (e.kind === 'explicit') {
      const ends = [e.from, e.to].map((id) => {
        if (id.startsWith('seg:')) {
          if (!g.has(id)) frame(id.slice(4), false);
          return { id, model: undefined as ModelNode | undefined };
        }
        const v = proj.visible(id);
        return v ? { id: v.id, model: model.nodes[id] } : null;
      });
      if (ends[0] && ends[1]) addRow(ends[0].id, ends[1].id, ends[1].model, e);
      continue;
    }
    const a = proj.visible(e.from);
    const b = proj.visible(e.to);
    if (!a || !b) continue;
    if (e.kind === 'publish' || e.kind === 'consume') {
      const toId = ensureBroker();
      if (toId) addRow(a.id, toId, broker, e);
      continue;
    }
    addRow(a.id, b.id, b.collapsed ? undefined : model.nodes[e.to], e);
  }

  const graph = g.build();
  graph.table = [...rows.values()]
    .map(({ row, reasons, attention }) => ({ ...row, reason: reasons.join('; '), attention: [...attention].sort() }))
    .sort((x, y) =>
      x.fromSegment.localeCompare(y.fromSegment) || x.toSegment.localeCompare(y.toSegment)
      || Number(x.port) - Number(y.port) || x.fromNode.localeCompare(y.fromNode) || x.toNode.localeCompare(y.toNode));
  return graph;
}
