// @vitest-environment jsdom
// An app's browser storage where the browser has IndexedDB: the limits a game's saved state needs,
// what a FormLogic before v0.1.24 left in localStorage carried across once, and the same rules as
// localStorage's (whole maps only, another tab's work never overwritten, a member's data purged).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LARGE_STORAGE_LIMITS, NativeStorageError, SMALL_STORAGE_LIMITS, clearNativeMemberStorage, nativeAppStorage,
  onNativeStorageChange, resetNativeStorageForTests, type NativeStorageScope,
} from './nativeAppStorage';
import { bumpSessionGeneration, setSessionOwner } from './sessionGeneration';

const app = (appId = 'app-one'): NativeStorageScope => ({ access: 'application', appId });
const member = (userId = 'member-a', appId = 'app-one'): NativeStorageScope => ({ access: 'members', appId, userId });
const appKey = (appId: string) => `formlogic:native-app-storage:v1:${appId}`;
const memberKey = (userId: string, appId: string) => `formlogic:native-member-storage:v1:${userId}:${appId}`;

/** What IndexedDB holds for a map, read the way the store reads it. */
async function held(key: string): Promise<string | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('formlogic-native-storage', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    return await new Promise((resolve, reject) => { const r = db.transaction('maps').objectStore('maps').get(key); r.onsuccess = () => resolve(r.result as string | undefined); r.onerror = () => reject(r.error); });
  } finally { db.close(); }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetNativeStorageForTests();
  localStorage.clear();
  setSessionOwner('member-a');
  bumpSessionGeneration();
});
afterEach(() => { setSessionOwner(null); resetNativeStorageForTests(); });

describe('kept in IndexedDB', () => {
  it('holds a save of hundreds of kilobytes, and tells the frame its limits', async () => {
    const store = nativeAppStorage('outer', app());
    expect(await store.storageLimits()).toEqual(LARGE_STORAGE_LIMITS);
    const save = 'x'.repeat(229_000);
    expect(await store.mutate({ operation: 'set', key: 'game.v1.manual0', value: save })).toEqual({ saved: true });
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ 'game.v1.manual0': save });
    expect(localStorage.length).toBe(0);
    expect(JSON.parse((await held(appKey('app-one')))!)).toEqual({ 'game.v1.manual0': save });
  });

  it('keeps six slots of a quarter of a megabyte, where localStorage held a quarter of a megabyte in all', async () => {
    const store = nativeAppStorage('outer', app());
    await store.read();
    for (let slot = 0; slot < 6; slot++) await store.mutate({ operation: 'set', key: `slot${slot}`, value: String(slot).repeat(250_000) });
    expect(Object.keys(await nativeAppStorage('outer', app()).read())).toHaveLength(6);
    expect(SMALL_STORAGE_LIMITS.map).toBeLessThan(6 * 250_000);
  });

  it('refuses a value over the large limit, and the store over its own, saving nothing', async () => {
    const store = nativeAppStorage('outer', app());
    await store.mutate({ operation: 'set', key: 'kept', value: 'v' });
    await expect(store.mutate({ operation: 'set', key: 'big', value: 'x'.repeat(LARGE_STORAGE_LIMITS.value + 1) })).rejects.toBeInstanceOf(NativeStorageError);
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ kept: 'v' });
  });
});

describe('what an older FormLogic kept in localStorage', () => {
  it('moves into IndexedDB the first time its app opens, and only then leaves localStorage', async () => {
    localStorage.setItem(appKey('app-one'), JSON.stringify({ session: 'from-before' }));
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ session: 'from-before' });
    expect(localStorage.getItem(appKey('app-one'))).toBeNull();
    expect(JSON.parse((await held(appKey('app-one')))!)).toEqual({ session: 'from-before' });
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ session: 'from-before' });
  });

  it('moves a map kept under the slug, from before maps were kept by id', async () => {
    localStorage.setItem('formlogic:native-storage:outer', JSON.stringify({ session: 'slug-era' }));
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ session: 'slug-era' });
    expect(localStorage.getItem('formlogic:native-storage:outer')).toBeNull();
  });

  it('never replaces what IndexedDB already holds with what was left behind', async () => {
    await nativeAppStorage('outer', app()).mutate({ operation: 'set', key: 'session', value: 'current' });
    localStorage.setItem(appKey('app-one'), JSON.stringify({ session: 'left behind' }));
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ session: 'current' });
  });

  it('moves damaged bytes as they are, so they can still be exported, and a refused save moves nothing', async () => {
    localStorage.setItem(appKey('app-one'), '{damaged');
    const store = nativeAppStorage('outer', app());
    await expect(store.mutate({ operation: 'set', key: 'new', value: 'v' })).rejects.toThrow(/could not be read/);
    expect(localStorage.getItem(appKey('app-one'))).toBe('{damaged');
    expect(await held(appKey('app-one'))).toBeUndefined();
    expect(await store.exportRaw()).toBe('{damaged');
    await store.reset();
    expect(await nativeAppStorage('outer', app()).read()).toEqual({});
  });
});

describe('two tabs on one map', () => {
  it('refuses a save from a snapshot another tab has moved past, and keeps that tab’s work', async () => {
    const first = nativeAppStorage('outer', app());
    const second = nativeAppStorage('outer', app());
    await first.read(); await second.read();
    await first.mutate({ operation: 'set', key: 'notes', value: '[a]' });
    await expect(second.mutate({ operation: 'set', key: 'notes', value: '[b]' })).rejects.toMatchObject({ code: 'stale' });
    expect(await nativeAppStorage('outer', app()).read()).toEqual({ notes: '[a]' });
  });

  it('tells the other handles, and not the one that wrote', async () => {
    const heard: Array<[string, string]> = [];
    const stop = onNativeStorageChange((key, from) => heard.push([key, from]));
    try {
      const writer = nativeAppStorage('outer', app());
      await writer.mutate({ operation: 'set', key: 'k', value: 'v' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(heard).toEqual([[writer.key, writer.id]]);
    } finally { stop(); }
  });
});

describe('a member’s data', () => {
  it('is removed from IndexedDB when they leave, and another member’s is not', async () => {
    await nativeAppStorage('outer', member('member-a')).mutate({ operation: 'set', key: 'session', value: 'a' });
    setSessionOwner('member-b'); bumpSessionGeneration();
    await nativeAppStorage('outer', member('member-b')).mutate({ operation: 'set', key: 'session', value: 'b' });
    expect(await clearNativeMemberStorage('member-a')).toBe(true);
    expect(await held(memberKey('member-a', 'app-one'))).toBeUndefined();
    expect(await held(memberKey('member-b', 'app-one'))).toBeDefined();
    setSessionOwner('member-a'); bumpSessionGeneration();
    expect(await nativeAppStorage('outer', member('member-a')).read()).toEqual({});
  });

  it('is not read until a purge still under way has finished', async () => {
    await nativeAppStorage('outer', member('member-a')).mutate({ operation: 'set', key: 'session', value: 'a' });
    const purge = clearNativeMemberStorage('member-a');
    // Read at once, as a fast sign-in again would: it waits for the purge, and finds nothing.
    expect(await nativeAppStorage('outer', member('member-a')).read()).toEqual({});
    expect(await purge).toBe(true);
    expect(localStorage.getItem('formlogic:native-member-purges:v1')).toBeNull();
  });

  it('is removed on the next opening when the page closed before a sign-out’s purge finished', async () => {
    await nativeAppStorage('outer', member('member-a')).mutate({ operation: 'set', key: 'session', value: 'a' });
    // What a page closed mid-purge leaves: the list, and the member's map still in IndexedDB.
    localStorage.setItem('formlogic:native-member-purges:v1', JSON.stringify(['member-a']));
    resetNativeStorageForTests();
    // Signed in again at once: the first read waits for the purge the opening resumes.
    expect(await nativeAppStorage('outer', member('member-a')).read()).toEqual({});
    expect(await held(memberKey('member-a', 'app-one'))).toBeUndefined();
    expect(localStorage.getItem('formlogic:native-member-purges:v1')).toBeNull();
  });
});

describe('Reset', () => {
  it('also removes a copy left in localStorage, which would otherwise come back next time', async () => {
    await nativeAppStorage('outer', app()).mutate({ operation: 'set', key: 'slot', value: 'kept in IndexedDB' });
    // Saved while IndexedDB would not open, or by a tab from before v0.1.24.
    localStorage.setItem(appKey('app-one'), JSON.stringify({ slot: 'left behind' }));
    await nativeAppStorage('outer', app()).reset();
    expect(localStorage.getItem(appKey('app-one'))).toBeNull();
    resetNativeStorageForTests();
    expect(await nativeAppStorage('outer', app()).read()).toEqual({});
  });
});

