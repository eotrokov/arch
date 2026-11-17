import type { Finding, Model, ModelEdge } from '../model/types.js';

/** Публикация для internet без ресурса kind: waf в цепочке. */
export function checkSecurity(model: Model): Finding[] {
  const out: Finding[] = [];
  const byService = new Map<string, ModelEdge[][]>();
  for (const e of model.edges) {
    if (e.kind !== 'expose' || e.audience !== 'internet' || !e.exposedService) continue;
    const chains = byService.get(e.exposedService) ?? [];
    if (e.from.startsWith('actor:') || chains.length === 0) chains.push([]);
    chains[chains.length - 1]!.push(e);
    byService.set(e.exposedService, chains);
  }
  for (const [service, chains] of byService) {
    for (const chain of chains) {
      const hasWaf = chain.some((e) => [e.from, e.to].some((id) => model.nodes[id]?.resourceKind === 'waf'));
      if (!hasWaf) {
        out.push({ rule: 'security.no-waf', level: 'error', nodeIds: [service], edgeIds: chain.map((e) => e.id),
          file: chain[0]!.file ?? model.nodes[service]?.file,
          message: `Сервис ${service} опубликован в интернет без WAF в цепочке публикации.` });
      }
    }
  }
  return out;
}
