// Данные карточки элемента. Без импортов Node (уходит в браузер).
import type { Finding, Link, Model, ModelNode, Owner } from '../src/model/types.js';
import { buildView } from '../src/views/index.js';
import type { Scope, ViewKind } from '../src/views/types.js';

export interface CardData {
  title: string;
  attrs: [string, string][];
  names: [string, string][];
  owners: Owner[];
  ownersInherited: boolean;
  /** Откуда унаследованы ответственные (для подписи в карточке). */
  ownersSource?: 'product' | 'dbserver';
  links: Link[];
  views: ViewKind[];
  findings: Finding[];
}

const CLASS_LABEL: Record<string, string> = { pdn: 'ПДн', kt: 'КТ', open: 'открытые' };

const VIEW_ORDER: ViewKind[] = ['kubernetes', 'containers', 'firewall', 'databases', 'dataflows'];

function viewsWith(model: Model, findings: Finding[], nodeId: string, scope: Scope): ViewKind[] {
  return VIEW_ORDER.filter((v) => buildView(model, findings, scope, v).nodes.some((n) => (n.modelId ?? n.id) === nodeId));
}

function publications(model: Model, n: ModelNode): [string, string][] {
  const byAudience = new Map<string, { actor: string; chain: string[] }>();
  for (const e of model.edges) {
    if (e.kind !== 'expose' || e.exposedService !== n.id) continue;
    const key = e.audience ?? e.from;
    let p = byAudience.get(key);
    if (!p) {
      p = { actor: e.from, chain: [] };
      byAudience.set(key, p);
    }
    p.chain.push(e.to);
  }
  const label = (id: string) => model.nodes[id]?.label ?? id;
  return [...byAudience.values()].map((p) => ['Публикация', [label(p.actor), ...p.chain.slice(0, -1).map(label), n.id].join(' → ')]);
}

function productCard(model: Model, findings: Finding[], id: string): CardData | null {
  const p = model.products.find((x) => `product:${x.code}` === id);
  if (!p) return null;
  const attrs: [string, string][] = [['Код', p.code]];
  if (p.criticality) attrs.push(['Критичность', p.criticality]);
  return {
    title: p.name, attrs, names: [], owners: p.owners, ownersInherited: false, links: p.links,
    views: viewsWith(model, findings, id, { kind: 'company', expanded: [] }),
    findings: findings.filter((f) => f.level !== 'attention' && f.nodeIds.includes(id)),
  };
}

export function cardData(model: Model, findings: Finding[], nodeId: string): CardData {
  const product = nodeId.startsWith('product:') ? productCard(model, findings, nodeId) : null;
  if (product) return product;

  const n = model.nodes[nodeId];
  if (!n) {
    return { title: nodeId, attrs: [], names: [], owners: [], ownersInherited: false, links: [], views: [], findings: [] };
  }
  const seg = model.segments.find((s) => s.id === n.segment);
  const attrs: [string, string][] = [['Сегмент', seg?.name ?? n.segment]];
  if (n.port !== undefined) attrs.push(['Порт', `${n.port}/${n.protocol ?? 'tcp'}`]);
  const names: [string, string][] = [];

  if (n.kind === 'service') {
    if (n.cluster) attrs.push(['Кластер', n.cluster]);
    attrs.push(...publications(model, n));
    const adfs = model.edges
      .filter((e) => e.kind === 'use' && e.from === n.id && model.nodes[e.to]?.resourceKind === 'adfs')
      .map((e) => `ADFS — ${e.purpose ?? e.reason}`);
    if (adfs.length > 0) attrs.push(['Аутентификация', adfs.join('; ')]);
    const d = n.names;
    if (d) {
      names.push(['Репозиторий', d.repo], ['Deployment', d.deployment], ['namespace', d.namespace],
        ['ServiceAccount', d.serviceAccount]);
      if (n.published) names.push(['Ingress', d.ingressHost]);
      names.push(['ТУЗ', d.tuz], ['Vault', d.vaultPath], ['Схема БД', d.dbSchema], ['Образ', d.image],
        ['Consumer group', d.consumerGroup]);
    }
  } else if (n.kind === 'database') {
    if (n.ownerService) attrs.push(['Владелец', n.ownerService]);
    attrs.push(['Классификация', CLASS_LABEL[n.classification ?? 'open'] ?? n.classification ?? '']);
    if (n.server) {
      attrs.push(['Сервер', n.server.replace(/^dbserver:/, '')]);
      const hosts = model.nodes[n.server]?.hosts;
      if (hosts) attrs.push(['Хосты', hosts.map((h) => `${h.fqdn} (${h.role})`).join(', ')]);
    }
    const schema = n.label;
    names.push(['Пользователи', `${schema}_rw, ${schema}_ro, ${schema}_migr`]);
  } else if (n.kind === 'topic') {
    if (n.ownerService) attrs.push(['Публикует', n.ownerService]);
    attrs.push(['Классификация', CLASS_LABEL[n.classification ?? 'open'] ?? n.classification ?? '']);
  } else if (n.kind === 'platform') {
    if (n.endpoint) attrs.push(['Endpoint', n.endpoint]);
    attrs.push(['Расположение', seg?.external ? 'облако / внешний' : 'внутренний']);
  }

  // у БД своих ответственных нет — берём ответственных сервера СУБД
  const server = n.kind === 'database' && n.server ? model.nodes[n.server] : undefined;
  const owners = server && n.owners.length === 0 ? server.owners : n.owners;
  const ownersInherited = server && n.owners.length === 0 ? true : n.ownersInherited;
  const ownersSource: CardData['ownersSource'] = !ownersInherited ? undefined : server ? 'dbserver' : 'product';

  const all: Scope = { kind: 'company', expanded: model.products.map((p) => p.code) };
  return {
    title: n.label, attrs, names, owners, ownersInherited, ownersSource, links: n.links,
    views: viewsWith(model, findings, nodeId, all),
    findings: findings.filter((f) => f.level !== 'attention' && f.nodeIds.includes(nodeId)),
  };
}
