import type { Model, ModelEdge, ModelNode } from '../src/model/types.js';

type NodeSpec = Partial<ModelNode> & { id: string };
type EdgeSpec = Partial<ModelEdge> & { kind: ModelEdge['kind']; from: string; to: string };

const TYPES = ['ui', 'job', 'worker', 'gw'];

/** Сервис по id: system — первый токен, serviceName — остаток без суффикса типа. */
export function svc(id: string, extra: Partial<ModelNode> = {}): ModelNode {
  const [system, ...rest] = id.split('-');
  const type = TYPES.includes(rest[rest.length - 1] ?? '') ? rest.pop()! : '';
  return {
    id, kind: 'service', label: id, segment: 'app', system, serviceName: rest.join('-'), serviceType: type as never,
    product: system, owners: [{ role: 'techlead', name: 'T' }], ownersInherited: false, links: [], ...extra,
  };
}

export function node(spec: NodeSpec): ModelNode {
  return { kind: 'platform', label: spec.id, segment: 'app', owners: [], ownersInherited: false, links: [], ...spec };
}

/** Небольшая модель для тестов правил: сегменты по умолчанию — external/dmz/app/db/pdn(sensitive). */
export function makeModel(spec: { services?: (string | ModelNode)[]; nodes?: NodeSpec[]; edges?: EdgeSpec[]; segments?: Model['segments']; products?: Model['products'] }): Model {
  const nodes: Record<string, ModelNode> = {};
  for (const s of spec.services ?? []) {
    const n = typeof s === 'string' ? svc(s) : s;
    nodes[n.id] = n;
  }
  for (const s of spec.nodes ?? []) nodes[s.id] = node(s);
  const edges: ModelEdge[] = (spec.edges ?? []).map((e) => ({
    id: `${e.kind}:${e.from}->${e.to}`, entities: [], classification: 'open', reason: 'test', ...e,
  }));
  return {
    env: 'prod', domain: 'company.ru', registry: 'registry.company.ru',
    segments: spec.segments ?? [
      { id: 'external', name: 'external', external: true, sensitive: false },
      { id: 'dmz', name: 'dmz', external: false, sensitive: false },
      { id: 'app', name: 'app', external: false, sensitive: false },
      { id: 'db', name: 'db', external: false, sensitive: false },
      { id: 'pdn', name: 'pdn', external: false, sensitive: true },
    ],
    clusters: [], teams: [], products: spec.products ?? [], entities: {}, nodes, edges,
  };
}
