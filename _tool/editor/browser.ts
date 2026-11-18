// Хранилища браузера с запасным вариантом в памяти и автозапуск редактора на странице.
import type { Deps } from './state.js';

/** Хранилище в памяти — если браузер запрещает localStorage/sessionStorage. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

function storageOr(get: () => Storage): Storage {
  try { return get(); } catch { return memoryStorage(); }
}

/** Запуск на странице редактора: boot вызывается с настоящими fetch/storage/location. */
export function autoBoot(boot: (d: Document, dp: Deps) => Promise<void>): void {
  if (typeof document !== 'undefined' && document.getElementById('app')) {
    void boot(document, {
      fetch: (input, init) => fetch(input, init),
      storage: storageOr(() => localStorage),
      session: storageOr(() => sessionStorage),
      location,
    });
  }
}
