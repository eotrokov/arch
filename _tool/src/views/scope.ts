import type { Model, ModelNode } from '../model/types.js';
import type { Projection, Scope, Visibility } from './types.js';

/** Проекция модели на охват: какие узлы видимы, приглушены или свёрнуты. */
export function project(model: Model, scope: Scope, opts: { collapseBySegment?: boolean } = {}): Projection {
  const nodes = model.nodes;
  const result = new Map<string, Visibility>();
  const put = (id: string, v: Visibility) => result.set(id, v);

  if (scope.kind === 'company') {
    const expanded = new Set(scope.expanded);
    for (const n of Object.values(nodes)) {
      if (n.product && !expanded.has(n.product)) {
        put(n.id, { id: collapsedId(n, opts), muted: false, collapsed: true });
      } else {
        put(n.id, { id: n.id, muted: false, collapsed: false });
      }
    }
    return { visible: (id) => result.get(id) ?? null };
  }

  const teamOfProduct = new Map(model.products.map((p) => [p.code, p.team]));
  const productInScope = (code: string | undefined): boolean => {
    if (!code) return false;
    if (scope.kind === 'product') return code === scope.id;
    if (scope.kind === 'team') return teamOfProduct.get(code) === scope.id;
    return false;
  };
  const inScope = (n: ModelNode): boolean => {
    if (n.kind !== 'service' && n.kind !== 'database' && n.kind !== 'topic') return false;
    if (scope.kind === 'service') return (n.kind === 'service' ? n.id : n.ownerService) === scope.id;
    return productInScope(n.product);
  };

  for (const n of Object.values(nodes)) {
    if (inScope(n)) put(n.id, { id: n.id, muted: false, collapsed: false });
  }

  // соседи на один шаг по любым рёбрам, кроме expose (explicit — уровень сегментов, не узлов)
  const addNeighbour = (n: ModelNode | undefined) => {
    if (!n || result.has(n.id)) return;
    if (!n.product || scope.kind === 'service' || productInScope(n.product)) {
      put(n.id, { id: n.id, muted: true, collapsed: false });
    } else {
      put(n.id, { id: collapsedId(n, opts), muted: true, collapsed: true });
    }
  };
  const inScopeIds = new Set(result.keys());
  for (const e of model.edges) {
    if (e.kind === 'expose' || e.kind === 'explicit') continue;
    if (inScopeIds.has(e.from)) addNeighbour(nodes[e.to]);
    if (inScopeIds.has(e.to)) addNeighbour(nodes[e.from]);
  }

  // публикации: акторы и платформа на пути, если опубликованный сервис в охвате
  for (const e of model.edges) {
    if (e.kind !== 'expose' || !e.exposedService) continue;
    if (result.get(e.exposedService)?.muted !== false) continue;
    for (const id of [e.from, e.to]) {
      const n = nodes[id];
      if (n && (n.kind === 'actor' || n.kind === 'platform') && !result.has(id)) {
        put(id, { id, muted: true, collapsed: false });
      }
    }
  }

  // серверы БД видны вместе с видимой (не свёрнутой) БД на них
  for (const n of Object.values(nodes)) {
    if (n.kind !== 'database' || !n.server) continue;
    const v = result.get(n.id);
    if (!v || v.collapsed) continue;
    const cur = result.get(n.server);
    if (!cur) put(n.server, { id: n.server, muted: v.muted, collapsed: false });
    else if (!v.muted) cur.muted = false;
  }

  return { visible: (id) => result.get(id) ?? null };
}

function collapsedId(n: ModelNode, opts: { collapseBySegment?: boolean }): string {
  return opts.collapseBySegment ? `product:${n.product}@${n.segment}` : `product:${n.product}`;
}
