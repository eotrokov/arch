import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROME, describeChrome } from './chrome.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { loadTree } from '../../src/model/load.js';
import { resolveModel } from '../../src/model/resolve.js';
import { runChecks } from '../../src/checks/index.js';
import { buildHtml } from '../../src/build/html.js';
import { generate } from '../../scripts/gen-synthetic.js';
import { toHash } from '../../viewer/state.js';

// Бюджет отрисовки на большой модели: охват «Компания» и один продукт — не более 2 с каждый.
// Модель: ARCH_E2E_ROOT или синтетическая 10/30/300.
const BUDGET_MS = 2000;

describeChrome('viewer scale budget', () => {
  let dir: string;
  let browser: Browser;
  let page: Page;
  let productId: string;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arch-e2e-scale-'));
    let root = process.env.ARCH_E2E_ROOT;
    if (!root) { root = join(dir, 'model'); generate({ teams: 10, products: 30, services: 300, out: root }); }
    const { tree, errors } = loadTree(root);
    expect(errors).toEqual([]);
    const model = resolveModel(tree!).model!;
    productId = model.products[0]!.code;
    const html = await buildHtml({ model, findings: runChecks(tree!, model), builtAt: '2026-11-18T00:00:00Z' });
    writeFileSync(join(dir, 'index.html'), html);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
  });

  afterAll(async () => {
    console.info('[e2e scale] ms:', JSON.stringify(timings));
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const waitRendered = (expected: string) =>
    page.waitForFunction((x) => document.body.dataset.rendered === x, { timeout: 15_000 }, expected);

  it(`company renders in < ${BUDGET_MS} ms`, async () => {
    const t0 = performance.now();
    await page.goto(pathToFileURL(join(dir, 'index.html')).href + toHash({ view: 'containers', scope: { kind: 'company', expanded: [] } }));
    await waitRendered('containers|company');
    timings.company = Math.round(performance.now() - t0);
    expect(timings.company).toBeLessThan(BUDGET_MS);
  });

  it(`one product renders in < ${BUDGET_MS} ms`, async () => {
    const t0 = performance.now();
    await page.evaluate((h) => { location.hash = h; }, toHash({ view: 'containers', scope: { kind: 'product', id: productId } }));
    await waitRendered(`containers|product:${productId}`);
    timings.product = Math.round(performance.now() - t0);
    expect(timings.product).toBeLessThan(BUDGET_MS);
  });
});
