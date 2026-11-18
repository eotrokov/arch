// Сборка страницы проверки в _dist/spike/ (index.html + main.js).
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('_dist/spike', { recursive: true });
await build({
  entryPoints: ['editor/spike/main.ts'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
  outfile: '_dist/spike/main.js', logLevel: 'warning',
});
copyFileSync('editor/spike/index.html', '_dist/spike/index.html');
