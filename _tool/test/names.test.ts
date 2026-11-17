import { describe, it, expect } from 'vitest';
import { deriveNames, topicName, bucketName } from '../src/model/names.js';
import { checkNaming } from '../src/checks/naming.js';
import type { RawTree, RawService } from '../src/model/raw.js';

const prod = { env: 'prod', domain: 'company.ru', registry: 'registry.company.ru', git: 'gitlab.company.ru' };

function tree(dir: string, code: string, svc: Partial<RawService> & { name: string }): RawTree {
  const data = { segment: 's', cluster: 'c', ...svc } as RawService;
  return {
    network: { segments: [] }, platform: { ...prod, clusters: [] },
    teams: [{ dir: 't', file: 't/team.yaml', data: { name: 'T' }, products: [
      { dir, file: `t/${dir}/product.yaml`, data: { code, name: 'P' }, services: [{ file: 'svc.yaml', data }] },
    ] }],
  };
}

describe('deriveNames', () => {
  it('backend', () => {
    const d = deriveNames('crm', 'orders', '', prod);
    expect(d).toMatchObject({
      id: 'crm-orders', namespace: 'crm-prod', ingressHost: 'orders.crm.company.ru', tuz: 'svc-crm-orders-prod',
      vaultPath: 'crm/prod/orders', dbSchema: 'crm_orders', consumerGroup: 'crm-orders',
      image: 'registry.company.ru/crm/crm-orders', repoUrl: 'https://gitlab.company.ru/crm/crm-orders',
    });
    expect(d.dbUsers.ro).toBe('crm_orders_ro');
  });
  it('ui and env', () => {
    const d = deriveNames('crm', 'orders', 'ui', prod);
    expect([d.id, d.deployment, d.helm, d.serviceAccount]).toEqual(Array(4).fill('crm-orders-ui'));
    expect(d.ingressHost).toBe('orders.crm.company.ru');
    expect(deriveNames('crm', 'orders', 'ui', { ...prod, env: 'test' }).ingressHost).toBe('orders.crm.test.company.ru');
  });
  it('ui: data names without type, identity names with type', () => {
    const d = deriveNames('crm', 'orders', 'ui', prod);
    expect(d.dbSchema).toBe('crm_orders');
    expect(d.dbUsers.rw).toBe('crm_orders_rw');
    expect(d.tuz).toBe('svc-crm-orders-ui-prod');
    expect(d.vaultPath).toBe('crm/prod/orders-ui');
    expect(d.consumerGroup).toBe('crm-orders-ui');
  });
  it('overrides applied', () => {
    expect(deriveNames('crm', 'orders', '', prod, { namespace: { value: 'x', reason: 'r' } }).namespace).toBe('x');
  });
  it('topic and bucket', () => {
    expect(topicName('crm', 'orders', 'order', 'created', 1)).toBe('crm.orders.order.created.v1');
    expect(topicName('crm', 'orders', 'order', 'created')).toBe('crm.orders.order.created');
    expect(bucketName('crm', 'orders', 'prod', 'files')).toBe('crm-orders-prod-files');
  });
});

describe('checkNaming', () => {
  it('clean', () => expect(checkNaming(tree('crm', 'crm', { name: 'orders' }))).toEqual([]));
  it('underscore', () => {
    const f = checkNaming(tree('crm', 'crm', { name: 'orders_api' }));
    expect(f.map((x) => x.rule)).toContain('naming.pattern');
    expect(f[0]!.nodeIds).toEqual(['crm-orders_api']);
  });
  it('forbidden word', () => {
    expect(checkNaming(tree('crm', 'crm', { name: 'new' })).map((x) => x.rule)).toEqual(['naming.forbidden-word']);
    expect(checkNaming(tree('crm', 'crm', { name: 'renew' }))).toEqual([]);
  });
  it('product dir', () => {
    expect(checkNaming(tree('crm', 'crmx', { name: 'orders' })).map((x) => x.rule)).toEqual(['naming.product-dir']);
  });
  it('product code pattern', () => {
    expect(checkNaming(tree('Crm', 'Crm', { name: 'orders' })).map((x) => x.rule)).toContain('naming.pattern');
  });
  it('override reason', () => {
    const f = checkNaming(tree('crm', 'crm', { name: 'orders', overrides: { namespace: { value: 'x', reason: '' } } }));
    expect(f).toMatchObject([{ rule: 'naming.override-reason', level: 'error', file: 'svc.yaml' }]);
    expect(checkNaming(tree('crm', 'crm', { name: 'orders', overrides: { namespace: { value: 'x', reason: 'ok' } } }))).toEqual([]);
  });
});
