# Система архитектурных схем по разрезам — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI `arch-views`, который читает YAML-модель из `arch/` (команда → продукт → сервис), проверяет её по регламенту и выдаёт один офлайн-HTML с пятью переключаемыми разрезами плюс Mermaid-экспорт разрезов «контейнеры» и «фаервол».

**Architecture:** Ядро на TypeScript: загрузка и JSON Schema-валидация дерева → разрешение в единую модель (узлы + связи) → проверки → проекция охвата → построение разреза (`ViewGraph`). Те же функции разрезов бандлятся в просмотрщик (Cytoscape.js + ELK), который получает модель и находки встроенным JSON и строит разрезы в браузере по требованию. Mermaid-экспорт строится из тех же `ViewGraph`.

**Tech Stack:** Node.js 22 LTS, TypeScript 5 (strict, ESM), `yaml`, `ajv` (+`ajv-formats`), `commander`, `esbuild`, `cytoscape@3.30.2`, `elkjs@0.9.3`, `cytoscape-elk@2.2.0` (версии проверены на прототипе), `vitest`, `puppeteer-core` (смоук-тесты в установленном Chrome, браузер не скачивается).

**Spec:** `arch/_docs/specs/2026-11-17-arch-views-design.md`

**Без git:** проект не под git, коммитов нет. Исполнитель задачи в отчёте перечисляет все созданные и изменённые файлы; ревьюер читает именно их.

## Global Constraints

- Все файлы инструмента — в `arch/_tool/`; документы — в `arch/_docs/`; вывод по умолчанию — `arch/_dist/`. Каталоги `arch/` с префиксом `_` не являются командами.
- Окружение одно: `prod` (параметр `env` в `platform.yaml`, по умолчанию `prod`).
- Имя репозитория/идентификатор сервиса: `<system>-<service>[-<type>]`, регулярка `^[a-z][a-z0-9-]{1,40}[a-z0-9]$`; код продукта `^[a-z][a-z0-9]{1,9}$`; запрещённые слова в `<service>`: `service`, `app`, `project`, `new`, `test`, `final`, `v2`.
- Типы сервиса: *нет* (backend), `ui`, `worker`, `job`, `gw`.
- Порты по умолчанию: сервис 8080 / `http`; БД — порт её сервера СУБД; ресурс платформы — его `port`.
- Классификации: `open` < `kt` < `pdn`; классификация потока — максимум по сущностям.
- Цепочка синхронных вызовов: не более 3 внутренних сервисов; внешние системы и ресурсы платформы не считаются.
- `index.html` самодостаточен: никаких внешних URL (CDN, шрифты) — JS, CSS и данные встроены. Шрифты только системные (`system-ui`, `ui-monospace`), Google Fonts не подключать.
- Код, который попадает в браузер, не импортирует модули Node (`fs`, `path`, `url`, `process` и т. п.): `src/model/types.ts`, `src/model/names.ts`, `src/views/**`, `viewer/**`. Загрузка с диска — только в `src/model/load.ts`, `src/build/**`, `src/cli.ts`.
- Принадлежность (A-1 для БД и бакетов, владелец топика) определяется по полям `system` и `serviceName` узла, **никогда** не разбором строки id по дефисам: имя сервиса может содержать дефис (`crm-order-items`).
- В стилях Cytoscape не использовать устаревшие `width: 'label'` / `height: 'label'`; размер узла — по `label` через функцию или фиксированные размеры с `text-max-width`.
- Тексты UI и сообщений проверок — на русском.
- Коды выхода CLI: `0` — нет ошибок; `1` — ошибки правил (HTML/Mermaid при `build` всё равно созданы); `2` — ошибки загрузки/схемы/ссылок (вывод не создаётся).

## Review Focus

1. Пустой `arch/` (нет команд) или продукт без `services/` — `build` проходит с кодом 0, разрезы пустые, ничего не падает. (Task 1, Task 11)
2. Битый YAML — ошибка с путём файла и номером строки, код 2, не стек-трейс. (Task 1)
3. Цикл синхронных вызовов — проверка цепочек завершается и сообщает цикл один раз, а не зависает и не дублирует. (Task 4)
4. Два продукта с одинаковым кодом в разных командах / два сервиса с одинаковым id — ошибка с обоими файлами. (Task 3)
5. `crm-orders-job` с `role: migr` на `crm_orders` — не нарушение A-1 (тот же `<system>-<service>`), а `crm-notify-worker` с `ro` на `crm_orders` — нарушение. (Task 4)
6. Сервисы с дефисом в имени (`crm-order-items` рядом с `crm-order`): A-1 по БД и бакетам не путает владельцев. (Task 4)
7. Публикация в интернет без WAF — ошибка; публикация одного сервиса не появляется в охвате другого продукта. (Task 4, Task 5)
8. Ни в одном разрезе ни при каком охвате нет ребра или `parent`, ссылающегося на отсутствующий узел (на прототипе это роняло всю отрисовку). (Task 7)
9. Модель на сотни сервисов: сборка и раскладка укладываются в бюджет. (Task 11)

---

## Структура файлов

```
arch/_tool/
├── package.json  tsconfig.json  vitest.config.ts  README.md
├── src/
│   ├── model/
│   │   ├── raw.ts          # типы сырых YAML-файлов (RawTree и пр.)
│   │   ├── schemas.ts      # JSON Schema для 5 видов файлов (network, platform, team, product, service)
│   │   ├── load.ts         # обход дерева, парсинг, валидация схемой
│   │   ├── names.ts        # выведение имён по регламенту
│   │   ├── types.ts        # Model, ModelNode, ModelEdge, Finding
│   │   └── resolve.ts      # RawTree → Model + ошибки ссылок
│   ├── checks/
│   │   ├── naming.ts  ownership.ts  chains.ts  topics.ts  meta.ts  db.ts  security.ts  attention.ts
│   │   └── index.ts        # runChecks
│   ├── views/
│   │   ├── types.ts        # Scope, ViewKind, ViewGraph, FirewallRow
│   │   ├── scope.ts        # проекция охвата
│   │   ├── containers.ts  kubernetes.ts  databases.ts  firewall.ts  dataflows.ts
│   │   └── index.ts        # buildView
│   ├── export/mermaid.ts
│   ├── build/html.ts       # бандл просмотрщика + встраивание
│   └── cli.ts
├── viewer/
│   ├── main.ts  state.ts  render.ts  panels.ts  styles.css
├── scripts/gen-synthetic.ts  # генератор большой модели для проверки масштаба
├── examples/demo/          # демо-модель (она же основная фикстура)
└── test/                   # *.test.ts, fixtures/, e2e/
```

---

### Task 1: Каркас, схемы и загрузка дерева

**Files:**
- Create: `arch/_tool/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `arch/_tool/src/model/raw.ts`, `schemas.ts`, `load.ts`
- Create: `arch/_tool/examples/demo/**` (демо-модель, см. ниже)
- Create: `arch/_tool/test/fixtures/{empty,bad-yaml,bad-schema,underscore,bad-link,bad-dbserver}/**`
- Test: `arch/_tool/test/load.test.ts`

**Interfaces:**
- Produces:
  - `interface LoadError { file: string; line?: number; message: string }`
  - `interface RawTree { network: RawNetwork; platform: RawPlatform; teams: RawTeam[] }`, где `RawTeam { dir: string; file: string; data: {...}; products: RawProduct[] }`, `RawProduct { dir: string; file: string; data: {...}; services: { file: string; data: RawService }[] }`
  - `loadTree(root: string): { tree: RawTree | null; errors: LoadError[] }` — `tree === null`, если есть хотя бы одна ошибка.

Поля YAML (схемы в `schemas.ts`, `additionalProperties: false`). Обязательность и значения по умолчанию:

| Файл / объект | Обязательные | Необязательные (по умолчанию) |
|---|---|---|
| `network.yaml` | `segments[]` (`id`, `name`) | `segments[].external` (false), `.sensitive` (false), `.description`; `actors[]` (`id`, `name`, `segment` — все обязательны); `connections[]` (`from`, `to`, `port`, `protocol`, `reason` — все обязательны) |
| `platform.yaml` | `domain`, `registry`, `git`, `clusters[]` (`id`, `name`) | `env` (`prod`); `resources[]` (обязательны `id`, `kind`, `name`, `segment`, `port`, `protocol`; необяз. `endpoint`, `owners`, `links`); `externals[]` (обяз. `id`, `name`, `segment`, `port`, `protocol`); `dbservers[]` (обяз. `id`, `engine`, `segment`, `port`, `hosts` ≥1 с `fqdn`, `role`; необяз. `version`, `endpoint`, `owners`, `links`) |
| `team.yaml` | `name` | `owners` ([]), `links` ([]) |
| `product.yaml` | `code`, `name` | `criticality`, `nfr`, `owners`, `links`, `entities[]` (все поля обяз.), `externals[]`, `dbservers[]`, `resources[]` — форматы как в `platform.yaml` |
| `services/*.yaml` | `name`, `segment`, `cluster` | `type` (backend), `port` (8080), `protocol` (`http`), `criticality`, `databases`, `publishes`, `consumes`, `calls`, `uses`, `exports`, `exposure`, `owners`, `links`, `overrides` |

`uses[]` — `oneOf` из трёх форм: `{resource, purpose?, entities?}`; `{resource, bucket, access, purpose?, entities?}` (только для `kind: s3`, проверяется при разрешении); `{db, role}`. `owners[]`: обяз. `role`, `name`; `links[]`: обяз. `kind`, `url` (`^https?://`). `exposure[]`: обяз. `audience`, `via` (≥1).

Демо-модель — каноничный пример формата:

```yaml
# _shared/network.yaml
segments:
  - { id: external, name: Внешняя сеть, external: true }
  - { id: dmz, name: DMZ }
  - { id: app, name: Сегмент приложений }
  - { id: db, name: Сегмент БД }
  - { id: pdn, name: Сегмент ПДн, sensitive: true }
  - { id: mgmt, name: Управление }
  - { id: office, name: Офисная сеть }
actors:                 # источники входящего трафика для публикаций
  - { id: internet, name: Интернет · клиенты, segment: external }
  - { id: office, name: Сотрудники, segment: office }
connections:            # явные соединения: from/to — {segment} или {node}
  - { from: {segment: mgmt}, to: {segment: app}, port: 9100, protocol: tcp, reason: Мониторинг }

# _shared/platform.yaml
env: prod
domain: company.ru
registry: registry.company.ru
git: https://gitlab.company.ru
clusters: [ { id: k8s-prod-1, name: Прод-1 }, { id: k8s-prod-2, name: Прод-2 } ]
resources:              # kind: kafka|ingress|waf|adfs|vault|s3|smtp|yandex-disk|yandex-messenger|other; облачные — в сегменте external
  - { id: kafka, kind: kafka, name: Kafka, endpoint: kafka.company.ru, segment: app, port: 9093, protocol: tcp }
  - { id: ingress, kind: ingress, name: Ingress, endpoint: ingress.company.ru, segment: dmz, port: 443, protocol: https }
  - { id: s3-main, kind: s3, name: S3 (MinIO), endpoint: s3.company.ru, segment: app, port: 443, protocol: https }
  - { id: ya-s3, kind: s3, name: Yandex Object Storage, endpoint: storage.yandexcloud.net, segment: external, port: 443, protocol: https }
  - { id: smtp-relay, kind: smtp, name: Почтовый relay, endpoint: smtp.company.ru, segment: app, port: 587, protocol: smtp }
  - { id: ya-disk, kind: yandex-disk, name: Яндекс Диск, endpoint: cloud-api.yandex.net, segment: external, port: 443, protocol: https }
  - { id: ya-messenger, kind: yandex-messenger, name: Яндекс Мессенджер, endpoint: botapi.messenger.yandex.net, segment: external, port: 443, protocol: https }
  - { id: waf-main, kind: waf, name: WAF, endpoint: waf.company.ru, segment: dmz, port: 443, protocol: https }
  - { id: adfs, kind: adfs, name: ADFS, endpoint: adfs.company.ru, segment: app, port: 443, protocol: https }
externals:
  - { id: bank, name: Банк-партнёр, segment: external, port: 443, protocol: https }
dbservers:              # общие серверы СУБД; выделенные — в product.yaml, тот же формат
  - id: pg-shared
    engine: postgres
    version: "16"
    segment: db
    port: 5432
    hosts:              # role: primary|replica|arbiter; только FQDN
      - { fqdn: pg-shared-01.db.company.ru, role: primary }
      - { fqdn: pg-shared-02.db.company.ru, role: replica }
      - { fqdn: pg-shared-03.db.company.ru, role: replica }
    owners: [ { role: dba, name: Смирнов В., contact: "@smirnov" } ]

# sales/team.yaml
name: Продажи
owners: [ { role: owner, name: Иванов И., contact: "@ivanov" } ]
links: [ { kind: wiki, url: https://wiki.company.ru/sales } ]

# sales/crm/product.yaml
code: crm
name: CRM
criticality: business-critical   # mission-critical|business-critical|business-operational|office
nfr: { slo: "99.9%" }            # свободный объект
owners:                          # role: owner|techlead|architect|analyst|devops|security|oncall|<строка>
  - { role: owner, name: Петрова А., contact: petrova@company.ru }
  - { role: architect, name: Сидоров П., contact: "@sidorov" }
links:                           # kind: repo|docs|api|adr|wiki|tracker|dashboard|alerts|runbook|ci|other; url — только http(s)
  - { kind: docs, url: https://wiki.company.ru/crm/architecture }
  - { kind: tracker, url: https://jira.company.ru/projects/CRM }
entities:
  - { name: order, classification: pdn, owner: crm-orders }
externals: []
dbservers:
  - id: pg-crm
    engine: postgres
    version: "16"
    segment: pdn
    port: 5432
    endpoint: pg-crm.db.company.ru
    hosts:
      - { fqdn: pg-crm-01.db.company.ru, role: primary }
      - { fqdn: pg-crm-02.db.company.ru, role: replica }

# sales/crm/services/orders.yaml
name: orders
segment: app
cluster: k8s-prod-1
port: 8080
protocol: http
databases: [ { server: pg-crm, classification: pdn } ]   # схема по умолчанию crm_orders; сегмент и порт — с сервера
publishes: [ { entity: order, event: created, version: 1, broker: kafka } ]
calls: [ { target: pay-billing, protocol: grpc, entities: [order] } ]
uses:
  - { resource: kafka }
  - { resource: s3-main, bucket: files, access: rw, entities: [order], purpose: Вложения к заказам }   # → бакет crm-orders-prod-files
  - { resource: adfs, purpose: Проверка токенов (JWKS) }
owners: [ { role: techlead, name: Кузнецов Д., contact: "@kuznetsov" } ]
links:                           # repo выводится сам: <git>/<system>/<repo>
  - { kind: api, url: https://gitlab.company.ru/crm/crm-orders/-/blob/main/api/openapi.yaml }
  - { kind: dashboard, title: Grafana, url: https://grafana.company.ru/d/crm-orders }
# overrides: { namespace: { value: crm-legacy, reason: "..." } }
```

У `crm-notify-worker` нет `owners` (для проверки наследования и `meta.no-owner`). Остальные демо-сервисы: `crm-orders-ui` (`type: ui`, dmz, вызывает `crm-orders`, `uses: [{resource: adfs, purpose: Вход пользователей (OIDC)}]`, `exposure: [{audience: internet, via: [waf-main, ingress]}]`), `crm-notify-worker` (`type: worker`, `k8s-prod-2`, `consumes: [{topic: crm.orders.order.created.v1}]`, `uses: [{resource: smtp-relay, entities: [order], purpose: Письма клиентам}, {resource: ya-messenger, purpose: Алерты дежурным}]`), `crm-orders-job` (`type: job`, `uses: [{db: crm_orders, role: migr}]`), `pay-billing` (продукт `sales/pay`, порт 9090 grpc, БД на `pg-shared` (`classification: kt`), сущность `payment: kt`, `calls: [{target: bank, entities: [payment]}]`, `exports: [{channel: cdc, target: dwh, entities: [payment]}]`, `uses: [{resource: ya-s3, bucket: archive, access: rw, entities: [payment]}, {resource: ya-disk, entities: [payment], purpose: Выгрузка отчётов}]`, `exposure: [{audience: office, via: [ingress]}]`; `dwh` — внешняя система в `pay/product.yaml`, сегмент `db`, порт 5432).

- [ ] **Step 1: Write the failing tests** (`test/load.test.ts`)
  - `loads demo tree`: `loadTree('examples/demo')` → `errors` пуст; 1 команда `sales`; продукты `crm` (4 сервиса) и `pay` (1).
  - `skips underscore dirs`: фикстура `fixtures/underscore` с каталогами `_tool/`, `_docs/`, `_dist/` (внутри — произвольные файлы, в т. ч. невалидный YAML) → `errors` пуст, `teams.length === 0`.
  - `empty model`: `fixtures/empty` (только `_shared/*.yaml`) → `errors` пуст, `teams.length === 0`.
  - `bad yaml has file and line`: `fixtures/bad-yaml` → одна ошибка, `file` оканчивается на `services/orders.yaml`, `line === 3`, `tree === null`.
  - `link url must be http(s)`: фикстура `fixtures/bad-link` (`url: ftp://x`) → ошибка схемы с `links`.
  - `dbserver without hosts`: фикстура `fixtures/bad-dbserver` (`hosts: []`) → ошибка схемы с `hosts`.
  - `schema error names field`: `fixtures/bad-schema` (сервис без `cluster`) → `message` содержит `cluster`.
  - `uses forms`: `uses: [{resource: x, db: y}]` (смесь форм) → ошибка схемы; каждая из трёх правильных форм проходит.
  - `defaults`: сервис без `port`/`protocol`/`type` загружается без ошибок (значения по умолчанию применяются в Task 3).
  - `product without services dir`: продукт без `services/` → `services: []`, без ошибки.
- [ ] **Step 2:** `cd arch/_tool && npx vitest run test/load.test.ts` — FAIL (`loadTree` не определён).
- [ ] **Step 3: Implement `loadTree` в `src/model/load.ts`** — `yaml.parseDocument`, позиция ошибки через `doc.errors[0].linePos`; ajv с `allErrors`, сообщение `"<instancePath>: <message>"` на русском префиксе «Схема:». Отсутствие `_shared/network.yaml` или `platform.yaml` — ошибка.
- [ ] **Step 4:** тот же запуск — PASS. Плюс `npx tsc --noEmit` — без ошибок.

---

### Task 2: Выведение имён и проверка наименований

**Files:**
- Create: `arch/_tool/src/model/names.ts`, `arch/_tool/src/checks/naming.ts`, `arch/_tool/src/model/types.ts` (пока только `Finding`)
- Test: `arch/_tool/test/names.test.ts`

**Interfaces:**
- Consumes: `RawTree`, `RawService` (Task 1).
- Produces:
  - `type ServiceType = '' | 'ui' | 'worker' | 'job' | 'gw'`
  - `interface DerivedNames { id; repo; deployment; helm; serviceAccount; namespace; ingressHost; tuz; vaultPath; dbSchema; dbUsers: { rw; ro; migr }; consumerGroup; image; repoUrl }` (все `string`)
  - `deriveNames(system: string, service: string, type: ServiceType, platform: { env: string; domain: string; registry: string; git: string }, overrides?: Record<string, { value: string; reason?: string }>): DerivedNames`
  - `topicName(system: string, service: string, entity: string, event: string, version?: number): string`
  - `bucketName(system: string, service: string, env: string, purpose: string): string`
  - `checkNaming(tree: RawTree): Finding[]`; `Finding` объявляется здесь в `src/model/types.ts` в форме, указанной в Task 3.

- [ ] **Step 1: Write the failing tests**
  - `deriveNames('crm','orders','',prod)` → `id: 'crm-orders'`, `namespace: 'crm-prod'`, `ingressHost: 'orders.crm.company.ru'`, `tuz: 'svc-crm-orders-prod'`, `vaultPath: 'crm/prod/orders'`, `dbSchema: 'crm_orders'`, `dbUsers.ro: 'crm_orders_ro'`, `consumerGroup: 'crm-orders'`, `image: 'registry.company.ru/crm/crm-orders'`, `repoUrl: 'https://gitlab.company.ru/crm/crm-orders'`.
  - `type ui` → `id/deployment/helm/serviceAccount: 'crm-orders-ui'`, `ingressHost: 'orders.crm.company.ru'` (prod — без env); при `env: 'test'` → `'orders.crm.test.company.ru'`. Имя хоста выводится всегда; показывается ли он, решает публикация (`exposure` через ресурс `kind: ingress`), а не тип сервиса.
  - `topicName('crm','orders','order','created',1)` → `'crm.orders.order.created.v1'`; без версии — без `.v`.
  - `bucketName('crm','orders','prod','files')` → `'crm-orders-prod-files'`.
  - override `namespace` с `reason` → применён; без `reason` → `checkNaming` даёт `error` `rule: 'naming.override-reason'`.
  - `checkNaming`: имя сервиса `orders_api` → `naming.pattern`; `name: new` → `naming.forbidden-word`; каталог продукта `crm`, `code: crmx` → `naming.product-dir`; код `Crm` → `naming.pattern`.
- [ ] **Step 2:** `npx vitest run test/names.test.ts` — FAIL.
- [ ] **Step 3: Implement** `deriveNames`, `topicName`, `bucketName`, `checkNaming` по таблице 2.4 регламента (spec 5.3). `names.ts` не импортирует модули Node.
- [ ] **Step 4:** PASS.

---

### Task 3: Разрешение в единую модель

**Files:**
- Create: `arch/_tool/src/model/resolve.ts`; Modify: `arch/_tool/src/model/types.ts`
- Test: `arch/_tool/test/resolve.test.ts`, фикстуры `test/fixtures/{dup-product,dup-service,bad-ref}/**`

**Interfaces:**
- Consumes: `RawTree`, `loadTree` (Task 1); `deriveNames`, `topicName` (Task 2).
- Produces (`types.ts`):
  - `type Classification = 'open' | 'kt' | 'pdn'`
  - `type NodeKind = 'service' | 'database' | 'dbserver' | 'topic' | 'platform' | 'external' | 'actor'`
  - `interface ModelNode { id: string; kind: NodeKind; label: string; segment: string; team?: string; product?: string; system?: string; serviceName?: string; ownerService?: string; cluster?: string; serviceType?: ServiceType; port?: number; protocol?: string; classification?: Classification; names?: DerivedNames; owners: Owner[]; ownersInherited: boolean; links: Link[]; file?: string }`
  - Для `platform`: `resourceKind: string`, `endpoint?: string`. Для `use`-рёбер в `ModelEdge` добавляются необязательные `bucket?: string` (полное имя), `access?: 'ro' | 'rw'`, `purpose?: string`. Для `expose`-рёбер — `exposedService: string` (id опубликованного сервиса) и `audience: string`; порт/протокол шага — порт/протокол узла-назначения.
  - Для `database`: `server: string` (id узла `dbserver:<id>`); для `dbserver`: `engine; version?; endpoint?: string; hosts: { fqdn: string; role: 'primary' | 'replica' | 'arbiter' }[]` (поля добавляются в `ModelNode` как необязательные).
  - `interface Owner { role: string; name: string; contact?: string }`, `interface Link { kind: string; url: string; title?: string }`
  - `type EdgeKind = 'call' | 'publish' | 'consume' | 'db' | 'use' | 'export' | 'explicit' | 'expose'`
  - `interface ModelEdge { id: string; kind: EdgeKind; from: string; to: string; port?: number; protocol?: string; entities: string[]; classification: Classification; role?: 'rw' | 'ro' | 'migr'; channel?: 'api' | 'topic' | 'cdc' | 'batch'; reason: string; file?: string }` — для `explicit` `from/to` может быть `seg:<id>`.
  - `interface Model { env; domain; registry: string; segments: { id; name; external: boolean; sensitive: boolean }[]; clusters: { id; name }[]; teams: { id; name; owners: Owner[]; links: Link[]; products: string[] }[]; products: { code; name; team; criticality?; nfr?; owners: Owner[]; links: Link[] }[]; entities: Record<string, { product: string; classification: Classification; owner: string }>; nodes: Record<string, ModelNode>; edges: ModelEdge[] }`
  - `interface Finding { rule: string; level: 'error' | 'warning' | 'attention'; message: string; nodeIds: string[]; edgeIds: string[]; file?: string }`
  - `resolveModel(tree: RawTree): { model: Model | null; errors: LoadError[] }`

Правила id: сервис — `DerivedNames.id`; БД — `db:<schema>`; сервер СУБД — `dbserver:<id>` (id уникальны глобально, FQDN хостов тоже); у сервиса — `published: boolean` (есть `exposure`, в `via` которого есть ресурс `kind: ingress`); топик — `topic:<name>`; ресурс — `platform:<id>`; внешняя — `ext:<id>` (уникальны глобально); актор — `actor:<id>`. Цель `calls`/`exports`: сначала сервис по полному имени, затем внешняя система продукта, затем общая. Связи: владение БД — `db`-ребро `rw` от владельца; `publish` — сервис → топик; `consume` — сервис → топик (направление подключения к брокеру; направление данных хранится в `kind`); топик — узел в сегменте и с портом брокера. Ребро сервис→топик несёт `port/protocol` брокера.

- [ ] **Step 1: Write the failing tests**
  - у сервисов заполнены `system` и `serviceName` (`crm-orders-job` → `system 'crm'`, `serviceName 'orders'`); у БД и топиков `ownerService` — id сервиса-владельца.
  - публикация через ingress: у `crm-orders-ui` и `pay-billing` есть признак `published: true` и `names.ingressHost`; у `crm-orders` — `published: false`.
  - demo: узлы `crm-orders`, `crm-orders-ui`, `crm-notify-worker`, `crm-orders-job`, `pay-billing`, `db:crm_orders`, `db:pay_billing`, `topic:crm.orders.order.created.v1`, `platform:kafka`, `ext:bank`, `ext:dwh`.
  - ребро `crm-orders → pay-billing`: `kind 'call'`, `port 9090` (порт цели), `protocol 'grpc'`, `classification 'pdn'` (сущность `order`).
  - ребро `crm-orders → db:crm_orders`: `kind 'db'`, `role 'rw'`, `port 5432`; узел БД в сегменте `pdn`, `server 'dbserver:pg-crm'`; `db:pay_billing.segment === 'db'` (с `pg-shared`).
  - узел `dbserver:pg-crm`: `hosts.length 2`, `endpoint 'pg-crm.db.company.ru'`.
  - публикация `crm-orders-ui`: три `expose`-ребра `actor:internet → platform:waf-main → platform:ingress → crm-orders-ui`, у всех `exposedService 'crm-orders-ui'`, `audience 'internet'`; порты `443`, `443`, `8080`.
  - ребро `crm-orders → platform:s3-main`: `kind 'use'`, `bucket 'crm-orders-prod-files'`, `access 'rw'`, `port 443`, `classification 'pdn'`; ребро `crm-notify-worker → platform:ya-messenger`: `entities []`, `classification 'open'`.
  - ребро `crm-notify-worker → topic:...`: `kind 'consume'`, `port 9093`, `classification 'pdn'`.
  - ребро `pay-billing → ext:dwh`: `kind 'export'`, `channel 'cdc'`, `classification 'kt'`.
  - `crm-orders.links` начинается с `{kind:'repo', url:'https://gitlab.company.ru/crm/crm-orders'}` (выведена), далее `api`, `dashboard`; явная `kind: repo` в YAML заменяет выведенную.
  - `crm-notify-worker.owners` = владельцы продукта `crm`, `ownersInherited: true`; у `crm-orders` — `ownersInherited: false`.
  - `explicit` из `network.yaml`: `from 'seg:mgmt'`, `to 'seg:app'`, `port 9100`, `reason 'Мониторинг'`.
  - `dup-product` (код `crm` в двух командах) → ошибка, `message` содержит оба пути файлов.
  - `dup-service` → аналогично для id `crm-orders`.
  - `bad-ref`: `uses.resource: nope`, `uses` с `bucket` на ресурс не `kind: s3`, `exposure.via: [nope]`, `exposure.audience: nope`, `databases.server: pg-nope`, `calls.target: crm-nope`, `segment: nope`, `cluster: nope`, `consumes` несуществующего топика, сущность не из каталога → по ошибке на каждую ссылку, с файлом; `model === null`.
- [ ] **Step 2:** `npx vitest run test/resolve.test.ts` — FAIL.
- [ ] **Step 3: Implement `resolveModel`** в два прохода: (1) регистрация всех узлов и сущностей с проверкой дублей, (2) рёбра с разрешением ссылок.
- [ ] **Step 4:** PASS.

---

### Task 4: Проверки правил

**Files:**
- Create: `arch/_tool/src/checks/{ownership,chains,topics,meta,db,security,attention,index}.ts`
- Test: `arch/_tool/test/checks.test.ts` (модели собираются в тесте хелпером `makeModel({ services, edges })` в `test/helpers.ts`)

**Interfaces:**
- Consumes: `Model`, `Finding` (Task 3); `checkNaming` (Task 2).
- Produces: `runChecks(tree: RawTree, model: Model): Finding[]` — порядок: naming, ownership, chains, topics, meta, db, security, attention; `hasErrors(findings: Finding[]): boolean`.

Правила (`rule`): `a1.foreign-db` — `db`-ребро от сервиса, у которого пара (`system`, `serviceName`) не совпадает с парой сервиса-владельца БД (тип не учитывается: `crm-orders-job` — свой); `a2.multiple-owners` — у топика >1 `publish` или у БД >1 владельца; `chain.too-long` — путь по `call`-рёбрам между узлами `kind 'service'` из ≥4 сервисов (одна находка на самый длинный путь от каждого начала, `nodeIds` = путь); `chain.cycle` — цикл (одна находка на цикл, нормализованный по минимальному id); `topic.no-publisher`, `topic.no-consumer` — `warning`; `meta.no-owner` — `warning` для сервиса без своих `owners` и продукта без `role: owner`; `db.pdn-not-sensitive` — `warning`, если схема с `pdn` на сервере в сегменте без `sensitive`; `db.duplicate-fqdn` — `error`; `a1.foreign-bucket` — `error`, если полное имя бакета не начинается с `<system>-<serviceName>-<env>-` сервиса (с env, чтобы `crm-orders` не считался владельцем `crm-orders-archive-prod-x`); `attention.egress` — `attention` на ребро в сегмент с `external`, несущее `pdn` или `kt`; `security.no-waf` — `error`, если у публикации с `audience: internet` в цепочке нет ресурса `kind: waf` (`nodeIds` = [сервис], `edgeIds` = рёбра публикации); `attention.external` (из сегмента с `external`), `attention.sensitive` (в сегмент с `sensitive`), `attention.cross-product` — `attention`, по ребру.

- [ ] **Step 1: Write the failing tests**
  - demo → нет `error`; есть `attention.cross-product` на `crm-orders → pay-billing`; есть `attention.sensitive` на `crm-orders → db:crm_orders`; нет `attention.external` (исходящее `pay-billing → ext:bank` не помечается — правило только для соединений **из** внешнего сегмента).
  - `crm-orders-job` с `migr` на `crm_orders` → нет `a1.foreign-db`; `crm-notify-worker` с `ro` на `crm_orders` → ровно одна `a1.foreign-db`, `edgeIds` = это ребро.
  - цепочка `a→b→c` → нет находки; `a→b→c→d` → одна `chain.too-long`, `nodeIds ['a','b','c','d']`; `a→b→c→ext:x` → нет.
  - цикл `a→b→c→a` → ровно одна `chain.cycle`; тест завершается < 1 с (vitest `timeout: 1000`); `chain.too-long` для цикла не генерируется бесконечно.
  - сервисы `crm-order` и `crm-order-items`: `crm-order` с `ro` на `crm_order_items` → `a1.foreign-db`; `crm-order-items` на свою БД → нет; `crm-orders` с бакетом `crm-orders-archive-prod-x` (сервис `crm-orders-archive` существует) → `a1.foreign-bucket`.
  - два сервиса публикуют один топик → `a2.multiple-owners`.
  - топик без потребителей → `topic.no-consumer`, `level 'warning'`.
  - demo → ровно одна `meta.no-owner`, `nodeIds ['crm-notify-worker']`.
  - demo → `attention.egress` на `pay-billing → platform:ya-s3` и `pay-billing → platform:ya-disk` (kt), нет на `crm-notify-worker → platform:ya-messenger` (без сущностей); `uses: {resource: s3-main, bucket: pay-billing-prod-archive}` у `crm-orders` → `a1.foreign-bucket`.
  - demo → нет `security.no-waf`; `exposure: [{audience: internet, via: [ingress]}]` → одна `security.no-waf`; `audience: office` без WAF → нет.
  - схема `pdn` на `pg-shared` (сегмент `db`) → `db.pdn-not-sensitive`; один FQDN у двух серверов → `db.duplicate-fqdn`.
- [ ] **Step 2:** `npx vitest run test/checks.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Цепочки: сначала Tarjan SCC для циклов; длинные пути — DFS по графу, где рёбра внутри SCC размера >1 исключены.
- [ ] **Step 4:** PASS.

---

### Task 5: Охват

**Files:**
- Create: `arch/_tool/src/views/types.ts`, `arch/_tool/src/views/scope.ts`
- Test: `arch/_tool/test/scope.test.ts`

**Interfaces:**
- Consumes: `Model` (Task 3).
- Produces:
  - `type Scope = { kind: 'company'; expanded: string[] } | { kind: 'team' | 'product' | 'service'; id: string }`
  - `type ViewKind = 'kubernetes' | 'containers' | 'firewall' | 'databases' | 'dataflows'`
  - `interface Projection { visible(nodeId: string): { id: string; muted: boolean; collapsed: boolean } | null }`
  - `project(model: Model, scope: Scope, opts?: { collapseBySegment?: boolean }): Projection`
  - `interface ViewNode { id: string; label: string; kind: string; parent?: string; muted?: boolean; collapsed?: boolean; classes: string[]; modelId?: string }`
  - `interface ViewEdge { id: string; from: string; to: string; label: string; classes: string[]; modelEdgeIds: string[] }`
  - `interface FirewallRow { fromNode; fromSegment; toNode; toSegment; toHosts: string[]; port: string; protocol: string; reason: string; intraSegment: boolean; attention: string[] }`
  - `interface ViewGraph { nodes: ViewNode[]; edges: ViewEdge[]; table?: FirewallRow[] }`

Семантика: в охвате — узлы продукта/команды/сервиса и их БД/топики (по `ownerService`/`product`); соседи на один шаг — `muted`, свёрнуты в `product:<code>` (или `product:<code>@<segment>` при `collapseBySegment`); ресурсы платформы и внешние — не сворачиваются, `muted`. `company`: каждый продукт → `product:<code>`, кроме перечисленных в `expanded`. `service`: только сервис и прямые соседи, соседи не сворачиваются. `expose`-рёбра не делают узлы соседями; все узлы публикации сервиса, который в охвате и не `muted`, видимы (`muted`, не свёрнуты); публикации сервисов вне охвата не показываются.

- [ ] **Step 1: Write the failing tests** (demo)
  - `{kind:'product', id:'crm'}`: `visible('crm-orders')` → `{id:'crm-orders', muted:false}`; `visible('pay-billing')` → `{id:'product:pay', muted:true, collapsed:true}`; `visible('ext:dwh')` → `null` (не сосед crm).
  - то же с `collapseBySegment` → `pay-billing` → `'product:pay@app'`.
  - `{kind:'company', expanded:[]}` → `crm-orders` → `'product:crm'`; с `expanded:['crm']` → `'crm-orders'`.
  - `{kind:'service', id:'crm-orders-ui'}` → `crm-orders` виден, `muted:true`, не свёрнут; `pay-billing` → `null`.
  - `{kind:'team', id:'sales'}` → все сервисы demo не `muted`.
  - `{kind:'product', id:'crm'}`: `actor:internet` и `platform:waf-main` видимы (`muted`); `actor:office` → `null` (публикация `pay-billing`).
- [ ] **Step 2–4:** FAIL → implement `project` → PASS (`npx vitest run test/scope.test.ts`).

---

### Task 6: Разрезы «контейнеры», «Kubernetes», «БД»

**Files:**
- Create: `arch/_tool/src/views/{containers,kubernetes,databases,index}.ts`
- Test: `arch/_tool/test/views-basic.test.ts`

**Interfaces:**
- Consumes: `Model`, `Finding`, `project`, `ViewGraph` (Tasks 3–5).
- Produces: `containersView(m, f, s)`, `kubernetesView(m, f, s)`, `databasesView(m, f, s)` — все `(model: Model, findings: Finding[], scope: Scope) => ViewGraph`; `buildView(model, findings, scope, view: ViewKind): ViewGraph` (диспетчер; `firewall`/`dataflows` подключаются в Task 7).

Общие правила: рёбра агрегируются по паре видимых id (дубли склеиваются, `modelEdgeIds` объединяются); петли после сворачивания отбрасываются; классы: `violation` — если ребро/узел в `error`-находке, `warning`, `attention-*`, `muted`, `cls-<classification>`.

В охвате `company` у свёрнутых `product:<code>` во всех разрезах, кроме фаервола и Kubernetes, `parent = 'frame:team:<id>'` (группировка по командам, spec §8).

- [ ] **Step 1: Write the failing tests** (demo, охват `product:crm`)
  - containers, охват `company`: `product:crm.parent === 'frame:team:sales'`.
  - containers: узлы-рамки `frame:product:crm`; `crm-orders.parent === 'frame:product:crm'`; ребро `crm-orders-ui → crm-orders` с `label 'http'`; ребро в `product:pay` с `label 'grpc'`.
  - kubernetes: рамки `cluster:k8s-prod-1 > ns:k8s-prod-1/crm-prod` и `cluster:k8s-prod-2 > ns:k8s-prod-2/crm-prod`; узел `crm-orders-job` имеет класс `cronjob`, остальные `deployment`; узел `ingress:orders.crm.company.ru` есть (публикация `crm-orders-ui`), узла ingress для `crm-orders` нет; в охвате `product:pay` есть `ingress:billing.pay.company.ru` (backend, опубликован для сотрудников); у каждого — подпись с `serviceAccount`.
  - databases: рамка `dbserver:pg-crm` (подпись содержит `postgres 16` и `pg-crm.db.company.ru`) содержит дочерние узлы `host:pg-crm-01.db.company.ru` (класс `primary`), `host:pg-crm-02...` (класс `replica`) и рамку `db:crm_orders`, а та — `user:crm_orders_rw|ro|migr`; ребро `crm-orders-job → user:crm_orders_migr`; в модели с чужим доступом (хелпер из Task 4) класс `violation` есть только у ребра чужого доступа — у узлов хостов и пользователей его нет.
  - пустая модель (`fixtures/empty`) → все три разреза возвращают `{nodes:[], edges:[]}`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run test/views-basic.test.ts`).
- [ ] **Step 5: Проверка совместимости с браузером:** `npx esbuild src/views/index.ts --bundle --platform=browser --format=esm --outfile=/tmp/views-check.js` — без ошибок (нет импортов Node).

---

### Task 7: Разрезы «фаервол» и «потоки данных»

**Files:**
- Create: `arch/_tool/src/views/{firewall,dataflows}.ts`; Modify: `arch/_tool/src/views/index.ts`
- Test: `arch/_tool/test/views-net.test.ts`

**Interfaces:**
- Consumes: как Task 6.
- Produces: `firewallView(m, f, s): ViewGraph` (с `table`), `dataflowsView(m, f, s): ViewGraph`.

Фаервол: проекция с `collapseBySegment: true`; рамки `seg:<id>`; каждое ребро модели с портом → соединение «узел-источник → узел-назначение», для `publish/consume` назначение — `platform:<broker>` (не топик); `explicit` — от рамки к рамке. `toHosts`: для БД — `endpoint` (если есть) и FQDN хостов её сервера, для ресурсов платформы — `[endpoint]`, для остальных — `[]`. Строки таблицы: одна на (источник, назначение, порт, протокол), `reason` — перечисление оснований через `; ` (например `call crm-orders → pay-billing`), сортировка по `fromSegment, toSegment, port`. Потоки данных: узлы — сервисы, внешние системы, топики и ресурсы, в которые уходят сущности (`use`-рёбра с непустыми `entities`; без Kafka/ingress-узлов и БД), ребро направлено **по движению данных** (`consume`: топик → сервис), `label` = сущности через `, ` + канал, класс `cls-<max classification>`.

- [ ] **Step 1: Write the failing tests** (demo)
  - firewall, `product:crm`: строка `{fromNode:'crm-orders', fromSegment:'app', toNode:'db:crm_orders', toSegment:'pdn', toHosts:['pg-crm.db.company.ru','pg-crm-01.db.company.ru','pg-crm-02.db.company.ru'], port:'5432', protocol:'tcp', intraSegment:false, attention:['sensitive']}`; строка `crm-orders → platform:kafka` с `intraSegment:true`; строка `crm-orders → product:pay@app`, `port '9090'`, `attention` содержит `'cross-product'`; строка `seg:mgmt → seg:app`, `port '9100'`, `reason 'Мониторинг'`.
  - firewall: `crm-orders.parent === 'seg:app'`, `db:crm_orders.parent === 'seg:pdn'`.
  - dataflows, `company` с `expanded:['crm','pay']`: ребро `topic:crm.orders.order.created.v1 → crm-notify-worker` (направление данных), класс `cls-pdn`; ребро `pay-billing → ext:dwh`, `label` содержит `payment` и `cdc`, класс `cls-kt`.
  - firewall, `product:crm`: строки `actor:internet (external) → platform:waf-main (dmz) 443`, `platform:waf-main → platform:ingress 443` (`intraSegment: true`), `platform:ingress → crm-orders-ui 8080`; строк с `actor:office` нет.
  - dataflows: `expose`-рёбер нет.
  - firewall: строка `crm-notify-worker → platform:ya-messenger`, `toSegment 'external'`, `toHosts ['botapi.messenger.yandex.net']`, `port '443'`.
  - dataflows: ребро `crm-notify-worker → platform:smtp-relay` с `label`, содержащим `order` и `SMTP`, класс `cls-pdn`; ребра в `platform:ya-messenger` нет.
  - `buildView(..., 'firewall')` возвращает то же, что `firewallView`.
  - явное соединение `mgmt → app` при отсутствии узлов в `mgmt`: рамка `seg:mgmt` есть в графе, ребро ссылается на неё.
  - инвариант по всем 5 разрезам × охватам `company` (без и с `expanded:['crm','pay']`), `team:sales`, `product:crm`, `product:pay`, каждый сервис: каждый `edge.from`, `edge.to` и `node.parent` есть среди `nodes`; id узлов уникальны.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run test/views-net.test.ts`).

---

### Task 8: Экспорт Mermaid

**Files:**
- Create: `arch/_tool/src/export/mermaid.ts`
- Test: `arch/_tool/test/mermaid.test.ts`

**Interfaces:**
- Consumes: `ViewGraph`, `buildView`, `Model` (Tasks 5–7).
- Produces:
  - `toMermaid(graph: ViewGraph, title: string): string` — markdown: `# title`, блок ```` ```mermaid ```` с `flowchart LR`, рамки → `subgraph`, id экранируются в `[A-Za-z0-9_]` (стабильно: `n_` + замена прочих символов на `_`), подписи в кавычках; для графа с `table` — ещё markdown-таблица «Источник | Сегмент | Назначение | Сегмент | Хосты | Порт/протокол | Основание».
  - `exportMermaid(model: Model, findings: Finding[]): { path: string; content: string }[]` — для каждого продукта `mermaid/<code>/containers.md` и `firewall.md`, для каждого сервиса `mermaid/<code>/<service-id>/containers.md` и `firewall.md`.
- [ ] **Step 1: Write the failing tests**
  - `exportMermaid(demo)` возвращает 4 файла на продукт-уровне (`crm`, `pay` × 2) + 10 на сервисы = 14; пути как выше.
  - `mermaid/crm/firewall.md` содержит `subgraph seg_pdn` (или эквивалентный экранированный id) и строку таблицы с `5432/tcp`.
  - id `topic:crm.orders.order.created.v1` превращается в валидный mermaid-id без `:` и `.`.
  - пустой граф → валидный блок `flowchart LR` без узлов.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 9: Логика просмотрщика (состояние и карточка)

**Files:**
- Create: `arch/_tool/viewer/{state,panels}.ts`
- Test: `arch/_tool/test/viewer-state.test.ts`

**Interfaces:**
- Consumes: `Model`, `Finding`, `buildView`, `Scope`, `ViewKind`, `ViewGraph` (Tasks 3–7).
- Produces:
  - Встроенные данные: `<script id="arch-data" type="application/json">{ "model": Model, "findings": Finding[], "builtAt": string }</script>`.
  - `state.ts`: `interface UiState { scope: Scope; view: ViewKind; selected?: string }`, `parseHash(hash: string): UiState`, `toHash(s: UiState): string`. Формат: `#view=firewall&scope=product:crm&sel=crm-orders`; `scope=company&exp=crm,pay`. Невалидный хэш → `{scope:{kind:'company',expanded:[]}, view:'containers'}`.
  - `panels.ts`: `cardData(model: Model, findings: Finding[], nodeId: string): { title: string; attrs: [string, string][]; names: [string, string][]; owners: Owner[]; ownersInherited: boolean; links: Link[]; views: ViewKind[]; findings: Finding[] }`; для узла `product:<code>` — данные продукта — `views` = разрезы, где узел присутствует.

UI (spec §9, реализуется в Task 10): слева дерево охвата (компания → команды → продукты → сервисы) с поиском по имени; сверху переключатель из 5 разрезов («Kubernetes», «Контейнеры», «Фаервол», «БД», «Потоки данных»); центр — Cytoscape (компаунд-рамки, раскладка `elk` `layered`, направление `RIGHT`); справа карточка `cardData`: атрибуты, выведенные имена, блок «Ответственные» (роль, имя, контакт текстом с кнопкой копирования; пометка «из продукта» при наследовании), блок «Ссылки» (иконка по `kind`, открываются в новой вкладке), ссылки «показать в разрезе X»; снизу вкладки «Соединения» (для фаервола, `FirewallRow[]`, кнопка «Скопировать как TSV») и «Нарушения» (клик — выделить элементы). В охвате `company` двойной клик по `product:<code>` добавляет его в `expanded`. Раскладка кэшируется в `Map` по `toHash` без `sel`. Цвета — CSS-переменные на `:root` со светлой и тёмной темой (`prefers-color-scheme`); `cls-pdn`/`cls-kt`/`cls-open`, `violation` (красная обводка), `attention-*` (жёлтая), `muted` (прозрачность 0.4).

- [ ] **Step 1: Write the failing tests**
  - `parseHash(toHash(s))` равно `s` для: `company` с `expanded ['crm','pay']`; `product:crm` + `firewall` + `sel 'crm-orders'`; `service:crm-orders-ui`.
  - `parseHash('#garbage')` → значение по умолчанию.
  - `cardData(demo, f, 'crm-orders')`: `names` содержит `['namespace','crm-prod']` и `['ТУЗ','svc-crm-orders-prod']`; `views` содержит все 5; для `db:crm_orders` `views` = `['containers','firewall','databases']`; `cardData(demo, f, 'db:crm_orders').attrs` содержит `['Сервер', 'pg-crm']` и `['Хосты', 'pg-crm-01.db.company.ru (primary), pg-crm-02.db.company.ru (replica)']`.
  - `cardData(demo, f, 'crm-orders-ui').attrs` содержит `['Публикация', 'Интернет · клиенты → WAF → Ingress → crm-orders-ui']` и `['Аутентификация', 'ADFS — Вход пользователей (OIDC)']`.
  - `cardData(demo, f, 'crm-notify-worker')` → `ownersInherited: true`, `owners[0].name === 'Петрова А.'`; `links[0].kind === 'repo'`.
- [ ] **Step 2–4:** FAIL → implement `state.ts`, `panels.ts` → PASS (`npx vitest run test/viewer-state.test.ts`).

---

### Task 10: Отрисовка просмотрщика и сборка HTML

**Files:**
- Create: `arch/_tool/viewer/{main,render}.ts`, `arch/_tool/viewer/styles.css`, `arch/_tool/src/build/html.ts`
- Modify: `arch/_tool/package.json` (зависимость `puppeteer-core`, скрипт `test:e2e` — отдельный конфиг vitest для `test/e2e/**`)
- Test: `arch/_tool/test/e2e/smoke.test.ts`

**Interfaces:**
- Consumes: `state.ts`, `panels.ts` (Task 9); `buildView` (Tasks 6–7).
- Produces:
  - `buildHtml(data: { model: Model; findings: Finding[]; builtAt: string }): Promise<string>` — esbuild бандлит `viewer/main.ts` (IIFE, minify, `platform: 'browser'`) и `styles.css`, вставляет их и JSON (с экранированием `</` → `<\/`) в шаблон с `<title>Архитектура</title>`.
  - `main.ts`: `boot(doc: Document): void`; после каждой отрисовки ставит `document.body.dataset.rendered = '<view>|<scope>'` и `data-node-count` (для смоук-теста).

Поведение UI — как описано в Task 9. Путь к Chrome для смоук-теста: `CHROME_PATH`, по умолчанию `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; если Chrome не найден, тест помечается `skip` с сообщением, а не проходит молча.

- [ ] **Step 1: Write the failing smoke test** — собрать HTML из `examples/demo` во временную папку, открыть в `puppeteer-core` (headless), для каждого из 5 разрезов × охватов `company`, `team:sales`, `product:crm`, `product:pay`, `service:crm-orders-ui` выставить `location.hash` и дождаться `data-rendered`:
  - нет событий `pageerror` и сообщений консоли уровня `error`;
  - `data-node-count > 0` (кроме сочетаний, которые пусты по построению — перечислить в тесте явно);
  - в «Фаерволе» `product:crm` в таблице есть строка с `5432/tcp` и `pg-crm.db.company.ru`;
  - перезагрузка страницы с хэшем `#view=databases&scope=product:crm&sel=db:crm_orders` восстанавливает разрез и карточку;
  - в HTML нет `http://`/`https://` в атрибутах `src`/`href` (ссылки из карточки строятся в рантайме и не считаются).
- [ ] **Step 2:** `npm run test:e2e` — FAIL.
- [ ] **Step 3: Implement** `render.ts`, `main.ts`, `styles.css`, `buildHtml`.
- [ ] **Step 4:** `npm run test:e2e` — PASS; `npx vitest run` — PASS.

---

### Task 11: CLI, проверка масштаба, README

**Files:**
- Create: `arch/_tool/src/cli.ts`, `arch/_tool/scripts/gen-synthetic.ts`, `arch/_tool/README.md`
- Modify: `arch/_tool/package.json` (`bin: { "arch-views": "dist/cli.js" }`, скрипты `build`, `test`, `arch:validate`, `arch:build`)
- Test: `arch/_tool/test/cli.test.ts`

**Interfaces:**
- Consumes: всё выше, в т. ч. `buildHtml` (Task 10), `exportMermaid` (Task 8).
- Produces:
  - `run(argv: string[], io: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number>` — команды `validate [--root <dir>]` и `build [--root <dir>] [--out <dir>]`; `root` по умолчанию `../` относительно `arch/_tool` (т. е. `arch/`), `out` — `<root>/_dist`. Вывод находок: `ERROR|WARN <rule> <file>: <message>`, затем сводка `Ошибок: N, предупреждений: M`; `attention` в консоль не выводятся (только в HTML).
- [ ] **Step 1: Write the failing tests** (запуск `run` в процессе, `out` во временной папке vitest)
  - `build --root examples/demo` → код 0; есть `index.html`, `mermaid/crm/firewall.md`; в `index.html` нет `http://`/`https://` в атрибутах `src`/`href`; содержит `id="arch-data"`; JSON из тега парсится и содержит узел `crm-orders`.
  - `build --root test/fixtures/empty` → код 0, `index.html` создан.
  - `build --root test/fixtures/bad-yaml` → код 2, `index.html` не создан, stderr содержит `orders.yaml:3`.
  - модель с A-1 (фикстура `test/fixtures/violations/`) → код 1, `index.html` создан, stdout содержит `a1.foreign-db`.
  - `validate --root examples/demo` → код 0, файлов не создаёт.
  - масштаб: `gen-synthetic --teams 10 --products 30 --services 300 --out <tmp>` создаёт валидную модель (сервисы с вызовами, топиками, БД на 5 серверах, ресурсами, публикациями); `build` по ней → код 0 и укладывается в 5 с.
- [ ] **Step 2:** `npx vitest run test/cli.test.ts` — FAIL.
- [ ] **Step 3: Implement** `buildHtml`, `run`; `src/cli.ts` вызывает `run(process.argv.slice(2), …)` и `process.exit(code)`.
- [ ] **Step 4:** `npx vitest run` (весь набор) — PASS; `npx tsc --noEmit` — без ошибок.
- [ ] **Step 5: Масштаб в браузере:** смоук-тест из Task 10 с моделью `gen-synthetic` (переменная `ARCH_E2E_ROOT`) для охватов `company` и одного `product`: отрисовка (до `data-rendered`) меньше 2 с каждая. Если бюджет не выполняется — остановиться и сообщить цифры, не подкручивать бюджет.
- [ ] **Step 6: Ручная проверка просмотрщика.** `npm run arch:build -- --root examples/demo --out /tmp/arch-demo` и открыть `index.html` в браузере без сети. Ожидается: все 5 разрезов переключаются; в «Фаерволе» рамки сегментов и таблица соединений со строкой `app → pdn 5432/tcp`; клик по `crm-orders` открывает карточку с `crm-prod`; ссылка «показать в разрезе БД» переключает разрез и сохраняет выбор; хэш в URL меняется, перезагрузка восстанавливает состояние; в охвате «Компания» двойной клик по продукту раскрывает его; тёмная тема читаема.
- [ ] **Step 7: README.md** (на русском): формат файлов (таблица полей из Task 1 + ссылка на `examples/demo`), команды, коды выхода, пример задания GitLab CI (с пометкой: в закрытой сети заменить `node:22` на образ из внутреннего registry и указать внутренний npm-registry):

```yaml
arch:
  image: node:22
  script: [cd arch/_tool, npm ci, npm run arch:build]
  artifacts: { when: always, paths: [arch/_dist/] }
  rules: [ { changes: ["arch/**/*"] } ]
```
