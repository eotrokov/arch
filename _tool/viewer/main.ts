// Точка входа просмотрщика: данные из <script id="arch-data">, состояние в location.hash. Без импортов Node.
import type { Finding, Link, Model, Owner } from '../src/model/types.js';
import { buildView } from '../src/views/index.js';
import type { FirewallRow, Scope, ViewGraph, ViewKind } from '../src/views/types.js';
import { cardData, type CardData } from './panels.js';
import { parseHash, toHash, type UiState } from './state.js';
import { GraphView } from './render.js';

interface ArchData { model: Model; findings: Finding[]; builtAt: string }

const VIEWS: [ViewKind, string][] = [
  ['kubernetes', 'Kubernetes'], ['containers', 'Контейнеры'], ['firewall', 'Фаервол'], ['databases', 'БД'], ['dataflows', 'Потоки данных'],
];
const VIEW_LABEL = new Map(VIEWS);
const ROLE: Record<string, string> = {
  dba: 'DBA', owner: 'Владелец продукта', techlead: 'Техлид', architect: 'Архитектор', analyst: 'Аналитик',
  devops: 'DevOps', security: 'ИБ', oncall: 'Дежурство',
};
const LINK_ICON: Record<string, string> = {
  repo: '⌥ репо', docs: '▤ доки', api: '⇄ API', adr: '✎ ADR', wiki: '▤ wiki', tracker: '☑ трекер',
  dashboard: '◔ дашборд', alerts: '⚠ алерты', runbook: '☰ runbook', ci: '▶ CI', other: '↗ ссылка',
};
const ATTN: Record<string, string> = { sensitive: 'ПДн', external: 'внешн.', 'cross-product': 'межпрод.', egress: 'наружу' };
const LEVEL: Record<Finding['level'], [string, string]> = {
  error: ['ошибка', 'p-err'], warning: ['предупр.', 'p-warn'], attention: ['внимание ИБ', 'p-attn'],
};
const LEVEL_ORDER: Finding['level'][] = ['error', 'warning', 'attention'];

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeUrl = (u: string) => /^(https?:|mailto:)/i.test(u);
const scopeKey = (s: Scope) => (s.kind === 'company' ? 'company' : `${s.kind}:${s.id}`);

function copyText(doc: Document, text: string, btn: HTMLElement): void {
  const done = () => {
    const t = btn.textContent;
    btn.textContent = 'скопировано';
    setTimeout(() => { btn.textContent = t; }, 1200);
  };
  const fallback = () => {
    const ta = doc.createElement('textarea');
    ta.value = text;
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand('copy'); done(); } catch { /* буфер недоступен */ }
    ta.remove();
  };
  try { void navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
}

export function boot(doc: Document): void {
  const win = doc.defaultView!;
  const data = JSON.parse(doc.getElementById('arch-data')!.textContent ?? '{}') as ArchData;
  const { model, findings } = data;
  const $ = (id: string) => doc.getElementById(id)!;
  const sensitiveSegments = new Set(model.segments.filter((s) => s.sensitive).map((s) => s.id));
  const segName = (id: string) => model.segments.find((s) => s.id === id)?.name ?? id;

  const graphs = new Map<string, ViewGraph>();
  const cards = new Map<string, CardData>();
  const graphOf = (key: string, s: UiState) => {
    let g = graphs.get(key);
    if (!g) graphs.set(key, (g = buildView(model, findings, s.scope, s.view)));
    return g;
  };
  const cardOf = (id: string) => {
    let c = cards.get(id);
    if (!c) cards.set(id, (c = cardData(model, findings, id)));
    return c;
  };

  let state = parseHash(win.location.hash);
  let bottom: 'conn' | 'find' = 'conn';
  let query = '';
  let activeFinding = -1;
  let currentKey = '';
  let current: ViewGraph = { nodes: [], edges: [] };

  const go = (next: UiState) => {
    const h = toHash(next);
    if (h === win.location.hash) render();
    else win.location.hash = h;
  };

  const graph = new GraphView(doc, $('cy'), {
    onSelect: (id) => go({ ...state, selected: id }),
    onExpand: (code) => {
      if (state.scope.kind !== 'company' || state.scope.expanded.includes(code)) return;
      go({ ...state, scope: { kind: 'company', expanded: [...state.scope.expanded, code] } });
    },
  });

  const built = new Date(data.builtAt);
  $('builtAt').textContent = `собрано ${Number.isNaN(built.getTime()) ? data.builtAt : built.toLocaleString('ru-RU')}`;

  // ---- разрезы и охват ----
  function renderTabs(): void {
    const t = $('viewTabs');
    t.innerHTML = VIEWS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${state.view === k}" data-v="${k}">${l}</button>`).join('');
    t.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => go({ ...state, view: b.dataset.v as ViewKind });
    });
  }

  function renderCrumb(): void {
    const s = state.scope;
    const el = $('crumb');
    if (s.kind === 'company') {
      el.innerHTML = s.expanded.length
        ? `Компания · раскрыто: ${esc(s.expanded.join(', '))} <button type="button" class="copy" id="collapseAll">свернуть</button>`
        : 'Компания · двойной клик по продукту раскрывает его';
      const b = doc.getElementById('collapseAll');
      if (b) b.onclick = () => go({ ...state, scope: { kind: 'company', expanded: [] } });
      return;
    }
    const name = s.kind === 'team' ? model.teams.find((t) => t.id === s.id)?.name
      : s.kind === 'product' ? model.products.find((p) => p.code === s.id)?.name : s.id;
    el.textContent = `${{ team: 'Команда', product: 'Продукт', service: 'Сервис' }[s.kind]} ${name ?? s.id}`;
  }

  function renderTree(): void {
    const el = $('tree');
    const cur = (k: string, id?: string) => state.scope.kind === k && (k === 'company' || (state.scope as { id: string }).id === id);
    const q = query.toLowerCase();
    const m = (...xs: (string | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q));
    const btn = (k: string, id: string, label: string, tag = '') =>
      `<button type="button" data-k="${k}" data-id="${esc(id)}" aria-current="${cur(k, id)}">${tag ? `<span class="k">${esc(tag)}</span>` : ''}${esc(label)}</button>`;
    let h = '<div class="lvl">Охват</div><ul>';
    h += `<li>${btn('company', '', 'Вся компания')}</li>`;
    for (const t of model.teams) {
      const prods = model.products.filter((p) => p.team === t.id || t.products.includes(p.code));
      let inner = '';
      for (const p of prods) {
        const svcs = Object.values(model.nodes).filter((n) => n.kind === 'service' && n.product === p.code).sort((a, b) => a.id.localeCompare(b.id));
        const shown = svcs.filter((n) => m(n.id, n.label));
        if (!m(p.name, p.code) && shown.length === 0) continue;
        inner += `<li>${btn('product', p.code, p.name, p.code)}<ul>${(m(p.name, p.code) ? svcs : shown)
          .map((s) => `<li>${btn('service', s.id, s.id)}</li>`).join('')}</ul></li>`;
      }
      if (!inner && !m(t.name, t.id)) continue;
      h += `<li>${btn('team', t.id, t.name, 'команда')}<ul>${inner}</ul></li>`;
    }
    el.querySelector('.tree-body')?.remove();
    let input = el.querySelector<HTMLInputElement>('input.search');
    if (!input) {
      el.innerHTML = '<input class="search" type="search" placeholder="Поиск по имени" aria-label="Поиск по имени">';
      input = el.querySelector<HTMLInputElement>('input.search')!;
      input.oninput = () => { query = input!.value; renderTree(); };
    }
    const body = doc.createElement('div');
    body.className = 'tree-body';
    body.innerHTML = `${h}</ul>`;
    el.appendChild(body);
    body.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.k!;
        const id = b.dataset.id!;
        const scope: Scope = k === 'company' ? { kind: 'company', expanded: [] } : { kind: k as 'team' | 'product' | 'service', id };
        const selected = k === 'service' ? id : k === 'product' ? `product:${id}` : state.selected;
        go({ ...state, scope, selected });
      };
    });
  }

  // ---- карточка ----
  function ownersHtml(list: Owner[], inherited: boolean): string {
    const head = `<h3>Ответственные${inherited ? '<span class="inh">из продукта</span>' : ''}</h3>`;
    if (list.length === 0) return `${head}<p class="empty">Не указаны.</p>`;
    return head + list.map((o) => `<div class="owner"><span class="role">${esc(ROLE[o.role] ?? o.role)}</span><span>${esc(o.name)}<br><span class="contact">${esc(o.contact ?? '')}</span></span>${
      o.contact ? `<button type="button" class="copy" data-c="${esc(o.contact)}">копировать</button>` : ''}</div>`).join('');
  }

  function linksHtml(list: Link[]): string {
    if (list.length === 0) return '';
    return `<h3>Ссылки</h3><div class="links">${list.map((l) => {
      const inner = `<span class="lk">${esc(LINK_ICON[l.kind] ?? `↗ ${l.kind}`)}</span>${esc(l.title ?? l.url)}`;
      return safeUrl(l.url) ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span>${inner}</span>`;
    }).join('')}</div>`;
  }

  const dl = (rows: [string, string][]) => `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

  function subtitle(id: string): string {
    if (id.startsWith('product:')) return 'Продукт';
    const n = model.nodes[id];
    if (!n) return '';
    const kind = {
      service: `Сервис · ${n.serviceType || 'backend'}`, database: 'База данных', dbserver: 'Сервер СУБД', topic: 'Топик Kafka',
      platform: `Ресурс · ${n.resourceKind ?? ''}`, external: 'Внешняя система', actor: 'Актор',
    }[n.kind];
    return [kind, n.product ? `продукт ${n.product}` : ''].filter(Boolean).join(' · ');
  }

  function renderCard(): void {
    const el = $('card');
    const id = state.selected;
    el.dataset.node = id ?? '';
    if (!id) {
      el.innerHTML = '<p class="empty">Выберите элемент на схеме, чтобы увидеть его атрибуты, ответственных и ссылки.</p>';
      return;
    }
    const c = cardOf(id);
    let h = `<h2>${esc(c.title)}</h2><div class="sub">${esc(subtitle(id))}</div>`;
    if (c.attrs.length) h += `<h3>Атрибуты</h3>${dl(c.attrs)}`;
    if (c.names.length) h += `<h3>Имена по регламенту</h3>${dl(c.names)}`;
    h += ownersHtml(c.owners, c.ownersInherited);
    h += linksHtml(c.links);
    if (c.findings.length) {
      h += '<h3>Нарушения</h3>' + c.findings.map((f) =>
        `<p class="cf"><span class="pill ${LEVEL[f.level][1]}">${LEVEL[f.level][0]}</span> ${esc(f.message)}</p>`).join('');
    }
    if (id.startsWith('product:')) {
      const code = id.slice('product:'.length);
      h += `<h3>Действия</h3><div class="views"><button type="button" data-act="open">Открыть продукт</button>${
        state.scope.kind === 'company' && !state.scope.expanded.includes(code) ? '<button type="button" data-act="expand">Раскрыть на схеме</button>' : ''}</div>`;
    }
    h += `<h3>Показать в разрезе</h3><div class="views">${VIEWS.map(([k, l]) =>
      `<button type="button" data-v="${k}" ${c.views.includes(k) && k !== state.view ? '' : 'disabled'}>${l}</button>`).join('')}</div>`;
    el.innerHTML = h;
    el.querySelectorAll<HTMLButtonElement>('.views button[data-v]').forEach((b) => {
      b.onclick = () => go({ ...state, view: b.dataset.v as ViewKind });
    });
    el.querySelectorAll<HTMLButtonElement>('.copy[data-c]').forEach((b) => { b.onclick = () => copyText(doc, b.dataset.c!, b); });
    el.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      b.onclick = () => {
        const code = id.slice('product:'.length);
        if (b.dataset.act === 'open') go({ ...state, scope: { kind: 'product', id: code } });
        else if (state.scope.kind === 'company') go({ ...state, scope: { kind: 'company', expanded: [...state.scope.expanded, code] } });
      };
    });
  }

  // ---- нижняя панель ----
  const nodeLabel = (id: string) => (current.nodes.find((n) => n.id === id)?.label ?? id).split('\n')[0]!;
  const sorted = [...findings].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));

  function rowCells(r: FirewallRow): string[] {
    return [nodeLabel(r.fromNode), segName(r.fromSegment), nodeLabel(r.toNode), segName(r.toSegment), r.toHosts.join(', '), r.port, r.protocol, r.reason];
  }

  function renderBottom(): void {
    const b = $('bbody');
    $('bt-conn').setAttribute('aria-selected', String(bottom === 'conn'));
    $('bt-find').setAttribute('aria-selected', String(bottom === 'find'));
    $('bt-find').textContent = `Нарушения (${findings.filter((f) => f.level !== 'attention').length})`;
    ($('copyTsv') as HTMLButtonElement).hidden = !(bottom === 'conn' && state.view === 'firewall');
    if (bottom === 'conn') {
      if (state.view !== 'firewall') {
        b.innerHTML = '<p class="empty" style="padding:10px">Таблица соединений строится в разрезе «Фаервол».</p>';
        return;
      }
      const rows = current.table ?? [];
      b.innerHTML = `<table><thead><tr><th>Источник</th><th>Сегмент</th><th>Назначение</th><th>Сегмент</th><th>Хосты назначения</th><th>Порт/протокол</th><th>Отметки</th><th>Основание</th></tr></thead><tbody>${
        rows.map((r) => {
          const marks = r.attention.map((a) => `<span class="pill p-attn">${esc(ATTN[a] ?? a)}</span>`).join(' ')
            + (r.intraSegment ? ' <span class="pill p-intra">внутри сегм.</span>' : '');
          return `<tr><td class="m">${esc(nodeLabel(r.fromNode))}</td><td>${esc(segName(r.fromSegment))}</td><td class="m">${esc(nodeLabel(r.toNode))}</td><td>${esc(segName(r.toSegment))}</td><td class="m hosts">${
            r.toHosts.length ? r.toHosts.map(esc).join('<br>') : '—'}</td><td class="m">${esc(r.port)}/${esc(r.protocol)}</td><td>${marks}</td><td class="r">${esc(r.reason)}</td></tr>`;
        }).join('')}</tbody></table>${rows.length ? '' : '<p class="empty" style="padding:10px">Соединений нет.</p>'}`;
      return;
    }
    if (sorted.length === 0) {
      b.innerHTML = '<p class="empty" style="padding:10px">Нарушений нет.</p>';
      return;
    }
    b.innerHTML = sorted.map((f, i) => `<div class="find${i === activeFinding ? ' hl' : ''}" data-i="${i}"><span class="pill ${LEVEL[f.level][1]}">${LEVEL[f.level][0]}</span><code>${esc(f.rule)}</code><span>${esc(f.message)}</span></div>`).join('');
    b.querySelectorAll<HTMLElement>('.find').forEach((d) => {
      d.onclick = () => {
        activeFinding = Number(d.dataset.i);
        const f = sorted[activeFinding]!;
        graph.highlight(f.nodeIds, f.edgeIds);
        if (f.nodeIds[0]) go({ ...state, selected: f.nodeIds[0] });
        else renderBottom();
      };
    });
  }

  $('bt-conn').onclick = () => { bottom = 'conn'; renderBottom(); };
  $('bt-find').onclick = () => { bottom = 'find'; renderBottom(); };
  $('copyTsv').onclick = (ev) => {
    const head = ['Источник', 'Сегмент', 'Назначение', 'Сегмент', 'Хосты', 'Порт', 'Протокол', 'Основание'];
    const tsv = [head, ...(current.table ?? []).map(rowCells)].map((r) => r.map((x) => x.replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
    copyText(doc, tsv, ev.currentTarget as HTMLElement);
  };

  function renderLegend(): void {
    const items: [string, string][] = state.view === 'dataflows'
      ? [['--pdn', 'ПДн'], ['--kt', 'КТ'], ['--open', 'открытые']]
      : [['--err', 'нарушение'], ['--attn', 'внимание ИБ'], ['--accent', 'выбрано']];
    $('legend').innerHTML = items.map(([c, t]) => `<span><i style="background:var(${c})"></i>${t}</span>`).join('');
  }

  // ---- общий цикл ----
  function render(): void {
    state = parseHash(win.location.hash);
    const key = toHash({ ...state, selected: undefined });
    if (key !== currentKey) {
      currentKey = key;
      activeFinding = -1;
      graph.clearHighlight();
    }
    current = graphOf(key, state);
    renderTabs();
    renderCrumb();
    renderTree();
    renderLegend();
    renderCard();
    renderBottom();
    const empty = $('graphEmpty');
    empty.hidden = current.nodes.length > 0;
    empty.textContent = `В разрезе «${VIEW_LABEL.get(state.view)}» для этого охвата нет элементов.`;
    const rendered = `${state.view}|${scopeKey(state.scope)}`;
    graph.show(key, current, { view: state.view, sensitiveSegments }, () => {
      if (key !== currentKey) return;
      graph.select(state.selected);
      doc.body.dataset.nodeCount = String(current.nodes.length);
      doc.body.dataset.rendered = rendered;
    });
  }

  const refresh = () => graph.refreshStyle();
  win.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  new win.MutationObserver(refresh).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  win.addEventListener('hashchange', render);
  render();
}

if (typeof document !== 'undefined' && document.getElementById('arch-data')) boot(document);
