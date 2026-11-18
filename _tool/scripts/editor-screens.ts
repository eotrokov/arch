// Скриншоты редактора для документации: `npm run editor:screens [-- <каталог>]`.
// Собирает сайт по демо-модели, поднимает фальшивый GitLab и проходит основные сценарии в Chrome.
// По умолчанию пишет в ../_docs/img/editor/. Chrome — CHROME_PATH или стандартный путь macOS.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { buildEditorSite } from '../src/build/editor.js';
import { readModelFiles } from '../src/model/load.js';
import { startFakeGitLab, type FakeGitLab } from '../test/fake-gitlab.js';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve(process.argv[2] ?? '../_docs/img/editor');
const T = 15_000;
const ORDERS = 'sales/crm/services/orders.yaml';

if (!existsSync(CHROME)) throw new Error(`Chrome не найден: ${CHROME}. Укажите CHROME_PATH.`);
mkdirSync(OUT, { recursive: true });
const demo = readModelFiles('examples/demo');
const tmp = mkdtempSync(join(tmpdir(), 'arch-editor-screens-'));
const pub = join(tmp, 'public');
await buildEditorSite('examples/demo', pub, null, { stdout: () => {}, stderr: () => {} });

let cfgJson: string | null = null;
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const site = createServer((req, res) => {
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
const editorUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/editor/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });

let fake: FakeGitLab | undefined;
async function session(online: boolean): Promise<Page> {
  await fake?.close();
  fake = online ? await startFakeGitLab({ files: demo }) : undefined;
  cfgJson = fake ? JSON.stringify({ gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'demo', redirectUri: editorUrl, baseBranch: 'main' }) : null;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.on('dialog', (d) => void d.accept());
  await page.goto(editorUrl);
  return page;
}
const ready = (page: Page) => page.waitForSelector('body[data-state="ready"]', { timeout: T });
async function login(page: Page): Promise<void> {
  await page.waitForSelector('#login', { timeout: T });
  await Promise.all([page.waitForNavigation({ timeout: T }), page.click('#login')]);
  await ready(page);
}
async function clickText(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some((e) => (e.textContent ?? '').includes(t)), { timeout: T }, selector, text);
  await page.evaluate((sel, t) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => (e.textContent ?? '').includes(t))!.click(), selector, text);
}
const step = (page: Page, title: string) => clickText(page, 'nav.steps button', title);
async function tree(page: Page, product: string, base: string | null, what: 'open' | 'delete' = 'open'): Promise<void> {
  await page.evaluate((p, b, w) => {
    const li = [...document.querySelectorAll<HTMLElement>('#tree button.node')].find((x) => x.querySelector('.k')?.textContent === p)?.parentElement;
    if (!li) throw new Error(`нет продукта ${p}`);
    if (b === null) return void [...li.querySelectorAll<HTMLElement>('button.add')].find((x) => x.textContent === '+ сервис')!.click();
    const svc = [...li.querySelectorAll<HTMLElement>('li.svc')].find((x) => x.querySelector('button.node')?.childNodes[1]?.textContent === b)!;
    svc.querySelector<HTMLElement>(w === 'open' ? 'button.node' : 'button[aria-label="Удалить сервис"]')!.click();
  }, product, base, what);
}
async function openReview(page: Page): Promise<void> {
  await step(page, 'Проверка и MR');
  await page.waitForSelector('#review #reviewStatus', { timeout: T });
  await page.waitForFunction(() => !!document.body.dataset.preview, { timeout: T });
}
const shot = async (page: Page, name: string, fullPage = false) => {
  await page.screenshot({ path: join(OUT, name), fullPage });
  console.log(`  ${name}`);
};

try {
  // 1. Вход
  let page = await session(true);
  await page.waitForSelector('#login', { timeout: T });
  await shot(page, '01-login.png');

  // 2. Новый сервис: шаг «Основное» с выведенными именами
  await login(page);
  await tree(page, 'crm', null);
  await page.waitForSelector('input[aria-label="Имя (name)"]', { timeout: T });
  await page.type('input[aria-label="Имя (name)"]', 'notify2');
  await page.select('select[aria-label="Тип"]', 'worker');
  await page.waitForFunction(() => (document.body.textContent ?? '').includes('svc-crm-notify2-worker'), { timeout: T });
  await shot(page, '02-new-service.png');

  // 3. Размещение и связи
  await step(page, 'Размещение');
  await page.waitForSelector('select[aria-label="Сегмент сети"]', { timeout: T });
  await page.select('select[aria-label="Сегмент сети"]', 'app');
  await page.select('select[aria-label="Кластер"]', 'k8s-prod-2');
  await step(page, 'Связи');
  await clickText(page, 'fieldset.rows button.add', '+ добавить');
  await page.waitForSelector('select[aria-label="Кого вызывает"]', { timeout: T });
  await page.select('select[aria-label="Кого вызывает"]', 'pay-billing');
  await page.type('input[aria-label="Протокол"]', 'grpc');
  await shot(page, '03-step-links.png');

  // 4. Проверка и MR: сводка, предпросмотр, diff, форма MR
  await step(page, 'Ответственные и ссылки');
  await clickText(page, 'fieldset.rows button.add', '+ добавить');
  await page.waitForSelector('input[aria-label="Роль"]', { timeout: T });
  await page.type('input[aria-label="Роль"]', 'techlead');
  await page.type('input[aria-label="Имя"]', 'Петров П.');
  await page.type('input[aria-label="Контакт"]', '@petrov');
  await openReview(page);
  await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
  await shot(page, '04-review.png', true);

  // 5. MR создан
  await page.click('#createMr');
  await page.waitForSelector('#mrLink', { timeout: T });
  await page.evaluate(() => document.getElementById('mrStatus')?.scrollIntoView({ block: 'center' }));
  await shot(page, '05-mr-created.png');

  // 6. Удаление сервиса, на который ссылаются: MR заблокирован
  page = await session(true);
  await login(page);
  await tree(page, 'pay', 'billing', 'delete');
  await page.waitForFunction(() => document.getElementById('cartCount')?.textContent === 'Изменений: 1', { timeout: T });
  await page.click('#cartCount');
  await page.waitForSelector('#review #reviewStatus', { timeout: T }); // при ошибках ссылок модель не строится — предпросмотра нет
  await shot(page, '06-blocked.png');

  // 7. main сдвинулся, правленый файл изменён коллегой: конфликт
  page = await session(true);
  await login(page);
  await tree(page, 'crm', 'orders');
  await page.waitForFunction(() => document.getElementById('wizPath')?.textContent === 'sales/crm/services/orders.yaml', { timeout: T });
  await step(page, 'Размещение');
  await page.waitForSelector('select[aria-label="Кластер"]', { timeout: T });
  await page.select('select[aria-label="Кластер"]', 'k8s-prod-2');
  await openReview(page);
  await page.waitForSelector('#createMr:not([disabled])', { timeout: T });
  fake!.setFile(ORDERS, `${demo[ORDERS]}# правка коллеги в main\n`);
  await page.click('#createMr');
  await page.waitForSelector('#conflicts', { timeout: T });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '07-conflict.png');

  // 8. Запасной режим: скачивание изменений
  page = await session(false);
  await ready(page);
  await tree(page, 'crm', 'orders');
  await page.waitForFunction(() => document.getElementById('wizPath')?.textContent === 'sales/crm/services/orders.yaml', { timeout: T });
  await step(page, 'Размещение');
  await page.waitForSelector('select[aria-label="Кластер"]', { timeout: T });
  await page.select('select[aria-label="Кластер"]', 'k8s-prod-2');
  await openReview(page);
  await page.waitForSelector('#download:not([disabled])', { timeout: T });
  await page.evaluate(() => document.getElementById('download')?.scrollIntoView({ block: 'end' }));
  await shot(page, '08-offline.png');
} finally {
  await browser.close();
  await fake?.close();
  site.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`скриншоты: ${OUT}`);
