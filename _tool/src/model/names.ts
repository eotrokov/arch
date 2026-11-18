// Выведение имён по таблице 2.4 регламента. Без импортов Node (уходит в браузер).

export type ServiceType = '' | 'ui' | 'worker' | 'job' | 'gw';

export interface DerivedNames {
  id: string; repo: string; deployment: string; helm: string; serviceAccount: string;
  namespace: string; ingressHost: string; tuz: string; vaultPath: string; dbSchema: string;
  dbUsers: { rw: string; ro: string; migr: string };
  consumerGroup: string; image: string; repoUrl: string;
}

export interface PlatformNames { env: string; domain: string; registry: string; git: string }
/** Имена платформы для deriveNames: env по умолчанию prod, git — хост без схемы и завершающих `/`. */
export function platformNames(p: { env?: string; domain: string; registry: string; git: string }): PlatformNames {
  return { env: p.env ?? 'prod', domain: p.domain, registry: p.registry, git: p.git.replace(/^https?:\/\//, '').replace(/\/+$/, '') };
}
export type NameOverrides = Record<string, { value: string; reason?: string }>;

export function deriveNames(
  system: string, service: string, type: ServiceType, platform: PlatformNames, overrides?: NameOverrides,
): DerivedNames {
  const { env, domain, registry, git } = platform;
  const id = type ? `${system}-${service}-${type}` : `${system}-${service}`;
  const under = `${system}_${service}`.replace(/-/g, '_');
  const hostEnv = env === 'prod' ? '' : `${env}.`;
  const d: DerivedNames = {
    id,
    repo: id,
    deployment: id,
    helm: id,
    serviceAccount: id,
    namespace: `${system}-${env}`,
    ingressHost: `${service}.${system}.${hostEnv}${domain}`,
    tuz: `svc-${id}-${env}`,
    vaultPath: `${system}/${env}/${type ? `${service}-${type}` : service}`,
    dbSchema: under,
    dbUsers: { rw: `${under}_rw`, ro: `${under}_ro`, migr: `${under}_migr` },
    consumerGroup: id,
    image: `${registry}/${system}/${id}`,
    repoUrl: `https://${git}/${system}/${id}`,
  };
  for (const [key, ov] of Object.entries(overrides ?? {})) {
    const value = String(ov.value);
    const m = /^dbUsers\.(rw|ro|migr)$/.exec(key);
    if (m) d.dbUsers[m[1] as 'rw' | 'ro' | 'migr'] = value;
    else if (key in d && key !== 'dbUsers') (d as unknown as Record<string, string>)[key] = value;
  }
  return d;
}

export function topicName(system: string, service: string, entity: string, event: string, version?: number): string {
  const base = `${system}.${service}.${entity}.${event}`;
  return version === undefined ? base : `${base}.v${version}`;
}

export function bucketName(system: string, service: string, env: string, purpose: string): string {
  return `${system}-${service}-${env}${purpose ? `-${purpose}` : ''}`;
}
