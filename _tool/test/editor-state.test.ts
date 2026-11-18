import { describe, it, expect } from 'vitest';
import { projectKey } from '../editor/state.js';

const loc = (origin: string, pathname: string) => ({ origin, pathname }) as Location;

describe('projectKey', () => {
  it('GitLab: путь проекта', () => {
    expect(projectKey({ cfg: { projectPath: 'g/arch' } } as never, loc('https://a.ru', '/x/'))).toBe('g/arch');
  });
  it('запасной режим: адрес страницы, два развёртывания не делят черновик', () => {
    const a = projectKey({} as never, loc('https://pages.ru', '/a/editor/'));
    const b = projectKey({} as never, loc('https://pages.ru', '/b/editor/'));
    expect(a).toBe('https://pages.ru/a/editor/');
    expect(a).not.toBe(b);
  });
});
