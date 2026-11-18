// Модель мастера: шаги, форма ↔ YAML-данные, ошибки по шагам. Браузерный код: без модулей Node.
import { parse } from 'yaml';
import type { Change } from './cart.js';
import { newYaml, patchYaml, productPath, servicePath, teamPath } from './yamlEdit.js';
import { deriveNames, type DerivedNames, type PlatformNames, type ServiceType } from '../src/model/names.js';
import type { LoadError } from '../src/model/raw.js';
import type { Finding } from '../src/model/types.js';

export type WizardKind = 'service' | 'product' | 'team';

export interface StepDef { id: string; title: string; fields: string[] }

export const STEPS: Record<WizardKind, StepDef[]> = {
  service: [
    { id: 'main', title: 'Основное', fields: ['name', 'type', 'criticality'] },
    { id: 'place', title: 'Размещение', fields: ['segment', 'cluster', 'port', 'protocol'] },
    { id: 'data', title: 'Данные', fields: ['databases', 'publishes'] },
    { id: 'links', title: 'Связи', fields: ['calls', 'consumes', 'uses', 'exports'] },
    { id: 'publish', title: 'Публикация', fields: ['exposure'] },
    { id: 'people', title: 'Ответственные и ссылки', fields: ['owners', 'links'] },
    { id: 'review', title: 'Проверка и MR', fields: [] },
  ],
  product: [
    { id: 'main', title: 'Основное', fields: ['code', 'name', 'criticality', 'nfr'] },
    { id: 'entities', title: 'Сущности', fields: ['entities'] },
    { id: 'own', title: 'Выделенные ресурсы', fields: ['externals'] },
    { id: 'people', title: 'Ответственные и ссылки', fields: ['owners', 'links'] },
    { id: 'review', title: 'Проверка и MR', fields: [] },
  ],
  team: [
    // id — псевдополе: имя каталога команды, хранится в WizardState.team и в team.yaml не пишется
    { id: 'main', title: 'Основное', fields: ['id', 'name'] },
    { id: 'people', title: 'Ответственные и ссылки', fields: ['owners', 'links'] },
    { id: 'review', title: 'Проверка и MR', fields: [] },
  ],
};

/** Поля, которые мастер не редактирует (показываются только для чтения). */
export const READONLY_FIELDS: Record<WizardKind, string[]> = {
  service: ['overrides'],
  product: ['dbservers', 'resources'],
  team: [],
};

const PSEUDO: Record<WizardKind, string[]> = { service: [], product: [], team: ['id'] };

/** Ключи верхнего уровня, которых нет ни в шагах, ни в READONLY_FIELDS. */
export function unknownFields(kind: WizardKind, data: Record<string, unknown>): string[] {
  const known = new Set([...STEPS[kind].flatMap((s) => s.fields), ...READONLY_FIELDS[kind]]);
  return Object.keys(data).filter((k) => !known.has(k));
}

export interface WizardState {
  kind: WizardKind;
  team: string;
  product?: string;
  isNew: boolean;
  data: Record<string, unknown>;
  originalText?: string;
  path: string;
}

export function startNew(kind: WizardKind, team: string, product?: string): WizardState {
  const data: Record<string, unknown> =
    kind === 'service' ? { name: '' } : kind === 'product' ? { code: '', name: '' } : { name: '' };
  return { kind, team, product: kind === 'service' ? product : undefined, isNew: true, data, path: '' };
}

export function startEdit(kind: WizardKind, path: string, text: string): WizardState {
  const parts = path.split('/');
  const parsed: unknown = parse(text);
  const data = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const team = parts[0] ?? '';
  const product = kind === 'team' ? undefined : parts[1];
  return { kind, team, product, isNew: false, data, originalText: text, path };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const typeOf = (data: Record<string, unknown>): ServiceType => {
  const t = str(data.type);
  return t === 'ui' || t === 'worker' || t === 'job' || t === 'gw' ? t : '';
};

function serviceId(s: WizardState): string {
  const t = typeOf(s.data);
  return `${s.product ?? ''}-${str(s.data.name)}${t ? `-${t}` : ''}`;
}

const subject = (s: WizardState): string =>
  s.kind === 'service' ? serviceId(s) : s.kind === 'product' ? str(s.data.code) || (s.product ?? '') : s.team;
const NEW_LABEL: Record<WizardKind, string> = { service: 'Новый сервис', product: 'Новый продукт', team: 'Новая команда' };
const EDIT_LABEL: Record<WizardKind, string> = { service: 'Изменение сервиса', product: 'Изменение продукта', team: 'Изменение команды' };

function pathOf(s: WizardState): string {
  if (!s.isNew) return s.path;
  if (s.kind === 'service') return servicePath(s.team, s.product ?? '', str(s.data.name), typeOf(s.data));
  if (s.kind === 'product') return productPath(s.team, str(s.data.code));
  return teamPath(s.team);
}

export function toChange(s: WizardState, blobId: string | null): Change {
  const data = Object.fromEntries(Object.entries(s.data).filter(([k]) => !PSEUDO[s.kind].includes(k)));
  const path = pathOf(s);
  if (s.isNew) {
    return { path, content: newYaml(s.kind, data), baseBlobId: null, label: `${NEW_LABEL[s.kind]} ${subject(s)}` };
  }
  const orig = parse(s.originalText ?? '') as Record<string, unknown> | null;
  const frozen = s.kind === 'service' ? ['name', 'type'] : s.kind === 'product' ? ['code'] : [];
  for (const k of frozen) {
    const was = k === 'type' ? typeOf(orig ?? {}) : str(orig?.[k]);
    const now = k === 'type' ? typeOf(s.data) : str(s.data[k]);
    if (was !== now) {
      const what = k === 'name' ? 'Имя существующего сервиса' : k === 'type' ? 'Тип существующего сервиса' : 'Код существующего продукта';
      throw new Error(`${what} не меняется`);
    }
  }
  return {
    path, content: patchYaml(s.originalText ?? '', data), baseBlobId: blobId,
    label: `${EDIT_LABEL[s.kind]} ${subject(s)}`,
  };
}

export function deleteChange(path: string, blobId: string | null, id: string): Change {
  return { path, content: null, baseBlobId: blobId, label: `Удаление сервиса ${id}` };
}

const SERVICE_RULES: [RegExp, string][] = [
  [/^naming\./, 'main'],
  [/^(a1|chain)\./, 'links'],
  [/^a2\./, 'data'],
  [/^db\.pdn/, 'data'],
  [/^security\.no-waf$/, 'publish'],
  [/^meta\.no-owner$/, 'people'],
];

/** Шаг по первому сегменту пути поля (`/cluster`, `/calls/0/target`). */
function stepByField(kind: WizardKind, field: string): string | null {
  return STEPS[kind].find((st) => st.fields.includes(field))?.id ?? null;
}

/** Шаг, которому принадлежит находка проверок или ошибка загрузки; null — не относится к файлу (показывается на review). */
export function stepOfFinding(kind: WizardKind, f: Finding | LoadError, path: string): string | null {
  if (f.file !== path) return null;
  if ('rule' in f) {
    if (kind === 'service') return SERVICE_RULES.find(([re]) => re.test(f.rule))?.[1] ?? null;
    if (/^naming\./.test(f.rule)) return 'main';
    return f.rule === 'meta.no-owner' ? 'people' : null;
  }
  const m = f.message;
  const schema = /^Схема: \/([^/:]*)/.exec(m);
  if (schema) return schema[1] ? stepByField(kind, schema[1]) : null;
  if (/^Дубликат сущности/.test(m)) return 'entities';
  if (/^Дубликат/.test(m)) return 'main';
  if (kind === 'product') {
    if (/сущност/.test(m)) return 'entities';
    if (/^Внешняя система/.test(m)) return 'own';
    return null;
  }
  if (kind !== 'service') return null;
  if (/кластер .* не найден/.test(m) || /: сегмент .* не найден/.test(m)) return 'place';
  if (/databases\.|publishes/.test(m)) return 'data';
  if (/calls\.|consumes:|exports\.|uses[.:]|сущность .* не найдена/.test(m)) return 'links';
  if (/exposure/.test(m)) return 'publish';
  return null;
}

/** Имена по текущим полям формы; null при пустом имени. */
export function previewNames(s: WizardState, platform: PlatformNames): DerivedNames | null {
  const name = str(s.data.name);
  if (s.kind !== 'service' || !name || !s.product) return null;
  return deriveNames(s.product, name, typeOf(s.data), platform, s.data.overrides as never);
}
