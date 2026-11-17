import type { Finding, Model, ModelEdge } from '../model/types.js';

/** Признак ребра-владения БД (создаётся резолвером для сервиса, объявившего базу). */
export const DB_OWNER_REASON_PREFIX = 'владелец БД';

export function checkOwnership(model: Model): Finding[] {
  const out: Finding[] = [];
  const topicPublishers = new Map<string, ModelEdge[]>();
  const dbOwners = new Map<string, ModelEdge[]>();
  const push = (m: Map<string, ModelEdge[]>, k: string, e: ModelEdge) => m.set(k, [...(m.get(k) ?? []), e]);

  for (const e of model.edges) {
    const from = model.nodes[e.from];
    const to = model.nodes[e.to];
    if (!from || !to) continue;
    if (e.kind === 'db' && from.kind === 'service' && to.kind === 'database') {
      if (e.reason.startsWith(DB_OWNER_REASON_PREFIX)) push(dbOwners, to.id, e);
      if (from.system !== to.system || from.serviceName !== to.serviceName) {
        out.push({ rule: 'a1.foreign-db', level: 'error', nodeIds: [from.id, to.id], edgeIds: [e.id], file: e.file ?? from.file,
          message: `A-1: сервис ${from.id} обращается к БД ${to.id}, принадлежащей сервису ${to.ownerService ?? `${to.system}-${to.serviceName}`}.` });
      }
    }
    if (e.kind === 'use' && e.bucket !== undefined && from.kind === 'service') {
      const prefix = `${from.system}-${from.serviceName}-${model.env}-`;
      if (!e.bucket.startsWith(prefix)) {
        out.push({ rule: 'a1.foreign-bucket', level: 'error', nodeIds: [from.id, to.id], edgeIds: [e.id], file: e.file ?? from.file,
          message: `A-1: сервис ${from.id} использует бакет «${e.bucket}», имя которого не начинается с «${prefix}».` });
      }
    }
    if (e.kind === 'publish' && to.kind === 'topic') push(topicPublishers, to.id, e);
  }

  for (const [topic, list] of topicPublishers) {
    if (list.length > 1) {
      out.push({ rule: 'a2.multiple-owners', level: 'error', nodeIds: [topic, ...list.map((e) => e.from)], edgeIds: list.map((e) => e.id),
        file: list[0]!.file, message: `A-2: топик ${topic} публикуют несколько сервисов: ${list.map((e) => e.from).join(', ')}.` });
    }
  }
  for (const [db, list] of dbOwners) {
    if (list.length > 1) {
      out.push({ rule: 'a2.multiple-owners', level: 'error', nodeIds: [db, ...list.map((e) => e.from)], edgeIds: list.map((e) => e.id),
        file: list[0]!.file, message: `A-2: у БД ${db} несколько владельцев: ${list.map((e) => e.from).join(', ')}.` });
    }
  }
  return out;
}
