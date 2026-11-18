// Дерево команд/продуктов/сервисов по путям файлов (main + корзина) и его кнопки.
import { applyCart } from './cart.js';
import type { WizardKind } from './forms.js';
import type { PickLists } from './model.js';
import { h } from './fields.js';
import { btn } from './ui.js';
import type { Env } from './state.js';

export interface TreeActions {
  open(kind: WizardKind, path: string): void;
  create(kind: WizardKind, team?: string, product?: string): void;
  removeService(path: string, id: string): void;
  removeFromCart(path: string): void;
}

/** Работает и когда модель не проходит проверку: имена — из последних удачных списков picks. */
export function renderTree(env: Env, picks: PickLists, act: TreeActions): void {
  const { doc, app } = env;
  const el = doc.getElementById('tree');
  if (!el) return;
  const files = applyCart(app.files, app.cart.changes());
  const changed = new Map(app.cart.changes().map((c) => [c.path, c]));
  const names = new Map<string, string>();
  for (const t of picks.teams) names.set(t.id, t.name);
  for (const p of picks.products) names.set(`${p.team}/${p.code}`, p.name);
  const cur = app.wizard ? (app.cartPath ?? app.wizard.path) : '';
  const tag = (path: string) => {
    const c = changed.get(path);
    return c ? h('span', { class: `chg ${c.content === null ? 'del' : path in app.files ? 'mod' : 'new'}` }, c.content === null ? 'удалён' : path in app.files ? 'изменён' : 'новый') : null;
  };
  const item = (path: string, label: string, sub: string, kind: WizardKind) => {
    const b = h('button', { type: 'button', class: 'node', 'aria-current': cur === path ? 'true' : false }, h('span', { class: 'k' }, sub), label, tag(path));
    b.addEventListener('click', () => act.open(kind, path));
    return b;
  };

  const teams = [...new Set(Object.keys(files).map((p) => p.split('/')).filter((p) => p.length > 1 && !/^[_.]/.test(p[0]!)).map((p) => p[0]!))].sort();
  const root = h('ul', {});
  for (const team of teams) {
    const tpath = `${team}/team.yaml`;
    const products = [...new Set(Object.keys(files).filter((p) => p.startsWith(`${team}/`) && p.endsWith('/product.yaml') && p.split('/').length === 3).map((p) => p.split('/')[1]!))].sort();
    const pl = h('ul', {});
    for (const code of products) {
      const prefix = `${team}/${code}/services/`;
      const svcs = Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).sort();
      const deleted = [...changed.values()].filter((c) => c.content === null && c.path.startsWith(prefix));
      const sl = h('ul', {});
      for (const p of svcs) {
        const base = p.slice(prefix.length).replace(/\.ya?ml$/, '');
        const id = `${code}-${base}`;
        sl.append(h('li', { class: 'svc' }, item(p, base, 'сервис', 'service'),
          btn('✕', 'ghost icon', () => act.removeService(p, id), 'Удалить сервис')));
      }
      for (const c of deleted) {
        sl.append(h('li', { class: 'svc gone' }, h('span', {}, c.path.slice(prefix.length).replace(/\.ya?ml$/, '')), tag(c.path),
          btn('↺', 'ghost icon', () => act.removeFromCart(c.path), 'Убрать из корзины')));
      }
      sl.append(h('li', {}, btn('+ сервис', 'ghost add', () => act.create('service', team, code))));
      pl.append(h('li', {}, item(`${team}/${code}/product.yaml`, names.get(`${team}/${code}`) ?? code, code, 'product'), sl));
    }
    pl.append(h('li', {}, btn('+ продукт', 'ghost add', () => act.create('product', team))));
    root.append(h('li', {}, tpath in files ? item(tpath, names.get(team) ?? team, team, 'team') : h('span', { class: 'node' }, team), pl));
  }
  el.replaceChildren(
    h('div', { class: 'lvl' }, 'Команды, продукты, сервисы'),
    btn('+ команда', 'ghost add', () => act.create('team')),
    root,
    h('p', { class: 'shared' }, h('code', {}, '_shared'), ' — сети, платформа, справочники: только чтение, меняют архитекторы.'),
  );
}
