// Статический сервер страницы проверки: http://localhost:5310/ (redirect URI для OAuth).
// config.json берётся из _dist/spike/ (скопируйте туда свой, см. editor/SPIKE.md).
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), '_dist', 'spike');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  const file = join(root, p);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(5310, '127.0.0.1', () => console.log('http://localhost:5310/'));
