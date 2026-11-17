import type { RawTree } from '../model/raw.js';
import type { Finding } from '../model/types.js';
import { deriveNames, type ServiceType } from '../model/names.js';

const PRODUCT_CODE = /^[a-z][a-z0-9]{1,9}$/;
const SERVICE_ID = /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const FORBIDDEN = ['service', 'app', 'project', 'new', 'test', 'final', 'v2'];

export function checkNaming(tree: RawTree): Finding[] {
  const out: Finding[] = [];
  const platform = { env: tree.platform.env ?? 'prod', domain: tree.platform.domain, registry: tree.platform.registry, git: tree.platform.git };
  for (const team of tree.teams) {
    for (const product of team.products) {
      const code = product.data.code;
      if (!PRODUCT_CODE.test(code)) {
        out.push({ rule: 'naming.pattern', level: 'error', nodeIds: [], edgeIds: [], file: product.file,
          message: `Код продукта «${code}» не соответствует шаблону ^[a-z][a-z0-9]{1,9}$.` });
      }
      if (product.dir !== code) {
        out.push({ rule: 'naming.product-dir', level: 'error', nodeIds: [], edgeIds: [], file: product.file,
          message: `Каталог продукта «${product.dir}» не совпадает с кодом «${code}».` });
      }
      for (const { file, data } of product.services) {
        const type: ServiceType = data.type && data.type !== 'backend' ? data.type : '';
        const names = deriveNames(code, data.name, type, platform, data.overrides as never);
        const id = names.id;
        const base = { level: 'error' as const, nodeIds: [id], edgeIds: [] as string[], file };
        if (!SERVICE_ID.test(id)) {
          out.push({ ...base, rule: 'naming.pattern',
            message: `Имя репозитория «${id}» не соответствует шаблону ^[a-z][a-z0-9-]{1,40}[a-z0-9]$.` });
        }
        if (!SERVICE_NAME.test(data.name)) {
          out.push({ ...base, rule: 'naming.pattern',
            message: `Имя сервиса «${data.name}» допускает только строчную латиницу, цифры и дефис (без подчёркиваний).` });
        }
        for (const tok of data.name.split('-')) {
          if (FORBIDDEN.includes(tok)) {
            out.push({ ...base, rule: 'naming.forbidden-word',
              message: `Имя сервиса «${data.name}» содержит запрещённое слово «${tok}».` });
          }
        }
        for (const [key, ov] of Object.entries(data.overrides ?? {})) {
          if (!ov.reason || !ov.reason.trim()) {
            out.push({ ...base, rule: 'naming.override-reason',
              message: `Переопределение «${key}» у сервиса «${id}» без обоснования (reason).` });
          }
        }
      }
    }
  }
  return out;
}
