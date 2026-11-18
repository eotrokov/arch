// JSON Schema (draft-07) для YAML-файлов модели. Везде additionalProperties: false.

type S = Record<string, unknown>;

const str: S = { type: 'string', minLength: 1 };
const port: S = { type: 'integer', minimum: 1, maximum: 65535 };
const strList: S = { type: 'array', items: str };
const ref = (n: string): S => ({ $ref: `#/definitions/${n}` });
const obj = (properties: Record<string, S>, required: string[] = []): S => ({
  type: 'object', properties, required, additionalProperties: false,
});

const definitions: Record<string, S> = {
  owner: obj({ role: str, name: str, contact: str }, ['role', 'name']),
  owners: { type: 'array', items: ref('owner') },
  link: obj({ kind: str, url: { type: 'string', pattern: '^https?://' }, title: str }, ['kind', 'url']),
  links: { type: 'array', items: ref('link') },
  resource: obj({
    id: str, kind: str, name: str, endpoint: str, segment: str, port, protocol: str,
    owners: ref('owners'), links: ref('links'),
  }, ['id', 'kind', 'name', 'segment', 'port', 'protocol']),
  external: obj({ id: str, name: str, segment: str, port, protocol: str },
    ['id', 'name', 'segment', 'port', 'protocol']),
  dbserver: obj({
    id: str, engine: str, version: { type: ['string', 'number'], minLength: 1 }, endpoint: str, segment: str, port,
    hosts: {
      type: 'array', minItems: 1,
      items: obj({ fqdn: str, role: { enum: ['primary', 'replica', 'arbiter'] } }, ['fqdn', 'role']),
    },
    owners: ref('owners'), links: ref('links'),
  }, ['id', 'engine', 'segment', 'port', 'hosts']),
  resources: { type: 'array', items: ref('resource') },
  externals: { type: 'array', items: ref('external') },
  dbservers: { type: 'array', items: ref('dbserver') },
  endpointRef: {
    type: 'object',
    properties: { segment: str, node: str },
    oneOf: [{ required: ['segment'] }, { required: ['node'] }],
    additionalProperties: false,
  },
};

export const networkSchema: S = {
  type: 'object',
  definitions,
  properties: {
    segments: {
      type: 'array',
      items: obj({ id: str, name: str, external: { type: 'boolean' }, sensitive: { type: 'boolean' }, description: str },
        ['id', 'name']),
    },
    actors: { type: 'array', items: obj({ id: str, name: str, segment: str }, ['id', 'name', 'segment']) },
    connections: {
      type: 'array',
      items: obj({ from: ref('endpointRef'), to: ref('endpointRef'), port, protocol: str, reason: str },
        ['from', 'to', 'port', 'protocol', 'reason']),
    },
  },
  required: ['segments'],
  additionalProperties: false,
};

export const platformSchema: S = {
  type: 'object',
  definitions,
  properties: {
    env: str, domain: str, registry: str, git: str,
    clusters: { type: 'array', items: obj({ id: str, name: str }, ['id', 'name']) },
    resources: ref('resources'), externals: ref('externals'), dbservers: ref('dbservers'),
  },
  required: ['domain', 'registry', 'git', 'clusters'],
  additionalProperties: false,
};

export const teamSchema: S = {
  type: 'object',
  definitions,
  properties: { name: str, owners: ref('owners'), links: ref('links') },
  required: ['name'],
  additionalProperties: false,
};

export const productSchema: S = {
  type: 'object',
  definitions,
  properties: {
    code: str, name: str, criticality: str, nfr: { type: 'object' },
    owners: ref('owners'), links: ref('links'),
    entities: {
      type: 'array',
      items: obj({ name: str, classification: { enum: ['open', 'kt', 'pdn'] }, owner: str },
        ['name', 'classification', 'owner']),
    },
    externals: ref('externals'), dbservers: ref('dbservers'), resources: ref('resources'),
  },
  required: ['code', 'name'],
  additionalProperties: false,
};

const entities: S = strList;

export const serviceSchema: S = {
  type: 'object',
  definitions,
  properties: {
    name: str, segment: str, cluster: str,
    type: { enum: ['backend', 'ui', 'worker', 'job', 'gw'] },
    port, protocol: str, criticality: str,
    databases: {
      type: 'array',
      items: obj({ server: str, classification: { enum: ['open', 'kt', 'pdn'] }, schema: str }, ['server']),
    },
    publishes: {
      type: 'array',
      items: obj({ entity: str, event: str, version: { type: 'integer', minimum: 1 }, broker: str },
        ['entity', 'event']),
    },
    consumes: { type: 'array', items: obj({ topic: str, broker: str }, ['topic']) },
    calls: {
      type: 'array',
      items: obj({ target: str, protocol: str, port, entities }, ['target']),
    },
    uses: {
      type: 'array',
      items: {
        oneOf: [
          obj({ resource: str, purpose: str, entities }, ['resource']),
          obj({ resource: str, bucket: str, access: { enum: ['ro', 'rw'] }, purpose: str, entities },
            ['resource', 'bucket', 'access']),
          obj({ db: str, role: { enum: ['rw', 'ro', 'migr'] } }, ['db', 'role']),
        ],
      },
    },
    exports: {
      type: 'array',
      items: obj({ channel: { enum: ['cdc', 'batch'] }, target: str, entities }, ['channel', 'target']),
    },
    exposure: {
      type: 'array',
      items: obj({ audience: str, via: { type: 'array', minItems: 1, items: str } }, ['audience', 'via']),
    },
    owners: ref('owners'), links: ref('links'),
    overrides: {
      type: 'object',
      additionalProperties: obj({ value: {}, reason: str }, ['value', 'reason']),
    },
  },
  required: ['name', 'segment', 'cluster'],
  additionalProperties: false,
};
