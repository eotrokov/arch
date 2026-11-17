import type { RawTree } from '../model/raw.js';
import type { Finding, Model } from '../model/types.js';
import { checkNaming } from './naming.js';
import { checkOwnership } from './ownership.js';
import { checkChains } from './chains.js';
import { checkTopics } from './topics.js';
import { checkMeta } from './meta.js';
import { checkDb } from './db.js';
import { checkSecurity } from './security.js';
import { checkAttention } from './attention.js';

export function runChecks(tree: RawTree, model: Model): Finding[] {
  return [
    ...checkNaming(tree), ...checkOwnership(model), ...checkChains(model), ...checkTopics(model),
    ...checkMeta(model), ...checkDb(model), ...checkSecurity(model), ...checkAttention(model),
  ];
}

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.level === 'error');
}
