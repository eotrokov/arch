import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEditor, buildEditorSite, editorConfigFromEnv } from '../src/build/editor.js';
import type { EditorConfig } from '../editor/config.js';

const cfg: EditorConfig = {
  gitlabUrl: 'https://gitlab.example.test',
  projectPath: 'arch/model',
  oauthClientId: 'cid-123',
  redirectUri: 'https://arch.pages.example.test/editor/',
  baseBranch: 'main',
};

/**
 * Строки-идентификаторы из библиотек бандла, а не адреса загрузки: $id мета-схем ajv/JSON Schema,
 * пространства имён XML Schema и EMF/ELK в elkjs. Плюс шаблоны и проверки схемы из нашего кода
 * (`https://${…}` для выведенных имён, голые `http://`/`https://` в регулярках).
 */
const LIBRARY_IDS = [
  /^http:\/\/json-schema\.org\//,
  /^https:\/\/raw\.githubusercontent\.com\/ajv-validator\/ajv\/master\/lib\/refs\//,
  /^http:\/\/www\.w3\.org\/2001\/XMLSchema#/,
  /^http:\/\/www\.eclipse\.org\/(emf|elk)\//,
  /^http:\/\/\/org\/eclipse\/emf\//,
  /^https?:\/\/(\$\{|$)/,
];
const URL_RE = /https?:\/\/[^\s"'`)<>\\]*/g;

function foreignUrls(text: string, allowed: string[]): string[] {
  return [...new Set(text.match(URL_RE) ?? [])]
    .filter((u) => !allowed.some((a) => u.startsWith(a)) && !LIBRARY_IDS.some((re) => re.test(u)));
}

describe('buildEditor', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arch-editor-build-'));
    await buildEditor(join(dir, 'with'), cfg);
    await buildEditor(join(dir, 'without'), null);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('пишет index.html, editor.js, editor.css и config.json', () => {
    expect(readdirSync(join(dir, 'with')).sort()).toEqual(['config.json', 'editor.css', 'editor.js', 'index.html']);
    expect(JSON.parse(readFileSync(join(dir, 'with', 'config.json'), 'utf8'))).toEqual(cfg);
  });

  it('без cfg — без config.json (запасной режим)', () => {
    expect(readdirSync(join(dir, 'without')).sort()).toEqual(['editor.css', 'editor.js', 'index.html']);
  });

  it('нет внешних CDN: страница ссылается только на файлы рядом, в бандле нет адресов кроме cfg', () => {
    const html = readFileSync(join(dir, 'with', 'index.html'), 'utf8');
    const js = readFileSync(join(dir, 'with', 'editor.js'), 'utf8');
    const css = readFileSync(join(dir, 'with', 'editor.css'), 'utf8');
    const allowed = [cfg.gitlabUrl, cfg.redirectUri];
    expect(foreignUrls(html, allowed)).toEqual([]);
    expect(foreignUrls(css, allowed)).toEqual([]);
    expect(foreignUrls(js, allowed)).toEqual([]);
    // подключаемые ресурсы — только относительные
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs).toEqual(['data:,', 'editor.css', 'editor.js']);
    expect(css).not.toMatch(/@import|url\((?!["']?data:)/);
    // загрузки по абсолютному адресу и воркеры с сети
    expect(js).not.toMatch(/fetch\(\s*["'`]https?:/);
    expect(js).not.toMatch(/importScripts\(|import\(\s*["'`]https?:/);
  });
});

describe('editorConfigFromEnv', () => {
  const env = {
    ARCH_GITLAB_URL: 'https://gitlab.example.test/', ARCH_PROJECT_PATH: 'arch/model',
    ARCH_OAUTH_CLIENT_ID: 'cid-123', ARCH_REDIRECT_URI: 'https://arch.pages.example.test/editor/',
  };

  it('берёт значения из окружения, baseBranch по умолчанию main', () => {
    expect(editorConfigFromEnv(env)).toEqual(cfg);
    expect(editorConfigFromEnv({ ...env, ARCH_BASE_BRANCH: 'master' })?.baseBranch).toBe('master');
  });

  it('без ARCH_OAUTH_CLIENT_ID — null (запасной режим)', () => {
    expect(editorConfigFromEnv({})).toBeNull();
    expect(editorConfigFromEnv({ ...env, ARCH_OAUTH_CLIENT_ID: '  ' })).toBeNull();
  });

  it('client id есть, а адресов нет — ошибка с именами переменных', () => {
    expect(() => editorConfigFromEnv({ ARCH_OAUTH_CLIENT_ID: 'x' })).toThrow(/ARCH_GITLAB_URL.*ARCH_PROJECT_PATH.*ARCH_REDIRECT_URI/);
  });
});

describe('buildEditorSite (раскладка для Pages)', () => {
  let out: string;
  let code: number;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'arch-editor-site-'));
    code = await buildEditorSite('examples/demo', out, null, { stdout: () => {}, stderr: () => {} });
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('просмотрщик в out/, редактор в out/editor/ с model.json рядом', () => {
    expect(code).toBeLessThan(2);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(readdirSync(join(out, 'editor')).sort()).toEqual(['editor.css', 'editor.js', 'index.html', 'model.json']);
    const m = JSON.parse(readFileSync(join(out, 'editor', 'model.json'), 'utf8')) as { files: Record<string, string>; builtAt: string };
    expect(Object.keys(m.files)).toContain('sales/crm/services/orders.yaml');
    expect(m.builtAt).toMatch(/^\d{4}-/);
  });

  it('ошибка загрузки модели (код 2) — исключение, ничего не собрано', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'arch-editor-bad-'));
    try {
      await expect(buildEditorSite(join(bad, 'nope'), join(bad, 'out'), null, { stdout: () => {}, stderr: () => {} })).rejects.toThrow(/arch-views build/);
      expect(existsSync(join(bad, 'out', 'editor'))).toBe(false);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
