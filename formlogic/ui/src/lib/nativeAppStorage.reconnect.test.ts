// @vitest-environment jsdom
// A connection the browser closes under the page (iOS Safari, after a while in the background):
// the save in hand is made on a connection opened again, and so is every one after it. Each save
// after it used to fail until the page was reloaded.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeStorageError, nativeAppStorage, resetNativeStorageForTests } from './nativeAppStorage';
import { bumpSessionGeneration, setSessionOwner } from './sessionGeneration';

const scope = { access: 'application' as const, appId: 'app-one' };

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetNativeStorageForTests();
  localStorage.clear();
  setSessionOwner('member-a');
  bumpSessionGeneration();
});
afterEach(() => { vi.restoreAllMocks(); setSessionOwner(null); resetNativeStorageForTests(); });

it('makes the save on a connection opened again, and keeps saving', async () => {
  const store = nativeAppStorage('outerstead', scope);
  await store.mutate({ operation: 'set', key: 'slot', value: 'before' });
  const lost = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => { throw new DOMException('The database connection is closing.', 'InvalidStateError'); });
  expect(await store.mutate({ operation: 'set', key: 'slot', value: 'after' })).toEqual({ saved: true });
  expect(lost).toHaveBeenCalledTimes(2);
  expect(await store.mutate({ operation: 'set', key: 'other', value: 'later' })).toEqual({ saved: true });
  expect(await nativeAppStorage('outerstead', scope).read()).toEqual({ slot: 'after', other: 'later' });
});

it('asks again once, and says what the browser said when the second connection fails too', async () => {
  const store = nativeAppStorage('outerstead', scope);
  await store.read();
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('closed', 'InvalidStateError'); });
  const failed = store.mutate({ operation: 'set', key: 'slot', value: 'x' });
  await expect(failed).rejects.toBeInstanceOf(NativeStorageError);
  await expect(failed).rejects.toMatchObject({ code: 'unavailable' });
});

it('never moves to another store when the database will not open again: the save says so, and the next opens it', async () => {
  const store = nativeAppStorage('outerstead', scope);
  await store.mutate({ operation: 'set', key: 'slot', value: 'before' });
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => { throw new DOMException('The database connection is closing.', 'InvalidStateError'); });
  vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw new DOMException('Connection to Indexed Database server lost', 'UnknownError'); });
  // Told as storage that is not there, as before the store was opened again: not another tab's work.
  await expect(store.mutate({ operation: 'set', key: 'slot', value: 'lost' })).rejects.toMatchObject({ code: 'unavailable' });
  // The next save opens the database again, and the map is the one it always was.
  expect(await store.mutate({ operation: 'set', key: 'slot', value: 'after' })).toEqual({ saved: true });
  resetNativeStorageForTests();
  expect(await nativeAppStorage('outerstead', scope).read()).toEqual({ slot: 'after' });
  expect(localStorage.length).toBe(0);
});

it('gives up on a database that does not answer when opened again, rather than hold every save', async () => {
  resetNativeStorageForTests({ reopenTimeoutMs: 50 });
  const store = nativeAppStorage('outerstead', scope);
  await store.read();
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => { throw new DOMException('closed', 'InvalidStateError'); });
  // A request that never answers.
  vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => ({}) as IDBOpenDBRequest);
  await expect(store.mutate({ operation: 'set', key: 'slot', value: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  expect(await store.mutate({ operation: 'set', key: 'slot', value: 'y' })).toEqual({ saved: true });
});

it('does not ask again for what a new connection would not cure', async () => {
  const store = nativeAppStorage('outerstead', scope);
  await store.read();
  const refused = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('no such store', 'NotFoundError'); });
  await expect(store.mutate({ operation: 'set', key: 'slot', value: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  expect(refused).toHaveBeenCalledTimes(1);
});
