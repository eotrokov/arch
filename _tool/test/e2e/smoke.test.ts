import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadTree } from '../../src/model/load.js';
import { resolveModel } from '../../src/model/resolve.js';
import { runChecks } from '../../src/checks/index.js';
import { buildHtml } from '../../src/build/html.js';
import { toHash } from '../../viewer/state.js';
import type { Scope, ViewKind } from '../../src/views/types.js';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = existsSync(CHROME);
if (!hasChrome) console.warn(`[e2e] Chrome не найден (${CHROME}): смоук-тест пропущен. Укажите CHROME_PATH.`);

const VIEWS: ViewKind[] = ['kubernetes', 'containers', 'firewall', 'databases', 'dataflows'];
const SCOPES: Scope[] = [
  { kind: 'company', expanded: [] },
  { kind: 'team', id: 'sales' },
  { kind: 'product', id: 'crm' },
  { kind: 'product', id: 'pay' },
  { kind: 'service', id: 'crm-orders-ui' },
];
const scopeKey = (s: Scope) => (s.kind === 'company' ? 'company' : `${s.kind}:${s.id}`);

/**
 * Пусты по построению: в company без раскрытых продуктов сервисы свёрнуты (k8s и БД их не показывают);
 * crm-orders-ui не ходит в БД и не передаёт сущностей (в потоках — только участники рёбер).
 */
const EMPTY = new Set(['kubernetes|company', 'databases|company', 'databases|service:crm-orders-ui', 'dataflows|service:crm-orders-ui']);

describe.skipIf(!hasChrome)(`viewer smoke (headless Chrome: ${CHROME})`, () => {
  let dir: string;
  let html: string;
  let url: string;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const external: string[] = [];

  const waitRendered = (expected: string) =>
    page.waitForFunction((x) => document.body.dataset.rendered === x, { timeout: 15_000 }, expected);

  beforeAll(async () => {
    const { tree, errors: loadErrors } = loadTree('examples/demo');
    expect(loadErrors).toEqual([]);
    const model = resolveModel(tree!).model!;
    html = await buildHtml({ model, findings: runChecks(tree!, model), builtAt: '2026-11-18T00:00:00Z' });
    dir = mkdtempSync(join(tmpdir(), 'arch-e2e-'));
    writeFileSync(join(dir, 'index.html'), html);
    url = pathToFileURL(join(dir, 'index.html')).href;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message ?? String(e)}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('request', (r) => { if (!/^(file|data|about|blob):/.test(r.url())) external.push(r.url()); });
    await page.goto(url);
    await waitRendered('containers|company');
  });

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('HTML has no external URLs in src/href and embeds data', () => {
    expect(html).toContain('<title>Архитектура</title>');
    expect(html).toContain('id="arch-data"');
    expect(html.match(/\b(?:src|href)\s*=\s*["']?\s*https?:/gi) ?? []).toEqual([]);
  });

  for (const view of VIEWS) {
    for (const scope of SCOPES) {
      const key = `${view}|${scopeKey(scope)}`;
      it(`renders ${key}`, async () => {
        await page.evaluate((h) => { location.hash = h; }, toHash({ view, scope }));
        await waitRendered(key);
        const count = Number(await page.evaluate(() => document.body.dataset.nodeCount));
        if (EMPTY.has(key)) expect(count).toBe(0);
        else expect(count).toBeGreaterThan(0);
        const emptyMsg = await page.$eval('#graphEmpty', (el) => ((el as HTMLElement).hidden ? '' : el.textContent ?? ''));
        if (key === 'kubernetes|company' || key === 'databases|company') {
          expect(emptyMsg).toBe('Раскройте продукт (двойной клик) или выберите продукт слева');
        } else if (EMPTY.has(key)) expect(emptyMsg).toContain('нет элементов');
        else expect(emptyMsg).toBe('');
        expect(errors).toEqual([]);
      });
    }
  }

  it('firewall product:crm table has the 5432/tcp row to pg-crm', async () => {
    await page.evaluate((h) => { location.hash = h; }, toHash({ view: 'firewall', scope: { kind: 'product', id: 'crm' } }));
    await waitRendered('firewall|product:crm');
    const rows = await page.$$eval('#bbody tr', (trs) => trs.map((tr) => (tr as HTMLElement).innerText));
    expect(rows.some((r) => r.includes('5432/tcp') && r.includes('pg-crm.db.company.ru'))).toBe(true);
  });

  it('reload with hash restores view and card', async () => {
    await page.evaluate(() => { location.hash = '#view=databases&scope=product:crm&sel=db:crm_orders'; });
    await page.reload();
    await waitRendered('databases|product:crm');
    expect(await page.$eval('#viewTabs [aria-selected="true"]', (b) => b.textContent)).toBe('БД');
    expect(await page.$eval('#card', (c) => (c as HTMLElement).dataset.node)).toBe('db:crm_orders');
    expect(await page.$eval('#card h2', (h) => h.textContent)).toContain('crm_orders');
    expect(errors).toEqual([]);
  });

  it('makes no network requests', () => expect(external).toEqual([]));
});
