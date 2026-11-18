import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parseDocument } from 'yaml';
import type { LoadError, RawNetwork, RawPlatform, RawProduct, RawService, RawTeam, RawTree } from './raw.js';
import { networkSchema, platformSchema, productSchema, serviceSchema, teamSchema } from './schemas.js';

export type { LoadError, RawTree } from './raw.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validators = {
  network: ajv.compile(networkSchema),
  platform: ajv.compile(platformSchema),
  team: ajv.compile(teamSchema),
  product: ajv.compile(productSchema),
  service: ajv.compile(serviceSchema),
};

function schemaMessage(e: ErrorObject): string {
  let path = e.instancePath;
  if (e.keyword === 'required') path += `/${(e.params as { missingProperty: string }).missingProperty}`;
  if (e.keyword === 'additionalProperties') path += `/${(e.params as { additionalProperty: string }).additionalProperty}`;
  return `Схема: ${path || '/'}: ${e.message ?? 'ошибка'}`;
}

export type FileMap = Record<string, string>;

/** Читает и проверяет один YAML-файл; при ошибках дописывает их в errors и возвращает null. */
function readYaml<T>(file: string, text: string, validate: ValidateFunction, errors: LoadError[]): T | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    errors.push({ file, line: err.linePos?.[0].line, message: `YAML: ${err.message.split('\n')[0]}` });
    return null;
  }
  const data = doc.toJS() as unknown;
  if (!validate(data)) {
    for (const e of validate.errors ?? []) errors.push({ file, message: schemaMessage(e) });
    return null;
  }
  return data as T;
}

const visible = (name: string) => !name.startsWith('_') && !name.startsWith('.');
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

/** Загружает дерево модели из карты файлов (ключ — путь от корня модели через `/`). Без Node. */
export function loadTreeFromFiles(files: FileMap, root = ''): { tree: RawTree | null; errors: LoadError[] } {
  const errors: LoadError[] = [];
  const base = root.replace(/\/+$/, '');
  const full = (p: string) => (base ? `${base}/${p}` : p);
  const parts = Object.keys(files).map((k) => k.split('/'));
  const childDirs = (prefix: string[]) =>
    uniqSorted(
      parts
        .filter((p) => p.length > prefix.length + 1 && prefix.every((s, i) => p[i] === s) && visible(p[prefix.length]!))
        .map((p) => p[prefix.length]!),
    );

  const load = <T>(path: string, validate: ValidateFunction): T | null => {
    const text = files[path];
    if (text === undefined) {
      errors.push({ file: full(path), message: 'Файл не найден' });
      return null;
    }
    return readYaml<T>(full(path), text, validate, errors);
  };
  const network = load<RawNetwork>('_shared/network.yaml', validators.network);
  const platform = load<RawPlatform>('_shared/platform.yaml', validators.platform);

  const teams: RawTeam[] = [];
  for (const teamDir of childDirs([])) {
    const teamFile = `${teamDir}/team.yaml`;
    const teamData = load<RawTeam['data']>(teamFile, validators.team);

    const products: RawProduct[] = [];
    for (const prodDir of childDirs([teamDir])) {
      const prodFile = `${teamDir}/${prodDir}/product.yaml`;
      const prodData = load<RawProduct['data']>(prodFile, validators.product);

      const services: RawProduct['services'] = [];
      const svcPrefix = `${teamDir}/${prodDir}/services/`;
      const names = Object.keys(files)
        .filter((k) => k.startsWith(svcPrefix) && !k.slice(svcPrefix.length).includes('/'))
        .map((k) => k.slice(svcPrefix.length))
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort();
      for (const f of names) {
        const data = load<RawService>(svcPrefix + f, validators.service);
        if (data) services.push({ file: full(svcPrefix + f), data });
      }
      if (prodData) products.push({ dir: prodDir, file: full(prodFile), data: prodData, services });
    }
    if (teamData) teams.push({ dir: teamDir, file: full(teamFile), data: teamData, products });
  }

  if (errors.length > 0 || !network || !platform) return { tree: null, errors };
  return { tree: { network, platform, teams }, errors };
}
