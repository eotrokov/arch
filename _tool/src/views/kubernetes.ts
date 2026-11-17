import type { Finding, Model } from '../model/types.js';
import type { Scope, ViewGraph } from './types.js';
import { project } from './scope.js';
import { FindingIndex, GraphBuilder, modelNodeClasses } from './common.js';

/**
 * Разрез «Kubernetes»: кластер > namespace > сервис (+ ingress для опубликованных).
 * Показаны только видимые неприглушённые сервисы; свёрнутые продукты не показываются.
 */
export function kubernetesView(model: Model, findings: Finding[], scope: Scope): ViewGraph {
  const idx = new FindingIndex(findings);
  const g = new GraphBuilder(idx);
  const proj = project(model, scope);

  for (const n of Object.values(model.nodes)) {
    if (n.kind !== 'service') continue;
    const v = proj.visible(n.id);
    if (!v || v.muted || v.collapsed) continue;

    let parent: string | undefined;
    const ns = n.names?.namespace;
    if (n.cluster && ns) {
      const cluster = model.clusters.find((c) => c.id === n.cluster);
      g.addNode({ id: `cluster:${n.cluster}`, label: cluster?.name ?? n.cluster, kind: 'cluster', muted: false });
      parent = `ns:${n.cluster}/${ns}`;
      g.addNode({ id: parent, label: ns, kind: 'namespace', parent: `cluster:${n.cluster}`, muted: false });
    }
    const sa = n.names?.serviceAccount ?? n.id;
    g.addNode({
      id: n.id, label: `${n.label}\nSA: ${sa}`, kind: 'service', parent, muted: false, collapsed: false,
      classes: [n.serviceType === 'job' ? 'cronjob' : 'deployment', ...modelNodeClasses(idx, n)], modelId: n.id,
    });

    if (n.published && n.names) {
      const host = n.names.ingressHost;
      const ingress = `ingress:${host}`;
      g.addNode({ id: ingress, label: host, kind: 'ingress', parent, muted: false, classes: ['ingress'] });
      for (const e of model.edges) {
        if (e.kind === 'expose' && e.exposedService === n.id && e.to === n.id) g.addEdge(ingress, n.id, e);
      }
    }
  }
  return g.build();
}
