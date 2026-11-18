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
 * Строки-идентификаторы из библиотек бандла, а не адреса загрузки — точный список того, что сейчас есть в бандле:
 * $id мета-схем ajv/JSON Schema, пространства имён XML Schema и EMF/ELK в elkjs. Новая библиотека с новым адресом
 * уронит тест — тогда адрес нужно проверить и добавить сюда явно.
 */
const LIBRARY_IDS = new Set([
  'http://json-schema.org/draft-07/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/schema',
  'https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#',
  ...['boolean', 'byte', 'decimal', 'double', 'float', 'hexBinary', 'int', 'integer', 'long', 'short', 'string']
    .map((t) => `http://www.w3.org/2001/XMLSchema#${t}`),
  'http://www.eclipse.org/elk/ElkGraph',
  'http://www.eclipse.org/emf/2002/Ecore',
  'http://www.eclipse.org/emf/2003/XMLType',
  'http:///org/eclipse/emf/ecore/util/ExtendedMetaData',
]);
/**
 * Голые `http://`/`https://` допустимы только в этих местах (вырезаются до поиска адресов):
 * разбор хоста в ajv-formats, подсказка поля URL в мастере, шаблон repoUrl выведенных имён.
 */
const LITERAL_CONTEXTS = [
  /new URL\("http:\/\/"\+/g,
  /placeholder:"https:\/\/"/g,
  /repoUrl:`https:\/\/\$\{\w+\}\/\$\{\w+\}\/\$\{\w+\}`/g,
];
const URL_RE = /https?:\/\/[^\s"'`)<>\\]*/g;

/** Адреса в тексте, кроме точных совпадений с cfg и LIBRARY_IDS. */
function foreignUrls(text: string, allowed: string[]): string[] {
  let rest = text;
  for (const re of LITERAL_CONTEXTS) rest = rest.replace(re, '');
  return [...new Set(rest.match(URL_RE) ?? [])].filter((u) => !allowed.includes(u) && !LIBRARY_IDS.has(u));
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

  it('проверка адресов точная: соседний хост, путь под разрешённым хостом и голый https:// вне известных мест ловятся', () => {
    const allowed = [cfg.gitlabUrl, cfg.redirectUri];
    expect(foreignUrls(`fetch("${cfg.gitlabUrl}.evil.example/x")`, allowed)).toEqual([`${cfg.gitlabUrl}.evil.example/x`]);
    expect(foreignUrls('s="https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/cdn.js"', allowed)).toHaveLength(1);
    expect(foreignUrls('s="http://json-schema.org/evil.js"', allowed)).toHaveLength(1);
    expect(foreignUrls('s="https://"+host', allowed)).toEqual(['https://']);
    expect(foreignUrls('u=`https://${h}/x.js`', allowed)).toHaveLength(1);
    expect(foreignUrls(`placeholder:"https://",repoUrl:\`https://\${a}/\${b}/\${c}\`,new URL("http://"+h),"${cfg.gitlabUrl}"`, allowed)).toEqual([]);
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
