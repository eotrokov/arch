// Генерация новых YAML-файлов модели и минимальная правка существующих.
// Браузерный код: без модулей Node.
//
// Новые файлы: канонический порядок ключей, списки — block, их элементы —
// flow `{ ... }`, если внутри нет вложенных объектов (как в демо-модели).
// Правка: parseDocument даёт узлы и их позиции в исходном тексте; правка
// рекурсивна: в блочных map — по ключам, в блочных списках — по сопоставленным
// элементам, скаляры (и блочные `|`/`>`) — по своему диапазону, flow-коллекции —
// целиком. Остальной текст (комментарии, порядок, стиль, отступы) остаётся
// байт-в-байт; новые строки — в стиле соседей, CRLF-файл остаётся CRLF.
// Если результат не прошёл проверку, изменённые значения верхнего уровня
// заменяются целиком; не прошёл и тогда — ошибка, файл не меняется.

import { Document, isMap, isScalar, isSeq, isCollection, parseDocument, Scalar, visit } from 'yaml';
import type { Pair, YAMLMap, YAMLSeq } from 'yaml';

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
type Edits = Splice[] | null;

/** Текст и позиционные помощники; `fine` — точечная правка внутри блоков (иначе — замена значения целиком). */
class Src {
  constructor(readonly text: string, readonly fine: boolean, readonly seqIndent: boolean) {}
  lineStart(x: number): number { return this.text.lastIndexOf('\n', x - 1) + 1; }
  lineEnd(x: number): number {
    if (x > 0 && this.text[x - 1] === '\n') return x;
    const nl = this.text.indexOf('\n', x);
    return nl < 0 ? this.text.length : nl + 1;
  }
  col(x: number): number { return x - this.lineStart(x); }
  /** Начало строк-комментариев с отступом `col` непосредственно над строкой, начинающейся в `ls`. */
  commentsAbove(ls: number, col: number): number {
    while (ls > 0) {
      const prev = this.lineStart(ls - 1);
      const line = this.text.slice(prev, ls - 1);
      if (line.trimStart().startsWith('#') && line.length - line.trimStart().length === col) ls = prev;
      else break;
    }
    return ls;
  }
  /** Перед позицией `x` в её строке только пробелы (и `- `, если `dash`). */
  lineLead(x: number, dash = false): boolean {
    return (dash ? /^ *- +$/ : /^ *$/).test(this.text.slice(this.lineStart(x), x));
  }
}

const rng = (n: unknown) => (n as { range?: [number, number, number] } | null)?.range;
const isBlock = (n: unknown) => isCollection(n) && !n.flow;

/** Конец пары: строка, где кончается значение (без хвостовых комментариев-строк). */
function pairEnd(s: Src, p: Pair): number {
  const r = rng(p.value);
  return s.lineEnd(r ? r[1] : rng(p.key)![2]);
}

/** Правки, превращающие значение-узел `node` (сейчас `cur`) в `want`; null — точечно нельзя. */
function patchNode(s: Src, node: unknown, cur: unknown, want: unknown): Edits {
  if (deepEqual(cur, want)) return [];
  const r = rng(node);
  if (!r) return null;
  const wantCol = Array.isArray(want) || isObj(want);
  if (isScalar(node)) {
    if (wantCol) return null;
    if (String(node.type).startsWith('BLOCK')) return typeof want === 'string' ? blockScalar(s, node, want) : null;
    // Пустое значение (`key:`): диапазон пуст и стоит сразу после `:` или перед комментарием.
    const pre = s.text[r[0] - 1] === ':' ? ' ' : '';
    const post = r[0] === r[1] && s.text[r[1]] === '#' ? ' ' : '';
    return [{ start: r[0], end: r[1], text: pre + scalar(want, node.type) + post }];
  }
  if (!isCollection(node) || !wantCol) return null;
  if (node.flow) return [{ start: r[0], end: r[1], text: flow(want) }];
  if (!s.fine) return null;
  if (isMap(node) && isObj(want) && entries(want).length && isObj(cur)) return patchMap(s, node, cur, want);
  if (isSeq(node) && Array.isArray(want) && want.length && Array.isArray(cur)) return patchSeq(s, node, cur, want);
  return null;
}

/** Блочный скаляр `|`/`>`: заголовок остаётся, если не изменился индикатор; текст — с прежним отступом. */
function blockScalar(s: Src, node: Scalar, want: string): Edits {
  const [r0, r1] = rng(node)!;
  const n = new Scalar(want);
  n.type = node.type;
  const lines = new Document({ k: n }).toString({ lineWidth: 0 }).split('\n');
  const head = lines[0]!.slice(3);
  const body = lines.slice(1, -1);
  const bodyStart = s.lineEnd(r0);
  const first = s.text.slice(bodyStart, r1).split('\n').find((l) => l.trim());
  const oldHead = /^[|>][-+0-9]*/.exec(s.text.slice(r0))?.[0];
  if (!/^[|>][-+]?$/.test(head) || first === undefined || !oldHead) return null;
  const ind = ' '.repeat(first.length - first.trimStart().length);
  const text = body.map((l) => (l ? ind + l.slice(2) : l) + '\n').join('');
  const out: Splice[] = [{ start: bodyStart, end: r1, text }];
  if (head !== oldHead) out.push({ start: r0, end: r0 + oldHead.length, text: head });
  return out;
}

/** Пара целиком заново (в стиле исходного значения), начиная с ключа. */
function replacePair(s: Src, p: Pair, want: unknown): Splice {
  const k = rng(p.key)!;
  const v = p.value;
  const ind = ' '.repeat(s.col(k[0]));
  const seqIndent = isSeq(v) && !v.flow ? s.col(rng(v)![0]) > s.col(k[0]) : s.seqIndent;
  const text = pair(s.text.slice(k[0], k[1]), want, ind, seqIndent, isMap(v));
  return { start: k[0], end: pairEnd(s, p), text: text.slice(ind.length) };
}

function patchMap(s: Src, map: YAMLMap, cur: Obj, want: Obj): Edits {
  const out: Splice[] = [];
  let col = -1, last = -1;
  for (const p of map.items) {
    if (!isScalar(p.key) || !rng(p.key)) return null;
    const key = String(p.key.value);
    const k0 = rng(p.key)![0];
    if (col < 0) col = s.col(k0);
    last = pairEnd(s, p);
    if (want[key] === undefined) {
      if (!s.lineLead(k0)) return null;
      out.push({ start: s.commentsAbove(s.lineStart(k0), col), end: last, text: '' });
      continue;
    }
    out.push(...(patchNode(s, p.value, cur[key], want[key]) ?? [replacePair(s, p, want[key])]));
  }
  if (col < 0) return null;
  const add = entries(want).filter(([k]) => !(k in cur));
  if (add.length) out.push({ start: last, end: last, text: add.map(([k, v]) => pair(scalar(k), v, ' '.repeat(col), s.seqIndent)).join('') });
  return out;
}

/** Сопоставление элементов (LCS по равенству): пары [i, j] совпавших элементов. */
function matchItems(a: unknown[], b: unknown[]): [number, number][] {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = deepEqual(a[i], b[j]) ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (deepEqual(a[i], b[j])) out.push([i++, j++]);
    else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

function patchSeq(s: Src, seq: YAMLSeq, cur: unknown[], want: unknown[]): Edits {
  const items = seq.items;
  if (items.length !== cur.length || !items.length) return null;
  const starts: number[] = [];
  for (const it of items) {
    const r = rng(it);
    if (!r || !s.lineLead(r[0], true)) return null;
    starts.push(s.lineStart(r[0]));
  }
  const dashCol = s.text.indexOf('-', starts[0]!) - starts[0]!;
  const end = (i: number) => s.lineEnd(rng(items[i])![1]);
  const out: Splice[] = [];
  const gap = (i0: number, i1: number, j0: number, j1: number) => {
    let i = i0, j = j0;
    for (; i < i1 && j < j1; i++, j++) {
      out.push(...(patchNode(s, items[i], cur[i], want[j]) ?? [{ start: starts[i]!, end: end(i), text: item(want[j], ' '.repeat(dashCol), s.seqIndent) }]));
    }
    for (; i < i1; i++) out.push({ start: s.commentsAbove(starts[i]!, dashCol), end: end(i), text: '' });
    if (j < j1) {
      const at = i1 > 0 ? end(i1 - 1) : s.commentsAbove(starts[0]!, dashCol);
      out.push({ start: at, end: at, text: want.slice(j, j1).map((x) => item(x, ' '.repeat(dashCol), s.seqIndent)).join('') });
    }
  };
  let pi = 0, pj = 0;
  for (const [i, j] of matchItems(cur, want)) {
    gap(pi, i, pj, j);
    pi = i + 1;
    pj = j + 1;
  }
  gap(pi, cur.length, pj, want.length);
  return out;
}

/** Стиль списков файла: отступает ли `- ` под ключом (по первому блочному списку). */
function detectSeqIndent(text: string, map: YAMLMap): boolean {
  const s = new Src(text, false, true);
  let found: boolean | undefined;
  visit(map, {
    Pair(_, p) {
      if (found === undefined && isSeq(p.value) && !p.value.flow && rng(p.key) && rng(p.value)) {
        found = s.col(rng(p.value)![0]) > s.col(rng(p.key)![0]);
        return visit.BREAK;
      }
    },
  });
  return found ?? true;
}

/** `kind` задаёт порядок ключей для новых ключей; без него — по наличию `code` (продукт) или сервис. */
export function patchYaml(original: string, next: object, kind?: YamlKind): string {
  // Файл целиком в CRLF правится как LF и возвращается в CRLF.
  const crlf = original.includes('\r\n') && !/(^|[^\r])\n/.test(original);
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const target = next as Obj;
  const src = text === '' || text.endsWith('\n') ? text : text + '\n';
  const doc = parseDocument(src);
  if (doc.errors.length) throw new Error(`YAML не разобран: ${doc.errors[0]!.message}`);
  const map = doc.contents;
  const cur: Obj = isObj(doc.toJS()) ? doc.toJS() : {};
  const k: YamlKind = kind ?? ('code' in target || 'code' in cur ? 'product' : 'service');
  const eol = (x: string) => (crlf ? x.replace(/\n/g, '\r\n') : x);
  if (!isMap(map)) return eol(newYaml(k, target));

  const seqIndent = detectSeqIndent(src, map);
  let out: string | undefined;
  try {
    out = splice(new Src(src, true, seqIndent), map, cur, target, k);
    if (out !== undefined) checkResult(out, cur, target);
  } catch {
    // Точечная правка не прошла проверку — замена изменённых значений целиком.
    out = splice(new Src(src, false, seqIndent), map, cur, target, k);
    if (out !== undefined) checkResult(out, cur, target);
  }
  return out === undefined ? original : eol(out);
}

/** Правки верхнего уровня (порядок новых ключей — канонический) и их применение; undefined — изменений нет. */
function splice(s: Src, map: YAMLMap, cur: Obj, target: Obj, k: YamlKind): string | undefined {
  const order = ORDER[k];
  const splices: Splice[] = [];
  const ends = new Map<string, number>();
  let firstStart = s.text.length;
  for (const p of map.items) {
    if (!isScalar(p.key) || !p.key.range) continue;
    const key = String(p.key.value);
    const start = p.key.range[0];
    const r = rng(p.value);
    const end = s.lineEnd(r ? r[2] : p.key.range[2]);
    ends.set(key, end);
    firstStart = Math.min(firstStart, start);
    const want = target[key];
    if (deepEqual(cur[key], want)) continue;
    if (!keep(want)) splices.push({ start: s.commentsAbove(s.lineStart(start), 0), end, text: '' });
    else splices.push(...(patchNode(s, p.value, cur[key], want) ?? [replacePair(s, p, want)]));
  }

  const inserts = new Map<number, string>();
  for (const key of orderedKeys(order, target)) {
    if (key in cur) continue;
    const at = order.indexOf(key);
    const anchor = at < 0 ? undefined : order.slice(0, at).reverse().find((x) => ends.has(x));
    const pos = at < 0 ? s.text.length : anchor ? ends.get(anchor)! : firstStart;
    inserts.set(pos, (inserts.get(pos) ?? '') + pair(scalar(key), target[key], '', true));
  }
  for (const [pos, text] of inserts) splices.push({ start: pos, end: pos, text });

  if (!splices.length) return undefined;
  // С конца к началу; при равном начале сначала замена, затем вставка перед ней.
  splices.sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start));
  let out = s.text;
  let limit = Infinity;
  for (const sp of splices) {
    // Пересекающиеся удаления (комментарий над ключом в хвосте предыдущего значения) сливаются.
    if (sp.end > limit) {
      if (sp.text) throw new Error('Правка YAML: пересекающиеся правки');
      sp.end = limit;
    }
    out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);
    limit = sp.start;
  }
  return out;
}

/** Результат обязан разбираться ровно в `next` (с учётом нетронутых пустых списков), иначе файл не пишется. */
function checkResult(out: string, cur: Obj, target: Obj): void {
  const doc = parseDocument(out);
  let got: Obj = {};
  try {
    if (!doc.errors.length) got = (doc.toJS() as Obj) ?? {};
  } catch (e) {
    throw new Error(`Правка YAML дала некорректный файл: ${(e as Error).message}`);
  }
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
