import type { Finding, Model } from '../model/types.js';
import type { Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { FindingIndex, GraphBuilder, modelNodeClasses, productName, teamFrame } from './common.js';

/** Разрез «контейнеры»: все видимые узлы, рамки продуктов, рёбра по протоколам. */
export function containersView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
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

  for (const n of Object.values(model.nodes)) {
    const v = proj.visible(n.id);
    if (!v) continue;
    if (v.collapsed) {
      g.addNode({
        id: v.id, label: productName(model, n.product), kind: 'product', collapsed: true, muted: v.muted,
        parent: ensureTeamFrame(n.product),
      });
      continue;
    }
    let parent: string | undefined;
    if (n.product) {
      parent = `frame:product:${n.product}`;
      g.addNode({
        id: parent, label: productName(model, n.product), kind: 'frame', muted: v.muted,
        parent: ensureTeamFrame(n.product),
      });
    }
    g.addNode({
      id: n.id, label: n.label, kind: n.kind, parent, muted: v.muted, collapsed: false,
      classes: modelNodeClasses(idx, n), modelId: n.id,
    });
  }

  for (const e of model.edges) {
    if (e.kind === 'explicit') continue;
    const a = proj.visible(e.from);
    const b = proj.visible(e.to);
    if (a && b) g.addEdge(a.id, b.id, e);
  }
  return g.build();
}
