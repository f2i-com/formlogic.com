// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { NativeStorageError, nativeAppStorage } from './nativeAppStorage';

const storageKey = (slug: string) => `formlogic:native-storage:${encodeURIComponent(slug)}`;
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
