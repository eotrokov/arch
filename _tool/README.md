# arch-views

Инструмент строит из YAML-описания архитектуры самодостаточный `index.html` (5 разрезов: Kubernetes, контейнеры, фаервол, БД, потоки данных), файлы Mermaid и проверяет модель на нарушения правил. Работает без сети.

Каталог `arch/_prototype/` — одноразовый прототип, не часть инструмента и в сборке не участвует.

## Структура модели

Корень модели — каталог `arch/`. Каталоги, имена которых начинаются с `_` (кроме `_shared`), пропускаются.

```
arch/
  _shared/network.yaml     # сегменты, актёры, явные соединения
  _shared/platform.yaml    # домен, registry, git, кластеры, общие ресурсы, внешние системы, серверы СУБД
  <team>/team.yaml
  <team>/<product>/product.yaml
  <team>/<product>/services/<service>.yaml
```

Полный пример формата: [`examples/demo`](examples/demo). Схемы запрещают лишние поля (`additionalProperties: false`).

| Файл / объект | Обязательные поля | Необязательные (значение по умолчанию) |
|---|---|---|
| `network.yaml` | `segments[]` (`id`, `name`) | `segments[].external` (false), `.sensitive` (false), `.description`; `actors[]` (`id`, `name`, `segment`); `connections[]` (`from`, `to`, `port`, `protocol`, `reason` — все обязательны) |
| `platform.yaml` | `domain`, `registry`, `git`, `clusters[]` (`id`, `name`) | `env` (`prod`); `resources[]` (обязательны `id`, `kind`, `name`, `segment`, `port`, `protocol`; необязательны `endpoint`, `owners`, `links`); `externals[]` (`id`, `name`, `segment`, `port`, `protocol`); `dbservers[]` (`id`, `engine`, `segment`, `port`, `hosts` ≥ 1 с `fqdn` и `role`; необязательны `version`, `endpoint`, `owners`, `links`) |
| `team.yaml` | `name` | `owners` (`[]`), `links` (`[]`) |
| `product.yaml` | `code`, `name` | `criticality`, `nfr`, `owners`, `links`, `entities[]` (все поля обязательны), `externals[]`, `dbservers[]`, `resources[]` — форматы как в `platform.yaml` |
| `services/*.yaml` | `name`, `segment`, `cluster` | `type` (`backend`), `port` (8080), `protocol` (`http`), `criticality`, `databases`, `publishes`, `consumes`, `calls`, `uses`, `exports`, `exposure`, `owners`, `links`, `overrides` |

Уточнения:

- `connections[].from/to` — `{segment}` или `{node}`.
- `resources[].kind`: `kafka`, `ingress`, `waf`, `adfs`, `vault`, `s3`, `smtp`, `yandex-disk`, `yandex-messenger`, `other`. Облачные ресурсы размещаются в сегменте `external`.
- `dbservers[].hosts[].role`: `primary`, `replica`, `arbiter`; только FQDN.
- `uses[]` — одна из трёх форм: `{resource, purpose?, entities?}`; `{resource, bucket, access, purpose?, entities?}` (только для `kind: s3`); `{db, role}`.
- `owners[]`: обязательны `role`, `name`; `links[]`: обязательны `kind`, `url` (только `http(s)://`); `exposure[]`: обязательны `audience`, `via` (≥ 1).
- Если у сервиса нет `owners`, наследуются ответственные продукта (правило `meta.no-owner` предупреждает об этом).

## Команды

Требуется Node.js 22+.

```
cd _tool
npm ci
npm run arch:validate [-- --root <каталог>]
npm run arch:build    [-- --root <каталог> --out <каталог>]
```

- `--root` — корень модели, по умолчанию `arch/` (каталог на уровень выше `_tool`).
- `--out` — куда писать результат, по умолчанию `<root>/_dist`.
- `validate` — загрузка, разрешение ссылок и проверка правил; ничего не пишет.
- `build` — то же, плюс запись `index.html` и файлов Mermaid (`mermaid/<продукт>/<разрез>.md`) в `out`. Файлы пишутся только после успешной загрузки; при нарушениях правил сборка всё равно создаётся.

Пример сборки демо-модели: `npm run arch:build -- --root examples/demo --out /tmp/arch-demo`, затем откройте `/tmp/arch-demo/index.html`.

Вывод:

- ошибки загрузки (синтаксис YAML, схема, неразрешённые ссылки) — в stderr: `ERROR <файл>:<строка>: <сообщение>` (строка опускается, если неизвестна);
- нарушения правил — в stdout: `ERROR|WARN <правило> <файл>: <сообщение>`, затем сводка `Ошибок: N, предупреждений: M`;
- находки уровня `attention` в консоль не выводятся, они видны только в HTML.

## Коды выхода

| Код | Значение |
|---|---|
| 0 | модель корректна (предупреждения допустимы) |
| 1 | есть нарушения уровня `error` (для `build` HTML всё равно создан) |
| 2 | ошибка загрузки модели или параметров команды; ничего не записано |

## Проверка масштаба

Генератор синтетической модели (детерминированный, без ошибок правил):

```
npx tsx scripts/gen-synthetic.ts --teams 10 --products 30 --services 300 --out /tmp/arch-big [--seed 1]
```

`npm test` проверяет, что сборка такой модели укладывается в 5 с. Тест просмотрщика в браузере (`npm run test:e2e`, нужен Chrome; путь — в `CHROME_PATH`) проверяет, что охват «Компания» и один продукт отрисовываются быстрее 2 с; модель можно задать переменной `ARCH_E2E_ROOT`.

## GitLab CI

```yaml
arch:
  image: node:22
  script: [cd arch/_tool, npm ci, npm run arch:build]
  artifacts: { when: always, paths: [arch/_dist/] }
  rules: [ { changes: ["arch/**/*"] } ]
```

В закрытой сети замените `node:22` на образ из внутреннего registry и укажите внутренний npm-registry (например, `npm config set registry <url>` или `.npmrc`) перед `npm ci`. Сборке нужны `esbuild`, `cytoscape`, `elkjs`, `cytoscape-elk` — они в `dependencies`, поэтому подходит и `npm ci --omit=dev`.
