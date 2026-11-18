// Состояние просмотрщика в URL-хэше. Без импортов Node (уходит в браузер).
import type { Scope, ViewKind } from '../src/views/types.js';

export interface UiState { scope: Scope; view: ViewKind; selected?: string }

const VIEWS: ViewKind[] = ['kubernetes', 'containers', 'firewall', 'databases', 'dataflows'];
const SCOPE_KINDS = ['team', 'product', 'service'] as const;

const dflt = (): UiState => ({ scope: { kind: 'company', expanded: [] }, view: 'containers' });

function dec(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function parseHash(hash: string): UiState {
  const state = dflt();
  const params = new Map<string, string>();
  for (const part of hash.replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) params.set(part.slice(0, i), dec(part.slice(i + 1)));
  }
  const view = params.get('view');
  if (view && (VIEWS as string[]).includes(view)) state.view = view as ViewKind;

  const scope = params.get('scope');
  if (scope) {
    const i = scope.indexOf(':');
    const kind = i < 0 ? scope : scope.slice(0, i);
    const id = i < 0 ? '' : scope.slice(i + 1);
    if (kind === 'company') {
      const exp = params.get('exp');
      state.scope = { kind: 'company', expanded: exp ? exp.split(',').map(dec).filter(Boolean) : [] };
    } else if ((SCOPE_KINDS as readonly string[]).includes(kind) && id) {
      state.scope = { kind: kind as (typeof SCOPE_KINDS)[number], id };
    }
  }
  const sel = params.get('sel');
  if (sel) state.selected = sel;
  return state;
}

export function toHash(s: UiState): string {
  const e = encodeURIComponent;
  const parts = [`view=${e(s.view)}`];
  if (s.scope.kind === 'company') {
    parts.push('scope=company');
    if (s.scope.expanded.length > 0) parts.push(`exp=${e(s.scope.expanded.join(','))}`);
  } else {
    parts.push(`scope=${e(`${s.scope.kind}:${s.scope.id}`)}`);
  }
  if (s.selected !== undefined) parts.push(`sel=${e(s.selected)}`);
  return `#${parts.join('&')}`;
}

/** Текст пустого состояния схемы. В охвате «Компания» k8s и БД не показывают свёрнутые продукты — подсказываем раскрыть. */
export function emptyText(view: ViewKind, viewLabel: string, scope: Scope, products: string[]): string {
  const hasCollapsed = scope.kind === 'company' && products.some((p) => !scope.expanded.includes(p));
  if (hasCollapsed && (view === 'kubernetes' || view === 'databases')) {
    return 'Раскройте продукт (двойной клик) или выберите продукт слева';
  }
  return `В разрезе «${viewLabel}» для этого охвата нет элементов.`;
}
