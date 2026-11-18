import type { Finding, Model, ModelEdge } from '../model/types.js';
import type { Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { addFramedNode, FindingIndex, GraphBuilder } from './common.js';

const RESOURCE_LABEL: Record<string, string> = {
  s3: 'S3', smtp: 'SMTP', 'yandex-disk': 'Яндекс Диск', 'yandex-messenger': 'Яндекс Мессенджер',
};

/** Разрез «потоки данных»: рёбра по направлению движения данных, подпись — сущности и канал; узлы — только участники рёбер. */
export function dataflowsView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
  const idx = new FindingIndex(findings);
  const g = new GraphBuilder(idx);
  const proj = project(model, scope);
  const addNodeById = (id: string): string | null => {
    const n = model.nodes[id];
    const v = proj.visible(id);
    if (!n || !v) return null;
    return addFramedNode(g, model, idx, scope, n, v);
  };

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
    const sv = proj.visible(src);
    const dv = proj.visible(dst);
    if (!sn || !dn || !sv || !dv || sv.id === dv.id) continue;
    const okNode = (k: string) => k === 'service' || k === 'external' || k === 'topic';
    if (!okNode(sn.kind) || !(okNode(dn.kind) || (e.kind === 'use' && dn.kind === 'platform'))) continue;
    const a = addNodeById(src);
    const b = addNodeById(dst);
    if (a && b) g.addEdge(a, b, e, `${e.entities.join(', ')} · ${channelLabel(e)}`);
  }
  return g.build();
}
