import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks, hasErrors } from '../src/checks/index.js';
import { checkOwnership } from '../src/checks/ownership.js';
import { checkChains } from '../src/checks/chains.js';
import { checkTopics } from '../src/checks/topics.js';
import { checkDb } from '../src/checks/db.js';
import { checkSecurity } from '../src/checks/security.js';
import type { Finding, Model } from '../src/model/types.js';
import { makeModel, svc } from './helpers.js';

const rules = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const call = (from: string, to: string) => ({ kind: 'call' as const, from, to });

describe('demo', () => {
  let model: Model;
  let findings: Finding[];
  beforeAll(() => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    const r = resolveModel(tree!);
    expect(r.errors).toEqual([]);
    model = r.model!;
    findings = runChecks(tree!, model);
  });
  const has = (rule: string, from: string, to: string) =>
    findings.some((f) => f.rule === rule && f.edgeIds.some((id) => model.edges.find((e) => e.id === id && e.from === from && e.to === to)));

  it('no errors', () => {
    expect(findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(hasErrors(findings)).toBe(false);
  });
  it('cross-product and sensitive', () => {
    expect(has('attention.cross-product', 'crm-orders', 'pay-billing')).toBe(true);
    expect(has('attention.sensitive', 'crm-orders', 'db:crm_orders')).toBe(true);
  });
  it('attention.external only on internet -> waf', () => {
    const ext = rules(findings, 'attention.external');
    expect(ext).toHaveLength(1);
    expect(ext[0]!.nodeIds).toEqual(['actor:internet', 'platform:waf-main']);
  });
  it('attention.egress', () => {
    expect(has('attention.egress', 'pay-billing', 'platform:ya-s3')).toBe(true);
    expect(has('attention.egress', 'pay-billing', 'platform:ya-disk')).toBe(true);
    expect(has('attention.egress', 'pay-billing', 'ext:bank')).toBe(true);
    expect(has('attention.egress', 'crm-notify-worker', 'platform:ya-messenger')).toBe(false);
  });
  it('exactly one meta.no-owner', () => {
    const f = rules(findings, 'meta.no-owner');
    expect(f).toHaveLength(1);
    expect(f[0]!.nodeIds).toEqual(['crm-notify-worker']);
  });
  it('no waf finding', () => expect(rules(findings, 'security.no-waf')).toEqual([]));
  it('foreign bucket for crm-orders using pay-billing bucket', () => {
    const m: Model = { ...model, edges: model.edges.map((e) =>
      e.kind === 'use' && e.from === 'crm-orders' && e.bucket ? { ...e, bucket: 'pay-billing-prod-archive' } : e) };
    expect(rules(checkOwnership(m), 'a1.foreign-bucket')).toHaveLength(1);
  });
});

describe('a1 / a2', () => {
  const db = { id: 'db:crm_orders', kind: 'database' as const, system: 'crm', serviceName: 'orders', ownerService: 'crm-orders' };
  it('job with migr is own, worker with ro is foreign', () => {
    const m = makeModel({
      services: ['crm-orders', 'crm-orders-job', 'crm-notify-worker'], nodes: [db],
      edges: [{ kind: 'db', from: 'crm-orders-job', to: db.id, role: 'migr' }, { kind: 'db', from: 'crm-notify-worker', to: db.id, role: 'ro' }],
    });
    const f = rules(checkOwnership(m), 'a1.foreign-db');
    expect(f).toHaveLength(1);
    expect(f[0]!.edgeIds).toEqual(['db:crm-notify-worker->db:crm_orders']);
  });
  it('prefix-named services are distinct', () => {
    const d2 = { id: 'db:crm_order_items', kind: 'database' as const, system: 'crm', serviceName: 'order-items', ownerService: 'crm-order-items' };
    const m = makeModel({
      services: ['crm-order', 'crm-order-items'], nodes: [d2],
      edges: [{ kind: 'db', from: 'crm-order', to: d2.id, role: 'ro' }, { kind: 'db', from: 'crm-order-items', to: d2.id, role: 'rw' }],
    });
    const f = rules(checkOwnership(m), 'a1.foreign-db');
    expect(f).toHaveLength(1);
    expect(f[0]!.nodeIds[0]).toBe('crm-order');
  });
  it('bucket prefix includes env', () => {
    const m = makeModel({
      services: ['crm-orders', 'crm-orders-archive'], nodes: [{ id: 'platform:s3', resourceKind: 's3' }],
      edges: [
        { kind: 'use', from: 'crm-orders', to: 'platform:s3', bucket: 'crm-orders-archive-prod-x' },
        { kind: 'use', from: 'crm-orders', to: 'platform:s3', bucket: 'crm-orders-prod-files' },
      ],
    });
    expect(rules(checkOwnership(m), 'a1.foreign-bucket')).toHaveLength(1);
  });
  it('two publishers of a topic', () => {
    const t = { id: 'topic:x', kind: 'topic' as const };
    const m = makeModel({ services: ['a-one', 'b-two'], nodes: [t], edges: [
      { kind: 'publish', from: 'a-one', to: t.id }, { kind: 'publish', from: 'b-two', to: t.id }] });
    expect(rules(checkOwnership(m), 'a2.multiple-owners')).toHaveLength(1);
  });
  it('two owners of a db', () => {
    const m = makeModel({ services: ['a-one', 'a-two'], nodes: [db], edges: [
      { kind: 'db', from: 'a-one', to: db.id, reason: 'владелец БД x' }, { kind: 'db', from: 'a-two', to: db.id, reason: 'владелец БД x' }] });
    expect(rules(checkOwnership(m), 'a2.multiple-owners')).toHaveLength(1);
  });
});

describe('chains', () => {
  const chainModel = (ids: string[], extra: string[] = []) =>
    makeModel({ services: [...new Set([...ids, ...extra])], edges: ids.slice(1).map((to, i) => call(ids[i]!, to)) });
  it('a->b->c is fine', () => expect(checkChains(chainModel(['a-a', 'b-b', 'c-c']))).toEqual([]));
  it('a->b->c->d is too long', () => {
    const f = checkChains(chainModel(['a-a', 'b-b', 'c-c', 'd-d']));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'chain.too-long', nodeIds: ['a-a', 'b-b', 'c-c', 'd-d'] });
  });
  it('ends in external -> fine', () => {
    const m = makeModel({ services: ['a-a', 'b-b', 'c-c'], nodes: [{ id: 'ext:x', kind: 'external' }],
      edges: [call('a-a', 'b-b'), call('b-b', 'c-c'), call('c-c', 'ext:x')] });
    expect(checkChains(m)).toEqual([]);
  });
  it('cycle yields one finding, fast', { timeout: 1000 }, () => {
    const f = checkChains(chainModel(['a-a', 'b-b', 'c-c', 'a-a']));
    expect(f.map((x) => x.rule)).toEqual(['chain.cycle']);
    expect(f[0]!.nodeIds).toEqual(['a-a', 'b-b', 'c-c']);
  });
  it('long chain behind a cycle is still found, cycle edges excluded', () => {
    const m = makeModel({ services: ['a-a', 'b-b', 'c-c', 'd-d', 'e-e'],
      edges: [call('a-a', 'b-b'), call('b-b', 'a-a'), call('b-b', 'c-c'), call('c-c', 'd-d'), call('d-d', 'e-e')] });
    const f = checkChains(m);
    expect(rules(f, 'chain.cycle')).toHaveLength(1);
    expect(rules(f, 'chain.too-long').map((x) => x.nodeIds)).toEqual([['b-b', 'c-c', 'd-d', 'e-e']]);
  });
});

describe('topics', () => {
  it('no consumer / no publisher are warnings', () => {
    const m = makeModel({ services: ['a-one'], nodes: [{ id: 'topic:x', kind: 'topic' }, { id: 'topic:y', kind: 'topic' }],
      edges: [{ kind: 'publish', from: 'a-one', to: 'topic:x' }, { kind: 'consume', from: 'a-one', to: 'topic:y' }] });
    const f = checkTopics(m);
    expect(f.map((x) => [x.rule, x.level, x.nodeIds[0]])).toEqual([
      ['topic.no-consumer', 'warning', 'topic:x'], ['topic.no-publisher', 'warning', 'topic:y']]);
  });
});

describe('security', () => {
  const expose = (audience: string, via: string[]) => {
    const path = [`actor:${audience}`, ...via.map((v) => `platform:${v}`), 'crm-ui'];
    return path.slice(1).map((to, i) => ({ kind: 'expose' as const, from: path[i]!, to, audience, exposedService: 'crm-ui' }));
  };
  const nodes = [{ id: 'platform:ingress', resourceKind: 'ingress' }, { id: 'platform:waf', resourceKind: 'waf' },
    { id: 'actor:internet', kind: 'actor' as const }, { id: 'actor:office', kind: 'actor' as const }];
  it('internet without waf', () => {
    const edges = expose('internet', ['ingress']);
    const f = checkSecurity(makeModel({ services: [svc('crm-ui')], nodes, edges }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'security.no-waf', level: 'error', nodeIds: ['crm-ui'] });
    expect(f[0]!.edgeIds).toHaveLength(2);
  });
  it('internet with waf / office without waf', () => {
    expect(checkSecurity(makeModel({ services: [svc('crm-ui')], nodes, edges: expose('internet', ['waf', 'ingress']) }))).toEqual([]);
    expect(checkSecurity(makeModel({ services: [svc('crm-ui')], nodes, edges: expose('office', ['ingress']) }))).toEqual([]);
  });
});

describe('db', () => {
  it('pdn schema on non-sensitive segment', () => {
    const m = makeModel({ nodes: [{ id: 'db:x', kind: 'database', segment: 'db', classification: 'pdn', server: 'dbserver:pg-shared' },
      { id: 'db:y', kind: 'database', segment: 'pdn', classification: 'pdn' }] });
    const f = checkDb(m);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'db.pdn-not-sensitive', level: 'warning', nodeIds: ['db:x'] });
  });
  it('duplicate fqdn is an error', () => {
    const hosts = [{ fqdn: 'pg.db', role: 'primary' as const }];
    const m = makeModel({ nodes: [{ id: 'dbserver:a', kind: 'dbserver', hosts }, { id: 'dbserver:b', kind: 'dbserver', hosts }] });
    const f = checkDb(m);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'db.duplicate-fqdn', level: 'error' });
  });
});
