import type { Finding, Model } from '../model/types.js';

export function checkDb(model: Model): Finding[] {
  const out: Finding[] = [];
  const segments = new Map(model.segments.map((s) => [s.id, s]));
  for (const n of Object.values(model.nodes)) {
    if (n.kind === 'database' && n.classification === 'pdn' && !segments.get(n.segment)?.sensitive) {
      out.push({ rule: 'db.pdn-not-sensitive', level: 'warning', nodeIds: [n.id], edgeIds: [], file: n.file,
        message: `Схема ${n.id} содержит ПДн, но сервер ${n.server ?? ''} находится в сегменте ${n.segment} без признака sensitive.` });
    }
  }
  const owners = new Map<string, string>();
  for (const n of Object.values(model.nodes)) {
    if (n.kind !== 'dbserver') continue;
    for (const h of n.hosts ?? []) {
      const prev = owners.get(h.fqdn);
      if (prev !== undefined) {
        out.push({ rule: 'db.duplicate-fqdn', level: 'error', nodeIds: [prev, n.id].filter((x, i, a) => a.indexOf(x) === i), edgeIds: [],
          file: n.file, message: `FQDN ${h.fqdn} указан у нескольких серверов СУБД: ${prev} и ${n.id}.` });
      } else owners.set(h.fqdn, n.id);
    }
  }
  return out;
}
