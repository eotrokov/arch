// Стенд редактора для разработки: сборка в _dist/editor, статический сервер и фейковый GitLab с демо-моделью.
// `npm run editor:serve` — режим gitlab; `npm run editor:serve -- --offline` — запасной режим (model.json рядом).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { buildEditor } from '../src/build/editor.js';
import { readModelFiles } from '../src/model/load.js';
import { startFakeGitLab } from '../test/fake-gitlab.js';

const PORT = Number(process.env.PORT ?? 5320);
const offline = process.argv.includes('--offline');
const out = join(process.cwd(), '_dist', 'editor');
const site = `http://127.0.0.1:${PORT}/`;
const files = readModelFiles('examples/demo');

rmSync(out, { recursive: true, force: true });
if (offline) {
  await buildEditor(out, null);
  writeFileSync(join(out, 'model.json'), JSON.stringify({ files, builtAt: new Date().toISOString() }));
} else {
  const fake = await startFakeGitLab({ files, port: Number(process.env.FAKE_PORT ?? 5321) });
  await buildEditor(out, { gitlabUrl: fake.url, projectPath: 'grp/arch', oauthClientId: 'dev-client', redirectUri: site, baseBranch: 'main' });
  console.log(`фейковый GitLab: ${fake.url}`);
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
};
createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  const file = join(out, p);
  if (!file.startsWith(out) || !existsSync(file)) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`редактор: ${site}${offline ? ' (запасной режим)' : ''}`));
