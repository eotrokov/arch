import { existsSync } from 'node:fs';
import { describe, it } from 'vitest';

export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const hasChrome = existsSync(CHROME);

/**
 * describe для тестов в Chrome. Нет Chrome: локально — пропуск с предупреждением, в CI (задана CI) — падение
 * с понятным сообщением, чтобы зелёный CI не скрывал непрогнанные e2e.
 */
export function describeChrome(name: string, fn: () => void): void {
  if (hasChrome) { describe(name, fn); return; }
  const msg = `Chrome не найден (${CHROME}): e2e «${name}» не выполнены. Установите Chrome или укажите CHROME_PATH.`;
  if (process.env.CI) {
    describe(name, () => { it('Chrome доступен', () => { throw new Error(msg); }); });
    return;
  }
  console.warn(`[e2e] ${msg}`);
  describe.skip(name, fn);
}
