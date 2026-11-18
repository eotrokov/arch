import type { Finding, Model } from '../model/types.js';
import type { Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { FindingIndex, GraphBuilder, productName, teamFrame } from './common.js';

const ROLES = ['rw', 'ro', 'migr'] as const;

/** Разрез «БД»: сервер СУБД > хосты и БД > пользователи; рёбра от сервисов к пользователям. */
export function databasesView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
  const idx = new FindingIndex(findings);
  const g = new GraphBuilder(idx);
  const proj = project(model, scope);
  const company = scope.kind === 'company';

  const dbs = new Set<string>();
  for (const n of Object.values(model.nodes)) {
    if (n.kind !== 'database') continue;
    const v = proj.visible(n.id);
    if (!v || v.collapsed) continue;
    dbs.add(n.id);

    const server = n.server ? model.nodes[n.server] : undefined;
    let parent: string | undefined;
    if (server) {
      parent = server.id;
      const sv = proj.visible(server.id);
      const muted = sv?.muted ?? v.muted;
      const head = [server.label, [server.engine, server.version].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
      g.addNode({
        id: server.id, label: server.endpoint ? `${head}\n${server.endpoint}` : head, kind: 'dbserver',
        muted, classes: idx.node(server.id).filter((c) => c !== 'violation'), modelId: server.id,
      });
      for (const h of server.hosts ?? []) {
        g.addNode({ id: `host:${h.fqdn}`, label: `${h.fqdn}\n${h.role}`, kind: 'host', parent: server.id, muted, classes: [h.role] });
      }
    }
    const schema = n.id.replace(/^db:/, '');
    g.addNode({ id: `db:${schema}`, label: n.label, kind: 'database', parent, muted: v.muted, modelId: n.id });
    for (const r of ROLES) {
      g.addNode({ id: `user:${schema}_${r}`, label: `${schema}_${r}`, kind: 'user', parent: `db:${schema}`, muted: v.muted });
    }
  }

  for (const e of model.edges) {
    if (e.kind !== 'db' || !dbs.has(e.to) || !e.role) continue;
    const from = proj.visible(e.from);
    if (!from) continue;
    if (!g.has(from.id)) {
      const n = model.nodes[e.from]!;
      if (from.collapsed) {
        let parent: string | undefined;
        const t = company ? teamFrame(model, n.product) : null;
        if (t) {
          g.addNode({ id: t.id, label: t.label, kind: 'frame', muted: false });
          parent = t.id;
        }
        g.addNode({ id: from.id, label: productName(model, n.product), kind: 'product', collapsed: true, muted: from.muted, parent });
      } else {
        g.addNode({
          id: n.id, label: n.label, kind: n.kind, muted: from.muted, collapsed: false,
          classes: idx.node(n.id), modelId: n.id,
        });
      }
    }
    const schema = e.to.replace(/^db:/, '');
    g.addEdge(from.id, `user:${schema}_${e.role}`, e);
  }
  return g.build();
}
