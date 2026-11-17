import type { DerivedNames, ServiceType } from './names.js';

export interface Finding {
  rule: string;
  level: 'error' | 'warning' | 'attention';
  message: string;
  nodeIds: string[];
  edgeIds: string[];
  file?: string;
}

// ---- Единая модель (Task 3) ----

export type Classification = 'open' | 'kt' | 'pdn';
export type NodeKind = 'service' | 'database' | 'dbserver' | 'topic' | 'platform' | 'external' | 'actor';
export type EdgeKind = 'call' | 'publish' | 'consume' | 'db' | 'use' | 'export' | 'explicit' | 'expose';

export interface Owner { role: string; name: string; contact?: string }
export interface Link { kind: string; url: string; title?: string }

export interface ModelNode {
  id: string; kind: NodeKind; label: string; segment: string;
  team?: string; product?: string; system?: string; serviceName?: string; ownerService?: string;
  cluster?: string; serviceType?: ServiceType; port?: number; protocol?: string;
  classification?: Classification; names?: DerivedNames;
  owners: Owner[]; ownersInherited: boolean; links: Link[]; file?: string;
  /** Сервис опубликован: есть exposure через ресурс kind: ingress. */
  published?: boolean;
  /** platform */
  resourceKind?: string; endpoint?: string;
  /** database: id узла dbserver:<id> */
  server?: string;
  /** dbserver */
  engine?: string; version?: string; hosts?: { fqdn: string; role: 'primary' | 'replica' | 'arbiter' }[];
}

export interface ModelEdge {
  id: string; kind: EdgeKind; from: string; to: string; port?: number; protocol?: string;
  entities: string[]; classification: Classification; role?: 'rw' | 'ro' | 'migr';
  channel?: 'api' | 'topic' | 'cdc' | 'batch'; reason: string; file?: string;
  /** db: неявное ребро владельца схемы (rw от объявившего её сервиса). */
  owner?: boolean;
  /** use */
  bucket?: string; access?: 'ro' | 'rw'; purpose?: string;
  /** expose */
  exposedService?: string; audience?: string;
}

export interface Model {
  env: string; domain: string; registry: string;
  segments: { id: string; name: string; external: boolean; sensitive: boolean }[];
  clusters: { id: string; name: string }[];
  teams: { id: string; name: string; owners: Owner[]; links: Link[]; products: string[] }[];
  products: { code: string; name: string; team: string; criticality?: string; nfr?: Record<string, unknown>; owners: Owner[]; links: Link[] }[];
  entities: Record<string, { product: string; classification: Classification; owner: string }>;
  nodes: Record<string, ModelNode>;
  edges: ModelEdge[];
}
