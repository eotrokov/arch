import { describe, it, expect, beforeAll } from 'vitest';
import { loadTree } from '../src/model/load.js';
import { resolveModel } from '../src/model/resolve.js';
import { runChecks } from '../src/checks/index.js';
import type { Finding, Model } from '../src/model/types.js';
import { emptyText, parseHash, toHash, type UiState } from '../viewer/state.js';
import { cardData } from '../viewer/panels.js';

describe('hash state', () => {
  const cases: UiState[] = [
    { scope: { kind: 'company', expanded: ['crm', 'pay'] }, view: 'containers' },
    { scope: { kind: 'product', id: 'crm' }, view: 'firewall', selected: 'crm-orders' },
    { scope: { kind: 'service', id: 'crm-orders-ui' }, view: 'kubernetes', selected: 'db:crm_orders' },
  ];
  for (const s of cases) it(`round-trip ${toHash(s)}`, () => expect(parseHash(toHash(s))).toEqual(s));
  it('garbage -> default', () => {
    const d = { scope: { kind: 'company', expanded: [] }, view: 'containers' };
    expect(parseHash('#garbage')).toEqual(d);
    expect(parseHash('')).toEqual(d);
    expect(parseHash('#view=nope&scope=zzz:1')).toEqual(d);
  });
  it('tolerates key order; omits empty exp and undefined sel', () => {
    expect(parseHash('#sel=x&scope=product:crm&view=firewall')).toEqual({ scope: { kind: 'product', id: 'crm' }, view: 'firewall', selected: 'x' });
    expect(toHash({ scope: { kind: 'company', expanded: [] }, view: 'databases' })).toBe('#view=databases&scope=company');
  });
});

describe('cardData (demo)', () => {
  let m: Model;
  let f: Finding[];
  beforeAll(() => {
    const { tree, errors } = loadTree('examples/demo');
    expect(errors).toEqual([]);
    m = resolveModel(tree!).model!;
    f = runChecks(tree!, m);
  });
  it('service names and views', () => {
    const c = cardData(m, f, 'crm-orders');
    expect(c.names).toContainEqual(['namespace', 'crm-prod']);
    expect(c.names).toContainEqual(['ТУЗ', 'svc-crm-orders-prod']);
    expect(c.views).toEqual(['kubernetes', 'containers', 'firewall', 'databases', 'dataflows']);
  });
  it('database', () => {
    const c = cardData(m, f, 'db:crm_orders');
    expect(c.views).toEqual(['containers', 'firewall', 'databases']);
    expect(c.attrs).toContainEqual(['Сервер', 'pg-crm']);
    expect(c.attrs).toContainEqual(['Хосты', 'pg-crm-01.db.company.ru (primary), pg-crm-02.db.company.ru (replica)']);
  });
  it('publication and auth', () => {
    const c = cardData(m, f, 'crm-orders-ui');
    expect(c.attrs).toContainEqual(['Публикация', 'Интернет · клиенты → WAF → Ingress → crm-orders-ui']);
    expect(c.attrs).toContainEqual(['Аутентификация', 'ADFS — Вход пользователей (OIDC)']);
    expect(c.names.some(([k]) => k === 'Ingress')).toBe(true);
  });
  it('inherited owners and links', () => {
    const c = cardData(m, f, 'crm-notify-worker');
    expect(c.ownersInherited).toBe(true);
    expect(c.owners[0]!.name).toBe('Петрова А.');
    expect(c.links[0]!.kind).toBe('repo');
    expect(c.findings.every((x) => x.level !== 'attention')).toBe(true);
  });
  it('database card: approver info, users, owners from dbserver', () => {
    const c = cardData(m, f, 'db:pay_billing');
    expect(c.attrs).toContainEqual(['Владелец', 'pay-billing']);
    expect(c.attrs).toContainEqual(['Классификация', 'КТ']);
    expect(c.names).toContainEqual(['Пользователи', 'pay_billing_rw, pay_billing_ro, pay_billing_migr']);
    expect(c.owners.map((o) => o.name)).toEqual(['Смирнов В.']);
    expect(c.ownersInherited).toBe(true);
    expect(c.ownersSource).toBe('dbserver');
    expect(cardData(m, f, 'db:crm_orders').attrs).toContainEqual(['Классификация', 'ПДн']);
  });
  it('topic card: publisher and classification', () => {
    const c = cardData(m, f, 'topic:crm.orders.order.created.v1');
    expect(c.attrs).toContainEqual(['Публикует', 'crm-orders']);
    expect(c.attrs).toContainEqual(['Классификация', 'ПДн']);
  });
  it('inherited service owners come from the product', () => {
    expect(cardData(m, f, 'crm-notify-worker').ownersSource).toBe('product');
    expect(cardData(m, f, 'crm-orders').ownersSource).toBeUndefined();
  });
  it('product card', () => {
    const c = cardData(m, f, 'product:crm');
    expect(c.ownersInherited).toBe(false);
    expect(c.attrs[0]).toEqual(['Код', 'crm']);
    expect(c.views).toContain('containers');
  });
});

describe('empty-state text', () => {
  const HINT = 'Раскройте продукт (двойной клик) или выберите продукт слева';
  const company = { kind: 'company' as const, expanded: [] };
  it('kubernetes / databases in company scope with collapsed products: hint', () => {
    expect(emptyText('kubernetes', 'Kubernetes', company, ['crm', 'pay'])).toBe(HINT);
    expect(emptyText('databases', 'БД', { kind: 'company', expanded: ['crm'] }, ['crm', 'pay'])).toBe(HINT);
  });
  it('otherwise: no elements', () => {
    expect(emptyText('databases', 'БД', { kind: 'company', expanded: ['crm', 'pay'] }, ['crm', 'pay'])).toBe('В разрезе «БД» для этого охвата нет элементов.');
    expect(emptyText('databases', 'БД', { kind: 'service', id: 'crm-orders-ui' }, ['crm'])).toContain('нет элементов');
    expect(emptyText('containers', 'Контейнеры', company, ['crm'])).toContain('нет элементов');
    expect(emptyText('kubernetes', 'Kubernetes', company, [])).toContain('нет элементов');
  });
});
