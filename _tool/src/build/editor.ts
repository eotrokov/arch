// Сборка редактора: бандл в каталог (index.html, editor.js, editor.css, config.json) и раскладка сайта для Pages.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { EditorConfig } from '../../editor/config.js';
import { run, type Io } from '../cli.js';
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

/**
 * config.json из переменных окружения CI. Пустой ARCH_OAUTH_CLIENT_ID — null (config.json не пишется, запасной режим);
 * client id задан, а адреса нет — ошибка (иначе редактор молча ушёл бы в запасной режим или на неверный GitLab).
 */
export function editorConfigFromEnv(env: Record<string, string | undefined>): EditorConfig | null {
  const v = (k: string) => (env[k] ?? '').trim();
  const clientId = v('ARCH_OAUTH_CLIENT_ID');
  if (!clientId) return null;
  const missing = ['ARCH_GITLAB_URL', 'ARCH_PROJECT_PATH', 'ARCH_REDIRECT_URI'].filter((k) => !v(k));
  if (missing.length) throw new Error(`editor:build: задан ARCH_OAUTH_CLIENT_ID, но не заданы ${missing.join(', ')}`);
  return {
    gitlabUrl: v('ARCH_GITLAB_URL').replace(/\/+$/, ''),
    projectPath: v('ARCH_PROJECT_PATH'),
    oauthClientId: clientId,
    redirectUri: v('ARCH_REDIRECT_URI'),
    baseBranch: v('ARCH_BASE_BRANCH') || 'main',
  };
}

/**
 * Сайт для Pages: `arch-views build` в out/ (просмотрщик index.html, model.json, mermaid/) и редактор в out/editor/.
 * Без cfg (запасной режим) рядом с редактором кладётся копия model.json — он читает её относительным адресом `model.json`;
 * в режиме GitLab копия не нужна (модель читается из GitLab) и не пишется.
 * Возвращает код `arch-views build` (0 или 1 — нарушения правил, сайт собран); код 2 (модель не загрузилась) — исключение.
 */
export async function buildEditorSite(root: string, out: string, cfg: EditorConfig | null, io: Io): Promise<number> {
  const dist = resolve(out);
  const code = await run(['build', '--root', resolve(root), '--out', dist], io);
  if (code === 2) throw new Error('arch-views build: модель не загрузилась (код 2) — редактор не собран');
  const editorDir = join(dist, 'editor');
  await buildEditor(editorDir, cfg);
  if (!cfg) copyFileSync(join(dist, 'model.json'), join(editorDir, 'model.json'));
  return code;
}
