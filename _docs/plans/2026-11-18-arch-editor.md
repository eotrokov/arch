# Редактор модели архитектуры — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Статическая страница-редактор (GitLab Pages), в которой команды через мастер по шагам заводят и меняют свои команды/продукты/сервисы, видят проверки и предпросмотр разрезов и создают MR в корпоративном GitLab от своего имени; без GitLab — скачивают изменения архивом.

**Architecture:** Браузерный TypeScript без фреймворка в `_tool/editor/`, на том же коде модели, что CLI: загрузка дерева из карты файлов в памяти → `resolveModel` → `runChecks` → `buildView`. Источник модели — GitLab API (OAuth + PKCE, токен в памяти) или `model.json` (запасной режим). Правки копятся в «корзине» пофайлово, YAML существующих файлов меняется через `yaml` Document API с сохранением форматирования; MR — один вызов commits API (с `last_commit_id`) и вызов merge_requests API.

**Tech Stack:** Node.js 22, TypeScript 5 strict ESM, `yaml`, `ajv`, `esbuild`, `cytoscape@3.30.2` / `elkjs@0.9.3` / `cytoscape-elk@2.2.0` (как у просмотрщика), `fflate@0.8.2` (zip в браузере), `vitest`, `puppeteer-core` (e2e в локальном Chrome).

**Spec:** `_docs/specs/2026-11-18-arch-editor-design.md` (и для модели — `_docs/specs/2026-11-17-arch-views-design.md`)

**Git:** ветка `feature/editor`, корень репозитория — `arch/` (пути плана `_tool/...` от корня репозитория). Каждая задача заканчивается одним коммитом `feat(arch-editor): Task N — <название>` с трейлером `Co-Authored-By`. Push — только по команде пользователя.

## Global Constraints

- Редактор не редактирует `_shared/**`: эти файлы только читаются; корзина отклоняет изменения путей `_shared/` (ошибка в UI).
- Не редактируются и не удаляются продукты и команды; удалять можно только файл сервиса; `name`/`code`/id команды существующего элемента не меняются.
- Браузерный код (`editor/**`, `viewer/**`, `src/views/**`, `src/checks/**`, `src/model/{types,names,schemas,resolve,loadFiles}.ts`) не импортирует модули Node.
- Токен GitLab хранится только в памяти вкладки (не в `localStorage`/`sessionStorage`/cookie); refresh-токен не сохраняется.
- OAuth: Authorization Code + PKCE (S256), scope `api`, параметры `client_id`, `redirect_uri`, `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`; обмен кода — `POST {gitlabUrl}/oauth/token` с `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`.
- `config.json`: `{ gitlabUrl, projectPath, oauthClientId, redirectUri, baseBranch }`; пустой/отсутствующий `oauthClientId` → запасной режим.
- MR: ветка `arch/<slug>-<4 символа [a-z0-9]>`, сообщение коммита `arch: <заголовок MR>`, `target_branch` = `baseBranch`, `labels: arch-editor`, `remove_source_branch: true`; `update`/`delete` всегда с `last_commit_id`.
- Сборка редактора самодостаточна: JS/CSS встроены или лежат рядом, никаких внешних CDN и шрифтов; сетевые запросы — только к `gitlabUrl` (или к `model.json` рядом в запасном режиме).
- Тексты UI — на русском; стиль — CSS-токены и тёмная/светлая темы просмотрщика (`viewer/styles.css`).
- Поведение CLI (`validate`/`build`) и все существующие тесты не меняются, кроме добавления `_dist/model.json` при `build`.

## Review Focus

1. Существующий YAML с комментариями и flow-стилем: после правки одного поля diff содержит только эту строку. (Task 4)
2. Файл изменён в `main` после загрузки: GitLab отклоняет коммит, пользователь видит понятное сообщение, корзина сохранена, ничего не перезаписано. (Task 6, Task 10)
3. Токен истёк или отозван посреди работы (401): предложение войти снова, корзина не теряется. (Task 8)
4. Удаление сервиса, на который ссылаются другие: MR заблокирован, ошибки указывают на ссылающиеся файлы. (Task 3, Task 9)
5. Заголовок MR на кириллице/с пробелами/пустой: имя ветки валидно (`[a-z0-9-]`), не пустое. (Task 6)

---

## Структура файлов

```
_tool/
├── src/model/loadFiles.ts     # NEW: loadTreeFromFiles(files) — без Node; load.ts становится обёрткой
├── src/model/resolve.ts       # MOD: без node:path
├── src/cli.ts                 # MOD: build пишет _dist/model.json
├── src/build/editor.ts        # NEW: buildEditor(outDir, config) — бандл редактора
├── editor/
│   ├── config.ts              # EditorConfig, loadConfig(), mode
│   ├── gitlab/oauth.ts        # PKCE, authorizeUrl, exchangeCode
│   ├── gitlab/api.ts          # GitLabClient (fetch внедряется)
│   ├── spike/index.html, spike/main.ts   # Task 1: страница проверки
│   ├── model.ts               # validateFiles, pickLists
│   ├── yamlEdit.ts            # новые файлы и минимальные правки YAML
│   ├── cart.ts                # корзина, наложение, черновики, сверка с main
│   ├── mr.ts                  # имя ветки, actions, описание MR, zip
│   ├── forms.ts               # форма ↔ Raw*, шаги, ошибки по шагам
│   ├── main.ts, wizard.ts, review.ts, styles.css, index.html   # UI
└── test/
    ├── fake-gitlab.ts         # NEW: фальшивый GitLab (http) для unit и e2e
    ├── editor-*.test.ts
    └── e2e/editor.test.ts, e2e/spike.test.ts
```

---

### Task 1: Проверка на реальном GitLab (spike) — OAuth, клиент API, страница проверки

**Files:**
- Create: `_tool/editor/config.ts`, `_tool/editor/gitlab/oauth.ts`, `_tool/editor/gitlab/api.ts`, `_tool/editor/spike/index.html`, `_tool/editor/spike/main.ts`, `_tool/test/fake-gitlab.ts`, `_tool/editor/SPIKE.md`
- Modify: `_tool/package.json` (скрипт `spike:build`, `spike:serve`), `_tool/tsconfig.json` (include `editor`)
- Test: `_tool/test/editor-oauth.test.ts`, `_tool/test/editor-api.test.ts`, `_tool/test/e2e/spike.test.ts`

**Interfaces:**
- Produces:
  - `interface EditorConfig { gitlabUrl: string; projectPath: string; oauthClientId: string; redirectUri: string; baseBranch: string }`; `loadConfig(fetchFn: typeof fetch, url = 'config.json'): Promise<EditorConfig | null>` (null — нет файла или пустой `oauthClientId`).
  - `oauth.ts`: `createPkce(): Promise<{ verifier: string; challenge: string }>` (verifier 64 символа base64url из `crypto.getRandomValues`; challenge = base64url(SHA-256(verifier)) через `crypto.subtle`), `challengeFor(verifier: string): Promise<string>`, `authorizeUrl(cfg: EditorConfig, challenge: string, state: string): string`, `exchangeCode(cfg, code: string, verifier: string, fetchFn): Promise<string>` (access_token). Verifier и state между редиректами — в `sessionStorage` (это не токен).
  - `api.ts`: `class GitLabClient { constructor(cfg: EditorConfig, token: string, fetchFn: typeof fetch) ; user(): Promise<{ username: string; name: string }>; branchHead(branch: string): Promise<string>; tree(ref: string): Promise<{ path: string; type: 'blob' | 'tree'; id: string }[]>; rawFile(path: string, ref: string): Promise<string>; createCommit(p: { branch: string; startSha: string; message: string; actions: CommitAction[] }): Promise<{ id: string }>; createMr(p: { sourceBranch: string; title: string; description: string; draft?: boolean }): Promise<{ iid: number; webUrl: string }> }`; `type CommitAction = { action: 'create' | 'update' | 'delete'; file_path: string; content?: string; last_commit_id?: string }`; `class GitLabError extends Error { status: number; kind: 'auth' | 'forbidden' | 'conflict' | 'cors-or-network' | 'other' }`. Проект адресуется как `/api/v4/projects/${encodeURIComponent(projectPath)}`; `tree` — `recursive=true&per_page=100` с проходом по `x-next-page`.
  - `fake-gitlab.ts`: `startFakeGitLab(opts: { files: Record<string,string>; port?: number }): Promise<{ url: string; requests: { method: string; path: string; body?: unknown }[]; setFile(path, content): void; close(): Promise<void> }>` — реализует `/oauth/authorize` (302 на `redirect_uri?code=c1&state=…`), `/oauth/token` (проверяет PKCE: `code_verifier` → challenge совпадает с сохранённым), `/api/v4/user`, `.../repository/branches/:b`, `.../repository/tree`, `.../repository/files/:path/raw`, `HEAD .../repository/files/:path` (заголовки `X-Gitlab-Last-Commit-Id`, `X-Gitlab-Blob-Id`), `POST .../repository/commits` (при несовпадении `last_commit_id` → 400 `{"message":"You are attempting to update a file that has changed since you started editing it."}`), `POST .../merge_requests`, `GET .../merge_requests?labels=…&author_username=…&state=opened`; CORS-заголовки на всё; 401 при неверном токене. Используется в Task 1, 6, 10.
- Страница проверки (`spike/`): кнопки «Войти», «Прочитать модель», «Создать тестовый MR»; результаты построчно: `✓ Вход: <name>`, `✓ Дерево: N файлов`, `✓ Файл <path>: M байт`, `✓ MR: <ссылка>` или `✗ <шаг>: <тип ошибки GitLabError.kind> — <сообщение>`; тестовый MR — ветка `arch/spike-<4>`, файл `_spike/<ISO-время>.txt`, заголовок `Draft: проверка редактора arch`, `draft: true`.

- [ ] **Step 1: Write the failing tests**
  - `editor-oauth.test.ts`: `challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')` === `'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'` (вектор RFC 7636); `createPkce()` даёт verifier длиной 64 `[A-Za-z0-9_-]`; `authorizeUrl` содержит все параметры из Global Constraints и `scope=api`.
  - `editor-api.test.ts` (fake GitLab): `user()` → username; `tree('main')` с 150 файлами в фейке собирает 2 страницы; `rawFile` кириллицы в UTF-8; неверный токен → `GitLabError.kind === 'auth'`; `createCommit` с устаревшим `last_commit_id` → `kind === 'conflict'`; `createMr` → `webUrl`.
  - `e2e/spike.test.ts`: собрать spike (`npm run spike:build`), отдать его локально вместе с `config.json`, указывающим на фейк; в Chrome пройти три кнопки; на странице есть `✓ Вход`, `✓ Дерево`, `✓ MR`; фейк получил коммит с файлом `_spike/…` и MR с `Draft:`.
- [ ] **Step 2:** `npx vitest run test/editor-oauth.test.ts test/editor-api.test.ts` и `npm run test:e2e -- spike` — FAIL.
- [ ] **Step 3: Implement** по Interfaces. `spike:build` бандлит `editor/spike/main.ts` в `_dist/spike/` (index.html + main.js); `spike:serve` — статический сервер на `127.0.0.1:5310` для ручной проверки с `http://localhost:5310/` как redirect URI.
- [ ] **Step 4:** тесты — PASS; `npx tsc --noEmit` чисто.
- [ ] **Step 5: `editor/SPIKE.md`** (на русском): текст запроса админам GitLab — «Зарегистрируйте OAuth-приложение: Name: arch-editor; Redirect URI: <адрес Pages>/ и http://localhost:5310/; Confidential: нет; Scopes: api»; как заполнить `config.json`; как запустить (`npm run spike:build && npm run spike:serve`); что значит каждая ошибка (`cors-or-network` — GitLab не разрешает CORS с этого адреса; `auth` — неверный client_id/redirect; `forbidden` — нет роли Developer). Пометка: результат проверки пользователь вписывает в §11 спеки.

> После Task 1 контроллер сообщает пользователю, как запустить проверку, и **продолжает** выполнение: задачи 2–10 не зависят от результата (запасной режим строится в любом случае).

---

### Task 2: Загрузка модели из карты файлов; `model.json` в сборке

**Files:**
- Create: `_tool/src/model/loadFiles.ts`
- Modify: `_tool/src/model/load.ts` (обёртка над loadFiles), `_tool/src/model/resolve.ts` (убрать `node:path`), `_tool/src/cli.ts` (`build` пишет `<out>/model.json`)
- Test: `_tool/test/load-files.test.ts`, `_tool/test/cli.test.ts` (дополнить)

**Interfaces:**
- Consumes: `RawTree`, `LoadError`, схемы (`schemas.ts`).
- Produces:
  - `type FileMap = Record<string, string>` — ключ: путь от корня модели через `/` (`_shared/network.yaml`, `sales/crm/services/orders.yaml`).
  - `loadTreeFromFiles(files: FileMap, root = ''): { tree: RawTree | null; errors: LoadError[] }` — те же правила, что `loadTree` (пропуск каталогов на `_` и `.`, обязательные `_shared/*.yaml`, `services/*.yaml|yml`); `file` в результатах и ошибках = `root ? root + '/' + path : path`.
  - `readModelFiles(root: string): FileMap` в `load.ts`; `loadTree(root)` = `loadTreeFromFiles(readModelFiles(root), root)`.
  - `model.json`: `{ files: FileMap; builtAt: string; commit?: string }` (`commit` из `process.env.CI_COMMIT_SHA`).
- [ ] **Step 1: Write the failing tests**
  - `loadTreeFromFiles(readModelFiles('examples/demo'), abs)` глубоко равен `loadTree(abs)` (tree и errors).
  - Все кейсы `load.test.ts` повторены для `loadTreeFromFiles` через `readModelFiles` фикстур (параметризованный тест); `bad-yaml` даёт ту же строку 3.
  - Ключ `_tool/x.yaml` и `.git/x.yaml` в карте игнорируются.
  - `build --root examples/demo --out <tmp>` создаёт `model.json`, где `files['_shared/network.yaml']` равен содержимому файла и есть `builtAt`.
  - Совместимость с браузером: `esbuild src/model/loadFiles.ts src/model/resolve.ts --bundle --platform=browser` без ошибок (тест через API esbuild).
- [ ] **Step 2–4:** FAIL → implement → `npx vitest run` целиком PASS (все существующие тесты зелёные), `npx tsc --noEmit`.

---

### Task 3: Проверка модели в браузере и списки для форм

**Files:**
- Create: `_tool/editor/model.ts`
- Test: `_tool/test/editor-model.test.ts`

**Interfaces:**
- Consumes: `loadTreeFromFiles` (Task 2), `resolveModel`, `runChecks`, `Model`, `Finding`.
- Produces:
  - `interface Validation { tree: RawTree | null; model: Model | null; loadErrors: LoadError[]; findings: Finding[]; ok: boolean }` — `ok` = нет `loadErrors` и нет findings уровня `error`.
  - `validateFiles(files: FileMap): Validation`.
  - `interface PickLists { segments: {id,name}[]; clusters: {id,name}[]; dbservers: {id,engine,segment}[]; resources: {id,kind,name}[]; actors: {id,name}[]; topics: string[]; services: string[]; externals: {id,name,product?}[]; entities: {name,product,classification}[]; teams: {id,name}[]; products: {code,name,team}[] }`; `pickLists(v: Validation): PickLists` — из `model` (если null — из `tree`, насколько возможно; если и он null — пустые списки).
- [ ] **Step 1: Write the failing tests**
  - demo: `validateFiles(files).ok === true`, findings совпадают с `runChecks(loadTree(demo))` по `rule`+`nodeIds` (**равенство с CLI**).
  - удалить из карты `sales/pay/services/billing.yaml` → `ok === false`, `loadErrors` содержат ошибку ссылки с `file`, оканчивающимся на `sales/crm/services/orders.yaml` (вызов `pay-billing`) — Review Focus 4.
  - `pickLists(demo)`: `segments` содержит `pdn`; `resources` содержит `{id:'waf-main', kind:'waf'}`; `topics` = `['crm.orders.order.created.v1']`; `services` содержит все 5 id; `externals` содержит `bank` и `dwh` (`product:'pay'`).
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 4: Генерация и минимальная правка YAML

**Files:**
- Create: `_tool/editor/yamlEdit.ts`
- Test: `_tool/test/editor-yaml.test.ts`

**Interfaces:**
- Consumes: `RawService`, `RawProductData`, `RawTeamData` (`raw.ts`).
- Produces:
  - `newYaml(kind: 'service' | 'product' | 'team', data: object): string` — канонический порядок ключей: сервис `name, type, segment, cluster, criticality, port, protocol, databases, publishes, consumes, calls, uses, exports, exposure, owners, links, overrides`; продукт `code, name, criticality, nfr, owners, links, entities, externals, dbservers, resources`; команда `name, owners, links`; пустые массивы и `undefined` опускаются; элементы списков — flow-стиль `{ ... }` для объектов без вложенных объектов, иначе block.
  - `patchYaml(original: string, next: object): string` — через `parseDocument`: для каждого ключа верхнего уровня — если значение не изменилось (глубокое сравнение), узел не трогается; изменённые скаляры меняются на месте; изменённые списки/объекты заменяются целиком (новый узел в стиле исходного); удалённые ключи удаляются; новые ключи добавляются в канонической позиции. Комментарии и порядок прочих ключей сохраняются.
  - `servicePath(team: string, code: string, name: string, type: string): string` → `<team>/<code>/services/<name>[-<type>].yaml`; `productPath(team, code)`, `teamPath(team)`.
- [ ] **Step 1: Write the failing tests**
  - `newYaml('service', …)` для `crm-orders` демо, затем `parseDocument().toJS()` глубоко равен исходным данным; порядок ключей канонический; нет пустых `[]`.
  - Review Focus 1: файл с комментарием `# главный сервис` и flow-списком `owners: [ {…} ]`; `patchYaml` с изменённым только `cluster` → текстовый diff (построчно) ровно 1 изменённая строка; комментарий на месте.
  - Добавление элемента в `uses` → меняется только блок `uses`; удаление ключа `exports` → строки `exports` исчезают, остальные без изменений.
  - `patchYaml(x, parse(x))` === `x` (идемпотентность) для всех YAML демо.
  - `servicePath('sales','crm','notify','worker')` === `'sales/crm/services/notify-worker.yaml'`.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 5: Корзина изменений, черновики, сверка с новым `main`

**Files:**
- Create: `_tool/editor/cart.ts`
- Test: `_tool/test/editor-cart.test.ts`

**Interfaces:**
- Consumes: `FileMap` (Task 2).
- Produces:
  - `interface Change { path: string; content: string | null /* null = удалить */; baseBlobId: string | null /* null = новый файл */; label: string /* «Новый сервис crm-notify-worker» */ }`.
  - `class Cart { changes(): Change[]; put(c: Change): void /* заменяет по path */; remove(path): void; clear(): void; isEmpty(): boolean }` — `put` бросает `Error('Файлы _shared меняют архитекторы')` для путей `_shared/`.
  - `applyCart(files: FileMap, changes: Change[]): FileMap` (новая карта; удаление убирает ключ).
  - `saveDraft(storage: Storage, projectPath: string, changes: Change[]): void`, `loadDraft(storage, projectPath): Change[]` — ключ `arch-editor:draft:<projectPath>`; битый JSON → `[]`.
  - `reconcile(changes: Change[], blobs: Record<string, string>): { applied: Change[]; conflicts: Change[] }` — конфликт: у изменения есть `baseBlobId` и он ≠ текущему `blobs[path]` (или файла уже нет); новый файл, путь которого уже существует в `blobs`, — тоже конфликт.
- [ ] **Step 1: Write the failing tests** — по каждому пункту Interfaces: замена по path, удаление, запрет `_shared/`, сохранение/загрузка через фейковый `Storage`, битый черновик, три вида конфликтов и неизменённый файл → `applied`.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 6: Сборка MR — ветка, actions, описание, загрузка модели из GitLab, zip

**Files:**
- Create: `_tool/editor/mr.ts`
- Modify: `_tool/editor/gitlab/api.ts` (добавить методы), `_tool/package.json` (`fflate@0.8.2` в dependencies)
- Test: `_tool/test/editor-mr.test.ts`, `_tool/test/editor-api.test.ts` (дополнить)

**Interfaces:**
- Consumes: `GitLabClient`, `CommitAction`, `GitLabError` (Task 1); `Change` (Task 5); `Finding` (модель).
- Produces:
  - `api.ts`: `loadModel(ref: string, concurrency = 8): Promise<{ files: FileMap; blobs: Record<string,string>; baseSha: string }>` — `branchHead` + `tree` + `rawFile` по `blob`-путям `*.yaml|*.yml` вне каталогов на `_`, кроме `_shared/`; `lastCommitId(path: string, ref: string): Promise<string>` (`HEAD files/:path`, заголовок `X-Gitlab-Last-Commit-Id`); `openMrs(username: string): Promise<{ iid: number; title: string; webUrl: string }[]>` (метка `arch-editor`, `state=opened`).
  - `mr.ts`: `branchName(title: string, rnd: () => string): string` — транслитерация кириллицы (ГОСТ-подобная таблица: а→a, б→b, … ж→zh, х→kh, ц→ts, ч→ch, ш→sh, щ→shch, ы→y, э→e, ю→yu, я→ya, ь/ъ→''), нижний регистр, всё кроме `[a-z0-9]` → `-`, схлопнуть дефисы, обрезать до 40, пусто → `change`; результат `arch/<slug>-<rnd()>`, где `rnd` даёт 4 символа `[a-z0-9]`.
  - `commitActions(changes: Change[], lastCommitIds: Record<string,string>): CommitAction[]` — `create` (baseBlobId null), `update`/`delete` с `last_commit_id`; отсутствие id для update/delete → `Error`.
  - `defaultTitle(changes): string` — один элемент: его `label`; несколько: `«<label первого>» и ещё N`.
  - `mrDescription(changes: Change[], findings: Finding[]): string` — markdown: «Изменения» (список label + путь), «Проверки» (`Ошибок: 0, предупреждений: M`, список предупреждений), строка «Создано в редакторе arch».
  - `zipChanges(changes: Change[], mrText: string): Uint8Array` — fflate `zipSync`: удалённые файлы — в `DELETED.txt` списком путей, остальные по своим путям, плюс `MR.md`.
- [ ] **Step 1: Write the failing tests**
  - Review Focus 5: `branchName('CRM: новый сервис crm-notify-worker', () => 'ab12')` === `'arch/crm-novyy-servis-crm-notify-worker-ab12'`; `branchName('   ', …)` === `'arch/change-ab12'`; `branchName('Очень '.repeat(20), …)` — slug ≤ 40.
  - `commitActions` трёх видов; ошибка при отсутствии `last_commit_id`.
  - `mrDescription` содержит путь каждого файла и `Ошибок: 0`.
  - `zipChanges` → `unzipSync` содержит пути, `MR.md`, `DELETED.txt`.
  - fake GitLab: `loadModel('main')` на демо → `files` равен демо-карте, `blobs` для каждого пути, `baseSha` = голова ветки; `lastCommitId` из заголовка; Review Focus 2: после `setFile` в фейке `createCommit` с прежним `last_commit_id` → `GitLabError.kind === 'conflict'`.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 7: Модель мастера — шаги, форма ↔ YAML-данные, ошибки по шагам

**Files:**
- Create: `_tool/editor/forms.ts`
- Test: `_tool/test/editor-forms.test.ts`

**Interfaces:**
- Consumes: `RawService`, `RawProductData`, `RawTeamData`, `Finding`, `LoadError`, `PickLists` (Task 3), `deriveNames` (`names.ts`).
- Produces:
  - `type WizardKind = 'service' | 'product' | 'team'`.
  - `interface StepDef { id: string; title: string; fields: string[] /* ключи верхнего уровня YAML, которые редактирует шаг */ }`; `STEPS: Record<WizardKind, StepDef[]>`: service — `main`(Основное: name, type, criticality), `place`(Размещение: segment, cluster, port, protocol), `data`(Данные: databases, publishes), `links`(Связи: calls, consumes, uses, exports), `publish`(Публикация: exposure), `people`(Ответственные и ссылки: owners, links), `review`(Проверка и MR); product — `main`(code, name, criticality, nfr), `entities`, `own`(Выделенные ресурсы: externals; dbservers/resources — только чтение), `people`, `review`; team — `main`(id, name), `people`, `review`.
  - `READONLY_FIELDS: Record<WizardKind, string[]>` = service `['overrides']`, product `['dbservers', 'resources']`, team `[]`; `unknownFields(kind, data): string[]` — ключи, которых нет ни в шагах, ни в READONLY_FIELDS (показываются только для чтения).
  - `interface WizardState { kind; team: string; product?: string; isNew: boolean; data: Record<string, unknown>; originalText?: string; path: string }`; `startNew(kind, team, product?): WizardState`; `startEdit(kind, path, text): WizardState`.
  - `toChange(s: WizardState, blobId: string | null): Change` — новый файл через `newYaml`, существующий — `patchYaml(originalText, data)`; `label` по-русски: `Новый сервис <id>` / `Изменение сервиса <id>` / `Новый продукт <code>` / …; `deleteChange(path, blobId, id): Change` (`Удаление сервиса <id>`).
  - `stepOfFinding(kind, f: Finding | LoadError, path: string): string | null` — сопоставляет находку шагу: `a1.foreign-db`/`a1.foreign-bucket` → `links`; `security.no-waf` → `publish`; `meta.no-owner` → `people`; `naming.*` → `main`; `chain.*` → `links`; ошибки схемы/ссылок по пути поля (`/segment` → `place`, `/calls…` → `links` и т. п.); не относится к файлу → `null` (показывается на `review`).
  - `previewNames(s: WizardState, platform): DerivedNames | null` — `deriveNames` по текущим полям (null при пустом имени).
- [ ] **Step 1: Write the failing tests**
  - `startEdit('service', 'sales/crm/services/orders.yaml', text)` → `toChange(s, 'b1')` без правок даёт `content === text` (идемпотентность).
  - Новый сервис `notify`/`worker` в `sales`/`crm` → `path === 'sales/crm/services/notify-worker.yaml'`, `label === 'Новый сервис crm-notify-worker'`, `baseBlobId === null`.
  - `unknownFields('service', {name:'x', foo:1})` === `['foo']`.
  - `stepOfFinding` для каждого правила из списка выше и для ошибки схемы `Схема: /cluster: …` → `place`.
  - `previewNames` для `notify`/`worker` → `tuz === 'svc-crm-notify-worker-prod'`.
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 8: Оболочка редактора — вход, загрузка, дерево, мастер (шаги ввода)

**Files:**
- Create: `_tool/editor/index.html`, `_tool/editor/main.ts`, `_tool/editor/wizard.ts`, `_tool/editor/styles.css`
- Test: поведение UI проверяется e2e в Task 10; здесь — ручная проверка скриншотами (Step 1)

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  - `boot(doc: Document, deps: { fetch: typeof fetch; storage: Storage; session: Storage; location: Location }): Promise<void>` — читает `config.json`; режим `gitlab` (есть `oauthClientId`) или `offline` (грузит `model.json`); в режиме `gitlab`: обработка `?code&state` после редиректа (обмен кода, очистка адресной строки `history.replaceState`), иначе кнопка «Войти через GitLab».
  - Состояние приложения в одном объекте `AppState { mode; cfg?; client?; user?; files; blobs; baseSha?; builtAt?; validation; cart: Cart; wizard?: WizardState; step: string }`; после каждого изменения формы: `validateFiles(applyCart(files, [...cart, текущая правка]))` с debounce 300 мс.
  - Экран: шапка (`Архитектура · Редактор`, пользователь, счётчик корзины «Изменений: N», в offline — «Модель от <builtAt>»), баннер открытых MR пользователя (`openMrs`), слева дерево команд/продуктов/сервисов с кнопками «+ команда», «+ продукт», «+ сервис», «Удалить сервис»; справа мастер: полоса шагов (`✓` — шаг без ошибок, `!` — с ошибками), поля шага, ошибки этого шага (по `stepOfFinding`), выведенные имена (`previewNames`) на шаге «Основное», поля только для чтения с пометкой «меняется вручную в YAML», кнопки «Назад»/«Далее»/«В корзину».
  - Поля-ссылки — `<select>` из `pickLists`; списки объектов (`databases`, `calls`, `uses`, `owners`, …) — строки с «+ добавить»/«удалить»; для `uses` с ресурсом `kind: s3` появляются поля `bucket`, `access`; для `exposure` по умолчанию при `audience: internet` подставляется `via: [<первый waf>, <первый ingress>]`.
  - Кэш модели: `files`/`blobs` по `baseSha` в `sessionStorage` (ключ `arch-editor:model:<projectPath>:<baseSha>`); если голова ветки не изменилась — без повторной загрузки.
  - Черновик: `saveDraft` при каждом изменении корзины; при старте `loadDraft` + `reconcile` с `blobs`; конфликтные — список с кнопками «Отбросить мою правку» и «Открыть заново».
  - Review Focus 3: любой `GitLabError.kind === 'auth'` → модальное «Сессия истекла — войти снова» (корзина уже в черновике, после входа восстанавливается).
- [ ] **Step 1:** В этой задаче отдельных unit-тестов UI нет (логика в Tasks 3–7); вместо них — e2e Task 10. Здесь: `npm run editor:dev` (временный скрипт: `buildEditor` в `_dist/editor` + статический сервер с фейковым GitLab) и ручная проверка исполнителем через puppeteer-скриншоты трёх экранов (вход, шаг «Связи», конфликт черновика) в каталог `.superpowers/` (не коммитить), с перечислением в отчёте.
- [ ] **Step 2: Implement** `index.html`, `main.ts`, `wizard.ts`, `styles.css` (CSS-токены и темы из `viewer/styles.css`, вынести общие токены в `viewer/tokens.css` и подключить в обоих).
- [ ] **Step 3:** `npx tsc --noEmit`; `npx vitest run`; `npm run test:e2e` (существующие) — PASS.

---

### Task 9: Шаг «Проверка и MR» — предпросмотр, diff, создание MR / скачивание

**Files:**
- Create: `_tool/editor/review.ts`
- Modify: `_tool/editor/wizard.ts` (подключить шаг), `_tool/viewer/render.ts` (только если нужен экспорт для встраивания — без изменения поведения)
- Test: `_tool/test/editor-review.test.ts`

**Interfaces:**
- Consumes: `GraphView`, `toElements`, `ElementOptions` (`viewer/render.ts`), `buildView`, `Validation`, `Cart`, `mr.ts`, `GitLabClient`.
- Produces:
  - `lineDiff(a: string, b: string): { kind: ' ' | '+' | '-'; text: string }[]` — построчный diff (LCS), для показа изменений.
  - `reviewSummary(v: Validation, changes: Change[]): { errors: (Finding | LoadError)[]; warnings: Finding[]; canSubmit: boolean }` — `canSubmit` = нет ошибок (load + error findings) и корзина не пуста.
  - `submit(app: AppState, title: string, description: string, rnd): Promise<{ webUrl: string }>` — `lastCommitId` для update/delete → `commitActions` → `createCommit({ branch: branchName(title, rnd), startSha: baseSha, message: 'arch: ' + title })` → `createMr` → очистка корзины и черновика; `GitLabError.kind === 'conflict'` → сообщение «Файл <путь> изменён в main после загрузки — обновите модель (кнопка «Обновить»), ваши правки сохранены» и корзина не очищается.
  - UI шага: переключатель 5 разрезов + `GraphView` в охвате изменяемого продукта (для команды — охват команды), список ошибок/предупреждений с переходом к шагу, diff каждого файла корзины, поля «Заголовок» (`defaultTitle`) и «Описание» (`mrDescription`), кнопка «Создать MR» (`canSubmit`) или в offline «Скачать изменения» (`zipChanges` → Blob → `<a download>`).
- [ ] **Step 1: Write the failing tests** — `lineDiff` (добавление, удаление, замена одной строки), `reviewSummary` (ошибка блокирует; только предупреждения — можно; пустая корзина — нельзя); `submit` с fake GitLab: успешный путь возвращает `webUrl`, фейк получил commit с `start_sha` = `baseSha` и `last_commit_id` для update; конфликт → брошена ошибка с путём файла, корзина не пуста.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npx tsc --noEmit`.

---

### Task 10: Сборка, публикация на Pages, CODEOWNERS, README, e2e сценарии

**Files:**
- Create: `_tool/src/build/editor.ts`, `_tool/test/e2e/editor.test.ts`, `CODEOWNERS.example` (корень репозитория)
- Modify: `_tool/package.json` (`editor:build`, удалить временный `editor:dev` или оставить как `editor:serve`), `_tool/README.md` (раздел «Редактор»), `README.md` корня (короткий раздел и ссылка)
- Test: `_tool/test/e2e/editor.test.ts`, `_tool/test/editor-build.test.ts`

**Interfaces:**
- Consumes: всё выше.
- Produces:
  - `buildEditor(outDir: string, cfg: EditorConfig | null): Promise<void>` — пишет `index.html`, `editor.js` (esbuild IIFE, alias elkjs как у просмотрщика), `editor.css`, `config.json` (если `cfg`); `npm run editor:build` берёт `cfg` из переменных окружения `ARCH_GITLAB_URL`, `ARCH_PROJECT_PATH`, `ARCH_OAUTH_CLIENT_ID`, `ARCH_REDIRECT_URI`, `ARCH_BASE_BRANCH` (по умолчанию `main`) и пишет в `<root>/_dist/editor/`; также запускает `arch-views build` рядом (для `model.json` в offline).
  - README: пример задания GitLab CI `pages` (собирает `_dist/editor` и `_dist/index.html` в `public/`), ссылка на `editor/SPIKE.md` для регистрации OAuth-приложения, описание запасного режима, `CODEOWNERS.example` (`/_shared/ @arch-team`, `/sales/ @arch-team @sales-owner` — с пометкой заменить группы).
- [ ] **Step 1: Write the failing tests**
  - `editor-build.test.ts`: `buildEditor(tmp, cfg)` создаёт 4 файла; в `index.html`/`editor.js` нет `http(s)://` вне строк из `cfg` (нет CDN); без `cfg` нет `config.json`.
  - `e2e/editor.test.ts` (fake GitLab + Chrome):
    1. Вход → загрузка демо → «+ сервис» в CRM → заполнить `notify2`/`worker`, сегмент `app`, кластер `k8s-prod-2`, ответственный → шаг «Проверка и MR» → «Создать MR» → на странице ссылка на MR; фейк получил commit с `create` `sales/crm/services/notify2-worker.yaml` и MR с меткой `arch-editor`.
    2. Изменить `crm-orders` (кластер `k8s-prod-2`) → в diff ровно одна строка `-`/`+`; в commit — `update` с `last_commit_id`.
    3. Review Focus 2: открыть `crm-orders`, в фейке изменить файл (`setFile`), «Создать MR» → текст «изменён в main после загрузки», корзина «Изменений: 1».
    4. Review Focus 4: «Удалить сервис» `pay-billing` → кнопка MR неактивна, ошибка ссылается на `orders.yaml`.
    5. Review Focus 3: фейк начинает отвечать 401 → модальное «Сессия истекла»; после повторного входа корзина на месте.
    6. Offline: без `config.json`, с `model.json` → «Скачать изменения» доступна, «Создать MR» нет; кнопка генерирует скачивание (перехват через `page.on('response')`/`Browser.setDownloadBehavior`).
    7. Изменения `_shared` недоступны: в дереве нет `_shared`, кнопок редактирования для него нет.
- [ ] **Step 2–4:** FAIL → implement → `npx vitest run`, `npm run test:e2e`, `npx tsc --noEmit` — PASS.
- [ ] **Step 5:** собрать редактор и сделать скриншоты шагов «Связи» и «Проверка и MR» (не коммитить) для контроллера.
