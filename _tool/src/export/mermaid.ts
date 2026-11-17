import type { Finding, Model } from '../model/types.js';
import type { ViewGraph, ViewKind } from '../views/types.js';
import { buildView } from '../views/index.js';

const q = (s: string) => s.replace(/"/g, '#quot;').replace(/\r?\n/g, '<br/>');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>');

/** Стабильное экранирование id в [A-Za-z0-9_]; коллизии разрешаются суффиксами _2, _3… */
function makeIdMap(ids: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const id of ids) {
    if (map.has(id)) continue;
    const base = 'n_' + id.replace(/[^A-Za-z0-9_]/g, '_');
    let cand = base;
    for (let i = 2; used.has(cand); i++) cand = `${base}_${i}`;
    used.add(cand);
    map.set(id, cand);
  }
  return map;
}

export function toMermaid(graph: ViewGraph, title: string): string {
  const ids = makeIdMap(graph.nodes.map((n) => n.id));
  const ref = (id: string) => ids.get(id) ?? makeIdMap([id]).get(id)!;
  const known = new Set(graph.nodes.map((n) => n.id));
  const children = new Map<string | undefined, typeof graph.nodes>();
  for (const n of graph.nodes) {
    const p = n.parent && known.has(n.parent) ? n.parent : undefined;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(n);
  }
  const lines: string[] = ['flowchart LR'];
  const emit = (parent: string | undefined, depth: number) => {
    const pad = '  '.repeat(depth);
    for (const n of children.get(parent) ?? []) {
      if (children.has(n.id)) {
        lines.push(`${pad}subgraph ${ref(n.id)}["${q(n.label)}"]`);
        emit(n.id, depth + 1);
        lines.push(`${pad}end`);
      } else {
        lines.push(`${pad}${ref(n.id)}["${q(n.label)}"]`);
      }
    }
  };
  emit(undefined, 1);

  const edgeLines: string[] = [];
  const violation: number[] = [];
  graph.edges.forEach((e, i) => {
    if (!known.has(e.from) || !known.has(e.to)) return;
    edgeLines.push(e.label ? `  ${ref(e.from)} -->|"${q(e.label)}"| ${ref(e.to)}` : `  ${ref(e.from)} --> ${ref(e.to)}`);
    if (e.classes.includes('violation')) violation.push(edgeLines.length - 1);
  });
  lines.push(...edgeLines);

  const muted = graph.nodes.filter((n) => n.muted || n.classes.includes('muted')).map((n) => ref(n.id));
  const bad = graph.nodes.filter((n) => n.classes.includes('violation')).map((n) => ref(n.id));
  if (muted.length) {
    lines.push('  classDef muted fill:#f2f2f2,stroke:#bbb,color:#888,stroke-dasharray:4 3');
    lines.push(`  class ${muted.join(',')} muted`);
  }
  if (bad.length) {
    lines.push('  classDef violation stroke:#d00,stroke-width:3px,color:#d00');
    lines.push(`  class ${bad.join(',')} violation`);
  }
  if (violation.length) lines.push(`  linkStyle ${violation.join(',')} stroke:#d00,stroke-width:2px`);

  let out = `# ${title}\n\n\`\`\`mermaid\n${lines.join('\n')}\n\`\`\`\n`;
  if (graph.table) {
    const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
    out += '\n| Источник | Сегмент | Назначение | Сегмент | Хосты | Порт/протокол | Основание |\n|---|---|---|---|---|---|---|\n';
    for (const r of graph.table) {
      const hosts = r.toHosts.length ? r.toHosts.join('<br/>') : '—';
      out += `| ${cell(label(r.fromNode))} | ${cell(r.fromSegment)} | ${cell(label(r.toNode))} | ${cell(r.toSegment)} | ${hosts} | ${cell(`${r.port}/${r.protocol}`)} | ${cell(r.reason)} |\n`;
    }
  }
  return out;
}

export function exportMermaid(model: Model, findings: Finding[]): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const views: [ViewKind, string, string][] = [['containers', 'containers', 'Контейнеры'], ['firewall', 'firewall', 'Фаервол']];
  const add = (dir: string, kind: 'product' | 'service', id: string, noun: string) => {
    for (const [view, file, name] of views) {
      files.push({
        path: `${dir}/${file}.md`,
        content: toMermaid(buildView(model, findings, { kind, id }, view), `${noun} ${id} — ${name}`),
      });
    }
  };
  for (const p of model.products) {
    add(`mermaid/${p.code}`, 'product', p.code, 'Продукт');
    for (const n of Object.values(model.nodes)) {
      if (n.kind === 'service' && n.product === p.code) add(`mermaid/${p.code}/${n.id}`, 'service', n.id, 'Сервис');
    }
  }
  return files;
}
