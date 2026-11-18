// Общие типы оболочки редактора: состояние приложения и окружение браузера (без логики).
import type { EditorConfig } from './config.js';
import type { GitLabClient } from './gitlab/api.js';
import type { FileMap, Validation } from './model.js';
import type { Cart, Change } from './cart.js';
import type { WizardState } from './forms.js';

export interface Deps { fetch: typeof fetch; storage: Storage; session: Storage; location: Location }

export interface AppState {
  mode: 'gitlab' | 'offline';
  cfg?: EditorConfig;
  client?: GitLabClient;
  user?: { username: string; name: string };
  files: FileMap;
  blobs: Record<string, string>;
  dirs: string[];
  baseSha?: string;
  builtAt?: string;
  /** Проверка модели: main + корзина + текущая правка мастера. */
  validation: Validation;
  cart: Cart;
  /** Правки черновика, чей файл изменился в main: ждут решения пользователя. */
  conflicts: Change[];
  wizard?: WizardState;
  step: string;
  /** Путь правки в корзине, открытой в мастере (новый файл может сменить путь при смене имени). */
  cartPath?: string;
  openMrs: { iid: number; title: string; webUrl: string }[];
}

/** Что нужно модулям оболочки: документ, браузерные зависимости и состояние (передаётся явно, не глобально). */
export interface Env { doc: Document; deps: Deps; app: AppState }
