import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadTree } from '../../src/model/load.js';
import { resolveModel } from '../../src/model/resolve.js';
import { runChecks } from '../../src/checks/index.js';
import { buildHtml } from '../../src/build/html.js';
import { toHash } from '../../viewer/state.js';

// Враждебные строки из YAML (имена, владельцы, основания) не ломают страницу и не внедряют разметку.
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOSTILE = 'X <!--<script> </script> " \' <img src=x onerror=alert(1)>     end';
const Y = JSON.stringify(HOSTILE); // YAML double-quoted == JSON string

describe.skipIf(!existsSync(CHROME))('viewer with hostile strings', () => {
  let dir: string;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const dialogs: string[] = [];

  const waitRendered = (expected: string) =>
    page.waitForFunction((x) => document.body.dataset.rendered === x, { timeout: 15_000 }, expected);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arch-e2e-hostile-'));
    const root = join(dir, 'model');
    cpSync('examples/demo', root, { recursive: true });
    const patch = (file: string, pairs: [string, string][]) => {
      const p = join(root, file);
      let s = readFileSync(p, 'utf8');
      for (const [a, b] of pairs) {
        if (!s.includes(a)) throw new Error(`${file}: ${a} not found`);
        s = s.replace(a, b);
      }
      writeFileSync(p, s);
    };
    patch('sales/team.yaml', [['name: Продажи', `name: ${Y}`], ['name: Иванов И.', `name: ${Y}`]]);
    patch('sales/crm/product.yaml', [['name: CRM', `name: ${Y}`], ['name: Петрова А.', `name: ${Y}`]]);
    patch('_shared/network.yaml', [['reason: Мониторинг', `reason: ${Y}`], ['name: Сегмент ПДн', `name: ${Y}`]]);
    patch('sales/crm/services/orders.yaml', [['purpose: Вложения к заказам', `purpose: ${Y}`]]);

    const { tree, errors: loadErrors } = loadTree(root);
    expect(loadErrors).toEqual([]);
    const r = resolveModel(tree!);
    expect(r.errors).toEqual([]);
    const model = r.model!;
    expect(model.products.find((p) => p.code === 'crm')!.name).toBe(HOSTILE);
    const html = await buildHtml({ model, findings: runChecks(tree!, model), builtAt: HOSTILE });
    writeFileSync(join(dir, 'index.html'), html);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message ?? String(e)}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  });

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const views = [
    ['containers', { kind: 'company', expanded: [] }, 'containers|company'],
    ['containers', { kind: 'product', id: 'crm' }, 'containers|product:crm'],
    ['firewall', { kind: 'product', id: 'crm' }, 'firewall|product:crm'],
  ] as const;

  it('renders, no page errors, no injected elements', async () => {
    await page.goto(pathToFileURL(join(dir, 'index.html')).href + toHash({ view: 'containers', scope: { kind: 'company', expanded: [] } }));
    await waitRendered('containers|company');
    for (const [view, scope, key] of views) {
      await page.evaluate((h) => { location.hash = h; }, toHash({ view, scope: scope as never }));
      await waitRendered(key);
      expect(Number(await page.evaluate(() => document.body.dataset.nodeCount))).toBeGreaterThan(0);
    }
    // карточка продукта с враждебными именем и владельцем
    await page.evaluate(() => { location.hash = '#view=containers&scope=product:crm&sel=crm-orders'; });
    await waitRendered('containers|product:crm');
    expect(await page.$$eval('img', (l) => l.length)).toBe(0);
    expect(await page.$$eval('script', (l) => l.length)).toBe(2);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });
});
