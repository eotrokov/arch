import type { Finding, Model } from '../model/types.js';
import type { Scope, ViewGraph, ViewKind } from './types.js';
import { containersView } from './containers.js';
import { kubernetesView } from './kubernetes.js';
import { databasesView } from './databases.js';
import { firewallView } from './firewall.js';
import { dataflowsView } from './dataflows.js';

export { containersView, kubernetesView, databasesView, firewallView, dataflowsView };
export { project } from './scope.js';

/** Диспетчер разрезов. */
export function buildView(model: Model, findings: Finding[], scope: Scope, view: ViewKind): ViewGraph {
  switch (view) {
    case 'containers': return containersView(model, findings, scope);
    case 'kubernetes': return kubernetesView(model, findings, scope);
    case 'databases': return databasesView(model, findings, scope);
    case 'firewall': return firewallView(model, findings, scope);
    case 'dataflows': return dataflowsView(model, findings, scope);
  }
}
