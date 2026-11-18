// Сборка редактора в каталог: index.html, editor.js (IIFE), editor.css, config.json (если задан).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { EditorConfig } from '../../editor/config.js';
import { toolRoot } from './html.js';

export async function buildEditor(outDir: string, cfg: EditorConfig | null): Promise<void> {
  const root = toolRoot();
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'editor', 'main.ts')],
    bundle: true, format: 'iife', minify: true, platform: 'browser', target: 'es2020',
    absWorkingDir: root, outfile: join(outDir, 'editor.js'), legalComments: 'none', logLevel: 'silent',
    // как в просмотрщике: основной вход elkjs тянет web-worker
    alias: { elkjs: 'elkjs/lib/elk.bundled.js' },
  });
  const css = [join(root, 'viewer', 'tokens.css'), join(root, 'editor', 'styles.css')].map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync(join(outDir, 'editor.css'), css);
  copyFileSync(join(root, 'editor', 'index.html'), join(outDir, 'index.html'));
  if (cfg) writeFileSync(join(outDir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
