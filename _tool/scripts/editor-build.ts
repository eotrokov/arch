// `npm run editor:build [-- --root <каталог модели>] [-- --out <каталог>]`: сайт для Pages в <root>/_dist/
// (просмотрщик index.html и model.json от `arch-views build`, редактор в editor/). config.json — из переменных
// ARCH_GITLAB_URL, ARCH_PROJECT_PATH, ARCH_OAUTH_CLIENT_ID, ARCH_REDIRECT_URI, ARCH_BASE_BRANCH (по умолчанию main);
// без ARCH_OAUTH_CLIENT_ID config.json не пишется — редактор работает в запасном режиме.
import { join, resolve } from 'node:path';
import { buildEditorSite, editorConfigFromEnv } from '../src/build/editor.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const root = resolve(arg('--root') ?? join(import.meta.dirname, '..', '..'));
const out = resolve(arg('--out') ?? join(root, '_dist'));

try {
  const cfg = editorConfigFromEnv(process.env);
  const code = await buildEditorSite(root, out, cfg, { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) });
  console.log(`Редактор: ${join(out, 'editor', 'index.html')} (${cfg ? `GitLab ${cfg.gitlabUrl}, проект ${cfg.projectPath}` : 'запасной режим: config.json не задан'})`);
  if (code === 1) console.log('В модели есть нарушения правил — сайт собран, нарушения видны в просмотрщике.');
} catch (e) {
  console.error(`ERROR ${(e as Error).message}`);
  process.exit(2);
}
