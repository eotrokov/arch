import { describe, it, expect } from 'vitest';
import { readModel } from '../src/model/load.js';
import { validateFiles } from '../editor/model.js';
import {
  STEPS, READONLY_FIELDS, unknownFields, startNew, startEdit, toChange, deleteChange, stepOfFinding, previewNames,
} from '../editor/forms.js';

const demo = readModel('examples/demo').files;
const platform = { env: 'prod', domain: 'example.org', registry: 'reg.example.org', git: 'git.example.org' };
const svcPath = 'sales/crm/services/orders.yaml';

describe('мастер: данные', () => {
  it('правка без изменений идемпотентна', () => {
    const text = demo[svcPath]!;
    const s = startEdit('service', svcPath, text);
    expect(s.team).toBe('sales');
    expect(s.product).toBe('crm');
    const c = toChange(s, 'b1');
    expect(c.content).toBe(text);
    expect(c.baseBlobId).toBe('b1');
    expect(c.label).toBe('Изменение сервиса crm-orders');
  });

  it('новый сервис: путь, подпись, baseBlobId', () => {
    const s = startNew('service', 'sales', 'crm');
    s.data = { name: 'notify', type: 'worker', segment: 'x', cluster: 'y' };
    const c = toChange(s, null);
    expect(c.path).toBe('sales/crm/services/notify-worker.yaml');
    expect(c.label).toBe('Новый сервис crm-notify-worker');
    expect(c.baseBlobId).toBeNull();
    expect(c.content).toContain('name: notify');
  });

  it('команда: id не попадает в данные и в unknownFields', () => {
    const s = startNew('team', 'ops');
    s.data = { id: 'ops', name: 'Ops' };
    const c = toChange(s, null);
    expect(c.path).toBe('ops/team.yaml');
    expect(c.content).not.toContain('id:');
    expect(c.label).toBe('Новая команда ops');
    expect(unknownFields('team', s.data)).toEqual([]);
    const e = startEdit('team', 'sales/team.yaml', demo['sales/team.yaml']!);
    expect(e.team).toBe('sales');
    expect(toChange(e, 'b').content).toBe(demo['sales/team.yaml']);
  });

  it('продукт: путь и подпись; удаление', () => {
    const s = startNew('product', 'sales');
    s.data = { code: 'shop', name: 'Shop' };
    const c = toChange(s, null);
    expect(c.path).toBe('sales/shop/product.yaml');
    expect(c.label).toBe('Новый продукт shop');
    const e = startEdit('product', 'sales/crm/product.yaml', demo['sales/crm/product.yaml']!);
    expect(e.product).toBe('crm');
    expect(deleteChange(svcPath, 'b2', 'crm-orders')).toEqual({ path: svcPath, content: null, baseBlobId: 'b2', label: 'Удаление сервиса crm-orders' });
  });

  it('unknownFields и шаги', () => {
    expect(unknownFields('service', { name: 'x', foo: 1, overrides: {} })).toEqual(['foo']);
    expect(READONLY_FIELDS.product).toEqual(['dbservers', 'resources']);
    expect(STEPS.service.map((x) => x.id)).toEqual(['main', 'place', 'data', 'links', 'publish', 'people', 'review']);
  });

  it('previewNames', () => {
    const s = startNew('service', 'sales', 'crm');
    expect(previewNames(s, platform)).toBeNull();
    s.data = { name: 'notify', type: 'worker' };
    expect(previewNames(s, platform)!.tuz).toBe('svc-crm-notify-worker-prod');
  });
});

describe('мастер: ошибки по шагам', () => {
  const f = (rule: string, file = svcPath) => ({ rule, level: 'error' as const, message: '', nodeIds: [], edgeIds: [], file });
  it('правила проверок', () => {
    const step = (r: string) => stepOfFinding('service', f(r), svcPath);
    expect(step('a1.foreign-db')).toBe('links');
    expect(step('a1.foreign-bucket')).toBe('links');
    expect(step('security.no-waf')).toBe('publish');
    expect(step('meta.no-owner')).toBe('people');
    expect(step('naming.pattern')).toBe('main');
    expect(step('chain.cycle')).toBe('links');
    expect(step('chain.too-long')).toBe('links');
    expect(step('topic.no-consumer')).toBeNull();
    expect(stepOfFinding('service', f('naming.pattern', 'other.yaml'), svcPath)).toBeNull();
  });

  it('ошибки схемы и ссылок', () => {
    const e = (message: string) => stepOfFinding('service', { file: svcPath, message }, svcPath);
    expect(e('Схема: /cluster: должно быть строкой')).toBe('place');
    expect(e('Схема: /segment: обязательное свойство')).toBe('place');
    expect(e('Схема: /calls/0/target: ошибка')).toBe('links');
    expect(e('Схема: /exposure/0: ошибка')).toBe('publish');
    expect(e('Схема: /foo: лишнее')).toBeNull();
    expect(e('Сервис crm-orders: кластер zz не найден в platform.yaml')).toBe('place');
    expect(e('Сервис crm-orders: сегмент zz не найден в network.yaml')).toBe('place');
    expect(e('Сервис crm-orders: databases.server x — сервер СУБД не найден')).toBe('data');
    expect(e('Сервис crm-orders: publishes e.v: сущность q не найдена в каталоге сущностей')).toBe('data');
    expect(e('crm-orders: calls.target x не найден (ни сервис, ни внешняя система)')).toBe('links');
    expect(e('crm-orders: consumes: топик t не найден')).toBe('links');
    expect(e('crm-orders: exports.target x не найден')).toBe('links');
    expect(e('crm-orders: uses.db x — база данных не найдена')).toBe('links');
    expect(e('crm-orders: exposure.audience a — актор не найден в network.yaml')).toBe('publish');
    expect(stepOfFinding('service', { file: 'network.yaml', message: 'Схема: /cluster: x' }, svcPath)).toBeNull();
  });

  it('реальные ошибки загрузки на сломанном сервисе', () => {
    const files = { ...demo, [svcPath]: demo[svcPath]!.replace(/^cluster:.*$/m, 'cluster: nope') };
    const v = validateFiles(files);
    const errs = [...v.loadErrors];
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.map((x) => stepOfFinding('service', x, svcPath))).toContain('place');
  });
});
