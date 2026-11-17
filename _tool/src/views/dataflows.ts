import type { Finding, Model, ModelEdge } from '../model/types.js';
import type { Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { FindingIndex, GraphBuilder, modelNodeClasses, productName, teamFrame } from './common.js';

const RESOURCE_LABEL: Record<string, string> = {
  s3: 'S3', smtp: 'SMTP', 'yandex-disk': 'Яндекс Диск', 'yandex-messenger': 'Яндекс Мессенджер',
};

/** Разрез «потоки данных»: рёбра по направлению движения данных, подпись — сущности и канал. */
export function dataflowsView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
  const idx = new FindingIndex(findings);
  const g = new GraphBuilder(idx);
  const proj = project(model, scope);
  const company = scope.kind === 'company';

  const ensureTeamFrame = (code: string | undefined): string | undefined => {
    if (!company) return undefined;
    const t = teamFrame(model, code);
    if (!t) return undefined;
    g.addNode({ id: t.id, label: t.label, kind: 'frame', muted: false });
    return t.id;
  };

  const addNodeById = (id: string): string | null => {
    const n = model.nodes[id];
    const v = proj.visible(id);
    if (!n || !v) return null;
    if (v.collapsed) {
      g.addNode({
        id: v.id, label: productName(model, n.product), kind: 'product', collapsed: true, muted: v.muted,
        parent: ensureTeamFrame(n.product),
      });
      return v.id;
    }
    let parent: string | undefined;
    if (n.product) {
      parent = `frame:product:${n.product}`;
      g.addNode({
        id: parent, label: productName(model, n.product), kind: 'frame', muted: v.muted, parent: ensureTeamFrame(n.product),
      });
    }
    g.addNode({
      id: n.id, label: n.label, kind: n.kind, parent, muted: v.muted, collapsed: false,
      classes: modelNodeClasses(idx, n), modelId: n.id,
    });
    return n.id;
  };

  for (const n of Object.values(model.nodes)) {
    if (n.kind === 'service' || n.kind === 'external' || n.kind === 'topic') addNodeById(n.id);
  }

  const channelLabel = (e: ModelEdge): string => {
    switch (e.kind) {
      case 'call': return 'API';
      case 'publish': case 'consume': return 'топик';
      case 'export': return e.channel ?? '';
      default: {
        const k = model.nodes[e.to]?.resourceKind ?? '';
        return RESOURCE_LABEL[k] ?? k.toUpperCase();
      }
    }
  };

  for (const e of model.edges) {
    if (!['call', 'publish', 'consume', 'export', 'use'].includes(e.kind) || e.entities.length === 0) continue;
    const src = e.kind === 'consume' ? e.to : e.from;
    const dst = e.kind === 'consume' ? e.from : e.to;
    const sn = model.nodes[src];
    const dn = model.nodes[dst];
    if (!sn || !dn || !proj.visible(src) || !proj.visible(dst)) continue;
    const okNode = (k: string) => k === 'service' || k === 'external' || k === 'topic';
    if (!okNode(sn.kind) || !(okNode(dn.kind) || (e.kind === 'use' && dn.kind === 'platform'))) continue;
    const a = addNodeById(src);
    const b = addNodeById(dst);
    if (a && b) g.addEdge(a, b, e, `${e.entities.join(', ')} · ${channelLabel(e)}`);
  }
  return g.build();
}
