import type { Finding, Model } from '../model/types.js';

export function checkMeta(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const n of Object.values(model.nodes)) {
    if (n.kind === 'service' && n.ownersInherited) {
      out.push({ rule: 'meta.no-owner', level: 'warning', nodeIds: [n.id], edgeIds: [], file: n.file,
        message: `У сервиса ${n.id} не заданы ответственные (owners), показаны ответственные продукта.` });
    }
  }
  for (const p of model.products) {
    if (!p.owners.some((o) => o.role === 'owner')) {
      out.push({ rule: 'meta.no-owner', level: 'warning', nodeIds: [`product:${p.code}`], edgeIds: [], file: p.file,
        message: `У продукта ${p.code} нет ответственного с ролью owner.` });
    }
  }
  return out;
}
