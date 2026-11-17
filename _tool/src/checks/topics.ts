import type { Finding, Model } from '../model/types.js';

export function checkTopics(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const t of Object.values(model.nodes)) {
    if (t.kind !== 'topic') continue;
    const pubs = model.edges.filter((e) => e.kind === 'publish' && e.to === t.id);
    const cons = model.edges.filter((e) => e.kind === 'consume' && e.to === t.id);
    if (pubs.length === 0) {
      out.push({ rule: 'topic.no-publisher', level: 'warning', nodeIds: [t.id], edgeIds: [], file: t.file,
        message: `У топика ${t.id} нет публикующего сервиса.` });
    }
    if (cons.length === 0) {
      out.push({ rule: 'topic.no-consumer', level: 'warning', nodeIds: [t.id], edgeIds: [], file: t.file,
        message: `У топика ${t.id} нет потребителей.` });
    }
  }
  return out;
}
