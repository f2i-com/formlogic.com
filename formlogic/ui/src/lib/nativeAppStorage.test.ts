// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeStorageError, nativeAppStorage as createNativeAppStorage } from './nativeAppStorage';

// These existing bounded-map and acknowledgement cases exercise independent application mode.
const nativeAppStorage = (slug: string) => createNativeAppStorage(slug, { access: 'application', appId: slug });

const storageKey = (slug: string) => `formlogic:native-app-storage:v1:${encodeURIComponent(slug)}`;
beforeEach(() => localStorage.clear());

it('restores only the selected app session and keeps it when another app clears storage', async () => {
  const notes = nativeAppStorage('notes');
  await notes.mutate({ operation: 'set', key: 'session', value: 'example-session' });
  await nativeAppStorage('calendar').mutate({ operation: 'clear' });
  expect(await nativeAppStorage('notes').read()).toEqual({ session: 'example-session' });
  await notes.mutate({ operation: 'remove', key: 'session' });
  expect(await notes.read()).toEqual({});
});
it('reports a full browser store without replacing the last saved value', async () => {
  const notes = nativeAppStorage('notes');
  await notes.mutate({ operation: 'set', key: 'draft', value: 'Saved note' });
  await expect(Promise.resolve().then(() => notes.mutate({ operation: 'set', key: 'draft', value: 'x'.repeat(30001) }))).rejects.toThrow();
  expect((await notes.read()).draft).toBe('Saved note');
});

// Audit FL-S07: the six assertions from the release handoff's isolated
// regression (checks/browser-storage.regression.test.mjs), kept here so the
// helper cannot drift back to filtering damaged entries and writing the
// rest over the original.
describe('damaged storage is preserved, never normalised', () => {
  it('healthy writes stay in their app namespace', async () => {
    await nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'first' });
    await nativeAppStorage('beta').mutate({ operation: 'set', key: 'note', value: 'second' });
    expect(await nativeAppStorage('alpha').read()).toEqual({ note: 'first' });
    expect(await nativeAppStorage('beta').read()).toEqual({ note: 'second' });
  });
  it('invalid top-level shape is rejected without writes', async () => {
    localStorage.setItem(storageKey('alpha'), '[]');
    await expect(Promise.resolve().then(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'new' }))).rejects.toThrow();
    expect(localStorage.getItem(storageKey('alpha'))).toBe('[]');
  });
  it('partially invalid stored entries must not appear healthy', async () => {
    localStorage.setItem(storageKey('alpha'), JSON.stringify({ good: 'preserve', damaged: { original: 'bytes' } }));
    await expect(Promise.resolve().then(() => nativeAppStorage('alpha').read())).rejects.toThrow(NativeStorageError);
    expect(await nativeAppStorage('alpha').status()).toMatchObject({ state: 'corrupt' });
  });
  it('ordinary mutation must not overwrite partially invalid original storage', async () => {
    const raw = JSON.stringify({ good: 'preserve', damaged: { original: 'bytes' } });
    localStorage.setItem(storageKey('alpha'), raw);
    await expect(Promise.resolve().then(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'new', value: 'value' }))).rejects.toThrow(/damaged/);
    await expect(Promise.resolve().then(() => nativeAppStorage('alpha').mutate({ operation: 'clear' }))).rejects.toThrow(/damaged/);
    expect(localStorage.getItem(storageKey('alpha'))).toBe(raw);
  });
  it('a failed single-key write preserves the previous stored value', async () => {
    const raw = JSON.stringify({ good: 'preserve' });
    localStorage.setItem(storageKey('alpha'), raw);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('Synthetic quota failure'); };
    try {
      await expect(Promise.resolve().then(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'new', value: 'value' }))).rejects.toThrow(/quota/);
    } finally { Storage.prototype.setItem = original; }
    expect(localStorage.getItem(storageKey('alpha'))).toBe(raw);
  });
  it('oversized new values are refused before persistence', async () => {
    localStorage.setItem(storageKey('alpha'), JSON.stringify({ good: 'preserve' }));
    await expect(Promise.resolve().then(() => nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'x'.repeat(30001) }))).rejects.toThrow();
    expect(localStorage.getItem(storageKey('alpha'))).toBe(JSON.stringify({ good: 'preserve' }));
  });
});

describe('recovery', () => {
  it('keeps healthy-missing distinct from damaged, and a damaged map exportable', async () => {
    expect(await nativeAppStorage('alpha').status()).toEqual({ state: 'empty' });
    await nativeAppStorage('alpha').mutate({ operation: 'set', key: 'note', value: 'first' });
    expect(await nativeAppStorage('alpha').status()).toEqual({ state: 'healthy', entries: 1 });
    localStorage.setItem(storageKey('alpha'), '{not json');
    expect(await nativeAppStorage('alpha').status()).toMatchObject({ state: 'corrupt' });
    expect(await nativeAppStorage('alpha').exportRaw()).toBe('{not json');
    localStorage.setItem(storageKey('alpha'), 'x'.repeat(256 * 1024 + 1));
    expect(await nativeAppStorage('alpha').status()).toMatchObject({ state: 'too-large' });
  });
  it('reset is explicit, per app, and leaves the other app alone', async () => {
    localStorage.setItem(storageKey('alpha'), '{not json');
    await nativeAppStorage('beta').mutate({ operation: 'set', key: 'note', value: 'second' });
    await nativeAppStorage('alpha').reset();
    expect(await nativeAppStorage('alpha').status()).toEqual({ state: 'empty' });
    expect(await nativeAppStorage('alpha').read()).toEqual({});
    expect(await nativeAppStorage('beta').read()).toEqual({ note: 'second' });
  });
  it('reports storage that cannot be reached as unavailable rather than empty', async () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('SecurityError'); };
    try {
      expect(await nativeAppStorage('alpha').status()).toMatchObject({ state: 'unavailable' });
      await expect(Promise.resolve().then(() => nativeAppStorage('alpha').read())).rejects.toThrow(/not available/);
    } finally { Storage.prototype.getItem = original; }
  });
});

describe('acknowledged replacement batches', () => {
  it('preflights every replacement and saves one candidate map exactly once', async () => {
    const alpha = nativeAppStorage('alpha');
    await alpha.mutate({ operation: 'set', key: 'kept', value: 'original' });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(await alpha.mutate({ operation: 'batch', replacements: [{ key: 'session', value: 'fictional' }, { key: 'looks', value: '[1,2,3]' }] })).toEqual({ saved: true });
      expect(write).toHaveBeenCalledTimes(1);
      expect(await alpha.read()).toEqual({ kept: 'original', session: 'fictional', looks: '[1,2,3]' });
    } finally { write.mockRestore(); }
  });
  it.each([
    [{ key: 'new', value: 'valid' }, { key: 'bad', value: 7 }],
    [{ key: 'new', value: 'valid' }, { key: 'x'.repeat(257), value: 'bad' }],
    [{ key: 'new', value: 'valid' }, { key: 'bad', value: 'x'.repeat(30001) }],
    [{ key: 'new', value: 'first' }, { key: 'new', value: 'duplicate' }],
    [{ key: 'new', value: 'valid' }, null],
  ].map(replacements => ({ replacements })))('refuses an invalid later replacement without saving the valid prefix: %j', async ({ replacements }) => {
    const alpha = nativeAppStorage('alpha');
    await alpha.mutate({ operation: 'set', key: 'kept', value: 'original' });
    const raw = await alpha.exportRaw();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements }))).rejects.toThrow(NativeStorageError);
      expect(write).not.toHaveBeenCalled();
      expect(await alpha.exportRaw()).toBe(raw);
    } finally { write.mockRestore(); }
  });
  it('admits the exact full-input UTF-16 boundary, including metadata, and refuses one unit above', async () => {
    const alpha = nativeAppStorage('alpha');
    const input = { operation: 'batch', replacements: [{ key: 'note', value: 'kept' }], padding: '' };
    input.padding = 'x'.repeat(32768 - JSON.stringify(input).length);
    expect(JSON.stringify(input).length).toBe(32768);
    expect(await alpha.mutate(input)).toEqual({ saved: true });
    const raw = await alpha.exportRaw();
    await expect(Promise.resolve().then(() => alpha.mutate({ ...input, padding: `${input.padding}x` }))).rejects.toThrow(/input/);
    expect(await alpha.exportRaw()).toBe(raw);
  });
  it('rejects escape-heavy input before any writes, but keeps raw reads that fit the stored-map limit', async () => {
    const alpha = nativeAppStorage('alpha');
    localStorage.setItem(storageKey('alpha'), JSON.stringify({ existing: '\n'.repeat(17000) }));
    const raw = await alpha.exportRaw();
    expect((await alpha.read()).existing).toHaveLength(17000);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'set', key: 'new', value: '\n'.repeat(17000) }))).rejects.toThrow(/input/);
      await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'new', value: '\n'.repeat(17000) }] }))).rejects.toThrow(/input/);
      expect(write).not.toHaveBeenCalled();
      expect(await alpha.exportRaw()).toBe(raw);
    } finally { write.mockRestore(); }
  });
  it('preserves existing key/value limits as UTF-16 units, including non-BMP characters', async () => {
    const alpha = nativeAppStorage('alpha');
    const key = '😀'.repeat(128);
    const value = '😀'.repeat(15000);
    expect(await alpha.mutate({ operation: 'batch', replacements: [{ key, value }] })).toEqual({ saved: true });
    expect((await alpha.read())[key]).toBe(value);
    await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: `${key}x`, value: '' }] }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'bad', value: `${value}x` }] }))).rejects.toThrow();
  });
  it('refuses aggregate map and entry quotas without changing the original map', async () => {
    const alpha = nativeAppStorage('alpha');
    const map = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, 'x'.repeat(30000)]));
    localStorage.setItem(storageKey('alpha'), JSON.stringify(map));
    const raw = await alpha.exportRaw();
    await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'overflow', value: 'x'.repeat(25000) }] }))).rejects.toThrow(/limit/);
    expect(await alpha.exportRaw()).toBe(raw);
    const full = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, 'kept']));
    localStorage.setItem(storageKey('alpha'), JSON.stringify(full));
    await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'overflow', value: 'x' }] }))).rejects.toThrow(/limit/);
    expect(await alpha.read()).toEqual(full);
    await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: Array.from({ length: 201 }, (_, index) => ({ key: `k${index}`, value: '' })) }))).rejects.toThrow();
    expect(await alpha.read()).toEqual(full);
  });
  it('returns no saved acknowledgment on quota failure and keeps corrupt bytes exportable', async () => {
    const alpha = nativeAppStorage('alpha');
    await alpha.mutate({ operation: 'set', key: 'kept', value: 'original' });
    const raw = await alpha.exportRaw();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota failure'); });
    try {
      await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'a', value: 'new' }, { key: 'b', value: 'new' }] }))).rejects.toThrow(/quota/);
      expect(await alpha.exportRaw()).toBe(raw);
    } finally { write.mockRestore(); }
    localStorage.setItem(storageKey('alpha'), '{original damaged bytes');
    await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [{ key: 'a', value: 'new' }] }))).rejects.toThrow(NativeStorageError);
    expect(await alpha.exportRaw()).toBe('{original damaged bytes');
  });
  it('keeps batches, clear and reset confined to the selected app, including prototype-like keys', async () => {
    const alpha = nativeAppStorage('alpha');
    await nativeAppStorage('beta').mutate({ operation: 'set', key: 'session', value: 'other' });
    await alpha.mutate({ operation: 'batch', replacements: [{ key: '__proto__', value: 'literal' }, { key: 'constructor', value: 'literal' }], slug: 'beta', actor: 'ignored' });
    expect(Object.entries(await alpha.read())).toEqual([['__proto__', 'literal'], ['constructor', 'literal']]);
    await alpha.mutate({ operation: 'clear' });
    await alpha.reset();
    expect(await nativeAppStorage('beta').read()).toEqual({ session: 'other' });
  });
  it('rejects malformed/cyclic input without storage mutation', async () => {
    const alpha = nativeAppStorage('alpha');
    const cyclic: Record<string, unknown> = { operation: 'clear' };
    cyclic.self = cyclic;
    const write = vi.spyOn(Storage.prototype, 'setItem');
    try {
      await expect(Promise.resolve().then(() => alpha.mutate(cyclic))).rejects.toThrow(/input/);
      await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: {} }))).rejects.toThrow();
      await expect(Promise.resolve().then(() => alpha.mutate({ operation: 'batch', replacements: [1] }))).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
});
