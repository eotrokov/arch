// Генерация новых YAML-файлов модели и минимальная правка существующих.
// Браузерный код: без модулей Node.
//
// Новые файлы: канонический порядок ключей, списки — block, их элементы —
// flow `{ ... }`, если внутри нет вложенных объектов (как в демо-модели).
// Правка: parseDocument даёт узлы и их позиции в исходном тексте; меняются
// только изменившиеся ключи верхнего уровня, остальной текст (комментарии,
// порядок, стиль, отступы) остаётся байт-в-байт.

import { Document, isMap, isScalar, isSeq, isCollection, parseDocument, Scalar } from 'yaml';

export type YamlKind = 'service' | 'product' | 'team';

const ORDER: Record<YamlKind, string[]> = {
  service: ['name', 'type', 'segment', 'cluster', 'criticality', 'port', 'protocol', 'databases', 'publishes', 'consumes', 'calls', 'uses', 'exports', 'exposure', 'owners', 'links', 'overrides'],
  product: ['code', 'name', 'criticality', 'nfr', 'owners', 'links', 'entities', 'externals', 'dbservers', 'resources'],
  team: ['name', 'owners', 'links'],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const entries = (o: Obj) => Object.entries(o).filter(([, v]) => v !== undefined);

/** Скаляр в записи, допустимой и во flow-, и в block-контексте; `type` — стиль кавычек исходного узла. */
function scalar(v: unknown, type?: Scalar.Type): string {
  const node = new Scalar(v);
  if (type && typeof v === 'string') node.type = type;
  const doc = new Document([node]);
  (doc.contents as { flow: boolean }).flow = true;
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd().slice(1, -1);
}

/** Есть ли внутри значения (не считая его самого) объект. */
function nestedObj(v: unknown): boolean {
  const kids = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [];
  return kids.some((k) => isObj(k) || nestedObj(k));
}
const flowable = (v: unknown) => !nestedObj(v);

function flow(v: unknown): string {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const items = v.map(flow);
    return v.some((x) => typeof x === 'object' && x !== null) ? `[ ${items.join(', ')} ]` : `[${items.join(', ')}]`;
  }
  if (isObj(v)) {
    const es = entries(v);
    return es.length ? `{ ${es.map(([k, x]) => `${scalar(k)}: ${flow(x)}`).join(', ')} }` : '{}';
  }
  return scalar(v);
}

/** Пара `key: value` с отступом `indent`; `seqIndent` — отступать ли `- ` под ключом; `block` — объект писать в block. */
function pair(key: string, v: unknown, indent: string, seqIndent: boolean, block = false): string {
  if (!(block && isObj(v) && entries(v).length) && flowable(v)) return `${indent}${key}: ${flow(v)}\n`;
  if (Array.isArray(v)) {
    const dash = indent + (seqIndent ? '  ' : '');
    return `${indent}${key}:\n` + v.map((x) => item(x, dash, seqIndent)).join('');
  }
  return `${indent}${key}:\n` + entries(v as Obj).map(([k, x]) => pair(scalar(k), x, indent + '  ', seqIndent)).join('');
}

function item(v: unknown, dash: string, seqIndent: boolean): string {
  if (!isObj(v) || flowable(v)) return `${dash}- ${flow(v)}\n`;
  const inner = dash + '  ';
  return entries(v).map(([k, x]) => pair(scalar(k), x, inner, seqIndent)).join('').replace(inner, `${dash}- `);
}

const keep = (v: unknown) => v !== undefined && !(Array.isArray(v) && v.length === 0);

function orderedKeys(order: string[], data: Obj): string[] {
  const keys = Object.keys(data).filter((k) => keep(data[k]));
  return [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))];
}

export function newYaml(kind: YamlKind, data: object): string {
  const d = data as Obj;
  return orderedKeys(ORDER[kind], d).map((k) => pair(scalar(k), d[k], '', true)).join('');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = entries(a), kb = entries(b);
    return ka.length === kb.length && ka.every(([k, x]) => deepEqual(x, b[k]));
  }
  return false;
}

interface Splice { start: number; end: number; text: string }

export function patchYaml(original: string, next: object): string {
  const target = next as Obj;
  const src = original === '' || original.endsWith('\n') ? original : original + '\n';
  const doc = parseDocument(src);
  if (doc.errors.length) throw new Error(`YAML не разобран: ${doc.errors[0]!.message}`);
  const map = doc.contents;
  const cur: Obj = isObj(doc.toJS()) ? doc.toJS() : {};
  const order = 'code' in target || 'code' in cur ? ORDER.product : ORDER.service;
  const keys = orderedKeys(order, target);
  if (!isMap(map)) return newYaml('code' in target ? 'product' : 'service', target);

  const lineEnd = (x: number) => {
    if (x > 0 && src[x - 1] === '\n') return x;
    const nl = src.indexOf('\n', x);
    return nl < 0 ? src.length : nl + 1;
  };
  const lineStart = (x: number) => src.lastIndexOf('\n', x - 1) + 1;

  const splices: Splice[] = [];
  const ends = new Map<string, number>();
  let firstStart = src.length;
  for (const p of map.items) {
    if (!isScalar(p.key) || !p.key.range) continue;
    const key = String(p.key.value);
    const v = p.value;
    const start = p.key.range[0];
    const end = lineEnd(isScalar(v) || isCollection(v) ? v.range![2] : p.key.range[2]);
    ends.set(key, end);
    firstStart = Math.min(firstStart, start);
    const want = target[key];
    if (deepEqual(cur[key], want)) continue;
    if (!keep(want)) {
      splices.push({ start, end, text: '' });
      continue;
    }
    const keyText = src.slice(p.key.range[0], p.key.range[1]);
    if (isScalar(v) && !isObj(want) && !Array.isArray(want) && !String(v.type).startsWith('BLOCK')) {
      // Пустое значение (`key:`): диапазон пуст и стоит сразу после `:` или перед комментарием.
      const [r0, r1] = v.range!;
      const pre = src[r0 - 1] === ':' ? ' ' : '';
      const post = r0 === r1 && src[r1] === '#' ? ' ' : '';
      splices.push({ start: r0, end: r1, text: pre + scalar(want, v.type) + post });
    } else if (isCollection(v) && v.flow) {
      splices.push({ start, end, text: `${keyText}: ${flow(want)}${src.slice(v.range![1], end)}` });
    } else {
      const seqIndent = isSeq(v) ? v.range![0] - lineStart(v.range![0]) > start - lineStart(start) : true;
      splices.push({ start, end, text: pair(keyText, want, '', seqIndent, isMap(v)) });
    }
  }

  const inserts = new Map<number, string>();
  for (const key of keys) {
    if (key in cur) continue;
    const at = order.indexOf(key);
    const anchor = at < 0 ? undefined : order.slice(0, at).reverse().find((k) => ends.has(k));
    const pos = at < 0 ? src.length : anchor ? ends.get(anchor)! : firstStart;
    inserts.set(pos, (inserts.get(pos) ?? '') + pair(scalar(key), target[key], '', true));
  }
  for (const [pos, text] of inserts) splices.push({ start: pos, end: pos, text });

  if (!splices.length) return original;
  // С конца к началу; при равном начале сначала замена, затем вставка перед ней.
  splices.sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start));
  let out = src;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  checkResult(out, cur, target);
  return out;
}

/** Результат обязан разбираться ровно в `next` (с учётом нетронутых пустых списков), иначе файл не пишется. */
function checkResult(out: string, cur: Obj, target: Obj): void {
  const doc = parseDocument(out);
  const got: Obj = doc.errors.length ? {} : (doc.toJS() as Obj) ?? {};
  const want: Obj = {};
  for (const k of Object.keys(target)) {
    if (deepEqual(cur[k], target[k])) want[k] = cur[k];
    else if (keep(target[k])) want[k] = target[k];
  }
  if (doc.errors.length) throw new Error(`Правка YAML дала некорректный файл: ${doc.errors[0]!.message}`);
  const bad = [...new Set([...Object.keys(want), ...Object.keys(got)])].find((k) => !deepEqual(got[k], want[k]));
  if (bad !== undefined) throw new Error(`Правка YAML исказила ключ «${bad}»: файл не изменён`);
}

export function servicePath(team: string, code: string, name: string, type: string): string {
  const file = !type || type === 'backend' ? name : `${name}-${type}`;
  return `${team}/${code}/services/${file}.yaml`;
}

export const productPath = (team: string, code: string): string => `${team}/${code}/product.yaml`;
export const teamPath = (team: string): string => `${team}/team.yaml`;
