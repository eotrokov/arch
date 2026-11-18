// Элементы полей мастера: текст, число, выпадающий список, флажки, списки строк. Браузерный код без фреймворка.
import { stringify } from 'yaml';

export type Obj = Record<string, unknown>;
export interface Opt { value: string; label: string }

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const objs = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => typeof x === 'object' && x !== null) as Obj[]) : []);

/** Пустое значение удаляет ключ (необязательные поля не пишутся в YAML; пустые списки отбрасывает yamlEdit). */
export function setKey(o: Obj, key: string, v: unknown): void {
  if (v === undefined || v === '') delete o[key];
  else o[key] = v;
}

/** Число из поля ввода; нечисловой текст остаётся строкой — его покажет проверка схемы. */
export const num = (s: string): number | string | undefined => (s.trim() === '' ? undefined : /^-?\d+$/.test(s.trim()) ? Number(s) : s);

let seq = 0;

export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h('label', { class: 'fld' }, h('span', { class: 'fl' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function readonlyNote(): HTMLElement {
  return h('span', { class: 'ro-note' }, 'меняется вручную в YAML');
}

export function text(value: string, onInput: (v: string) => void, o: { type?: string; readonly?: boolean; placeholder?: string; list?: string[]; label?: string } = {}): HTMLElement {
  const input = h('input', { type: o.type ?? 'text', class: 'in', value, placeholder: o.placeholder ?? false, 'aria-label': o.label ?? false, readonly: !!o.readonly });
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  if (!o.list?.length || o.readonly) return input;
  const id = `dl${++seq}`;
  input.setAttribute('list', id);
  return h('span', { class: 'dl' }, input, h('datalist', { id }, ...o.list.map((v) => h('option', { value: v }))));
}

/** Выпадающий список. Значения нет в списке (ссылка сломана или задана вручную) — оно сохраняется отдельным пунктом. */
export function select(value: string, options: Opt[], onChange: (v: string) => void, o: { empty?: string; readonly?: boolean; label?: string } = {}): HTMLSelectElement {
  const el = h('select', { class: 'in', 'aria-label': o.label ?? false, disabled: !!o.readonly });
  const all = [...options];
  if (value && !all.some((x) => x.value === value)) all.unshift({ value, label: `${value} (нет в модели)` });
  if (o.empty !== undefined || !value) el.append(h('option', { value: '' }, o.empty ?? '— выберите —'));
  for (const x of all) el.append(h('option', { value: x.value }, x.label));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checks(values: string[], options: Opt[], onChange: (vs: string[]) => void): HTMLElement {
  const all = [...options, ...values.filter((v) => !options.some((x) => x.value === v)).map((v) => ({ value: v, label: `${v} (нет в модели)` }))];
  if (!all.length) return h('span', { class: 'empty' }, 'нет вариантов');
  const box = h('span', { class: 'checks' });
  for (const x of all) {
    const cb = h('input', { type: 'checkbox', checked: values.includes(x.value) });
    cb.addEventListener('change', () => {
      const cur = new Set(values);
      if (cb.checked) cur.add(x.value);
      else cur.delete(x.value);
      values = all.map((a) => a.value).filter((v) => cur.has(v));
      onChange(values);
    });
    box.append(h('label', { class: 'chk' }, cb, x.label));
  }
  return box;
}

/** Список объектов: строка на элемент с кнопкой «удалить» и кнопка «+ добавить». */
export function rows(title: string, items: Obj[], renderRow: (item: Obj, i: number) => Node[], on: { add: () => void; remove: (i: number) => void }): HTMLElement {
  const box = h('fieldset', { class: 'rows' }, h('legend', {}, title));
  items.forEach((it, i) => {
    const del = h('button', { type: 'button', class: 'ghost del' }, 'удалить');
    del.addEventListener('click', () => on.remove(i));
    box.append(h('div', { class: 'row' }, ...renderRow(it, i), del));
  });
  const add = h('button', { type: 'button', class: 'ghost add' }, '+ добавить');
  add.addEventListener('click', on.add);
  box.append(add);
  return box;
}

/** Поле вне мастера: YAML только для чтения. */
export function readonlyYaml(key: string, value: unknown): HTMLElement {
  return h('div', { class: 'ro' }, h('div', { class: 'fl' }, key, ' ', readonlyNote()),
    h('pre', {}, stringify({ [key]: value }, { lineWidth: 0 }).trimEnd()));
}
