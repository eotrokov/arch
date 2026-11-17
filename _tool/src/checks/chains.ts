import type { Finding, Model, ModelEdge } from '../model/types.js';

const MIN_CHAIN = 4;

/** Цепочки и циклы вызовов между сервисами (рёбра kind 'call'). */
export function checkChains(model: Model): Finding[] {
  const ids = Object.values(model.nodes).filter((n) => n.kind === 'service').map((n) => n.id).sort();
  const isService = new Set(ids);
  const adj = new Map<string, { to: string; edge: ModelEdge }[]>(ids.map((i) => [i, []]));
  for (const e of model.edges) {
    if (e.kind !== 'call' || !isService.has(e.from) || !isService.has(e.to)) continue;
    const list = adj.get(e.from)!;
    if (!list.some((x) => x.to === e.to)) list.push({ to: e.to, edge: e });
  }
  for (const l of adj.values()) l.sort((a, b) => a.to.localeCompare(b.to));

  // Tarjan SCC
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  const compSize: number[] = [];
  let counter = 0;
  const strong = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const { to } of adj.get(v)!) {
      if (!index.has(to)) { strong(to); low.set(v, Math.min(low.get(v)!, low.get(to)!)); }
      else if (onStack.has(to)) low.set(v, Math.min(low.get(v)!, index.get(to)!));
    }
    if (low.get(v) === index.get(v)) {
      const c = compSize.length;
      let size = 0;
      for (let w: string; (w = stack.pop()!) !== undefined;) {
        onStack.delete(w); comp.set(w, c); size++;
        if (w === v) break;
      }
      compSize.push(size);
    }
  };
  for (const v of ids) if (!index.has(v)) strong(v);

  const out: Finding[] = [];
  const fileOf = (id: string) => model.nodes[id]?.file;
  const edgeOf = (a: string, b: string) => adj.get(a)!.find((x) => x.to === b)!.edge;

  // Циклы: элементарные, каждый ищется от своего минимального id.
  for (const s of ids) {
    const path = [s];
    const dfs = (v: string) => {
      for (const { to } of adj.get(v)!) {
        if (comp.get(to) !== comp.get(s)) continue;
        if (to === s) {
          const edgeIds = path.map((p, i) => edgeOf(p, path[i + 1] ?? s).id);
          out.push({ rule: 'chain.cycle', level: 'error', nodeIds: [...path], edgeIds, file: fileOf(s),
            message: `Цикл вызовов: ${[...path, s].join(' → ')}.` });
        } else if (to > s && !path.includes(to)) {
          path.push(to); dfs(to); path.pop();
        }
      }
    };
    dfs(s);
  }

  // Длинные цепочки: рёбра внутри нетривиальных SCC (и петли) исключены, остаётся DAG.
  const inSameScc = (a: string, b: string) => comp.get(a) === comp.get(b) && (a === b || compSize[comp.get(a)!]! > 1);
  const dag = new Map<string, { to: string; edge: ModelEdge }[]>();
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const v of ids) {
    const l = adj.get(v)!.filter((x) => !inSameScc(v, x.to));
    dag.set(v, l);
    for (const x of l) indeg.set(x.to, indeg.get(x.to)! + 1);
  }
  const seen = new Set<string>();
  const walk = (path: string[]) => {
    const v = path[path.length - 1]!;
    const next = dag.get(v)!;
    if (next.length === 0) {
      const key = path.join('>');
      if (path.length >= MIN_CHAIN && !seen.has(key)) {
        seen.add(key);
        out.push({ rule: 'chain.too-long', level: 'error', nodeIds: [...path],
          edgeIds: path.slice(1).map((p, i) => edgeOf(path[i]!, p).id), file: fileOf(path[0]!),
          message: `Цепочка синхронных вызовов из ${path.length} сервисов (допустимо не более ${MIN_CHAIN - 1}): ${path.join(' → ')}.` });
      }
      return;
    }
    for (const { to } of next) { path.push(to); walk(path); path.pop(); }
  };
  for (const v of ids) if (indeg.get(v) === 0) walk([v]);
  return out;
}
