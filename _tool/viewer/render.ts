// Отрисовка графа разреза в Cytoscape (раскладка ELK layered). Без импортов Node (уходит в браузер).
import cytoscape from 'cytoscape';
import type { Core, ElementDefinition, LayoutOptions, NodeSingular, Stylesheet } from 'cytoscape';
import cytoscapeElk from 'cytoscape-elk';
import type { ViewGraph, ViewKind, ViewNode } from '../src/views/types.js';

cytoscape.use(cytoscapeElk);

const MONO_KINDS = new Set(['host', 'user', 'ingress']);
const MAX_TEXT = 220;
const MAX_FIT_ZOOM = 1.25;

/** Id элемента модели для карточки: modelId, у свёрнутого продукта — product:<code> (без @сегмента). */
export function nodeModelId(n: ViewNode): string | undefined {
  if (n.modelId) return n.modelId;
  if (n.kind === 'product') return n.id.replace(/@.*$/, '');
  return undefined;
}

/** Размер листового узла по тексту метки (вместо устаревшего width/height: 'label'). */
export function nodeSize(label: string, kind: string): { w: number; h: number } {
  const mono = MONO_KINDS.has(kind);
  const charW = mono ? 6.2 : 6.6;
  const lineH = mono ? 13 : 14;
  let lines = 0;
  let widest = 0;
  for (const line of label.split('\n')) {
    const w = Math.max(1, line.length) * charW;
    lines += Math.ceil(w / MAX_TEXT);
    widest = Math.max(widest, Math.min(w, MAX_TEXT));
  }
  const extraW = kind === 'platform' ? 28 : kind === 'topic' || kind === 'database' || kind === 'host' ? 14 : 0;
  return { w: Math.round(widest + 24 + extraW), h: Math.round(lines * lineH + 18) };
}

export interface ElementOptions { view: ViewKind; sensitiveSegments: Set<string> }

/** Элементы Cytoscape из графа разреза. Защитно: родитель вне графа сбрасывается, рёбра к отсутствующим узлам отбрасываются. */
export function toElements(g: ViewGraph, opts: ElementOptions): ElementDefinition[] {
  const ids = new Set(g.nodes.map((n) => n.id));
  const parents = new Set(g.nodes.map((n) => n.parent).filter((p): p is string => !!p && ids.has(p)));
  const els: ElementDefinition[] = [];
  for (const n of g.nodes) {
    const classes = [...n.classes];
    if (parents.has(n.id)) classes.push('frame');
    if (n.kind === 'segment' && opts.sensitiveSegments.has(n.id.replace(/^seg:/, ''))) classes.push('sensitive');
    const { w, h } = nodeSize(n.label, n.kind);
    els.push({
      group: 'nodes',
      data: { id: n.id, label: n.label, kind: n.kind, parent: n.parent && ids.has(n.parent) ? n.parent : undefined, model: nodeModelId(n), w, h },
      classes: classes.join(' '),
    });
  }
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const classes = e.classes.filter((c) => opts.view === 'dataflows' || !c.startsWith('cls-'));
    if (e.classes.some((c) => c.startsWith('attention-'))) classes.push('attn');
    els.push({ group: 'edges', data: { id: e.id, source: e.from, target: e.to, label: e.label, me: e.modelEdgeIds }, classes: classes.join(' ') });
  }
  return els;
}

function cssVar(doc: Document, name: string): string {
  return doc.defaultView!.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
}

/** Стиль из CSS-переменных темы; пересчитывается при смене темы. */
export function graphStyle(doc: Document): Stylesheet[] {
  const c = (n: string) => cssVar(doc, n);
  const ui = c('--font-ui') || 'system-ui, sans-serif';
  const mono = c('--font-mono') || 'ui-monospace, monospace';
  return [
    { selector: 'node', style: {
      'background-color': c('--node'), 'border-width': 1.5, 'border-color': c('--node-line'), label: 'data(label)', color: c('--fg'),
      'font-family': ui, 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': `${MAX_TEXT}px`, 'text-valign': 'center', 'text-halign': 'center',
      shape: 'round-rectangle', width: 'data(w)', height: 'data(h)',
    } },
    { selector: 'node[kind="database"]', style: { shape: 'barrel' } },
    { selector: 'node[kind="topic"]', style: { shape: 'tag' } },
    { selector: 'node[kind="platform"]', style: { shape: 'hexagon' } },
    { selector: 'node[kind="external"], node[kind="actor"]', style: { 'border-style': 'dashed' } },
    { selector: 'node[kind="product"]', style: { 'border-width': 2, 'border-color': c('--node-line'), 'background-color': c('--accent-soft'), 'font-weight': 600 } },
    { selector: 'node.cronjob', style: { 'border-style': 'dashed' } },
    { selector: 'node[kind="ingress"]', style: { 'font-family': mono, 'font-size': 10, 'background-color': c('--accent-soft'), 'border-color': c('--accent') } },
    { selector: 'node[kind="user"]', style: { 'font-family': mono, 'font-size': 10 } },
    { selector: 'node[kind="host"]', style: { shape: 'barrel', 'font-family': mono, 'font-size': 10 } },
    { selector: 'node.primary', style: { 'border-width': 4, 'border-style': 'double' } },
    { selector: 'node.frame', style: {
      'background-color': c('--frame'), 'background-opacity': 1, 'border-color': c('--line'), 'border-width': 1, shape: 'round-rectangle',
      // подпись внутри рамки (сверху), чтобы соседние рамки её не перекрывали
      'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': 20, 'font-size': 11, 'font-weight': 600, color: c('--muted'), padding: '24px',
    } },
    { selector: 'node.frame[kind="segment"]', style: { 'border-width': 1.5 } },
    { selector: 'node.frame[kind="dbserver"]', style: { 'border-width': 2, 'border-color': c('--node-line'), 'background-color': c('--bg') } },
    { selector: 'node.frame[kind="database"]', style: { shape: 'round-rectangle' } },
    { selector: 'node.sensitive', style: { 'border-color': c('--pdn'), 'border-style': 'dashed' } },
    { selector: 'node.warning', style: { 'border-color': c('--warn'), 'border-width': 2.5 } },
    { selector: 'node.violation', style: { 'border-color': c('--err'), 'border-width': 3 } },
    { selector: '.muted', style: { opacity: 0.4 } },
    { selector: 'edge', style: {
      width: 1.6, 'line-color': c('--node-line'), 'target-arrow-color': c('--node-line'), 'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
      label: 'data(label)', 'font-size': 10, 'font-family': mono, color: c('--muted'),
      'text-background-color': c('--panel'), 'text-background-opacity': 1, 'text-background-padding': '2px',
    } },
    { selector: 'edge.cls-pdn', style: { 'line-color': c('--pdn'), 'target-arrow-color': c('--pdn'), width: 2.4 } },
    { selector: 'edge.cls-kt', style: { 'line-color': c('--kt'), 'target-arrow-color': c('--kt'), width: 2.4 } },
    { selector: 'edge.cls-open', style: { 'line-color': c('--open'), 'target-arrow-color': c('--open'), width: 2.4 } },
    { selector: 'edge.attn', style: { 'line-color': c('--attn'), 'target-arrow-color': c('--attn'), 'line-style': 'dashed' } },
    { selector: 'edge.violation', style: { 'line-color': c('--err'), 'target-arrow-color': c('--err'), width: 3, 'line-style': 'solid' } },
    { selector: ':selected', style: { 'border-color': c('--accent'), 'border-width': 3, 'line-color': c('--accent'), 'target-arrow-color': c('--accent') } },
    { selector: '.hl', style: { 'underlay-color': c('--accent'), 'underlay-opacity': 0.25, 'underlay-padding': 6 } },
  ] as Stylesheet[];
}

const SPACING = { 'elk.spacing.nodeNode': 28, 'elk.layered.spacing.nodeNodeBetweenLayers': 70 };
// Отступы и интервалы ELK задаются на каждой рамке (опции корня на вложенные графы не действуют);
// padding не меньше padding рамки в Cytoscape (24px) плюс подпись сверху, иначе соседние рамки наезжают.
const FRAME_OPTIONS = { ...SPACING, 'elk.padding': '[top=40,left=28,bottom=28,right=28]' };

const ELK_LAYOUT = {
  name: 'elk', nodeDimensionsIncludeLabels: false, fit: true, padding: 44,
  nodeLayoutOptions: (n: NodeSingular) => (n.isParent() ? FRAME_OPTIONS : undefined),
  elk: { algorithm: 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', ...SPACING },
} as unknown as LayoutOptions;

type Positions = Map<string, { x: number; y: number }>;

export interface GraphHandlers {
  /** Клик по узлу с элементом модели (рамки без модели клик игнорируют). */
  onSelect(modelId: string): void;
  /** Двойной клик по свёрнутому продукту: его код. */
  onExpand(code: string): void;
}

/** Граф на странице: перестраивается при смене ключа (разрез+охват), раскладки кэшируются по ключу. */
export class GraphView {
  private cy: Core;
  private layouts = new Map<string, Positions>();
  private key: string | undefined;
  private token = 0;

  constructor(private doc: Document, container: HTMLElement, handlers: GraphHandlers) {
    this.cy = cytoscape({ container, style: graphStyle(doc), minZoom: 0.1, maxZoom: 2.5, boxSelectionEnabled: false });
    this.cy.on('tap', 'node', (ev) => {
      const m = (ev.target as NodeSingular).data('model') as string | undefined;
      if (m) handlers.onSelect(m);
    });
    this.cy.on('dbltap', 'node[kind="product"]', (ev) => {
      const id = (ev.target as NodeSingular).id();
      handlers.onExpand(id.replace(/^product:/, '').replace(/@.*$/, ''));
    });
  }

  /** Показать граф; done вызывается после раскладки (сразу, если ключ не изменился). */
  show(key: string, graph: ViewGraph, opts: ElementOptions, done: () => void): void {
    if (key === this.key) {
      done();
      return;
    }
    this.key = key;
    const token = ++this.token;
    const cy = this.cy;
    cy.elements().remove();
    cy.add(toElements(graph, opts));
    if (cy.nodes().length === 0) {
      done();
      return;
    }
    const cached = this.layouts.get(key);
    const layout = cached
      ? cy.layout({ name: 'preset', fit: true, padding: 44, positions: (n: NodeSingular) => cached.get(n.id()) ?? n.position() } as unknown as LayoutOptions)
      : cy.layout(ELK_LAYOUT);
    layout.one('layoutstop', () => {
      if (token !== this.token) return;
      // маленький граф не раздуваем на весь экран
      if (cy.zoom() > MAX_FIT_ZOOM) {
        cy.zoom(MAX_FIT_ZOOM);
        cy.center();
      }
      if (!cached) {
        const pos: Positions = new Map();
        cy.nodes(':childless').forEach((n) => { pos.set(n.id(), { ...n.position() }); });
        this.layouts.set(key, pos);
      }
      done();
    });
    layout.run();
  }

  /** Уничтожить cytoscape (редактор пересоздаёт предпросмотр; просмотрщик не вызывает). */
  destroy(): void {
    this.token++; // незавершённая раскладка не должна трогать уничтоженный граф
    this.cy.destroy();
  }

  select(modelId: string | undefined): void {
    this.cy.elements().unselect();
    if (modelId) this.cy.nodes().filter((n) => n.data('model') === modelId).select();
  }

  highlight(modelIds: string[], modelEdgeIds: string[]): void {
    this.cy.elements().removeClass('hl');
    this.cy.nodes().filter((n) => modelIds.includes(n.data('model'))).addClass('hl');
    this.cy.edges().filter((e) => ((e.data('me') as string[]) ?? []).some((x) => modelEdgeIds.includes(x))).addClass('hl');
  }

  clearHighlight(): void {
    this.cy.elements().removeClass('hl');
  }

  refreshStyle(): void {
    this.cy.style(graphStyle(this.doc));
  }
}
