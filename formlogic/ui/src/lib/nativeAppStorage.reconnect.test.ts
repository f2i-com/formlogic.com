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

it('does not ask again for what a new connection would not cure', async () => {
  const store = nativeAppStorage('outerstead', scope);
  await store.read();
  const refused = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('no such store', 'NotFoundError'); });
  await expect(store.mutate({ operation: 'set', key: 'slot', value: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
  expect(refused).toHaveBeenCalledTimes(1);
});
