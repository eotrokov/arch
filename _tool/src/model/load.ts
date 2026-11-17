import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/** Читает и проверяет один YAML-файл; при ошибках дописывает их в errors и возвращает null. */
function readYaml<T>(file: string, validate: ValidateFunction, errors: LoadError[]): T | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    errors.push({ file, message: `Не удалось прочитать файл: ${(e as Error).message}` });
    return null;
  }
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

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const subdirs = (p: string) =>
  readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

export function loadTree(root: string): { tree: RawTree | null; errors: LoadError[] } {
  const errors: LoadError[] = [];
  const shared = join(root, '_shared');

  const requireFile = <T>(name: string, validate: ValidateFunction): T | null => {
    const file = join(shared, name);
    if (!existsSync(file)) {
      errors.push({ file, message: 'Файл не найден' });
      return null;
    }
    return readYaml<T>(file, validate, errors);
  };
  const network = requireFile<RawNetwork>('network.yaml', validators.network);
  const platform = requireFile<RawPlatform>('platform.yaml', validators.platform);

  const teams: RawTeam[] = [];
  for (const teamDir of subdirs(root)) {
    const teamPath = join(root, teamDir);
    const teamFile = join(teamPath, 'team.yaml');
    const teamData = existsSync(teamFile)
      ? readYaml<RawTeam['data']>(teamFile, validators.team, errors)
      : (errors.push({ file: teamFile, message: 'Файл не найден' }), null);

    const products: RawProduct[] = [];
    for (const prodDir of subdirs(teamPath)) {
      const prodPath = join(teamPath, prodDir);
      const prodFile = join(prodPath, 'product.yaml');
      const prodData = existsSync(prodFile)
        ? readYaml<RawProduct['data']>(prodFile, validators.product, errors)
        : (errors.push({ file: prodFile, message: 'Файл не найден' }), null);

      const services: RawProduct['services'] = [];
      const svcPath = join(prodPath, 'services');
      if (isDir(svcPath)) {
        const files = readdirSync(svcPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
        for (const f of files) {
          const file = join(svcPath, f);
          const data = readYaml<RawService>(file, validators.service, errors);
          if (data) services.push({ file, data });
        }
      }
      if (prodData) products.push({ dir: prodDir, file: prodFile, data: prodData, services });
    }
    if (teamData) teams.push({ dir: teamDir, file: teamFile, data: teamData, products });
  }

  if (errors.length > 0 || !network || !platform) return { tree: null, errors };
  return { tree: { network, platform, teams }, errors };
}
