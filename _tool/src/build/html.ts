// Сборка самодостаточного index.html: бандл просмотрщика + стили + данные модели.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Finding, Model } from '../model/types.js';

export interface HtmlData { model: Model; findings: Finding[]; builtAt: string }

/** Каталог инструмента (с viewer/main.ts): ищем вверх от этого файла — работает и из src/build, и из dist. */
function toolRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'viewer', 'main.ts'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('arch-views: не найден каталог viewer/ (viewer/main.ts)');
    dir = up;
  }
}

/** JSON для вставки в <script>: `</` не может закрыть тег. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

async function bundle(root: string): Promise<string> {
  const res = await build({
    entryPoints: [join(root, 'viewer', 'main.ts')],
    bundle: true, format: 'iife', minify: true, platform: 'browser', target: 'es2020',
    write: false, legalComments: 'none', logLevel: 'silent',
    // основной вход elkjs тянет web-worker; для браузера — самодостаточная сборка
    alias: { elkjs: 'elkjs/lib/elk.bundled.js' },
  });
  return res.outputFiles[0]!.text;
}

export async function buildHtml(data: HtmlData): Promise<string> {
  const root = toolRoot();
  const js = (await bundle(root)).replace(/<\/script/gi, '<\\/script');
  const css = readFileSync(join(root, 'viewer', 'styles.css'), 'utf8');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Архитектура</title>
<style>${css}</style>
</head>
<body>
<header>
  <h1>Архитектура</h1>
  <span class="tag" id="builtAt"></span>
  <nav class="tabs" id="viewTabs" role="tablist" aria-label="Разрез"></nav>
  <span class="crumb" id="crumb"></span>
</header>
<main>
  <aside class="pane tree" id="tree" aria-label="Охват"></aside>
  <section class="pane" id="graphWrap"><div id="cy" aria-label="Схема"></div><div id="legend"></div><p class="empty graph-empty" id="graphEmpty" hidden></p></section>
  <aside class="pane card" id="card" aria-label="Карточка элемента"></aside>
  <section class="pane" id="bottom">
    <div class="btabs" role="tablist">
      <button type="button" id="bt-conn" role="tab" aria-selected="true">Соединения</button>
      <button type="button" id="bt-find" role="tab" aria-selected="false">Нарушения</button>
      <span class="sp"></span>
      <button type="button" class="copy" id="copyTsv">Скопировать как TSV</button>
    </div>
    <div class="bbody" id="bbody"></div>
  </section>
</main>
<script id="arch-data" type="application/json">${scriptJson(data)}</script>
<script>${js}</script>
</body>
</html>
`;
}
