import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core';
import { buildEditorSite } from '../../src/build/editor.js';
import { readModelFiles } from '../../src/model/load.js';
import { FAKE_TOKEN, startFakeGitLab, type FakeGitLab } from '../fake-gitlab.js';

// Редактор в headless Chrome против фальшивого GitLab. Раскладка как на Pages: public/index.html — просмотрщик,
// public/editor/ — редактор (config.json отдаётся сервером, model.json лежит рядом для запасного режима).
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = existsSync(CHROME);
if (!hasChrome) console.warn(`[e2e] Chrome не найден (${CHROME}): тесты редактора пропущены. Укажите CHROME_PATH.`);
/** Каталог для скриншотов шагов «Связи» и «Проверка и MR» (для ревью; в тестах не обязателен). */
const SCREENS = process.env.ARCH_E2E_SCREENS;

const T = 20_000;
const ORDERS = 'sales/crm/services/orders.yaml';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
/** Фейк нумерует коммиты sha1('c1'), sha1('c2')…: начальное состояние main — первый коммит. */
const INITIAL_COMMIT = sha1('c1');

type Commit = { branch: string; start_branch?: string; start_sha?: string; commit_message: string; actions: { action: string; file_path: string; content?: string; last_commit_id?: string }[] };

describe.skipIf(!hasChrome)('редактор: сценарии в Chrome с фальшивым GitLab', () => {
  const demo = readModelFiles('examples/demo');
  let tmp: string;
  let pub: string;
  let site: Server;
  let origin: string;
  let editorUrl: string;
  let cfgJson: string | null = null;
  let browser: Browser;
  let ctx: BrowserContext;
  let fake: FakeGitLab | undefined;
  const errors: string[] = [];
  const external: string[] = [];
  /** Цели, кроме самой вкладки сценария (воркеры, service worker, всплывающие окна): их запросы page.on('request') не видит. */
  const targets: string[] = [];
  /** Тексты confirm/alert; confirm «Удалить сервис…» принимается, если acceptDelete, остальные диалоги отклоняются. */
  const dialogs: string[] = [];
  let acceptDelete = true;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'arch-e2e-editor-'));
    pub = join(tmp, 'public');
    await buildEditorSite('examples/demo', pub, null, { stdout: () => {}, stderr: () => {} });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    site = createServer((req, res) => {
      let p = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
      if (p === '/editor/config.json') {
        return void (cfgJson === null ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': 'application/json' }).end(cfgJson));
      }
      if (p.endsWith('/')) p += 'index.html';
      const file = join(pub, p);
      if (!file.startsWith(pub) || !existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
    });
    await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    editorUrl = `${origin}/editor/`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    if (SCREENS) mkdirSync(SCREENS, { recursive: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((ok) => (site ? site.close(() => ok()) : ok()));
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    await ctx?.close();
    await fake?.close();
    fake = undefined;
    cfgJson = null;
  });

  /** Новая изолированная вкладка (свои localStorage/sessionStorage); online — с фейком и config.json. */
  async function setup(online: boolean): Promise<Page> {
    errors.length = 0;
    external.length = 0;
    targets.length = 0;
    dialogs.length = 0;
    acceptDelete = true;
    if (online) {
      fake = await startFakeGitLab({ files: demo });
      cfgJson = JSON.stringify({ gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'e2e-client', redirectUri: editorUrl, baseBranch: 'main' });
    }
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    ctx.on('targetcreated', (t) => targets.push(`${t.type()}: ${t.url()}`));
    page.on('workercreated', (w) => targets.push(`worker: ${w.url()}`));
    await page.setViewport({ width: 1440, height: 1000 });
    page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message ?? String(e)}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    page.on('request', (r) => {
      const u = r.url();
      if (/^(data|blob|about):/.test(u) || u.startsWith(`${origin}/`) || (fake && u.startsWith(`${fake.url}/`))) return;
      external.push(u);
    });
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void (acceptDelete && /^Удалить сервис/.test(d.message()) ? d.accept() : d.dismiss());
    });
    return page;
  }

  const ready = (page: Page) => page.waitForSelector('body[data-state="ready"]', { timeout: T });

  async function login(page: Page): Promise<void> {
    if (!page.url().startsWith(editorUrl)) await page.goto(editorUrl);
    await page.waitForSelector('#login', { timeout: T });
    await Promise.all([page.waitForNavigation({ timeout: T }), page.click('#login')]);
    await ready(page);
  }

  /** Клик по элементу с селектором, чей текст содержит text (ждёт появления). */
  async function clickText(page: Page, selector: string, text: string): Promise<void> {
    await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some((e) => (e.textContent ?? '').includes(t)), { timeout: T }, selector, text);
    await page.evaluate((sel, t) => {
      [...document.querySelectorAll<HTMLElement>(sel)].find((e) => (e.textContent ?? '').includes(t))!.click();
    }, selector, text);
  }

  const step = (page: Page, title: string) => clickText(page, 'nav.steps button', title);

  /** Кнопка в дереве: внутри продукта `product` — узел сервиса `base` (или «+ сервис» при base = null). */
  async function treeClick(page: Page, product: string, base: string | null, what: 'open' | 'delete' = 'open'): Promise<void> {
    const ok = await page.evaluate((p, b, w) => {
      const prod = [...document.querySelectorAll<HTMLElement>('#tree button.node')].find((x) => x.querySelector('.k')?.textContent === p);
      const li = prod?.parentElement;
      if (!li) return false;
      if (b === null) {
        const add = [...li.querySelectorAll<HTMLElement>('button.add')].find((x) => x.textContent === '+ сервис');
        add?.click();
        return !!add;
      }
      const svc = [...li.querySelectorAll<HTMLElement>('li.svc')].find((x) => {
        const n = x.querySelector('button.node');
        return n && n.childNodes[1]?.textContent === b;
      });
      const target = w === 'open' ? svc?.querySelector<HTMLElement>('button.node') : svc?.querySelector<HTMLElement>('button[aria-label="Удалить сервис"]');
      target?.click();
      return !!target;
    }, product, base, what);
    expect(ok, `дерево: ${product}/${base ?? '+ сервис'}`).toBe(true);
  }

  async function openReview(page: Page): Promise<void> {
    await step(page, 'Проверка и MR');
    await page.waitForSelector('#review #reviewStatus', { timeout: T });
  }

  const text = (page: Page, sel: string) => page.$eval(sel, (e) => e.textContent ?? '');
  const commits = () => fake!.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/repository/commits')).map((r) => r.body as Commit);
  const mrPosts = () => fake!.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/merge_requests'));
  const mainFile = async (path: string) => {
    const r = await fetch(`${fake!.url}/api/v4/projects/grp%2Farch/repository/files/${encodeURIComponent(path)}/raw?ref=main`, { headers: { authorization: `Bearer ${FAKE_TOKEN}` } });
    return r.text();
  };

  /** Открыть crm-orders и сменить кластер на k8s-prod-2. */
  async function editOrdersCluster(page: Page): Promise<void> {
    await treeClick(page, 'crm', 'orders');
    await page.waitForFunction(() => document.getElementById('wizPath')?.textContent === 'sales/crm/services/orders.yaml', { timeout: T });
    await step(page, 'Размещение');
    await page.waitForSelector('select[aria-label="Кластер"]', { timeout: T });
    await page.select('select[aria-label="Кластер"]', 'k8s-prod-2');
  }

  async function submitAndWaitLink(page: Page): Promise<string> {
    await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
    await page.click('#createMr');
    await page.waitForSelector('#mrLink', { timeout: T });
    return page.$eval('#mrLink', (a) => (a as HTMLAnchorElement).href);
  }

  function clean(): void {
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(targets).toEqual([]);
  }

  it('1. вход → новый сервис notify2/worker в CRM → MR', async () => {
    const page = await setup(true);
    await login(page);
    expect(await text(page, '#user')).toContain('@tester');
    await treeClick(page, 'crm', null);
    await page.waitForSelector('input[aria-label="Имя (name)"]', { timeout: T });
    await page.type('input[aria-label="Имя (name)"]', 'notify2');
    await page.select('select[aria-label="Тип"]', 'worker');
    await step(page, 'Размещение');
    await page.waitForSelector('select[aria-label="Сегмент сети"]', { timeout: T });
    await page.select('select[aria-label="Сегмент сети"]', 'app');
    await page.select('select[aria-label="Кластер"]', 'k8s-prod-2');
    await step(page, 'Связи');
    await clickText(page, 'fieldset.rows button.add', '+ добавить'); // первый список — «Синхронные вызовы»
    await page.waitForSelector('select[aria-label="Кого вызывает"]', { timeout: T });
    await page.select('select[aria-label="Кого вызывает"]', 'pay-billing');
    await page.type('input[aria-label="Протокол"]', 'grpc');
    if (SCREENS) await page.screenshot({ path: join(SCREENS, 'task10-step-links.png'), fullPage: true });
    await step(page, 'Ответственные и ссылки');
    await clickText(page, 'fieldset.rows button.add', '+ добавить');
    await page.waitForSelector('input[aria-label="Роль"]', { timeout: T });
    await page.type('input[aria-label="Роль"]', 'techlead');
    await page.type('input[aria-label="Имя"]', 'Петров П.');
    await page.type('input[aria-label="Контакт"]', '@petrov');
    await openReview(page);
    await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
    expect(await text(page, '#review')).toContain('sales/crm/services/notify2-worker.yaml');
    if (SCREENS) {
      await page.waitForFunction(() => !!document.body.dataset.preview, { timeout: T });
      await page.screenshot({ path: join(SCREENS, 'task10-step-review.png'), fullPage: true });
    }
    const href = await submitAndWaitLink(page);
    expect(href).toBe(`${fake!.url}/grp/arch/-/merge_requests/1`);

    const [c] = commits();
    expect(c!.branch).toMatch(/^arch\/[a-z0-9-]+-[a-z0-9]{4}$/);
    // start_branch, не start_sha: только так GitLab сверяет last_commit_id с текущим main
    expect(c!.start_branch).toBe('main');
    expect(c!.start_sha).toBeUndefined();
    expect(c!.commit_message).toMatch(/^arch: /);
    expect(c!.actions.map((a) => [a.action, a.file_path])).toEqual([['create', 'sales/crm/services/notify2-worker.yaml']]);
    expect(c!.actions[0]!.content).toContain('cluster: k8s-prod-2');
    expect(c!.actions[0]!.content).toContain('target: pay-billing');
    const mr = mrPosts()[0]!.body as { title: string; labels: string; source_branch: string; target_branch: string; remove_source_branch: boolean };
    expect(c!.commit_message).toBe(`arch: ${mr.title}`);
    expect(mr.labels).toBe('arch-editor');
    expect(mr.remove_source_branch).toBe(true);
    expect(mr.source_branch).toBe(c!.branch);
    expect(mr.target_branch).toBe('main');
    expect(await text(page, '#cartCount')).toBe('Изменений: 0');
    clean();
  });

  it('2. изменение crm-orders: в diff одна строка −/+, в коммите update с last_commit_id', async () => {
    const page = await setup(true);
    await login(page);
    await editOrdersCluster(page);
    await openReview(page);
    const rm = await page.$$eval('#review pre.diff span.rm', (els) => els.map((e) => e.textContent));
    const add = await page.$$eval('#review pre.diff span.add', (els) => els.map((e) => e.textContent));
    expect(rm).toEqual(['- cluster: k8s-prod-1']);
    expect(add).toEqual(['+ cluster: k8s-prod-2']);
    await submitAndWaitLink(page);

    const [c] = commits();
    expect(c!.actions).toHaveLength(1);
    const a = c!.actions[0]!;
    expect([a.action, a.file_path, a.last_commit_id]).toEqual(['update', ORDERS, INITIAL_COMMIT]);
    expect(a.content).toBe(demo[ORDERS]!.replace('cluster: k8s-prod-1', 'cluster: k8s-prod-2'));
    clean();
  });

  it('3. main ушёл вперёд: ничего не пишется, модель перезагружается; изменённый файл — конфликт, корзина в черновике, main не перезаписан', async () => {
    const page = await setup(true);
    await login(page);
    await editOrdersCluster(page);
    await openReview(page);
    await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
    const moved = (p: Page) => p.waitForFunction(() => (document.getElementById('mrStatus')?.textContent ?? '').includes('main обновился'), { timeout: T });

    // (а) в main изменён другой файл: коммита нет, модель перезагружена, правка применена заново
    fake!.setFile('sales/pay/services/billing.yaml', `${demo['sales/pay/services/billing.yaml']}# чужая правка\n`);
    await page.click('#createMr');
    await moved(page);
    expect(await text(page, '#mrStatus')).toContain('модель перезагружена, проверьте изменения и отправьте снова');
    expect(commits()).toEqual([]);
    expect(await text(page, '#cartCount')).toBe('Изменений: 1');
    expect(await page.$('#conflicts')).toBeNull();
    expect(await text(page, '#review')).toContain(ORDERS);

    // (б) в main изменён сам orders.yaml: коммита нет, после перезагрузки правка — конфликт в баннере, в MR не войдёт
    const theirs = `${demo[ORDERS]}# правка коллеги в main\n`;
    fake!.setFile(ORDERS, theirs);
    await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
    await page.click('#createMr');
    await page.waitForSelector('#conflicts', { timeout: T });
    await moved(page);
    expect(await text(page, '#conflicts')).toContain(ORDERS);
    expect(await text(page, '#conflictNote')).toContain('1 правка черновика ждёт решения и в MR не войдёт');
    expect(await text(page, '#cartCount')).toBe('Изменений: 0');
    const draft = await page.evaluate(() => localStorage.getItem('arch-editor:draft:grp/arch') ?? '');
    expect(draft).toContain(ORDERS);
    expect(draft).toContain('cluster: k8s-prod-2');
    expect(commits()).toEqual([]);
    expect(mrPosts()).toEqual([]);
    expect(await mainFile(ORDERS)).toBe(theirs);
    clean();
  });

  it('4. удаление pay-billing, на который ссылаются: подтверждение, MR недоступен, ошибка указывает на orders.yaml; убрать из корзины — MR снова доступен', async () => {
    const page = await setup(true);
    await login(page);
    await editOrdersCluster(page);
    await clickText(page, '.wiz-nav button.primary', 'В корзину');
    await page.waitForFunction(() => document.getElementById('cartCount')?.textContent === 'Изменений: 1', { timeout: T });
    // отказ в подтверждении — удаления нет
    acceptDelete = false;
    await treeClick(page, 'pay', 'billing', 'delete');
    expect(dialogs).toEqual(['Удалить сервис pay-billing? Удаление попадёт в корзину; убрать его можно до создания MR.']);
    expect(await text(page, '#cartCount')).toBe('Изменений: 1');
    acceptDelete = true;
    await treeClick(page, 'pay', 'billing', 'delete');
    await page.waitForFunction(() => document.getElementById('cartCount')?.textContent === 'Изменений: 2', { timeout: T });
    expect(await page.$('#tree li.svc.gone button[aria-label="Убрать из корзины"]')).not.toBeNull();
    await page.click('#cartCount');
    await page.waitForSelector('#review #reviewStatus', { timeout: T });
    expect(await page.$eval('#createMr', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(await text(page, '#reviewStatus')).toMatch(/Ошибок: [1-9]/);
    const findings = await page.$$eval('#review .findings .find', (els) => els.map((e) => e.textContent ?? ''));
    const errs = findings.filter((f) => f.includes('ошибка'));
    expect(errs.some((f) => f.includes(ORDERS) && f.includes('pay-billing')), JSON.stringify(findings)).toBe(true);
    expect(commits()).toEqual([]);

    await page.click('#review button[data-remove="sales/pay/services/billing.yaml"]');
    await page.waitForFunction(() => document.getElementById('cartCount')?.textContent === 'Изменений: 1', { timeout: T });
    await page.waitForFunction(() => (document.getElementById('reviewStatus')?.textContent ?? '').startsWith('Ошибок нет'), { timeout: T });
    await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
    expect(await page.$('#review button[data-remove="sales/pay/services/billing.yaml"]')).toBeNull();
    expect(await page.$('#tree li.svc.gone')).toBeNull();
    clean();
  });

  it('5. токен отозван (401): «Сессия истекла», после повторного входа корзина на месте', async () => {
    const page = await setup(true);
    await login(page);
    await editOrdersCluster(page);
    await clickText(page, '.wiz-nav button.primary', 'В корзину');
    await page.waitForFunction(() => document.getElementById('cartCount')?.textContent === 'Изменений: 1', { timeout: T });
    fake!.revokeToken();
    await openReview(page);
    await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
    await page.click('#createMr');
    await page.waitForSelector('#modal:not([hidden]) [role="alertdialog"]', { timeout: T });
    expect(await text(page, '#modal')).toContain('Сессия истекла');
    // токен — только в памяти вкладки
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toContain(FAKE_TOKEN);

    await Promise.all([page.waitForNavigation({ timeout: T }), clickText(page, '#modal button', 'Войти снова')]);
    await ready(page);
    expect(await text(page, '#cartCount')).toBe('Изменений: 1');
    expect(await text(page, '#tree')).toContain('изменён');
    // с новым токеном MR создаётся
    await page.click('#cartCount');
    await page.waitForSelector('#review #reviewStatus', { timeout: T });
    await submitAndWaitLink(page);
    expect(commits()[0]!.actions.map((a) => a.file_path)).toEqual([ORDERS]);
    clean();
  });

  it('6. запасной режим: без config.json, model.json рядом — «Скачать изменения» вместо «Создать MR», zip', async () => {
    const page = await setup(false);
    const dl = join(tmp, `dl-${Date.now()}`);
    mkdirSync(dl);
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, browserContextId: ctx.id, eventsEnabled: true });
    const model = page.waitForResponse((r) => r.url() === `${editorUrl}model.json`, { timeout: T });
    await page.goto(editorUrl);
    expect((await model).status()).toBe(200);
    await ready(page);
    expect(await text(page, '#builtAt')).toMatch(/^Модель от \d/);
    await editOrdersCluster(page);
    await openReview(page);
    expect(await page.$('#createMr')).toBeNull();
    expect(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Создать MR'))).toBe(false);
    await page.waitForSelector('#download:not([disabled])', { timeout: T });
    expect(await text(page, '#download')).toBe('Скачать изменения');
    await page.click('#download');
    await page.waitForFunction(() => (document.getElementById('mrStatus')?.textContent ?? '').includes('скачан'), { timeout: T });

    let zip = '';
    for (let i = 0; i < 100 && !zip; i++) {
      zip = readdirSync(dl).find((f) => f.endsWith('.zip')) ?? '';
      if (!zip) await new Promise((r) => setTimeout(r, 100));
    }
    expect(zip).toMatch(/\.zip$/);
    const entries = unzipSync(readFileSync(join(dl, zip)));
    expect(Object.keys(entries).sort()).toEqual(['MR.md', ORDERS]);
    expect(strFromU8(entries[ORDERS]!)).toContain('cluster: k8s-prod-2');
    await cdp.detach();
    clean();
  });

  it('7. _shared недоступен: нет в дереве, нет кнопок, правка из черновика отброшена', async () => {
    const page = await setup(true);
    await page.goto(editorUrl);
    await page.waitForSelector('#login', { timeout: T });
    await page.evaluate((c) => localStorage.setItem('arch-editor:draft:grp/arch', JSON.stringify([
      { path: '_shared/platform.yaml', content: `${c}# моя правка\n`, baseBlobId: null, label: 'платформа' },
    ])), demo['_shared/platform.yaml']!);
    await login(page);
    expect(await text(page, '#cartCount')).toBe('Изменений: 0');
    const tree = await page.$eval('#tree', (el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector('p.shared')?.remove();
      return { text: copy.innerText, nodes: [...copy.querySelectorAll('button')].map((b) => b.textContent ?? '') };
    });
    expect(tree.text).not.toMatch(/_shared|network|platform/);
    expect(tree.nodes.filter((n) => /_shared|network|platform/.test(n))).toEqual([]);
    expect(await text(page, '#tree p.shared')).toContain('только чтение');
    expect(commits()).toEqual([]);
    clean();
  });
});
