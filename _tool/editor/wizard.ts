// Мастер сервиса, продукта и команды: полоса шагов, поля шага, ошибки шага, выведенные имена.
// Поля перерисовываются только при смене шага и добавлении/удалении строк; после проверки обновляются
// лишь отметки шагов, ошибки и имена (фокус ввода не теряется).
import { READONLY_FIELDS, STEPS, previewNames, stepOfFinding, unknownFields, type WizardState } from './forms.js';
import type { PickLists, Validation } from './model.js';
import { checks, field, h, num, objs, readonlyYaml, rows, select, setKey, str, strs, text, type Obj, type Opt } from './fields.js';
import { topicName, type PlatformNames } from '../src/model/names.js';
import type { LoadError } from '../src/model/raw.js';
import type { Finding } from '../src/model/types.js';

export interface WizardHost {
  lists(): PickLists;
  validation(): Validation;
  platform(): PlatformNames;
  /** Путь файла текущей правки и ошибка её построения (например, пустое имя). */
  current(): { path: string | null; error: string | null };
  /** Данные формы изменились: перепроверка с задержкой. */
  changed(): void;
  stepChanged(step: string): void;
  toCart(): void;
  close(): void;
  /** Заполнить шаг «Проверка и MR» (контейнер уже в документе). */
  review(el: HTMLElement): void;
}

type Item = { f: Finding | LoadError; level: Finding['level'] };

const CRITICALITY = ['mission-critical', 'business-critical', 'business-operational', 'office-productivity'];
const PROTOCOLS = ['http', 'https', 'grpc', 'tcp'];
const CLASSES: Opt[] = [{ value: 'open', label: 'open' }, { value: 'kt', label: 'kt — коммерческая тайна' }, { value: 'pdn', label: 'pdn — персональные данные' }];
const ROLES = ['owner', 'techlead', 'architect', 'analyst', 'devops', 'dba'];
const LINK_KINDS = ['docs', 'api', 'dashboard', 'tracker', 'wiki', 'repo', 'runbook'];
const TITLES: Record<WizardState['kind'], [string, string]> = {
  service: ['Новый сервис', 'Сервис'], product: ['Новый продукт', 'Продукт'], team: ['Новая команда', 'Команда'],
};
const opts = (vs: string[]): Opt[] => vs.map((v) => ({ value: v, label: v }));

export class Wizard {
  /** Строки НФТ живут между перерисовками (пустой ключ в данные не попадает). */
  private nfrPairs?: Obj[];
  private origNfr?: Obj;
  private els!: { marks: Map<string, HTMLElement>; err: HTMLElement; find: HTMLElement; names: HTMLElement };

  constructor(private root: HTMLElement, public state: WizardState, private host: WizardHost, public step = 'main') {}

  private get d(): Obj { return this.state.data; }
  private get steps() { return STEPS[this.state.kind]; }

  private changed(): void { this.host.changed(); }
  private set(o: Obj, key: string, v: unknown): void { setKey(o, key, v); this.changed(); }
  /** Список объектов поля (создаётся при первом обращении; пустые списки в YAML не пишутся). */
  private arr(key: string): Obj[] {
    if (!Array.isArray(this.d[key])) this.d[key] = [];
    return this.d[key] as Obj[];
  }

  go(step: string): void {
    this.step = step;
    this.host.stepChanged(step);
    this.render();
  }

  render(): void {
    const st = this.state;
    const idx = this.steps.findIndex((s) => s.id === this.step);
    const close = h('button', { type: 'button', class: 'ghost' }, 'Закрыть');
    close.addEventListener('click', () => this.host.close());

    const marks = new Map<string, HTMLElement>();
    const bar = h('nav', { class: 'steps', 'aria-label': 'Шаги мастера' });
    this.steps.forEach((s, i) => {
      const mark = h('i', { class: 'mark' });
      marks.set(s.id, mark);
      const b = h('button', { type: 'button', 'aria-current': s.id === this.step ? 'step' : false }, mark, `${i + 1}. ${s.title}`);
      b.addEventListener('click', () => this.go(s.id));
      bar.append(b);
    });

    const back = h('button', { type: 'button', class: 'ghost', disabled: idx <= 0 }, 'Назад');
    back.addEventListener('click', () => this.go(this.steps[idx - 1]!.id));
    const next = h('button', { type: 'button', class: 'ghost', disabled: idx >= this.steps.length - 1 }, 'Далее');
    next.addEventListener('click', () => this.go(this.steps[idx + 1]!.id));
    const cart = h('button', { type: 'button', class: 'primary' }, 'В корзину');
    cart.addEventListener('click', () => this.host.toCart());

    this.els = { marks, err: h('p', { class: 'msg err', hidden: true }), find: h('div', { class: 'stepfind' }), names: h('div', { class: 'names' }) };
    this.root.replaceChildren(
      h('div', { class: 'wiz-head' },
        h('h2', { id: 'wizTitle' }),
        h('span', { class: 'path', id: 'wizPath' }), h('span', { class: 'sp' }), close),
      bar, this.els.err,
      h('div', { class: 'fields' }, ...this.fields()),
      this.els.names, this.els.find,
      h('div', { class: 'wiz-nav' }, back, next, h('span', { class: 'sp' }), cart),
    );
    const review = this.root.querySelector<HTMLElement>('#review');
    if (review) this.host.review(review);
    this.refresh();
  }

  /** Обновляет отметки шагов, ошибки шага и выведенные имена по последней проверке. */
  refresh(): void {
    const { path, error } = this.host.current();
    const v = this.host.validation();
    const byStep = new Map<string, Item[]>();
    const items: Item[] = [...v.loadErrors.map((f) => ({ f, level: 'error' as const })), ...v.findings.map((f) => ({ f, level: f.level }))];
    for (const it of items) {
      if (!path || it.f.file !== path) continue;
      const step = stepOfFinding(this.state.kind, it.f, path) ?? 'review';
      byStep.set(step, [...(byStep.get(step) ?? []), it]);
    }
    for (const [id, mark] of this.els.marks) {
      const bad = id === 'review' ? !v.ok : (byStep.get(id) ?? []).some((x) => x.level === 'error') || (id === 'main' && !!error);
      mark.textContent = bad ? '!' : '✓';
      mark.className = bad ? 'mark bad' : 'mark ok';
      mark.title = bad ? 'есть ошибки' : 'без ошибок';
    }
    const st = this.state;
    const [newTitle, title] = TITLES[st.kind];
    const subject = st.kind === 'team' ? st.team : st.kind === 'product' ? str(this.d.code) : previewNames(st, this.host.platform())?.id ?? '';
    this.root.querySelector('#wizTitle')!.textContent = `${st.isNew ? newTitle : title}${subject ? ` ${subject}` : ''}`;
    this.root.querySelector('#wizPath')!.textContent = path ?? '';
    this.els.err.hidden = !error;
    this.els.err.textContent = error ?? '';
    const mine = this.step === 'review' ? [] : byStep.get(this.step) ?? []; // на «Проверке» — полная сводка шага
    this.els.find.replaceChildren(...(mine.length ? [h('h3', {}, 'Ошибки и предупреждения шага'), ...mine.map(findingRow)] : []));
    this.els.names.replaceChildren(...this.names());
  }

  private names(): Node[] {
    if (this.state.kind !== 'service' || (this.step !== 'main' && this.step !== 'data')) return [];
    const n = previewNames(this.state, this.host.platform());
    if (!n) return [h('p', { class: 'empty' }, 'Имена появятся после ввода имени сервиса.')];
    const pairs: [string, string][] = this.step === 'main'
      ? [['id', n.id], ['репозиторий', n.repoUrl], ['deployment / helm', n.deployment], ['namespace', n.namespace], ['ingress', n.ingressHost],
        ['ТУЗ', n.tuz], ['Vault', n.vaultPath], ['образ', n.image], ['consumer group', n.consumerGroup], ['схема БД', n.dbSchema]]
      : [['схема БД', n.dbSchema], ['пользователи БД', `${n.dbUsers.rw}, ${n.dbUsers.ro}, ${n.dbUsers.migr}`],
        ...objs(this.d.publishes).filter((p) => str(p.entity) && str(p.event)).map((p): [string, string] =>
          ['топик', topicName(this.state.product ?? '', str(this.d.name), str(p.entity), str(p.event), typeof p.version === 'number' ? p.version : undefined)])];
    const dl = h('dl', {});
    for (const [k, val] of pairs) dl.append(h('dt', {}, k), h('dd', {}, val));
    return [h('h3', {}, 'Выведенные имена'), dl];
  }

  private fields(): Node[] {
    const k = this.state.kind;
    const s = this.step;
    if (s === 'review') return [h('div', { class: 'review', id: 'review' })];
    if (s === 'people') return this.people();
    if (k === 'service') {
      if (s === 'main') return this.serviceMain();
      if (s === 'place') return this.servicePlace();
      if (s === 'data') return this.serviceData();
      if (s === 'links') return this.serviceLinks();
      if (s === 'publish') return this.servicePublish();
    }
    if (k === 'product') {
      if (s === 'main') return this.productMain();
      if (s === 'entities') return this.productEntities();
      if (s === 'own') return this.productOwn();
    }
    if (k === 'team' && s === 'main') return this.teamMain();
    return [];
  }

  // ---- общие помощники строк ----

  private tx(o: Obj, key: string, label: string, extra: { type?: string; list?: string[]; placeholder?: string } = {}): HTMLElement {
    return field(label, text(str(o[key]), (v) => this.set(o, key, extra.type === 'number' ? num(v) : v), { ...extra, type: extra.type === 'number' ? 'text' : extra.type, label }));
  }
  private sel(o: Obj, key: string, label: string, options: Opt[], empty?: string, after?: () => void): HTMLElement {
    return field(label, select(str(o[key]), options, (v) => { this.set(o, key, v); after?.(); }, { empty, label }));
  }
  private chk(o: Obj, key: string, label: string, options: Opt[]): HTMLElement {
    return field(label, checks(strs(o[key]), options, (vs) => this.set(o, key, vs.length ? vs : undefined)));
  }
  private list(key: string, title: string, blank: () => Obj, row: (o: Obj, i: number) => Node[]): HTMLElement {
    const items = this.arr(key);
    return rows(title, items, row, {
      add: () => { items.push(blank()); this.changed(); this.render(); },
      remove: (i) => { items.splice(i, 1); this.changed(); this.render(); },
    });
  }
  /** Поля вне мастера и неизвестные поля — только для чтения. */
  private readonly(keys: string[]): Node[] {
    return keys.filter((key) => this.d[key] !== undefined).map((key) => readonlyYaml(key, this.d[key]));
  }
  /** На «Основном»: поля вне мастера (кроме продуктовых — они на «Выделенных ресурсах») и неизвестные поля. */
  private extraReadonly(): Node[] {
    const k = this.state.kind;
    return this.readonly([...(k === 'product' ? [] : READONLY_FIELDS[k]), ...unknownFields(k, this.d)]);
  }

  private get lists(): PickLists { return this.host.lists(); }
  private entityOpts(own = false): Opt[] {
    const ents = this.lists.entities;
    const mine = ents.filter((e) => e.product === this.state.product);
    const pool = own && mine.length ? mine : [...mine, ...ents.filter((e) => e.product !== this.state.product)];
    return [...new Map(pool.map((e) => [e.name, { value: e.name, label: e.product === this.state.product ? e.name : `${e.name} (${e.product})` }])).values()];
  }
  private targetOpts(): Opt[] {
    const self = previewNames(this.state, this.host.platform())?.id;
    return [
      ...this.lists.services.filter((s) => s !== self).map((s) => ({ value: s, label: s })),
      ...this.lists.externals.map((x) => ({ value: x.id, label: `${x.id} — ${x.name}` })),
    ];
  }
  private resourceOpts(kind?: string): Opt[] {
    return this.lists.resources.filter((r) => !kind || r.kind === kind).map((r) => ({ value: r.id, label: `${r.id} — ${r.name} (${r.kind})` }));
  }
  private brokerOpts(): Opt[] { return this.resourceOpts('kafka'); }

  // ---- сервис ----

  private serviceMain(): Node[] {
    const d = this.d;
    const ro = !this.state.isNew;
    const name = field('Имя (name)', text(str(d.name), (v) => this.set(d, 'name', v), { readonly: ro, placeholder: 'например, orders', label: 'Имя (name)' }),
      ro ? 'у существующего сервиса не меняется' : 'латиница в нижнем регистре, цифры и дефис');
    const type = field('Тип', select(str(d.type), opts(['ui', 'worker', 'job', 'gw', ...(d.type === 'backend' ? ['backend'] : [])]),
      (v) => this.set(d, 'type', v), { empty: 'backend (по умолчанию)', readonly: ro, label: 'Тип' }), ro ? 'у существующего сервиса не меняется' : undefined);
    return [name, type, this.tx(d, 'criticality', 'Критичность', { list: CRITICALITY, placeholder: 'наследуется от продукта' }), ...this.extraReadonly()];
  }

  private servicePlace(): Node[] {
    const d = this.d;
    const l = this.lists;
    return [
      this.sel(d, 'segment', 'Сегмент сети', l.segments.map((s) => ({ value: s.id, label: `${s.id} — ${s.name}` }))),
      this.sel(d, 'cluster', 'Кластер', l.clusters.map((c) => ({ value: c.id, label: `${c.id} — ${c.name}` }))),
      this.tx(d, 'port', 'Порт', { type: 'number', placeholder: '8080' }),
      this.tx(d, 'protocol', 'Протокол', { list: PROTOCOLS, placeholder: 'http' }),
    ];
  }

  private serviceData(): Node[] {
    const servers = this.lists.dbservers.map((s) => ({ value: s.id, label: `${s.id} (${s.engine}, ${s.segment})` }));
    return [
      this.list('databases', 'Свои базы данных', () => ({}), (o) => [
        this.sel(o, 'server', 'Сервер СУБД', servers),
        this.sel(o, 'classification', 'Классификация', CLASSES, '—'),
        this.tx(o, 'schema', 'Схема', { placeholder: previewNames(this.state, this.host.platform())?.dbSchema ?? 'выводится из имени' }),
      ]),
      this.list('publishes', 'Публикуемые события', () => ({}), (o) => [
        this.sel(o, 'entity', 'Сущность', this.entityOpts(true)),
        this.tx(o, 'event', 'Событие', { list: ['created', 'updated', 'deleted'] }),
        this.tx(o, 'version', 'Версия', { type: 'number', placeholder: '1' }),
        this.sel(o, 'broker', 'Брокер', this.brokerOpts(), '— по умолчанию —'),
      ]),
    ];
  }

  private serviceLinks(): Node[] {
    const ents = this.entityOpts();
    const kinds = new Map(this.lists.resources.map((r) => [r.id, r.kind]));
    const dbs = Object.values(this.host.validation().model?.nodes ?? {}).filter((n) => n.kind === 'database').map((n) => n.label);
    const useRow = (o: Obj): Node[] => {
      const isDb = 'db' in o;
      const mode = field('Что', select(isDb ? 'db' : 'resource', [{ value: 'resource', label: 'ресурс' }, { value: 'db', label: 'чужая БД' }], (v) => {
        for (const key of Object.keys(o)) delete o[key];
        if (v === 'db') o.db = '';
        this.changed();
        this.render();
      }, { label: 'Что' }));
      if (isDb) {
        return [mode, this.sel(o, 'db', 'База данных (схема)', opts(dbs)), this.sel(o, 'role', 'Роль', opts(['rw', 'ro', 'migr']))];
      }
      const s3 = kinds.get(str(o.resource)) === 's3';
      return [
        mode,
        this.sel(o, 'resource', 'Ресурс', this.resourceOpts(), undefined, () => {
          if ((kinds.get(str(o.resource)) === 's3') === s3) return;
          delete o.bucket;
          delete o.access;
          this.render();
        }),
        ...(s3 ? [
          this.tx(o, 'bucket', 'Бакет', { placeholder: 'назначение или полное имя' }),
          this.sel(o, 'access', 'Доступ', opts(['ro', 'rw'])),
        ] : []),
        this.tx(o, 'purpose', 'Назначение'),
        this.chk(o, 'entities', 'Сущности', ents),
      ];
    };
    return [
      this.list('calls', 'Синхронные вызовы', () => ({}), (o) => [
        this.sel(o, 'target', 'Кого вызывает', this.targetOpts()),
        this.tx(o, 'protocol', 'Протокол', { list: PROTOCOLS }),
        this.tx(o, 'port', 'Порт', { type: 'number' }),
        this.chk(o, 'entities', 'Сущности', ents),
      ]),
      this.list('consumes', 'Читаемые топики', () => ({}), (o) => [
        this.sel(o, 'topic', 'Топик', opts(this.lists.topics)),
        this.sel(o, 'broker', 'Брокер', this.brokerOpts(), '— по умолчанию —'),
      ]),
      this.list('uses', 'Используемые ресурсы и подключения к БД', () => ({}), useRow),
      this.list('exports', 'Выгрузки', () => ({}), (o) => [
        this.sel(o, 'channel', 'Канал', [{ value: 'cdc', label: 'CDC' }, { value: 'batch', label: 'batch' }]),
        this.sel(o, 'target', 'Куда', this.targetOpts()),
        this.chk(o, 'entities', 'Сущности', ents),
      ]),
    ];
  }

  private servicePublish(): Node[] {
    const l = this.lists;
    const actors = l.actors.map((a) => ({ value: a.id, label: `${a.id} — ${a.name}` }));
    const res = this.resourceOpts();
    const firstOf = (kind: string) => l.resources.find((r) => r.kind === kind)?.id;
    return [
      h('p', { class: 'hint' }, 'Для интернета цепочка входа по умолчанию — WAF → Ingress; без WAF правило покажет ошибку.'),
      this.list('exposure', 'Публикация', () => ({ audience: '', via: [] }), (o) => {
        if (!Array.isArray(o.via)) o.via = [];
        const via = o.via as string[];
        const chain = h('span', { class: 'chain' });
        via.forEach((v, i) => {
          const del = h('button', { type: 'button', class: 'ghost', 'aria-label': 'Убрать звено' }, '×');
          del.addEventListener('click', () => { via.splice(i, 1); this.changed(); this.render(); });
          chain.append(select(v, res, (nv) => { via[i] = nv; this.changed(); }, { label: `Звено ${i + 1}` }), del, i < via.length - 1 ? ' → ' : '');
        });
        const add = h('button', { type: 'button', class: 'ghost' }, '+ звено');
        add.addEventListener('click', () => { via.push(''); this.changed(); this.render(); });
        chain.append(add);
        return [
          this.sel(o, 'audience', 'Для кого', actors, undefined, () => {
            if (o.audience !== 'internet' || via.length) return;
            o.via = [firstOf('waf'), firstOf('ingress')].filter((x): x is string => !!x);
            this.changed();
            this.render();
          }),
          field('Цепочка входа (via)', chain),
        ];
      }),
    ];
  }

  // ---- продукт ----

  private productMain(): Node[] {
    const d = this.d;
    const ro = !this.state.isNew;
    const nfr = d.nfr;
    const scalarNfr = nfr === undefined || (typeof nfr === 'object' && nfr !== null && !Array.isArray(nfr)
      && Object.values(nfr).every((x) => typeof x !== 'object' || x === null));
    return [
      field('Код (code)', text(str(d.code), (v) => this.set(d, 'code', v), { readonly: ro, placeholder: 'код из реестра систем', label: 'Код (code)' }),
        ro ? 'у существующего продукта не меняется' : 'латиница в нижнем регистре, цифры и дефис'),
      this.tx(d, 'name', 'Название'),
      this.tx(d, 'criticality', 'Критичность', { list: CRITICALITY }),
      scalarNfr ? this.nfrRows() : readonlyYaml('nfr', nfr),
      ...this.extraReadonly(),
    ];
  }

  /** НФТ — плоский словарь «ключ: значение»; тип числа/булева исходного значения сохраняется. */
  private nfrRows(): HTMLElement {
    const orig = (this.origNfr ??= { ...((this.d.nfr ?? {}) as Obj) });
    const pairs = (this.nfrPairs ??= Object.entries(orig).map(([k, v]) => ({ k, v: v === null ? '' : String(v) })));
    const sync = () => {
      const out: Obj = {};
      for (const p of pairs) {
        const k = str(p.k);
        if (!k) continue;
        const was = orig[k];
        const v = str(p.v);
        out[k] = typeof was === 'number' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : typeof was === 'boolean' && /^(true|false)$/.test(v) ? v === 'true' : v;
      }
      this.set(this.d, 'nfr', Object.keys(out).length ? out : undefined);
    };
    return rows('Нефункциональные требования (nfr)', pairs, (p) => [
      field('Ключ', text(str(p.k), (v) => { p.k = v; sync(); }, { placeholder: 'slo', label: 'Ключ' })),
      field('Значение', text(str(p.v), (v) => { p.v = v; sync(); }, { placeholder: '99.9%', label: 'Значение' })),
    ], {
      add: () => { pairs.push({ k: '', v: '' }); this.render(); },
      remove: (i) => { pairs.splice(i, 1); sync(); this.render(); },
    });
  }

  private productEntities(): Node[] {
    const code = str(this.d.code) || this.state.product || '';
    const owners = this.lists.services.filter((s) => s.startsWith(`${code}-`));
    return [this.list('entities', 'Каталог сущностей', () => ({}), (o) => [
      this.tx(o, 'name', 'Имя'),
      this.sel(o, 'classification', 'Классификация', CLASSES),
      this.sel(o, 'owner', 'Сервис-владелец', opts(owners)),
    ])];
  }

  private productOwn(): Node[] {
    const segs = this.lists.segments.map((s) => ({ value: s.id, label: `${s.id} — ${s.name}` }));
    return [
      this.list('externals', 'Внешние системы продукта', () => ({}), (o) => [
        this.tx(o, 'id', 'Id'), this.tx(o, 'name', 'Название'), this.sel(o, 'segment', 'Сегмент', segs),
        this.tx(o, 'port', 'Порт', { type: 'number' }), this.tx(o, 'protocol', 'Протокол', { list: PROTOCOLS }),
      ]),
      ...this.readonly(READONLY_FIELDS.product),
    ];
  }

  // ---- команда ----

  private teamMain(): Node[] {
    const st = this.state;
    return [
      field('Id команды (имя каталога)', text(st.team, (v) => { st.team = v; this.changed(); }, { readonly: !st.isNew, placeholder: 'например, sales', label: 'Id команды (имя каталога)' }),
        st.isNew ? 'латиница в нижнем регистре, цифры и дефис' : 'у существующей команды не меняется'),
      this.tx(this.d, 'name', 'Название'),
      ...this.extraReadonly(),
    ];
  }

  // ---- ответственные и ссылки ----

  private people(): Node[] {
    const inherit = this.state.kind === 'service' ? 'продукта' : this.state.kind === 'product' ? 'команды' : null;
    const noOwners = !objs(this.d.owners).length;
    return [
      noOwners ? h('p', { class: 'msg warn' }, inherit ? `Ответственных нет — будут унаследованы ответственные ${inherit}.` : 'Ответственных нет — укажите хотя бы одного.') : null,
      this.list('owners', 'Ответственные', () => ({}), (o) => [
        this.tx(o, 'role', 'Роль', { list: ROLES }), this.tx(o, 'name', 'Имя'), this.tx(o, 'contact', 'Контакт', { placeholder: '@login или почта' }),
      ]),
      this.list('links', 'Ссылки', () => ({}), (o) => [
        this.tx(o, 'kind', 'Вид', { list: LINK_KINDS }), this.tx(o, 'url', 'URL', { type: 'url', placeholder: 'https://' }), this.tx(o, 'title', 'Название'),
      ]),
    ].filter((n): n is HTMLElement => n !== null);
  }
}

function findingRow(it: Item): HTMLElement {
  const lvl = it.level === 'error' ? ['p-err', 'ошибка'] : it.level === 'warning' ? ['p-warn', 'предупр.'] : ['p-attn', 'внимание'];
  const code = 'rule' in it.f ? it.f.rule : it.f.line !== undefined ? `строка ${it.f.line}` : 'файл';
  return h('div', { class: 'find' }, h('span', { class: `pill ${lvl[0]}` }, lvl[1]!), h('code', {}, code), h('span', {}, it.f.message));
}
