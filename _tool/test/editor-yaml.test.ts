import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readModel } from '../src/model/load.js';
import { newYaml, patchYaml, servicePath, productPath, teamPath } from '../editor/yamlEdit.js';

const demo = readModel('examples/demo').files;
const file = (p: string) => demo[p]!;
const fixtures: Record<string, string> = Object.fromEntries(
  readdirSync('test/fixtures', { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.yaml'))
    .map((p) => [p, readFileSync(join('test/fixtures', p), 'utf8')]),
);

const SERVICE_ORDER = ['name', 'type', 'segment', 'cluster', 'criticality', 'port', 'protocol', 'databases', 'publishes', 'consumes', 'calls', 'uses', 'exports', 'exposure', 'owners', 'links', 'overrides'];
const PRODUCT_ORDER = ['code', 'name', 'criticality', 'nfr', 'owners', 'links', 'entities', 'externals', 'dbservers', 'resources'];

/** Построчный diff (LCS): строки, удалённые из a, и строки, добавленные в b. */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const removed: string[] = [], added: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { i++; j++; } else if (t[i + 1]![j]! >= t[i]![j + 1]!) removed.push(x[i++]!); else added.push(y[j++]!);
  }
  while (i < n) removed.push(x[i++]!);
  while (j < m) added.push(y[j++]!);
  return { removed, added };
}

describe('newYaml', () => {
  it('service crm-orders: round-trips, canonical key order, block list of flow items', () => {
    const data = parse(file('sales/crm/services/orders.yaml'));
    const text = newYaml('service', { ...data, exports: [], overrides: undefined });
    expect(parse(text)).toEqual(data);
    const keys = Object.keys(parse(text));
    expect(keys).toEqual(SERVICE_ORDER.filter((k) => k in data));
    expect(text).not.toContain('[]');
    expect(text).not.toContain('exports');
    expect(text).toContain('uses:\n  - { resource: kafka }\n  - { resource: s3-main, bucket: files, access: rw, entities: [order], purpose: Вложения к заказам }\n');
    expect(text).toContain('owners:\n  - { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" }\n');
  });

  it('orders keys canonically regardless of input order', () => {
    const text = newYaml('service', { owners: [{ role: 'techlead', name: 'X' }], cluster: 'k8s-prod-1', segment: 'app', type: 'worker', name: 'notify' });
    expect(text).toBe('name: notify\ntype: worker\nsegment: app\ncluster: k8s-prod-1\nowners:\n  - { role: techlead, name: X }\n');
  });

  it('product: nested objects go block, flat maps flow, empty arrays omitted', () => {
    const data = parse(file('sales/crm/product.yaml'));
    const text = newYaml('product', data);
    const { externals: _omit, ...rest } = data;
    expect(parse(text)).toEqual(rest);
    expect(Object.keys(parse(text))).toEqual(PRODUCT_ORDER.filter((k) => k in rest));
    expect(text).toContain('nfr: { slo: 99.9% }\n');
    expect(text).toContain('dbservers:\n  - id: pg-crm\n    engine: postgres\n    version: "16"\n');
    expect(text).toContain('    hosts:\n      - { fqdn: pg-crm-01.db.company.ru, role: primary }\n');
  });

  it('team', () => {
    expect(newYaml('team', { links: [], owners: [{ role: 'owner', name: 'И.' }], name: 'Продажи' })).toBe('name: Продажи\nowners:\n  - { role: owner, name: И. }\n');
  });
});

describe('patchYaml', () => {
  const commented = [
    '# главный сервис',
    'name: orders # имя',
    'segment: app',
    'cluster: k8s-prod-1',
    'port: 8080',
    'owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" } ]',
    '',
    '# зависимости',
    'uses:',
    '  - { resource: kafka }',
    '  - {resource: adfs,   purpose: "Проверка токенов"}',
    'exports: [ { channel: cdc, target: dwh } ]',
    'links:',
    '- { kind: api, url: https://x }',
    '',
  ].join('\n');

  it('Review Focus 1: changing only cluster changes exactly one line, comments survive', () => {
    const next = { ...parse(commented), cluster: 'k8s-prod-2' };
    const out = patchYaml(commented, next);
    expect(lineDiff(commented, out)).toEqual({ removed: ['cluster: k8s-prod-1'], added: ['cluster: k8s-prod-2'] });
    expect(out).toContain('# главный сервис\nname: orders # имя\n');
    expect(parse(out)).toEqual(next);
  });

  it('changed scalar keeps a trailing comment and quoting style', () => {
    const out = patchYaml('name: orders # имя\nsegment: "app"\n', { name: 'billing', segment: 'dmz' });
    expect(out).toBe('name: billing # имя\nsegment: "dmz"\n');
  });

  it('adding an item to uses changes only the uses block', () => {
    const before = parse(commented);
    const next = { ...before, uses: [...before.uses, { resource: 's3-main', bucket: 'files', access: 'rw' }] };
    const out = patchYaml(commented, next);
    const head = commented.slice(0, commented.indexOf('uses:'));
    const tail = commented.slice(commented.indexOf('exports:'));
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(parse(out)).toEqual(next);
    const d = lineDiff(commented, out);
    expect([...d.removed, ...d.added].every((l) => l.startsWith('  - '))).toBe(true);
    expect(d.added).toContain('  - { resource: s3-main, bucket: files, access: rw }');
  });

  it('removing exports deletes exactly its lines', () => {
    const { exports: _x, ...next } = parse(commented);
    const out = patchYaml(commented, next);
    expect(out).toBe(commented.replace('exports: [ { channel: cdc, target: dwh } ]\n', ''));
    const billing = file('sales/pay/services/billing.yaml');
    const { exports: _y, ...nb } = parse(billing);
    expect(patchYaml(billing, nb)).toBe(billing.replace('exports: [ { channel: cdc, target: dwh, entities: [payment] } ]\n', ''));
  });

  it('empty array in next removes the key', () => {
    const out = patchYaml(commented, { ...parse(commented), exports: [] });
    expect(out).not.toContain('exports');
  });

  it('a changed flow list stays flow; a block list with "- " at column 0 keeps its indent', () => {
    const before = parse(commented);
    const out = patchYaml(commented, { ...before, owners: [...before.owners, { role: 'owner', name: 'И.' }], links: [{ kind: 'api', url: 'https://y' }] });
    const d = lineDiff(commented, out);
    expect(d.removed).toEqual(['owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" } ]', '- { kind: api, url: https://x }']);
    expect(d.added).toEqual(['owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" }, { role: owner, name: И. } ]', '- { kind: api, url: https://y }']);
  });

  it('a nested scalar change inside a block list of block items changes only that line', () => {
    const src = file('sales/crm/product.yaml');
    const next = parse(src);
    next.dbservers[0].hosts[1].role = 'arbiter';
    const out = patchYaml(src, next);
    expect(lineDiff(src, out)).toEqual({
      removed: ['      - { fqdn: pg-crm-02.db.company.ru, role: replica }'],
      added: ['      - { fqdn: pg-crm-02.db.company.ru, role: arbiter }'],
    });
  });

  it('fills an empty value (`key:`) with a separating space', () => {
    const src = 'name: a\ncluster:\nport:\n';
    const out = patchYaml(src, { name: 'a', cluster: 'x', port: 8080 });
    expect(out).toBe('name: a\ncluster: x\nport: 8080\n');
    expect(patchYaml('cluster:', { cluster: 'x' })).toBe('cluster: x\n');
  });

  it('fills an empty value followed by a comment without merging them', () => {
    const out = patchYaml('name: a\ncluster: # todo\nport: 1\n', { name: 'a', cluster: 'x', port: 1 });
    expect(out).toBe('name: a\ncluster: x # todo\nport: 1\n');
    expect(parse(out).cluster).toBe('x');
  });

  it('a changed block map stays block; diff is limited to the changed line', () => {
    const src = 'code: crm\nname: CRM\nnfr:\n  slo: 99.9%\n  rto: 1h\nowners: [ { role: owner, name: X } ]\n';
    const out = patchYaml(src, { ...parse(src), nfr: { slo: '99.95%', rto: '1h' } });
    expect(lineDiff(src, out)).toEqual({ removed: ['  slo: 99.9%'], added: ['  slo: 99.95%'] });
    const ov = 'name: a\noverrides:\n  port: { value: 1, reason: r }\n  tls:\n    value: true\n    reason: x\n';
    const next = { ...parse(ov), overrides: { port: { value: 2, reason: 'r' }, tls: { value: true, reason: 'x' } } };
    expect(lineDiff(ov, patchYaml(ov, next))).toEqual({ removed: ['  port: { value: 1, reason: r }'], added: ['  port: { value: 2, reason: r }'] });
  });

  it('a changed block scalar is replaced with a valid value', () => {
    const src = 'name: a\nnote: |\n  line1\n  line2\nport: 1\n';
    const out = patchYaml(src, { name: 'a', note: 'другой\nтекст', port: 1 });
    expect(parse(out)).toEqual({ name: 'a', note: 'другой\nтекст', port: 1 });
    expect(lineDiff(src, out)).toEqual({ removed: ['note: |', '  line1', '  line2'], added: ['note: |-', '  другой', '  текст'] });
  });

  it('guard: throws instead of returning a file that does not parse to next', () => {
    // Псевдоним: правка `a` через якорь изменила бы и `b`.
    const src = 'a: &x 1\nb: *x\n';
    expect(() => patchYaml(src, { a: 2, b: 1 })).toThrow(/ключ «b»/);
  });

  it('new keys are inserted in canonical position', () => {
    const src = file('sales/crm/services/notify-worker.yaml');
    const next = { ...parse(src), port: 8081, owners: [{ role: 'techlead', name: 'X' }], criticality: 'low' };
    const out = patchYaml(src, next);
    expect(out).toBe(src
      .replace('cluster: k8s-prod-2\n', 'cluster: k8s-prod-2\ncriticality: low\nport: 8081\n')
      .concat('owners:\n  - { role: techlead, name: X }\n'));
    expect(Object.keys(parse(out))).toEqual(SERVICE_ORDER.filter((k) => k in next));
  });

  it('new key at the end of a file without trailing newline', () => {
    expect(patchYaml('name: a\nsegment: app', { name: 'a', segment: 'app', cluster: 'c' })).toBe('name: a\nsegment: app\ncluster: c\n');
  });

  it('kind задаёт порядок ключей (team), и для файла не-объекта тоже', () => {
    const data = { links: [{ kind: 'wiki', url: 'https://w' }], owners: [{ role: 'owner', name: 'И.' }], name: 'Продажи' };
    expect(patchYaml('', data, 'team')).toBe(newYaml('team', data));
    expect(patchYaml('- x\n', data, 'team')).toBe(newYaml('team', data));
    expect(patchYaml('name: Продажи\n', data, 'team')).toBe('name: Продажи\nowners:\n  - { role: owner, name: И. }\nlinks:\n  - { kind: wiki, url: https://w }\n');
  });

  describe('точечная правка внутри блоков', () => {
    const product = [
      'code: crm',
      'name: CRM',
      'nfr: # почему так',
      '  # доступность',
      '  slo: 99.9%',
      '  rto: 1h # согласовано',
      '  # хвост',
      'owners: [ { role: owner, name: X } ]',
      '',
    ].join('\n');

    it('скаляр во вложенном блочном map: 1 строка, комментарии на месте', () => {
      const next = parse(product);
      next.nfr.slo = '99.95%';
      const out = patchYaml(product, next);
      expect(lineDiff(product, out)).toEqual({ removed: ['  slo: 99.9%'], added: ['  slo: 99.95%'] });
      expect(parse(out)).toEqual(next);
    });

    it('новый и удалённый ключ во вложенном map — только их строки', () => {
      const next = parse(product);
      delete next.nfr.rto;
      next.nfr.rpo = '15m';
      const out = patchYaml(product, next);
      expect(lineDiff(product, out)).toEqual({ removed: ['  rto: 1h # согласовано'], added: ['  rpo: 15m'] });
      expect(out).toContain('nfr: # почему так\n  # доступность\n');
    });

    it('map в map: блочный стиль сохранён', () => {
      const ov = 'name: a\noverrides:\n  # порт\n  port: { value: 1, reason: r }\n  tls:\n    value: true # да\n    reason: x\n';
      const next = parse(ov);
      next.overrides.tls.value = false;
      const out = patchYaml(ov, next);
      expect(lineDiff(ov, out)).toEqual({ removed: ['    value: true # да'], added: ['    value: false # да'] });
    });

    const svc = [
      'name: orders',
      'uses:',
      '  # шина',
      '  - { resource: kafka }',
      '  # файлы',
      '  - { resource: s3-main, bucket: files, access: rw } # вложения',
      '  # токены',
      '  - { resource: adfs, purpose: "Проверка токенов" }',
      'links: [ { kind: api, url: https://x } ]',
      '',
    ].join('\n');

    it('элемент списка правится точечно, комментарии между элементами на месте', () => {
      const next = parse(svc);
      next.uses[1].access = 'ro';
      const out = patchYaml(svc, next);
      expect(lineDiff(svc, out)).toEqual({
        removed: ['  - { resource: s3-main, bucket: files, access: rw } # вложения'],
        added: ['  - { resource: s3-main, bucket: files, access: ro } # вложения'],
      });
    });

    it('добавление в конец списка — только новые строки', () => {
      const next = parse(svc);
      next.uses.push({ resource: 'redis' });
      const out = patchYaml(svc, next);
      expect(lineDiff(svc, out)).toEqual({ removed: [], added: ['  - { resource: redis }'] });
      expect(parse(out)).toEqual(next);
    });

    it('удаление из середины — его строки и его комментарий', () => {
      const next = parse(svc);
      next.uses.splice(1, 1);
      const out = patchYaml(svc, next);
      expect(lineDiff(svc, out)).toEqual({ removed: ['  # файлы', '  - { resource: s3-main, bucket: files, access: rw } # вложения'], added: [] });
    });

    it('добавление в начало и в середину списка', () => {
      const next = parse(svc);
      next.uses.splice(1, 0, { resource: 'redis' });
      next.uses.unshift({ resource: 'pg' });
      const out = patchYaml(svc, next);
      expect(lineDiff(svc, out)).toEqual({ removed: [], added: ['  - { resource: pg }', '  - { resource: redis }'] });
      expect(parse(out)).toEqual(next);
    });

    it('последовательность с отступом 4: отступ сохраняется', () => {
      const src = 'name: a\nuses:\n    - { resource: kafka }\n    - { resource: s3, access: rw }\n';
      const next = parse(src);
      next.uses[1].access = 'ro';
      next.uses.push({ resource: 'redis' });
      const out = patchYaml(src, next);
      expect(lineDiff(src, out)).toEqual({ removed: ['    - { resource: s3, access: rw }'], added: ['    - { resource: s3, access: ro }', '    - { resource: redis }'] });
    });

    it('блочный элемент списка: правка вложенного ключа и добавление нового', () => {
      const src = file('sales/crm/product.yaml');
      const next = parse(src);
      next.dbservers[0].port = 6432;
      next.dbservers[0].hosts.push({ fqdn: 'pg-crm-03.db.company.ru', role: 'replica' });
      const out = patchYaml(src, next);
      expect(lineDiff(src, out)).toEqual({ removed: ['    port: 5432'], added: ['    port: 6432', '      - { fqdn: pg-crm-03.db.company.ru, role: replica }'] });
    });

    it('блочный скаляр | : стиль сохранён, меняются только строки текста', () => {
      const src = 'name: a\ndescription: |\n  Строка 1\n  Строка 2\nport: 1\n';
      const next = { ...parse(src), description: 'Строка 1\nСтрока два\n' };
      const out = patchYaml(src, next);
      expect(lineDiff(src, out)).toEqual({ removed: ['  Строка 2'], added: ['  Строка два'] });
      expect(parse(out)).toEqual(next);
      const folded = 'name: a\nnote: >\n    один\n    два\nport: 1\n';
      const nf = { ...parse(folded), note: 'три\n' };
      const of = patchYaml(folded, nf);
      expect(lineDiff(folded, of)).toEqual({ removed: ['    один', '    два'], added: ['    три'] });
      expect(parse(of)).toEqual(nf);
    });

    it('CRLF: замена, вставка, удаление — только \\r\\n', () => {
      const src = 'name: a\r\nsegment: app\r\nuses:\r\n  - { resource: kafka }\r\n  - { resource: s3 }\r\nexports: [ { channel: cdc, target: dwh } ]\r\n';
      const { exports: _x, ...base } = parse(src);
      const next = { ...base, segment: 'dmz', cluster: 'c1', uses: [{ resource: 'kafka' }, { resource: 's3' }, { resource: 'redis' }] };
      const out = patchYaml(src, next);
      expect(parse(out)).toEqual(next);
      expect(out.replace(/\r\n/g, '')).not.toContain('\n');
      expect(out).toBe('name: a\r\nsegment: dmz\r\ncluster: c1\r\nuses:\r\n  - { resource: kafka }\r\n  - { resource: s3 }\r\n  - { resource: redis }\r\n');
      expect(patchYaml(src, parse(src))).toBe(src);
    });

    it('удаление ключа вместе с комментарием-строкой над ним', () => {
      const src = 'name: a\n# кластер временный\ncluster: c1\nport: 1\n';
      expect(patchYaml(src, { name: 'a', port: 1 })).toBe('name: a\nport: 1\n');
      const nested = 'name: a\nnfr:\n  slo: 1\n  # убрать\n  rto: 2\n';
      expect(patchYaml(nested, { name: 'a', nfr: { slo: 1 } })).toBe('name: a\nnfr:\n  slo: 1\n');
    });

    it('защита: правка рядом с псевдонимом точечна, правка якоря — ошибка (откат на замену целиком тоже не проходит)', () => {
      const src = 'name: a\nbase: &b\n  x: 1\nother:\n  <<: *b\n  y: 2\n';
      const next = JSON.parse(JSON.stringify(parse(src)));
      next.other.y = 3;
      const out = patchYaml(src, next);
      expect(lineDiff(src, out)).toEqual({ removed: ['  y: 2'], added: ['  y: 3'] });
      expect(parse(out)).toEqual(next);
      const next2 = JSON.parse(JSON.stringify(parse(src)));
      next2.base.x = 5;
      expect(() => patchYaml(src, next2)).toThrow(/Правка YAML/);
    });
  });

  it.each(Object.keys(fixtures).filter((p) => p.endsWith('.yaml')))('is idempotent on fixture %s', (p) => {
    const x = fixtures[p]!;
    let data: unknown;
    try { data = parse(x); } catch { return; }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    expect(patchYaml(x, data)).toBe(x);
  });

  it.each(Object.keys(demo).filter((p) => p.endsWith('.yaml')))('is idempotent on demo %s', (p) => {
    const x = file(p);
    expect(patchYaml(x, parse(x))).toBe(x);
  });
});

describe('paths', () => {
  it('servicePath', () => {
    expect(servicePath('sales', 'crm', 'notify', 'worker')).toBe('sales/crm/services/notify-worker.yaml');
    expect(servicePath('sales', 'crm', 'orders', 'ui')).toBe('sales/crm/services/orders-ui.yaml');
    expect(servicePath('sales', 'crm', 'orders', 'backend')).toBe('sales/crm/services/orders.yaml');
    expect(servicePath('sales', 'crm', 'orders', '')).toBe('sales/crm/services/orders.yaml');
  });
  it('productPath / teamPath', () => {
    expect(productPath('sales', 'crm')).toBe('sales/crm/product.yaml');
    expect(teamPath('sales')).toBe('sales/team.yaml');
  });
});
