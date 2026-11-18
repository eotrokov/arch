import type { Finding, Model } from '../model/types.js';
import type { Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { addFramedNode, exposeShown, FindingIndex, GraphBuilder } from './common.js';

/**
 * Разрез «контейнеры»: видимые узлы (кроме серверов СУБД — их показывает разрез «БД»), рамки продуктов,
 * рёбра по протоколам.
 */
export function containersView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
  const idx = new FindingIndex(findings);
  const g = new GraphBuilder(idx);
  const proj = project(model, scope);

  for (const n of Object.values(model.nodes)) {
    if (n.kind === 'dbserver') continue;
    const v = proj.visible(n.id);
    if (v) addFramedNode(g, model, idx, scope, n, v);
  }

  for (const e of model.edges) {
    if (e.kind === 'explicit' || !exposeShown(e, proj, scope)) continue;
    const a = proj.visible(e.from);
    const b = proj.visible(e.to);
    if (a && b && g.has(a.id) && g.has(b.id)) g.addEdge(a.id, b.id, e);
  }
  return g.build();
}
