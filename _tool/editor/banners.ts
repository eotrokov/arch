// Шапка (счётчик корзины, пользователь, дата офлайн-модели) и баннеры (открытые MR, конфликты черновика).
import type { Change } from './cart.js';
import { h } from './fields.js';
import { byId } from './ui.js';
import type { Env } from './state.js';

export function renderHeader(env: Env): void {
  const { doc, app } = env;
  const $ = (id: string) => byId(doc, id);
  const n = app.cart.changes().length;
  const cnt = $('cartCount');
  cnt.hidden = false;
  cnt.textContent = `Изменений: ${n}`;
  cnt.title = 'Проверка и MR';
  cnt.classList.toggle('on', n > 0);
  $('reload').hidden = app.mode !== 'gitlab';
  const u = $('user');
  u.hidden = !app.user;
  u.textContent = app.user ? `${app.user.name} · @${app.user.username}` : '';
  const b = $('builtAt');
  b.hidden = app.mode !== 'offline';
  if (app.mode === 'offline') {
    const d = app.builtAt ? new Date(app.builtAt) : null;
    b.textContent = `Модель от ${d && !isNaN(d.getTime()) ? d.toLocaleString('ru-RU') : 'неизвестной даты'}`;
  }
}

export function renderBanners(env: Env, resolve: (c: Change, reopen: boolean) => void): void {
  const { doc, app } = env;
  const $ = (id: string) => byId(doc, id);
  const out: Node[] = [];
  if (app.openMrs.length) {
    out.push(h('div', { class: 'banner' }, h('strong', {}, 'Ваши открытые MR (ещё не в main): '),
      ...app.openMrs.flatMap((m, i) => [i ? ', ' : '', /^https?:\/\//i.test(m.webUrl)
        ? h('a', { href: m.webUrl, target: '_blank', rel: 'noopener' }, `!${m.iid} ${m.title}`)
        : h('span', {}, `!${m.iid} ${m.title}`)])));
  }
  if (app.conflicts.length) {
    const box = h('div', { class: 'banner conflict', id: 'conflicts' },
      h('strong', {}, 'Черновик: эти файлы изменились в main после вашей правки. Автослияния нет — выберите действие.'));
    for (const c of app.conflicts) {
      const drop = h('button', { type: 'button', class: 'ghost' }, 'Отбросить мою правку');
      drop.addEventListener('click', () => resolve(c, false));
      const reopen = h('button', { type: 'button', class: 'ghost' }, 'Открыть заново');
      reopen.addEventListener('click', () => resolve(c, true));
      box.append(h('div', { class: 'crow' }, h('span', {}, c.label), h('code', {}, c.path), h('span', { class: 'sp' }), drop, reopen));
    }
    out.push(box);
  }
  $('banners').replaceChildren(...out);
}
