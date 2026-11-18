// Генератор синтетической модели для проверки масштаба.
// Запуск: npx tsx scripts/gen-synthetic.ts --teams 10 --products 30 --services 300 --out /tmp/arch-big [--seed 1]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';

export interface SyntheticOptions { teams: number; products: number; services: number; out: string; seed?: number }

const DB_SERVERS = 5;

/** mulberry32: детерминированный ГПСЧ. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function write(out: string, rel: string, data: unknown): void {
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(data));
}

export function generate(opts: SyntheticOptions): void {
  const { teams, products, services, out } = opts;
  const rand = rng(opts.seed ?? 1);
  const owner = (role: string, n: number) => ({ role, name: `Владелец ${n}`, contact: `@owner${n}` });

  write(out, '_shared/network.yaml', {
    segments: [
      { id: 'external', name: 'Внешняя сеть', external: true },
      { id: 'dmz', name: 'DMZ' },
      { id: 'app', name: 'Сегмент приложений' },
      { id: 'db', name: 'Сегмент БД' },
      { id: 'pdn', name: 'Сегмент ПДн', sensitive: true },
    ],
    actors: [{ id: 'internet', name: 'Интернет', segment: 'external' }],
    connections: [{ from: { segment: 'app' }, to: { segment: 'db' }, port: 5432, protocol: 'tcp', reason: 'Доступ к БД' }],
  });

  const dbservers = Array.from({ length: DB_SERVERS }, (_, i) => ({
    id: `pg-shared-${i + 1}`, engine: 'postgres', version: '16', segment: 'db', port: 5432,
    hosts: [
      { fqdn: `pg-shared-${i + 1}-01.db.company.ru`, role: 'primary' },
      { fqdn: `pg-shared-${i + 1}-02.db.company.ru`, role: 'replica' },
    ],
    owners: [owner('dba', 900 + i)],
  }));
  write(out, '_shared/platform.yaml', {
    env: 'prod', domain: 'company.ru', registry: 'registry.company.ru', git: 'https://gitlab.company.ru',
    clusters: [{ id: 'k8s-prod-1', name: 'Прод-1' }, { id: 'k8s-prod-2', name: 'Прод-2' }],
    resources: [
      { id: 'kafka', kind: 'kafka', name: 'Kafka', segment: 'app', port: 9093, protocol: 'tcp' },
      { id: 'ingress', kind: 'ingress', name: 'Ingress', segment: 'dmz', port: 443, protocol: 'https' },
      { id: 's3-main', kind: 's3', name: 'S3 (MinIO)', segment: 'app', port: 443, protocol: 'https' },
      { id: 'adfs', kind: 'adfs', name: 'ADFS', segment: 'app', port: 443, protocol: 'https' },
      { id: 'smtp-relay', kind: 'smtp', name: 'Почтовый relay', segment: 'app', port: 587, protocol: 'smtp' },
    ],
    externals: [{ id: 'bank', name: 'Банк-партнёр', segment: 'external', port: 443, protocol: 'https' }],
    dbservers,
  });

  // распределяем сервисы по продуктам, продукты по командам (поровну, остаток — первым)
  const perProduct = (p: number) => Math.floor(services / products) + (p < services % products ? 1 : 0);
  const svcName = (_p: number, i: number) => `s${pad(i)}`;
  const isWorker = (i: number) => i % 7 === 3;
  const code = (p: number) => `p${pad(p + 1)}`;
  const idOf = (p: number, i: number) => `${code(p)}-${svcName(p, i)}${isWorker(i) ? '-worker' : ''}`;
  const publishes = (i: number) => i % 3 === 0 && !isWorker(i);
  const entity = (p: number, i: number) => `e${pad(p + 1)}x${pad(i)}`;

  for (let t = 0; t < teams; t++) {
    write(out, `t${pad(t + 1)}/team.yaml`, { name: `Команда ${t + 1}`, owners: [owner('owner', t + 1)] });
  }
  for (let p = 0; p < products; p++) {
    const team = p % teams;
    const n = perProduct(p);
    const base = `t${pad(team + 1)}/${code(p)}`;
    write(out, `${base}/product.yaml`, {
      code: code(p), name: `Продукт ${p + 1}`, criticality: 'business-operational', owners: [owner('owner', 100 + p)],
      entities: Array.from({ length: n }, (_, i) => i).filter(publishes)
        .map((i) => ({ name: entity(p, i), classification: 'open', owner: idOf(p, i) })),
    });
    for (let i = 0; i < n; i++) {
      const svc: Record<string, unknown> = {
        name: svcName(p, i), segment: 'app', cluster: p % 2 === 0 ? 'k8s-prod-1' : 'k8s-prod-2',
      };
      if (isWorker(i)) svc.type = 'worker';
      if (!isWorker(i) && i % 2 === 0) {
        svc.databases = [{ server: `pg-shared-${Math.floor(rand() * DB_SERVERS) + 1}`, classification: 'open' }];
      }
      if (publishes(i)) svc.publishes = [{ entity: entity(p, i), event: 'created', version: 1, broker: 'kafka' }];
      if (isWorker(i)) {
        // потребляет топики всех публикующих сервисов своего продукта
        svc.consumes = Array.from({ length: n }, (_, j) => j).filter(publishes)
          .map((j) => ({ topic: `${code(p)}.${svcName(p, j)}.${entity(p, j)}.created.v1` }));
      }
      const calls: unknown[] = [];
      if (!isWorker(i) && i % 3 === 1 && !isWorker(i - 1)) calls.push({ target: idOf(p, i - 1), protocol: 'http' });
      if (!isWorker(i) && i % 3 === 2 && products > 1) {
        const q = (p + 1 + Math.floor(rand() * (products - 1))) % products;
        if (perProduct(q) > 0) calls.push({ target: idOf(q, 0), protocol: 'http' });
      }
      if (i === 0) calls.push({ target: 'bank', protocol: 'https' });
      if (calls.length > 0) svc.calls = calls;
      const uses: unknown[] = [];
      if (i % 5 === 0) uses.push({ resource: 's3-main', bucket: 'files', access: 'rw' });
      if (i % 4 === 0) uses.push({ resource: 'adfs', purpose: 'Проверка токенов' });
      if (i % 11 === 0) uses.push({ resource: 'smtp-relay', purpose: 'Письма' });
      if (uses.length > 0) svc.uses = uses;
      svc.owners = [owner('techlead', 200 + p)];
      write(out, `${base}/services/${svcName(p, i)}${isWorker(i) ? '-worker' : ''}.yaml`, svc);
    }
  }
}

function arg(argv: string[], name: string, def?: string): string {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : def;
  if (v === undefined) throw new Error(`gen-synthetic: не указан --${name}`);
  return v;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  generate({
    teams: Number(arg(a, 'teams', '10')), products: Number(arg(a, 'products', '30')),
    services: Number(arg(a, 'services', '300')), out: arg(a, 'out'), seed: Number(arg(a, 'seed', '1')),
  });
}
