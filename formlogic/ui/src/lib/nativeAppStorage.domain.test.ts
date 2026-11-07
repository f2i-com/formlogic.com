// @vitest-environment jsdom
// A SoftN app hosted on its own, then moved to FormLogic on the same domain: what the earlier page
// left in its visitors' browsers (in the domain's own localStorage: its runtime's
// `softn:<id made safe>:<key>` and its XDB store's `xdb:<id>:<collection>` and `xdb:<id>::<name>`) is
// copied into the app's FormLogic map the first time it opens there, under the frame's names.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LARGE_STORAGE_LIMITS, nativeAppStorage, resetNativeStorageForTests, type NativeStorageScope } from './nativeAppStorage';
import { bumpSessionGeneration, setSessionOwner } from './sessionGeneration';

const app = (appId = 'app-one'): NativeStorageScope => ({ access: 'application', appId });
const member = (userId = 'member-a', appId = 'app-one'): NativeStorageScope => ({ access: 'members', appId, userId });
const appKey = (appId: string) => `formlogic:native-app-storage:v1:${appId}`;
// What SoftN's private single-app page (softn-serve) names an app it serves at /index.php with the
// id `outerstead`: `served:/index.php:outerstead`, made safe for the runtime's keys.
const EARLIER = 'softn:served__index_php_outerstead:';
const EARLIER_XDB = 'xdb:served:/index.php:outerstead';
const FRAME = 'softn:native-app-one:';
const earlierSaves = { 'outerstead.firstlight.v1.manual0': '{"game":{"name":"Lantern Reach"}}', 'outerstead.firstlight.v1.latest': 'outerstead.firstlight.v1.manual0', 'outerstead.firstlight.v1.resume': '1' };
const leaveEarlierSaves = (prefix = EARLIER, saves: Record<string, string> = earlierSaves) => { for (const [name, value] of Object.entries(saves)) localStorage.setItem(prefix + name, value); };
const asFrameKeys = (saves: Record<string, string>, frame = FRAME) => Object.fromEntries(Object.entries(saves).map(([name, value]) => [frame + name, value]));
const earlierLeft = () => Object.keys(localStorage).filter(name => name.startsWith(EARLIER) || name.startsWith(EARLIER_XDB)).length;
const open = (scope = app(), domain = true) => nativeAppStorage('outerstead', scope, { domain }).read();

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

describe('on the app’s own domain', () => {
  it('opens on what the earlier page left, under the frame’s names, and leaves the page’s copy where it was', async () => {
    leaveEarlierSaves();
    localStorage.setItem('formlogic:app-look:v1:outerstead', '{}');
    expect(await open()).toEqual(asFrameKeys(earlierSaves));
    expect(JSON.parse((await held(appKey('app-one')))!)).toEqual(asFrameKeys(earlierSaves));
    expect(earlierLeft()).toBe(3);
    expect(localStorage.getItem('formlogic:app-look:v1:outerstead')).toBe('{}');
  });

  it('takes the earlier page’s XDB records and their bookkeeping too, under the frame’s XDB names', async () => {
    leaveEarlierSaves();
    localStorage.setItem(`${EARLIER_XDB}:colonists`, '[{"id":"1"}]');
    localStorage.setItem(`${EARLIER_XDB}::collections`, '["colonists"]');
    expect(await open()).toEqual({
      ...asFrameKeys(earlierSaves),
      'xdb:native-app-one:colonists': '[{"id":"1"}]',
      'xdb:native-app-one::collections': '["colonists"]',
    });
  });

  it('takes an app that kept only XDB records', async () => {
    localStorage.setItem(`${EARLIER_XDB}:notes`, '[]');
    expect(await open()).toEqual({ 'xdb:native-app-one:notes': '[]' });
  });

  it('saves on top of them as on any map, with no other tab’s work to refuse', async () => {
    leaveEarlierSaves();
    const store = nativeAppStorage('outerstead', app(), { domain: true });
    await store.read();
    expect(await store.mutate({ operation: 'set', key: `${FRAME}outerstead.firstlight.v1.manual0`, value: 'newer' })).toEqual({ saved: true });
    expect((await open())[`${FRAME}outerstead.firstlight.v1.manual0`]).toBe('newer');
  });

  it('looks once: a reset of the app’s data does not bring them back', async () => {
    leaveEarlierSaves();
    const store = nativeAppStorage('outerstead', app(), { domain: true });
    await store.read();
    await store.reset();
    expect(await open()).toEqual({});
  });

  it('never replaces a map the app already has, nor brings the earlier saves in after that map is reset', async () => {
    const store = nativeAppStorage('outerstead', app(), { domain: true });
    await store.mutate({ operation: 'set', key: `${FRAME}mine`, value: 'kept' });
    leaveEarlierSaves();
    expect(await open()).toEqual({ [`${FRAME}mine`]: 'kept' });
    await store.reset();
    expect(await open()).toEqual({});
    expect(earlierLeft()).toBe(3);
  });

  it('leaves them for another app connected to the domain later: nothing said the first was the one', async () => {
    leaveEarlierSaves();
    await open();
    expect(await open(app('app-two'))).toEqual(asFrameKeys(earlierSaves, 'softn:native-app-two:'));
  });

  it('gives way to a damaged map an older FormLogic left, and takes them once that map is reset', async () => {
    leaveEarlierSaves();
    localStorage.setItem(appKey('app-one'), '{damaged');
    await expect(open()).rejects.toThrow();
    await nativeAppStorage('outerstead', app(), { domain: true }).reset();
    expect(await open()).toEqual(asFrameKeys(earlierSaves));
  });

  it('takes nothing where two earlier apps left saves: which one this was is not known', async () => {
    leaveEarlierSaves();
    leaveEarlierSaves('softn:single__runtime_config_json_other:', { other: 'x' });
    expect(await open()).toEqual({});
  });

  it('takes nothing where two XDB ids are the same only once made safe', async () => {
    localStorage.setItem('xdb:served:/index.php:outerstead:notes', '[]');
    localStorage.setItem('xdb:served/index.php/outerstead:notes', '[]');
    expect(await open()).toEqual({});
  });

  it('is not misled by the frame’s own names, a preview’s throwaway store or keys that name no app', async () => {
    leaveEarlierSaves();
    localStorage.setItem('softn:native-someone-else:key', 'not an earlier page');
    localStorage.setItem('softn:__softn_preview__abc:key', 'throwaway');
    localStorage.setItem('xdb:__softn_preview__7:notes', '[]');
    localStorage.setItem('softn:first-draw', '{}');
    localStorage.setItem('xdb:legacy', '[]');
    localStorage.setItem('xdb-meta:served:/index.php:outerstead:legacy-migration', 'done');
    expect(await open()).toEqual(asFrameKeys(earlierSaves));
    expect(localStorage.getItem('softn:native-someone-else:key')).toBe('not an earlier page');
  });

  it('takes them whole or not at all: one that would be over a limit leaves the app empty', async () => {
    leaveEarlierSaves();
    localStorage.setItem(`${EARLIER}${'k'.repeat(LARGE_STORAGE_LIMITS.key)}`, 'name too long once renamed');
    expect(await open()).toEqual({});
  });

  it('gives way to a map an older FormLogic left in localStorage, which is this app’s own', async () => {
    leaveEarlierSaves();
    localStorage.setItem(appKey('app-one'), JSON.stringify({ [`${FRAME}older`]: 'formlogic' }));
    expect(await open()).toEqual({ [`${FRAME}older`]: 'formlogic' });
  });

  it('takes them only as the app opens: never on a status check or an export', async () => {
    leaveEarlierSaves();
    const store = nativeAppStorage('outerstead', app(), { domain: true });
    expect(await store.status()).toEqual({ state: 'empty' });
    expect(await store.exportRaw()).toBeNull();
  });
});

describe('anywhere else', () => {
  it('never on FormLogic’s own address, where every app’s and every editor’s keys are mixed', async () => {
    leaveEarlierSaves();
    expect(await open(app(), false)).toEqual({});
    // Nor does looking there count as the look the domain gets.
    expect(await open()).toEqual(asFrameKeys(earlierSaves));
  });

  it('never into a member’s private map: nothing says whose the earlier saves were', async () => {
    leaveEarlierSaves();
    expect(await open(member())).toEqual({});
  });
});

describe('where the browser has no IndexedDB', () => {
  it('takes nothing, and does not count as the look: the next opening with IndexedDB takes them', async () => {
    const working = globalThis.indexedDB;
    // @ts-expect-error A page that could not open it.
    globalThis.indexedDB = undefined;
    resetNativeStorageForTests();
    leaveEarlierSaves(EARLIER, { ...earlierSaves, 'outerstead.firstlight.v1.manual1': 'x'.repeat(200_000) });
    expect(await open()).toEqual({});
    expect(localStorage.getItem('formlogic:native-earlier-site:v1:app-one')).toBeNull();
    globalThis.indexedDB = working;
    resetNativeStorageForTests();
    expect(Object.keys(await open())).toHaveLength(4);
    expect(localStorage.getItem('formlogic:native-earlier-site:v1:app-one')).toBe('1');
  });
});
