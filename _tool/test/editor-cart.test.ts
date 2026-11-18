import { describe, it, expect } from 'vitest';
import { Cart, isSharedPath, applyCart, saveDraft, loadDraft, reconcile, type Change } from '../editor/cart.js';

class FakeStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

const ch = (path: string, content: string | null, baseBlobId: string | null, label = 'l'): Change => ({ path, content, baseBlobId, label });

describe('Cart', () => {
  it('put replaces by path, remove and clear work', () => {
    const c = new Cart();
    expect(c.isEmpty()).toBe(true);
    c.put(ch('a.yaml', '1', 'b1'));
    c.put(ch('a.yaml', '2', 'b1'));
    c.put(ch('b.yaml', null, 'b2'));
    expect(c.changes()).toHaveLength(2);
    expect(c.changes().find((x) => x.path === 'a.yaml')!.content).toBe('2');
    c.remove('a.yaml');
    expect(c.changes().map((x) => x.path)).toEqual(['b.yaml']);
    c.clear();
    expect(c.isEmpty()).toBe(true);
  });

  it('rejects _shared paths', () => {
    const c = new Cart();
    expect(() => c.put(ch('_shared/x.yaml', 'a', null))).toThrow('Файлы _shared меняют архитекторы');
    expect(c.isEmpty()).toBe(true);
  });
});

describe('applyCart', () => {
  it('overlays, creates and deletes without mutating input', () => {
    const files = { 'a.yaml': 'a', 'b.yaml': 'b' };
    const out = applyCart(files, [ch('a.yaml', 'A', 'x'), ch('b.yaml', null, 'y'), ch('c.yaml', 'C', null)]);
    expect(out).toEqual({ 'a.yaml': 'A', 'c.yaml': 'C' });
    expect(files).toEqual({ 'a.yaml': 'a', 'b.yaml': 'b' });
  });
});

describe('drafts', () => {
  it('round-trips per project', () => {
    const s = new FakeStorage();
    const changes = [ch('a.yaml', 'A', 'x', 'Новый')];
    saveDraft(s, 'g/p', changes);
    expect(s.getItem('arch-editor:draft:g/p')).not.toBeNull();
    expect(loadDraft(s, 'g/p')).toEqual(changes);
    expect(loadDraft(s, 'other')).toEqual([]);
  });

  it('broken JSON and non-array give []', () => {
    const s = new FakeStorage();
    s.setItem('arch-editor:draft:p', '{oops');
    expect(loadDraft(s, 'p')).toEqual([]);
    s.setItem('arch-editor:draft:p', '{"a":1}');
    expect(loadDraft(s, 'p')).toEqual([]);
  });

  it('drops malformed items and _shared paths', () => {
    const s = new FakeStorage();
    const good = ch('a.yaml', 'A', null);
    s.setItem('arch-editor:draft:p', JSON.stringify([good, null, 5, { path: 'x' }, { ...good, content: 3 }, { ...good, baseBlobId: 1 }, { ...good, label: undefined }, ch('_shared/z', 'q', null)]));
    expect(loadDraft(s, 'p')).toEqual([good]);
  });

  it('empty changes remove the draft', () => {
    const s = new FakeStorage();
    saveDraft(s, 'p', [ch('a', 'A', null)]);
    saveDraft(s, 'p', []);
    expect(s.getItem('arch-editor:draft:p')).toBeNull();
  });
});

describe('reconcile', () => {
  it('unchanged file applies; three conflict kinds', () => {
    const blobs = { 'same.yaml': 's1', 'moved.yaml': 'm2', 'exists.yaml': 'e1' };
    const same = ch('same.yaml', 'x', 's1');
    const moved = ch('moved.yaml', 'x', 'm1');
    const gone = ch('gone.yaml', null, 'g1');
    const clash = ch('exists.yaml', 'x', null);
    const fresh = ch('fresh.yaml', 'x', null);
    const r = reconcile([same, moved, gone, clash, fresh], blobs);
    expect(r.applied).toEqual([same, fresh]);
    expect(r.conflicts).toEqual([moved, gone, clash]);
  });
});

describe('_shared path normalisation', () => {
  const forms = ['_shared', '_shared/x', './_shared/x', '/_shared/x', 'a/../_shared/x', '\\_shared\\x', 'a//../_shared/./x'];
  it.each(forms)('%s is shared', (p) => {
    expect(isSharedPath(p)).toBe(true);
    expect(() => new Cart().put(ch(p, 'a', null))).toThrow('Файлы _shared меняют архитекторы');
    expect(() => applyCart({}, [ch(p, 'a', null)])).toThrow('_shared');
    expect(() => reconcile([ch(p, 'a', null)], {})).toThrow('_shared');
  });
  it('non-shared look-alikes pass', () => {
    for (const p of ['_shared2/x', 'a/_shared/x', 'sales/../crm/x.yaml']) expect(isSharedPath(p)).toBe(false);
  });
  it('loadDraft drops loose _shared forms', () => {
    const s = new FakeStorage();
    s.setItem('arch-editor:draft:p', JSON.stringify(forms.map((p) => ch(p, 'a', null))));
    expect(loadDraft(s, 'p')).toEqual([]);
  });
});

describe('storage failures', () => {
  const boom = new FakeStorage();
  boom.getItem = () => { throw new Error('SecurityError'); };
  boom.setItem = () => { throw new Error('QuotaExceededError'); };
  boom.removeItem = () => { throw new Error('SecurityError'); };
  it('saveDraft returns false instead of throwing; true on success', () => {
    expect(saveDraft(boom, 'p', [ch('a', 'A', null)])).toBe(false);
    expect(saveDraft(boom, 'p', [])).toBe(false);
    expect(saveDraft(new FakeStorage(), 'p', [ch('a', 'A', null)])).toBe(true);
  });
  it('loadDraft returns [] when getItem throws', () => {
    expect(loadDraft(boom, 'p')).toEqual([]);
  });
});
