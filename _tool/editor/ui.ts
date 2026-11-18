// Мелкие помощники оболочки: экран, тост, кнопка.
import { h } from './fields.js';

export const byId = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;

export function setScreen(doc: Document, state: 'login' | 'loading' | 'ready' | 'error', ...content: Node[]): void {
  doc.body.dataset.state = state;
  if (content.length) byId(doc, 'app').replaceChildren(...content);
}

export function toast(doc: Document, msg: string, kind: 'ok' | 'warn' | 'err' = 'ok'): void {
  const t = byId(doc, 'toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => { t.hidden = true; }, kind === 'ok' ? 3000 : 8000));
}

export function btn(label: string, cls: string, onClick: () => void, aria?: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, 'aria-label': aria ?? false, title: aria ?? false }, label);
  b.addEventListener('click', onClick);
  return b;
}
