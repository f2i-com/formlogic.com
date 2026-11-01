import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// "Saved on this device. You can close the app." has to mean it. On a nearly full disk the request
// can succeed and the transaction abort when it commits, and a queue that settled on the request
// told the form its submission was safe when nothing had been stored.
vi.mock('../lib/api', () => ({ api: { createAppResponseResult: vi.fn() }, newIdempotencyKey: () => 'key' }));
vi.mock('../lib/sessionGeneration', () => ({ currentSessionOwner: () => 'u1' }));

import { enqueueSubmission, listQueue } from './offlineQueue';

interface FakeTransaction {
  objectStore: () => unknown;
  oncomplete: null | (() => void);
  onabort: null | (() => void);
  error: Error | null;
}

/** A store where the test decides how each transaction ends. */
function indexedDbEndingWith(end: (transaction: FakeTransaction, rollBack: () => void) => void): { factory: IDBFactory; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  const request = (result: unknown) => {
    const req = { result: undefined as unknown, error: null, onsuccess: null as null | (() => void), onerror: null };
    queueMicrotask(() => { req.result = result; req.onsuccess?.(); });
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const written: string[] = [];
      const store = {
        put: (row: { id: string }) => { rows.set(row.id, structuredClone(row)); written.push(row.id); return request(row.id); },
        getAll: () => request([...rows.values()]),
      };
      const transaction: FakeTransaction = { objectStore: () => store, oncomplete: null, onabort: null, error: null };
      setTimeout(() => end(transaction, () => written.forEach((id) => rows.delete(id))));
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const req = { result: db, error: null, onsuccess: null as null | (() => void), onerror: null, onupgradeneeded: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, rows };
}

const submission = { appSlug: 'shop', formId: 'orders', answers: { item: 'tea' } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enqueueSubmission and the commit', () => {
  let commit: (() => void) | null = null;

  beforeEach(() => {
    commit = null;
  });

  it('rejects when the transaction aborts after the request succeeded', async () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    const { factory, rows } = indexedDbEndingWith((transaction, rollBack) => {
      rollBack();
      transaction.error = quota;
      transaction.onabort?.();
    });
    vi.stubGlobal('indexedDB', factory);

    await expect(enqueueSubmission(submission)).rejects.toBe(quota);
    expect(rows.size).toBe(0);
  });

  it('says something even when the browser gives no reason for the abort', async () => {
    const { factory } = indexedDbEndingWith((transaction) => transaction.onabort?.());
    vi.stubGlobal('indexedDB', factory);

    await expect(enqueueSubmission(submission)).rejects.toThrow('This could not be saved on this device.');
  });

  it('resolves only once the transaction has committed', async () => {
    const { factory } = indexedDbEndingWith((transaction) => { commit = () => transaction.oncomplete?.(); });
    vi.stubGlobal('indexedDB', factory);
    let resolved = false;

    const queued = enqueueSubmission(submission).then((row) => { resolved = true; return row; });
    await vi.waitFor(() => expect(commit).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    commit!();
    expect((await queued).status).toBe('pending');
  });

  it('keeps what committed', async () => {
    const { factory } = indexedDbEndingWith((transaction) => transaction.oncomplete?.());
    vi.stubGlobal('indexedDB', factory);

    await enqueueSubmission(submission);

    expect((await listQueue()).map((row) => row.answers)).toEqual([{ item: 'tea' }]);
  });
});
