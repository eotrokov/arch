import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CHROME, describeChrome } from './chrome.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { startFakeGitLab, type FakeGitLab } from '../fake-gitlab.js';


describeChrome('spike: страница проверки на фейковом GitLab', () => {
  let fake: FakeGitLab;
  let site: Server;
  let browser: Browser;
  let page: Page;
  let siteUrl: string;
  const errors: string[] = [];

  beforeAll(async () => {
    execFileSync('npm', ['run', 'spike:build'], { cwd: resolve(__dirname, '../..'), stdio: 'pipe' });
    const dist = resolve(__dirname, '../../_dist/spike');
    fake = await startFakeGitLab({ files: { 'products/crm/service.yaml': 'name: Orders\n', 'teams/sales.yaml': 'code: sales\n' } });
    let cfgJson = '';
    site = createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p === '/config.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(cfgJson);
      const name = p === '/' ? 'index.html' : p.slice(1);
      if (!/^[\w.]+$/.test(name) || !existsSync(`${dist}/${name}`)) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }).end(readFileSync(`${dist}/${name}`));
    });
    await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    cfgJson = JSON.stringify({ gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'cid', redirectUri: siteUrl, baseBranch: 'main' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message ?? String(e)}`));
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((ok) => (site ? site.close(() => ok()) : ok()));
    await fake?.close();
  });

  const logText = () => page.$eval('#log', (el) => (el as HTMLElement).innerText);
  const waitLog = (text: string) =>
    page.waitForFunction((t) => (document.getElementById('log')?.textContent ?? '').includes(t), { timeout: 15_000 }, text);

  it('вход, чтение модели и тестовый MR', async () => {
    await page.goto(siteUrl);
    await page.click('#login');
    await waitLog('✓ Вход');
    await page.click('#read');
    await waitLog('✓ Дерево');
    await page.click('#mr');
    await waitLog('✓ MR');

    const text = await logText();
    expect(text).toContain('✓ Вход: Тестовый Пользователь');
    expect(text).toContain('✓ Дерево: 2 файлов');
    expect(text).toMatch(/✓ Файл [\w/.]+: \d+ байт/);
    expect(text).not.toContain('✗');

    const commit = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/repository/commits'))!;
    const cb = commit.body as { branch: string; actions: { file_path: string }[] };
    expect(cb.branch).toMatch(/^arch\/spike-[a-z0-9]{4}$/);
    expect(cb.actions[0]!.file_path).toMatch(/^_spike\/.+\.txt$/);
    const mr = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/merge_requests'))!;
    expect((mr.body as { title: string }).title).toMatch(/^Draft: /);
    expect(errors).toEqual([]);
  });
});
