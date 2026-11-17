export type Scope =
  | { kind: 'company'; expanded: string[] }
  | { kind: 'team' | 'product' | 'service'; id: string };

export type ViewKind = 'kubernetes' | 'containers' | 'firewall' | 'databases' | 'dataflows';

export interface Visibility { id: string; muted: boolean; collapsed: boolean }

export interface Projection {
  /** null: узел вне охвата и не сосед. */
  visible(nodeId: string): Visibility | null;
}

export interface ViewNode {
  id: string; label: string; kind: string; parent?: string;
  muted?: boolean; collapsed?: boolean; classes: string[]; modelId?: string;
}

export interface ViewEdge {
  id: string; from: string; to: string; label: string; classes: string[]; modelEdgeIds: string[];
}

export interface FirewallRow {
  fromNode: string; fromSegment: string; toNode: string; toSegment: string; toHosts: string[];
  port: string; protocol: string; reason: string; intraSegment: boolean; attention: string[];
}

export interface ViewGraph { nodes: ViewNode[]; edges: ViewEdge[]; table?: FirewallRow[] }
