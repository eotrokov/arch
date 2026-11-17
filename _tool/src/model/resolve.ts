// Разрешение дерева YAML в единую модель: узлы + рёбра. Два прохода:
// (1) регистрация узлов и сущностей с проверкой дублей, (2) рёбра с разрешением ссылок.
import { dirname, join } from 'node:path';
import { bucketName, deriveNames, topicName, type DerivedNames, type ServiceType } from './names.js';
import type { LoadError, RawEndpointRef, RawProduct, RawService, RawTree } from './raw.js';
import type { Classification, EdgeKind, Link, Model, ModelEdge, ModelNode, Owner } from './types.js';

const CLASS_ORDER: Classification[] = ['open', 'kt', 'pdn'];
const maxClass = (list: Classification[]): Classification =>
  list.reduce<Classification>((a, b) => (CLASS_ORDER.indexOf(b) > CLASS_ORDER.indexOf(a) ? b : a), 'open');

interface Ctx {
  product: RawProduct;
  team: string;
  file: string;
  svc: RawService;
  node: ModelNode;
}

export function resolveModel(tree: RawTree): { model: Model | null; errors: LoadError[] } {
  const errors: LoadError[] = [];
  const err = (file: string, message: string) => errors.push({ file, message });

  const firstTeamFile = tree.teams[0]?.file;
  const sharedDir = firstTeamFile ? join(dirname(dirname(firstTeamFile)), '_shared') : '_shared';
  const platformFile = join(sharedDir, 'platform.yaml');
  const networkFile = join(sharedDir, 'network.yaml');

  const platform = tree.platform;
  const env = platform.env ?? 'prod';
  const gitHost = platform.git.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const platformNames = { env, domain: platform.domain, registry: platform.registry, git: gitHost };

  const nodes: Record<string, ModelNode> = {};
  const edges: ModelEdge[] = [];
  const edgeIds = new Set<string>();
  let duplicates = false;

  const register = (node: ModelNode): boolean => {
    const prev = nodes[node.id];
    if (prev) {
      duplicates = true;
      err(node.file ?? '', `Дубликат идентификатора ${node.id}: ${prev.file ?? '?'} и ${node.file ?? '?'}`);
      return false;
    }
    nodes[node.id] = node;
    return true;
  };
  const addEdge = (e: Omit<ModelEdge, 'id'>) => {
    const base = `${e.kind}:${e.from}->${e.to}`;
    let id = base;
    for (let i = 2; edgeIds.has(id); i++) id = `${base}#${i}`;
    edgeIds.add(id);
    edges.push({ ...e, id });
  };

  // ---------- сегменты, кластеры ----------
  const segmentIds = new Set(tree.network.segments.map((s) => s.id));
  const clusterIds = new Set(platform.clusters.map((c) => c.id));
  const checkSegment = (seg: string, file: string, what: string) => {
    if (!segmentIds.has(seg)) err(file, `${what}: сегмент ${seg} не найден в network.yaml`);
  };

  // ---------- команды и продукты ----------
  const teams: Model['teams'] = [];
  const products: Model['products'] = [];
  const productFiles = new Map<string, string>();
  const entities: Model['entities'] = {};
  const entityFiles = new Map<string, string>();

  for (const team of tree.teams) {
    teams.push({
      id: team.dir, name: team.data.name, owners: team.data.owners ?? [], links: team.data.links ?? [],
      products: team.products.map((p) => p.data.code),
    });
    for (const product of team.products) {
      const code = product.data.code;
      const prevFile = productFiles.get(code);
      if (prevFile) {
        duplicates = true;
        err(product.file, `Дубликат кода продукта ${code}: ${prevFile} и ${product.file}`);
      } else productFiles.set(code, product.file);
      products.push({
        code, name: product.data.name, team: team.dir, criticality: product.data.criticality, nfr: product.data.nfr,
        owners: product.data.owners ?? [], links: product.data.links ?? [],
      });
      for (const en of product.data.entities ?? []) {
        const prev = entityFiles.get(en.name);
        if (prev) {
          duplicates = true;
          err(product.file, `Дубликат сущности ${en.name}: ${prev} и ${product.file}`);
        } else {
          entityFiles.set(en.name, product.file);
          entities[en.name] = { product: code, classification: en.classification, owner: en.owner };
        }
      }
    }
  }

  // ---------- проход 1: узлы ----------
  const noOwners = { owners: [] as Owner[], ownersInherited: false, links: [] as Link[] };

  for (const a of tree.network.actors ?? []) {
    checkSegment(a.segment, networkFile, `Актор ${a.id}`);
    register({ id: `actor:${a.id}`, kind: 'actor', label: a.name, segment: a.segment, ...noOwners, file: networkFile });
  }

  const resources = new Map<string, ModelNode>();
  const externals = new Map<string, { node: ModelNode; product?: string }>();
  const dbservers = new Map<string, ModelNode>();
  const fqdns = new Map<string, string>();

  const addResource = (r: NonNullable<RawTree['platform']['resources']>[number], file: string) => {
    checkSegment(r.segment, file, `Ресурс ${r.id}`);
    const node: ModelNode = {
      id: `platform:${r.id}`, kind: 'platform', label: r.name, segment: r.segment, port: r.port, protocol: r.protocol,
      resourceKind: r.kind, endpoint: r.endpoint, owners: r.owners ?? [], ownersInherited: false, links: r.links ?? [], file,
    };
    if (register(node)) resources.set(r.id, node);
  };
  const addExternal = (x: NonNullable<RawTree['platform']['externals']>[number], file: string, product?: string) => {
    checkSegment(x.segment, file, `Внешняя система ${x.id}`);
    const node: ModelNode = {
      id: `ext:${x.id}`, kind: 'external', label: x.name, segment: x.segment, port: x.port, protocol: x.protocol,
      product, ...noOwners, file,
    };
    if (register(node)) externals.set(x.id, { node, product });
  };
  const addDbServer = (d: NonNullable<RawTree['platform']['dbservers']>[number], file: string) => {
    checkSegment(d.segment, file, `Сервер СУБД ${d.id}`);
    for (const h of d.hosts) {
      const prev = fqdns.get(h.fqdn);
      if (prev) {
        duplicates = true;
        err(file, `Дубликат FQDN ${h.fqdn}: ${prev} и ${file}`);
      } else fqdns.set(h.fqdn, file);
    }
    const node: ModelNode = {
      id: `dbserver:${d.id}`, kind: 'dbserver', label: d.id, segment: d.segment, port: d.port, protocol: 'tcp',
      engine: d.engine, version: d.version, endpoint: d.endpoint, hosts: d.hosts,
      owners: d.owners ?? [], ownersInherited: false, links: d.links ?? [], file,
    };
    if (register(node)) dbservers.set(d.id, node);
  };

  for (const r of platform.resources ?? []) addResource(r, platformFile);
  for (const x of platform.externals ?? []) addExternal(x, platformFile);
  for (const d of platform.dbservers ?? []) addDbServer(d, platformFile);

  const ctxs: Ctx[] = [];
  const serviceById = new Map<string, ModelNode>();

  for (const team of tree.teams) {
    for (const product of team.products) {
      const pd = product.data;
      for (const r of pd.resources ?? []) addResource(r, product.file);
      for (const x of pd.externals ?? []) addExternal(x, product.file, pd.code);
      for (const d of pd.dbservers ?? []) addDbServer(d, product.file);
    }
  }

  for (const team of tree.teams) {
    for (const product of team.products) {
      const pd = product.data;
      for (const { file, data: svc } of product.services) {
        const type = (svc.type === 'backend' || !svc.type ? '' : svc.type) as ServiceType;
        const names: DerivedNames = deriveNames(pd.code, svc.name, type, platformNames, svc.overrides as never);
        checkSegment(svc.segment, file, `Сервис ${names.id}`);
        if (!clusterIds.has(svc.cluster)) err(file, `Сервис ${names.id}: кластер ${svc.cluster} не найден в platform.yaml`);
        const own = svc.owners && svc.owners.length > 0;
        const links: Link[] = [...(svc.links ?? [])];
        const repoLink: Link = { kind: 'repo', url: names.repoUrl, title: names.id };
        const explicitRepo = links.filter((l) => l.kind === 'repo');
        const finalLinks = explicitRepo.length > 0
          ? [...explicitRepo, ...links.filter((l) => l.kind !== 'repo')]
          : [repoLink, ...links];
        const published = (svc.exposure ?? []).some((x) => x.via.some((v) => resources.get(v)?.resourceKind === 'ingress'));
        const node: ModelNode = {
          id: names.id, kind: 'service', label: names.id, segment: svc.segment, team: team.dir, product: pd.code,
          system: pd.code, serviceName: svc.name, cluster: svc.cluster, serviceType: type,
          port: svc.port ?? 8080, protocol: svc.protocol ?? 'http', names, published,
          owners: own ? svc.owners! : (pd.owners ?? []), ownersInherited: !own, links: finalLinks, file,
        };
        if (!register(node)) continue;
        serviceById.set(names.id, node);
        ctxs.push({ product, team: team.dir, file, svc, node });
      }
    }
  }

  // базы и топики (владелец известен после регистрации сервисов)
  const defaultBroker = [...resources.values()].find((r) => r.resourceKind === 'kafka');
  const topicNodes = new Map<string, ModelNode>();
  const topicEntity = new Map<string, string>();
  const dbOwnerEdges: { ctx: Ctx; db: ModelNode; server: ModelNode }[] = [];
  const publishEdges: { ctx: Ctx; topic: ModelNode; entity: string; broker: ModelNode }[] = [];

  for (const ctx of ctxs) {
    const { node, svc, file } = ctx;
    for (const d of svc.databases ?? []) {
      const server = dbservers.get(d.server);
      if (!server) {
        err(file, `Сервис ${node.id}: databases.server ${d.server} — сервер СУБД не найден`);
        continue;
      }
      const schema = d.schema ?? node.names!.dbSchema;
      const db: ModelNode = {
        id: `db:${schema}`, kind: 'database', label: schema, segment: server.segment, team: node.team, product: node.product,
        system: node.system, serviceName: node.serviceName, ownerService: node.id, port: server.port, protocol: server.protocol,
        server: server.id, classification: (d.classification as Classification | undefined) ?? 'open', ...noOwners, file,
      };
      if (register(db)) dbOwnerEdges.push({ ctx, db, server });
    }
    for (const p of svc.publishes ?? []) {
      const broker = p.broker ? resources.get(p.broker) : defaultBroker;
      if (!broker) {
        err(file, `Сервис ${node.id}: publishes ${p.entity}.${p.event}: брокер ${p.broker ?? '(по умолчанию)'} не найден`);
        continue;
      }
      if (p.broker && broker.resourceKind !== 'kafka') {
        err(file, `Сервис ${node.id}: publishes: ресурс ${p.broker} не брокер (kind: ${broker.resourceKind})`);
        continue;
      }
      const ent = entities[p.entity];
      if (!ent) err(file, `Сервис ${node.id}: publishes: сущность ${p.entity} не найдена в каталоге сущностей`);
      const name = topicName(node.system!, node.serviceName!, p.entity, p.event, p.version);
      const topic: ModelNode = {
        id: `topic:${name}`, kind: 'topic', label: name, segment: broker.segment, team: node.team, product: node.product,
        system: node.system, serviceName: node.serviceName, ownerService: node.id, port: broker.port, protocol: broker.protocol,
        classification: ent?.classification ?? 'open', ...noOwners, file,
      };
      if (register(topic)) {
        topicNodes.set(name, topic);
        topicEntity.set(topic.id, p.entity);
        publishEdges.push({ ctx, topic, entity: p.entity, broker });
      }
    }
  }

  // ---------- проход 2: рёбра ----------
  if (duplicates) return { model: null, errors };

  const entityClass = (entList: string[], file: string, ctxLabel: string): Classification => {
    const cls: Classification[] = [];
    for (const e of entList) {
      const ent = entities[e];
      if (!ent) err(file, `${ctxLabel}: сущность ${e} не найдена в каталоге сущностей`);
      else cls.push(ent.classification);
    }
    return maxClass(cls);
  };

  for (const [name, ent] of Object.entries(entities)) {
    if (!serviceById.has(ent.owner)) {
      err(entityFiles.get(name) ?? '', `Сущность ${name}: владелец ${ent.owner} — сервис не найден`);
    }
  }

  const resolveTarget = (ctx: Ctx, target: string): ModelNode | undefined => {
    const svc = serviceById.get(target);
    if (svc) return svc;
    const ext = externals.get(target);
    if (ext && (ext.product === undefined || ext.product === ctx.product.data.code)) return ext.node;
    return undefined;
  };

  for (const { ctx, db, server } of dbOwnerEdges) {
    addEdge({
      kind: 'db', from: ctx.node.id, to: db.id, port: server.port, protocol: server.protocol, entities: [],
      classification: db.classification!, role: 'rw', reason: `владелец БД ${db.label}`, file: ctx.file,
    });
  }
  for (const { ctx, topic, entity, broker } of publishEdges) {
    addEdge({
      kind: 'publish', from: ctx.node.id, to: topic.id, port: broker.port, protocol: broker.protocol, entities: [entity],
      classification: topic.classification!, channel: 'topic', reason: `publish ${ctx.node.id} → ${topic.label}`, file: ctx.file,
    });
  }

  for (const ctx of ctxs) {
    const { node, svc, file } = ctx;
    const label = `Сервис ${node.id}`;

    for (const c of svc.calls ?? []) {
      const to = resolveTarget(ctx, c.target);
      if (!to) {
        err(file, `${label}: calls.target ${c.target} не найден (ни сервис, ни внешняя система)`);
        continue;
      }
      const ents = c.entities ?? [];
      addEdge({
        kind: 'call', from: node.id, to: to.id, port: c.port ?? to.port, protocol: c.protocol ?? to.protocol, entities: ents,
        classification: entityClass(ents, file, `${label}: calls`), channel: 'api', reason: `call ${node.id} → ${to.id}`, file,
      });
    }

    for (const c of svc.consumes ?? []) {
      const topic = nodes[`topic:${c.topic}`];
      if (!topic || topic.kind !== 'topic') {
        err(file, `${label}: consumes: топик ${c.topic} не найден`);
        continue;
      }
      const ent = topicEntity.get(topic.id);
      addEdge({
        kind: 'consume', from: node.id, to: topic.id, port: topic.port, protocol: topic.protocol, entities: ent ? [ent] : [],
        classification: topic.classification ?? 'open', channel: 'topic', reason: `consume ${node.id} ← ${topic.label}`, file,
      });
    }

    for (const x of svc.exports ?? []) {
      const to = resolveTarget(ctx, x.target);
      if (!to) {
        err(file, `${label}: exports.target ${x.target} не найден (ни сервис, ни внешняя система)`);
        continue;
      }
      const ents = x.entities ?? [];
      addEdge({
        kind: 'export', from: node.id, to: to.id, port: to.port, protocol: to.protocol, entities: ents,
        classification: entityClass(ents, file, `${label}: exports`), channel: x.channel as ModelEdge['channel'],
        reason: `export ${node.id} → ${to.id}`, file,
      });
    }

    for (const u of svc.uses ?? []) {
      if ('db' in u) {
        const db = nodes[`db:${u.db}`];
        if (!db || db.kind !== 'database') {
          err(file, `${label}: uses.db ${u.db} — база данных не найдена`);
          continue;
        }
        addEdge({
          kind: 'db', from: node.id, to: db.id, port: db.port, protocol: db.protocol, entities: [],
          classification: db.classification ?? 'open', role: u.role as ModelEdge['role'],
          reason: `доступ ${node.id} → ${db.label} (${u.role})`, file,
        });
        continue;
      }
      const res = resources.get(u.resource);
      if (!res) {
        err(file, `${label}: uses.resource ${u.resource} — ресурс платформы не найден`);
        continue;
      }
      const ents = u.entities ?? [];
      const classification = entityClass(ents, file, `${label}: uses ${u.resource}`);
      const e: Omit<ModelEdge, 'id'> = {
        kind: 'use', from: node.id, to: res.id, port: res.port, protocol: res.protocol, entities: ents, classification,
        reason: u.purpose ?? `use ${node.id} → ${res.id}`, purpose: u.purpose, file,
      };
      if ('bucket' in u) {
        if (res.resourceKind !== 's3') {
          err(file, `${label}: uses.bucket: ресурс ${u.resource} не kind: s3 (kind: ${res.resourceKind})`);
          continue;
        }
        e.bucket = bucketName(node.system!, node.serviceName!, env, u.bucket);
        e.access = u.access as 'ro' | 'rw';
      }
      addEdge(e);
    }

    for (const ex of svc.exposure ?? []) {
      const actor = nodes[`actor:${ex.audience}`];
      if (!actor) err(file, `${label}: exposure.audience ${ex.audience} — актор не найден в network.yaml`);
      const chain: ModelNode[] = [];
      let ok = !!actor;
      for (const v of ex.via) {
        const r = resources.get(v);
        if (!r) {
          err(file, `${label}: exposure.via ${v} — ресурс платформы не найден`);
          ok = false;
        } else chain.push(r);
      }
      if (!ok) continue;
      const path = [actor!, ...chain, node];
      for (let i = 0; i < path.length - 1; i++) {
        const to = path[i + 1]!;
        addEdge({
          kind: 'expose', from: path[i]!.id, to: to.id, port: to.port, protocol: to.protocol, entities: [], classification: 'open',
          reason: `публикация ${node.id} для ${ex.audience}`, exposedService: node.id, audience: ex.audience, file,
        });
      }
    }
  }

  for (const c of tree.network.connections ?? []) {
    const ends = [c.from, c.to].map((ref: RawEndpointRef) => {
      if (ref.segment !== undefined) {
        if (!segmentIds.has(ref.segment)) err(networkFile, `Связь ${c.reason}: сегмент ${ref.segment} не найден`);
        return `seg:${ref.segment}`;
      }
      const n = ref.node ?? '';
      if (!nodes[n]) err(networkFile, `Связь ${c.reason}: узел ${n} не найден`);
      return n;
    });
    addEdge({
      kind: 'explicit' as EdgeKind, from: ends[0]!, to: ends[1]!, port: c.port, protocol: c.protocol, entities: [],
      classification: 'open', reason: c.reason, file: networkFile,
    });
  }

  if (errors.length > 0) return { model: null, errors };

  return {
    model: {
      env, domain: platform.domain, registry: platform.registry,
      segments: tree.network.segments.map((s) => ({ id: s.id, name: s.name, external: !!s.external, sensitive: !!s.sensitive })),
      clusters: platform.clusters.map((c) => ({ id: c.id, name: c.name })),
      teams, products, entities, nodes, edges,
    },
    errors,
  };
}
