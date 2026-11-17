import type { Finding, Model } from '../model/types.js';
import type { Scope, ViewGraph, ViewKind } from './types.js';
import { containersView } from './containers.js';
import { kubernetesView } from './kubernetes.js';
import { databasesView } from './databases.js';

export { containersView, kubernetesView, databasesView };
export { project } from './scope.js';

/** Диспетчер разрезов. `firewall` и `dataflows` подключаются в Task 7. */
export function buildView(model: Model, findings: Finding[], scope: Scope, view: ViewKind): ViewGraph {
  switch (view) {
    case 'containers': return containersView(model, findings, scope);
    case 'kubernetes': return kubernetesView(model, findings, scope);
    case 'databases': return databasesView(model, findings, scope);
    default: throw new Error(`Разрез «${view}» ещё не реализован`);
  }
}
