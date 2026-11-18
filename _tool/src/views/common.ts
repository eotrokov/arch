import type { Classification, Finding, Model, ModelEdge, ModelNode } from '../model/types.js';
import type { Projection, Scope, ViewEdge, ViewGraph, ViewNode, Visibility } from './types.js';

const CLS_ORDER: Classification[] = ['open', 'kt', 'pdn'];

/** Классы по находкам: violation (error), warning, attention-<суффикс>. */
export class FindingIndex {
  private nodes = new Map<string, string[]>();
  private edges = new Map<string, string[]>();

  constructor(findings: Finding[]) {
    for (const f of findings) {
      const cls = classOf(f);
      for (const id of f.nodeIds) push(this.nodes, id, cls);
      for (const id of f.edgeIds) push(this.edges, id, cls);
    }
  }
  node(modelId: string): string[] { return this.nodes.get(modelId) ?? []; }
  edge(modelEdgeId: string): string[] { return this.edges.get(modelEdgeId) ?? []; }
}

function classOf(f: Finding): string {
  if (f.level === 'error') return 'violation';
  if (f.level === 'warning') return 'warning';
  return `attention-${f.rule.replace(/^attention\./, '')}`;
}
function push(m: Map<string, string[]>, k: string, v: string) {
  const list = m.get(k);
  if (!list) m.set(k, [v]);
  else if (!list.includes(v)) list.push(v);
}

export function edgeLabel(e: ModelEdge): string {
  switch (e.kind) {
    case 'db': return `sql ${e.role ?? ''}`.trim();
    case 'publish': return 'pub';
    case 'consume': return 'sub';
    case 'export': return e.channel ?? '';
    default: return e.protocol ?? '';
  }
}

interface EdgeAcc { id: string; from: string; to: string; labels: string[]; modelEdgeIds: string[]; classes: string[]; cls: Classification }

/** Накопитель графа: узлы по id, рёбра агрегируются по паре видимых id, петли отбрасываются. */
export class GraphBuilder {
  private nodes = new Map<string, ViewNode>();
  private edges = new Map<string, EdgeAcc>();

  constructor(private idx: FindingIndex) {}

  has(id: string): boolean { return this.nodes.has(id); }

  /** Добавляет узел; повторное добавление объединяет классы, muted — только если приглушены все. */
  addNode(n: Omit<ViewNode, 'classes'> & { classes?: string[] }): void {
    const cur = this.nodes.get(n.id);
    if (!cur) {
      this.nodes.set(n.id, { ...n, classes: [...(n.classes ?? [])] });
      return;
    }
    cur.muted = Boolean(cur.muted) && Boolean(n.muted);
    for (const c of n.classes ?? []) if (!cur.classes.includes(c)) cur.classes.push(c);
  }

  addEdge(from: string, to: string, me: ModelEdge, labelOverride?: string): void {
    if (from === to) return;
    const id = `${from}->${to}`;
    let acc = this.edges.get(id);
    if (!acc) {
      acc = { id, from, to, labels: [], modelEdgeIds: [], classes: [], cls: 'open' };
      this.edges.set(id, acc);
    }
    const label = labelOverride ?? edgeLabel(me);
    if (label && !acc.labels.includes(label)) acc.labels.push(label);
    if (!acc.modelEdgeIds.includes(me.id)) acc.modelEdgeIds.push(me.id);
    for (const c of this.idx.edge(me.id)) if (!acc.classes.includes(c)) acc.classes.push(c);
    if (CLS_ORDER.indexOf(me.classification) > CLS_ORDER.indexOf(acc.cls)) acc.cls = me.classification;
  }

  build(): ViewGraph {
    const nodes = [...this.nodes.values()].map((n) => {
      const classes = n.muted ? [...n.classes, 'muted'] : n.classes;
      return { ...n, classes: [...new Set(classes)] };
    });
    const edges: ViewEdge[] = [...this.edges.values()].map((a) => {
      const muted = this.nodes.get(a.from)?.muted || this.nodes.get(a.to)?.muted;
      return {
        id: a.id, from: a.from, to: a.to, label: a.labels.join(', '),
        classes: [...a.classes, ...(muted ? ['muted'] : []), `cls-${a.cls}`], modelEdgeIds: a.modelEdgeIds,
      };
    });
    return { nodes, edges };
  }
}

/** Рамка команды (только в охвате company). */
export function teamFrame(model: Model, productCode: string | undefined): { id: string; label: string } | null {
  const team = model.teams.find((t) => t.products.includes(productCode ?? ''))
    ?? model.teams.find((t) => t.id === model.products.find((p) => p.code === productCode)?.team);
  return team ? { id: `frame:team:${team.id}`, label: team.name } : null;
}

export function productName(model: Model, code: string | undefined): string {
  return model.products.find((p) => p.code === code)?.name ?? code ?? '';
}

export function modelNodeClasses(idx: FindingIndex, n: ModelNode): string[] {
  return idx.node(n.id);
}

/**
 * Ребро публикации (expose) показывается, только если опубликованный сервис виден и не приглушён (spec §5.2);
 * в охвате company опубликованный сервис всегда считается видимым.
 */
export function exposeShown(e: ModelEdge, proj: Projection, scope: Scope): boolean {
  if (e.kind !== 'expose') return true;
  if (scope.kind === 'company') return true;
  const v = e.exposedService ? proj.visible(e.exposedService) : null;
  return !!v && !v.muted;
}

/**
 * Узел в разрезах с рамками продуктов (контейнеры, потоки): свёрнутый продукт — узел в рамке команды,
 * иначе узел в рамке продукта; узлы свёрнутого продукта (его внешние системы) — прямо в рамке команды.
 * Возвращает id узла вида.
 */
export function addFramedNode(
  g: GraphBuilder, model: Model, idx: FindingIndex, scope: Scope, n: ModelNode, v: Visibility,
): string {
  const company = scope.kind === 'company';
  const ensureTeamFrame = (code: string | undefined): string | undefined => {
    if (!company) return undefined;
    const t = teamFrame(model, code);
    if (!t) return undefined;
    g.addNode({ id: t.id, label: t.label, kind: 'frame', muted: false });
    return t.id;
  };
  if (v.collapsed) {
    g.addNode({
      id: v.id, label: productName(model, n.product), kind: 'product', collapsed: true, muted: v.muted,
      parent: ensureTeamFrame(n.product),
    });
    return v.id;
  }
  let parent: string | undefined;
  if (n.product) {
    const productCollapsed = scope.kind === 'company' && !scope.expanded.includes(n.product);
    if (productCollapsed) parent = ensureTeamFrame(n.product);
    else {
      parent = `frame:product:${n.product}`;
      g.addNode({
        id: parent, label: productName(model, n.product), kind: 'frame', muted: v.muted, parent: ensureTeamFrame(n.product),
      });
    }
  }
  g.addNode({
    id: n.id, label: n.label, kind: n.kind, parent, muted: v.muted, collapsed: false,
    classes: modelNodeClasses(idx, n), modelId: n.id,
  });
  return n.id;
}
