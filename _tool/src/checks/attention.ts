import type { Finding, Model, ModelEdge } from '../model/types.js';

export function checkAttention(model: Model): Finding[] {
  const out: Finding[] = [];
  const segments = new Map(model.segments.map((s) => [s.id, s]));
  const segmentOf = (id: string): string | undefined =>
    id.startsWith('seg:') ? id.slice(4) : model.nodes[id]?.segment;
  const mark = (rule: string, e: ModelEdge, message: string) =>
    out.push({ rule, level: 'attention', message, nodeIds: [e.from, e.to], edgeIds: [e.id], file: e.file });

  for (const e of model.edges) {
    const fs = segmentOf(e.from);
    const ts = segmentOf(e.to);
    const fromSeg = fs === undefined ? undefined : segments.get(fs);
    const toSeg = ts === undefined ? undefined : segments.get(ts);
    if (toSeg?.external && e.classification !== 'open') {
      mark('attention.egress', e, `Данные класса ${e.classification} уходят во внешний сегмент: ${e.from} → ${e.to}.`);
    }
    if (fromSeg?.external) {
      mark('attention.external', e, `Соединение из внешнего сегмента: ${e.from} → ${e.to}.`);
    }
    if (toSeg?.sensitive && fs !== ts) {
      mark('attention.sensitive', e, `Соединение в чувствительный сегмент ${ts}: ${e.from} → ${e.to}.`);
    }
    const fp = model.nodes[e.from]?.product;
    const tp = model.nodes[e.to]?.product;
    if (fp !== undefined && tp !== undefined && fp !== tp) {
      mark('attention.cross-product', e, `Связь между продуктами ${fp} и ${tp}: ${e.from} → ${e.to}.`);
    }
  }
  return out;
}
