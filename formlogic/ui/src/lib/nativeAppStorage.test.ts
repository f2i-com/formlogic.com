// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeStorageError, nativeAppStorage as createNativeAppStorage } from './nativeAppStorage';

// These existing bounded-map and acknowledgement cases exercise independent application mode.
const nativeAppStorage = (slug: string) => createNativeAppStorage(slug, { access: 'application', appId: slug });

const storageKey = (slug: string) => `formlogic:native-app-storage:v1:${encodeURIComponent(slug)}`;
beforeEach(() => localStorage.clear());

it('restores only the selected app session and keeps it when another app clears storage', () => {
  const notes = nativeAppStorage('notes');
  notes.mutate({ operation: 'set', key: 'session', value: 'example-session' });
  nativeAppStorage('calendar').mutate({ operation: 'clear' });
  expect(nativeAppStorage('notes').read()).toEqual({ session: 'example-session' });
  notes.mutate({ operation: 'remove', key: 'session' });
  expect(notes.read()).toEqual({});
});
it('reports a full browser store without replacing the last saved value', () => {
  const notes = nativeAppStorage('notes');
  notes.mutate({ operation: 'set', key: 'draft', value: 'Saved note' });
  expect(() => notes.mutate({ operation: 'set', key: 'draft', value: 'x'.repeat(30001) })).toThrow();
  expect(notes.read().draft).toBe('Saved note');
});

// Audit FL-S07: the six assertions from the release handoff's isolated
// regression (checks/browser-storage.regression.test.mjs), kept here so the
// helper cannot drift back to filtering damaged entries and writing the
// rest over the original.
describe('damaged storage is preserved, never normalised', () => {
  it('healthy writes stay in their app namespace', () => {
    nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'first' });
    nativeAppStorage('beta').mutate({ operation: 'set', key: 'note', value: 'second' });
    expect(nativeAppStorage('alpha').read()).toEqual({ note: 'first' });
    expect(nativeAppStorage('beta').read()).toEqual({ note: 'second' });
  });
  it('invalid top-level shape is rejected without writes', () => {
    localStorage.setItem(storageKey('alpha'), '[]');
    expect(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'new' })).toThrow();
    expect(localStorage.getItem(storageKey('alpha'))).toBe('[]');
  });
  it('partially invalid stored entries must not appear healthy', () => {
    localStorage.setItem(storageKey('alpha'), JSON.stringify({ good: 'preserve', damaged: { original: 'bytes' } }));
    expect(() => nativeAppStorage('alpha').read()).toThrow(NativeStorageError);
    expect(nativeAppStorage('alpha').status()).toMatchObject({ state: 'corrupt' });
  });
  it('ordinary mutation must not overwrite partially invalid original storage', () => {
    const raw = JSON.stringify({ good: 'preserve', damaged: { original: 'bytes' } });
    localStorage.setItem(storageKey('alpha'), raw);
    expect(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'new', value: 'value' })).toThrow(/damaged/);
    expect(() => nativeAppStorage('alpha').mutate({ operation: 'clear' })).toThrow(/damaged/);
    expect(localStorage.getItem(storageKey('alpha'))).toBe(raw);
  });
  it('a failed single-key write preserves the previous stored value', () => {
    const raw = JSON.stringify({ good: 'preserve' });
    localStorage.setItem(storageKey('alpha'), raw);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('Synthetic quota failure'); };
    try {
      expect(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'new', value: 'value' })).toThrow(/quota/);
    } finally { Storage.prototype.setItem = original; }
    expect(localStorage.getItem(storageKey('alpha'))).toBe(raw);
  });
  it('oversized new values are refused before persistence', () => {
    localStorage.setItem(storageKey('alpha'), JSON.stringify({ good: 'preserve' }));
    expect(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'x'.repeat(30001) })).toThrow();
    expect(localStorage.getItem(storageKey('alpha'))).toBe(JSON.stringify({ good: 'preserve' }));
  });
});

describe('recovery', () => {
  it('keeps healthy-missing distinct from damaged, and a damaged map exportable', () => {
    expect(nativeAppStorage('alpha').status()).toEqual({ state: 'empty' });
    nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'first' });
    expect(nativeAppStorage('alpha').status()).toEqual({ state: 'healthy', entries: 1 });
    localStorage.setItem(storageKey('alpha'), '{not json');
    expect(nativeAppStorage('alpha').status()).toMatchObject({ state: 'corrupt' });
    expect(nativeAppStorage('alpha').exportRaw()).toBe('{not json');
    localStorage.setItem(storageKey('alpha'), 'x'.repeat(256 * 1024 + 1));
    expect(nativeAppStorage('alpha').status()).toMatchObject({ state: 'too-large' });
  });
  it('reset is explicit, per app, and leaves the other app alone', () => {
    localStorage.setItem(storageKey('alpha'), '{not json');
    nativeAppStorage('beta').mutate({ operation: 'set', key: 'note', value: 'second' });
    nativeAppStorage('alpha').reset();
    expect(nativeAppStorage('alpha').status()).toEqual({ state: 'empty' });
    expect(nativeAppStorage('alpha').read()).toEqual({});
    expect(nativeAppStorage('beta').read()).toEqual({ note: 'second' });
  });
  it('reports storage that cannot be reached as unavailable rather than empty', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('SecurityError'); };
    try {
      expect(nativeAppStorage('alpha').status()).toMatchObject({ state: 'unavailable' });
      expect(() => nativeAppStorage('alpha').read()).toThrow(/not available/);
    } finally { Storage.prototype.getItem = original; }
  });
});

describe('acknowledged replacement batches', () => {
  it('preflights every replacement and saves one candidate map exactly once', () => {
    const alpha = nativeAppStorage('alpha');
    alpha.mutate({ operation: 'set', key: 'kept', value: 'original' });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(alpha.mutate({ operation: 'batch', replacements: [{ key: 'session', value: 'fictional' }, { key: 'looks', value: '[1,2,3]' }] })).toEqual({ saved: true });
      expect(write).toHaveBeenCalledTimes(1);
      expect(alpha.read()).toEqual({ kept: 'original', session: 'fictional', looks: '[1,2,3]' });
    } finally { write.mockRestore(); }
  });
  it.each([
    [{ key: 'new', value: 'valid' }, { key: 'bad', value: 7 }],
    [{ key: 'new', value: 'valid' }, { key: 'x'.repeat(257), value: 'bad' }],
    [{ key: 'new', value: 'valid' }, { key: 'bad', value: 'x'.repeat(30001) }],
    [{ key: 'new', value: 'first' }, { key: 'new', value: 'duplicate' }],
    [{ key: 'new', value: 'valid' }, null],
  ].map(replacements => ({ replacements })))('refuses an invalid later replacement without saving the valid prefix: %j', ({ replacements }) => {
    const alpha = nativeAppStorage('alpha');
    alpha.mutate({ operation: 'set', key: 'kept', value: 'original' });
    const raw = alpha.exportRaw();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(() => alpha.mutate({ operation: 'batch', replacements })).toThrow(NativeStorageError);
      expect(write).not.toHaveBeenCalled();
      expect(alpha.exportRaw()).toBe(raw);
    } finally { write.mockRestore(); }
  });
  it('admits the exact full-input UTF-16 boundary, including metadata, and refuses one unit above', () => {
    const alpha = nativeAppStorage('alpha');
    const input = { operation: 'batch', replacements: [{ key: 'note', value: 'kept' }], padding: '' };
    input.padding = 'x'.repeat(32768 - JSON.stringify(input).length);
    expect(JSON.stringify(input).length).toBe(32768);
    expect(alpha.mutate(input)).toEqual({ saved: true });
    const raw = alpha.exportRaw();
    expect(() => alpha.mutate({ ...input, padding: `${input.padding}x` })).toThrow(/input/);
    expect(alpha.exportRaw()).toBe(raw);
  });
  it('rejects escape-heavy input before any writes, but keeps raw reads that fit the stored-map limit', () => {
    const alpha = nativeAppStorage('alpha');
    localStorage.setItem(storageKey('alpha'), JSON.stringify({ existing: '\n'.repeat(17000) }));
    const raw = alpha.exportRaw();
    expect(alpha.read().existing).toHaveLength(17000);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(() => alpha.mutate({ operation: 'set', key: 'new', value: '\n'.repeat(17000) })).toThrow(/input/);
      expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'new', value: '\n'.repeat(17000) }] })).toThrow(/input/);
      expect(write).not.toHaveBeenCalled();
      expect(alpha.exportRaw()).toBe(raw);
    } finally { write.mockRestore(); }
  });
  it('preserves existing key/value limits as UTF-16 units, including non-BMP characters', () => {
    const alpha = nativeAppStorage('alpha');
    const key = '😀'.repeat(128);
    const value = '😀'.repeat(15000);
    expect(alpha.mutate({ operation: 'batch', replacements: [{ key, value }] })).toEqual({ saved: true });
    expect(alpha.read()[key]).toBe(value);
    expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: `${key}x`, value: '' }] })).toThrow();
    expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'bad', value: `${value}x` }] })).toThrow();
  });
  it('refuses aggregate map and entry quotas without changing the original map', () => {
    const alpha = nativeAppStorage('alpha');
    const map = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, 'x'.repeat(30000)]));
    localStorage.setItem(storageKey('alpha'), JSON.stringify(map));
    const raw = alpha.exportRaw();
    expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'overflow', value: 'x'.repeat(25000) }] })).toThrow(/limit/);
    expect(alpha.exportRaw()).toBe(raw);
    const full = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, 'kept']));
    localStorage.setItem(storageKey('alpha'), JSON.stringify(full));
    expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'overflow', value: 'x' }] })).toThrow(/limit/);
    expect(alpha.read()).toEqual(full);
    expect(() => alpha.mutate({ operation: 'batch', replacements: Array.from({ length: 201 }, (_, index) => ({ key: `k${index}`, value: '' })) })).toThrow();
    expect(alpha.read()).toEqual(full);
  });
  it('returns no saved acknowledgment on quota failure and keeps corrupt bytes exportable', () => {
    const alpha = nativeAppStorage('alpha');
    alpha.mutate({ operation: 'set', key: 'kept', value: 'original' });
    const raw = alpha.exportRaw();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota failure'); });
    try {
      expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'a', value: 'new' }, { key: 'b', value: 'new' }] })).toThrow(/quota/);
      expect(alpha.exportRaw()).toBe(raw);
    } finally { write.mockRestore(); }
    localStorage.setItem(storageKey('alpha'), '{original damaged bytes');
    expect(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'a', value: 'new' }] })).toThrow(NativeStorageError);
    expect(alpha.exportRaw()).toBe('{original damaged bytes');
  });
  it('keeps batches, clear and reset confined to the selected app, including prototype-like keys', () => {
    const alpha = nativeAppStorage('alpha');
    nativeAppStorage('beta').mutate({ operation: 'set', key: 'session', value: 'other' });
    alpha.mutate({ operation: 'batch', replacements: [{ key: '__proto__', value: 'literal' }, { key: 'constructor', value: 'literal' }], slug: 'beta', actor: 'ignored' });
    expect(Object.entries(alpha.read())).toEqual([['__proto__', 'literal'], ['constructor', 'literal']]);
    alpha.mutate({ operation: 'clear' });
    alpha.reset();
    expect(nativeAppStorage('beta').read()).toEqual({ session: 'other' });
  });
  it('rejects malformed/cyclic input without storage mutation', () => {
    const alpha = nativeAppStorage('alpha');
    const cyclic: Record<string, unknown> = { operation: 'clear' };
    cyclic.self = cyclic;
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(() => alpha.mutate(cyclic)).toThrow(/input/);
      expect(() => alpha.mutate({ operation: 'batch', replacements: {} })).toThrow();
      expect(() => alpha.mutate({ operation: 'batch', replacements: [1] })).toThrow();
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
});
