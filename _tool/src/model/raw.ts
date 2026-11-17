// Типы сырых YAML-файлов (после проверки по схемам, до разрешения ссылок и умолчаний).

export interface RawOwner { role: string; name: string; contact?: string }
export interface RawLink { kind: string; url: string; title?: string }

export interface RawSegment { id: string; name: string; external?: boolean; sensitive?: boolean; description?: string }
export interface RawActor { id: string; name: string; segment: string }
export interface RawEndpointRef { segment?: string; node?: string }
export interface RawConnection { from: RawEndpointRef; to: RawEndpointRef; port: number; protocol: string; reason: string }
export interface RawNetwork { segments: RawSegment[]; actors?: RawActor[]; connections?: RawConnection[] }

export interface RawResource {
  id: string; kind: string; name: string; segment: string; port: number; protocol: string;
  endpoint?: string; owners?: RawOwner[]; links?: RawLink[];
}
export interface RawExternal { id: string; name: string; segment: string; port: number; protocol: string }
export interface RawDbHost { fqdn: string; role: 'primary' | 'replica' | 'arbiter' }
export interface RawDbServer {
  id: string; engine: string; segment: string; port: number; hosts: RawDbHost[];
  version?: string; endpoint?: string; owners?: RawOwner[]; links?: RawLink[];
}
export interface RawCluster { id: string; name: string }

export interface RawPlatform {
  env?: string; domain: string; registry: string; git: string;
  clusters: RawCluster[]; resources?: RawResource[]; externals?: RawExternal[]; dbservers?: RawDbServer[];
}

export interface RawTeamData { name: string; owners?: RawOwner[]; links?: RawLink[] }

export interface RawEntity { name: string; classification: 'open' | 'kt' | 'pdn'; owner: string }
export interface RawProductData {
  code: string; name: string; criticality?: string; nfr?: Record<string, unknown>;
  owners?: RawOwner[]; links?: RawLink[]; entities?: RawEntity[];
  externals?: RawExternal[]; dbservers?: RawDbServer[]; resources?: RawResource[];
}

export type RawUse =
  | { resource: string; purpose?: string; entities?: string[] }
  | { resource: string; bucket: string; access: string; purpose?: string; entities?: string[] }
  | { db: string; role: string };

export interface RawService {
  name: string; segment: string; cluster: string;
  type?: 'ui' | 'worker' | 'job' | 'gw' | 'backend'; port?: number; protocol?: string; criticality?: string;
  databases?: { server: string; classification?: string; schema?: string }[];
  publishes?: { entity: string; event: string; version?: number; broker?: string }[];
  consumes?: { topic: string; broker?: string }[];
  calls?: { target: string; protocol?: string; port?: number; entities?: string[] }[];
  uses?: RawUse[];
  exports?: { channel: string; target: string; entities?: string[] }[];
  exposure?: { audience: string; via: string[] }[];
  owners?: RawOwner[]; links?: RawLink[];
  overrides?: Record<string, { value: unknown; reason: string }>;
}

export interface RawProduct {
  dir: string; file: string; data: RawProductData;
  services: { file: string; data: RawService }[];
}
export interface RawTeam { dir: string; file: string; data: RawTeamData; products: RawProduct[] }
export interface RawTree { network: RawNetwork; platform: RawPlatform; teams: RawTeam[] }

export interface LoadError { file: string; line?: number; message: string }
