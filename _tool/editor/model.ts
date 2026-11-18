// Проверка модели в браузере и списки значений для форм. Без Node.
import { loadTreeFromFiles, type FileMap } from '../src/model/loadFiles.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import { deriveNames, platformNames, topicName, type ServiceType } from '../src/model/names.js';
import type { LoadError, RawTree } from '../src/model/raw.js';
import type { Finding, Model } from '../src/model/types.js';

export type { FileMap };

export interface Validation {
  tree: RawTree | null;
  model: Model | null;
  loadErrors: LoadError[];
  findings: Finding[];
  ok: boolean;
}

/** Тот же конвейер, что в CLI: загрузка → разрешение ссылок → проверки. `dirs` — каталоги команд/продуктов (как в CLI). */
export function validateFiles(files: FileMap, dirs?: string[]): Validation {
  const loaded = loadTreeFromFiles(files, '', dirs);
  if (!loaded.tree) return { tree: null, model: null, loadErrors: loaded.errors, findings: [], ok: false };
  const { model, errors } = resolveModel(loaded.tree);
  if (!model) return { tree: loaded.tree, model: null, loadErrors: errors, findings: [], ok: false };
  const findings = runChecks(loaded.tree, model);
  return { tree: loaded.tree, model, loadErrors: [], findings, ok: !findings.some((f) => f.level === 'error') };
}

export interface PickLists {
  segments: { id: string; name: string }[];
  clusters: { id: string; name: string }[];
  dbservers: { id: string; engine: string; segment: string }[];
  resources: { id: string; kind: string; name: string }[];
  actors: { id: string; name: string }[];
  topics: string[];
  services: string[];
  externals: { id: string; name: string; product?: string }[];
  entities: { name: string; product: string; classification: string }[];
  teams: { id: string; name: string }[];
  products: { code: string; name: string; team: string }[];
}

const emptyLists = (): PickLists => ({
  segments: [], clusters: [], dbservers: [], resources: [], actors: [], topics: [], services: [],
  externals: [], entities: [], teams: [], products: [],
});

/**
 * Списки для выпадающих полей. Берутся из дерева (оно есть и при ошибках ссылок, поэтому формы работают
 * и на сломанной модели); когда модель разрешилась, id сервисов и топики берутся из неё.
 */
export function pickLists(v: Validation): PickLists {
  const tree = v.tree;
  if (!tree) return emptyLists();
  const { network, platform } = tree;
  const out = emptyLists();
  out.segments = network.segments.map((s) => ({ id: s.id, name: s.name }));
  out.actors = (network.actors ?? []).map((a) => ({ id: a.id, name: a.name }));
  out.clusters = platform.clusters.map((c) => ({ id: c.id, name: c.name }));
  const dbs = (x: { id: string; engine: string; segment: string }) => ({ id: x.id, engine: x.engine, segment: x.segment });
  out.dbservers = (platform.dbservers ?? []).map(dbs);
  out.resources = (platform.resources ?? []).map((r) => ({ id: r.id, kind: r.kind, name: r.name }));
  out.externals = (platform.externals ?? []).map((x) => ({ id: x.id, name: x.name }));

  const platNames = platformNames(platform);
  const topics = new Set<string>();
  for (const team of tree.teams) {
    out.teams.push({ id: team.dir, name: team.data.name });
    for (const product of team.products) {
      const pd = product.data;
      out.products.push({ code: pd.code, name: pd.name, team: team.dir });
      for (const e of pd.entities ?? []) out.entities.push({ name: e.name, product: pd.code, classification: e.classification });
      for (const x of pd.externals ?? []) out.externals.push({ id: x.id, name: x.name, product: pd.code });
      for (const d of pd.dbservers ?? []) out.dbservers.push(dbs(d));
      for (const r of pd.resources ?? []) out.resources.push({ id: r.id, kind: r.kind, name: r.name });
      for (const { data: svc } of product.services) {
        const type = (svc.type === 'backend' || !svc.type ? '' : svc.type) as ServiceType;
        out.services.push(deriveNames(pd.code, svc.name, type, platNames).id);
        for (const p of svc.publishes ?? []) topics.add(topicName(pd.code, svc.name, p.entity, p.event, p.version));
      }
    }
  }
  if (v.model) {
    out.services = Object.values(v.model.nodes).filter((n) => n.kind === 'service').map((n) => n.id);
    out.topics = Object.values(v.model.nodes).filter((n) => n.kind === 'topic').map((n) => n.label);
  } else {
    out.topics = [...topics];
  }
  return out;
}
