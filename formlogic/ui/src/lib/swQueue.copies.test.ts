// The requests Workbox's background-sync plugin keeps (vite.config.ts) are the only copy of a
// public form's queued submission, and a second copy of an app submit that never reached the
// server. A page has to be able to find one by its idempotency key and remove it, or a submission
// the person discarded is still sent, and answers they asked to remove stay on the device.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discardBackgroundSyncCopies, hasBackgroundSyncCopy } from './swQueue';

interface Entry { id: number; queueName: string; requestData: { url: string; body?: ArrayBuffer } }

/** Workbox's database ('workbox-background-sync', store 'requests', index 'queueName'), in memory. */
function workboxIndexedDB(entries: Entry[] | null) {
  const opened: string[] = [];
  const factory = {
    open: (name: string) => {
      opened.push(name);
      const req: Record<string, unknown> = { result: undefined, error: null, transaction: { abort: vi.fn() } };
      queueMicrotask(() => {
        if (entries === null || name !== 'workbox-background-sync') {
          (req.onupgradeneeded as (() => void) | undefined)?.();
          return;
        }
        const db = {
          objectStoreNames: { contains: (s: string) => s === 'requests' },
          close: () => {},
          transaction: () => {
            const tx: Record<string, unknown> = {};
            const store = {
              index: () => ({
                openCursor: (range: { only: string }) => {
                  const cursorReq: Record<string, unknown> = { result: null };
                  const matching = entries.filter((e) => e.queueName === range.only);
                  let i = 0;
                  const step = () => queueMicrotask(() => {
                    const entry = matching[i];
                    if (!entry) {
                      cursorReq.result = null;
                      (cursorReq.onsuccess as () => void)();
                      queueMicrotask(() => (tx.oncomplete as () => void)?.());
                      return;
                    }
                    cursorReq.result = {
                      value: structuredClone(entry),
                      delete: () => { entries.splice(entries.indexOf(entry), 1); },
                      continue: () => { i++; step(); },
                    };
                    (cursorReq.onsuccess as () => void)();
                  });
                  step();
                  return cursorReq;
                },
              }),
            };
            tx.objectStore = () => store;
            return tx;
          },
        };
        req.result = db;
        (req.onsuccess as () => void)();
      });
      return req;
    },
  };
  return { factory, opened };
}

const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Workbox copies of a queued submission', () => {
  it('are found and removed by the idempotency key in their body, and only in their own queue', async () => {
    const entries: Entry[] = [
      { id: 1, queueName: 'publicFormSubmissionQueue', requestData: { url: '/api/forms/f/responses', body: body({ envelope: { ct: 'x' }, idempotencyKey: 'k1' }) } },
      { id: 2, queueName: 'publicFormSubmissionQueue', requestData: { url: '/api/forms/f/responses', body: body({ answers: {}, idempotencyKey: 'k2' }) } },
      { id: 3, queueName: 'formSubmissionQueue', requestData: { url: '/api/app/s/forms/f/responses', body: body({ answers: {}, idempotencyKey: 'k1' }) } },
      { id: 4, queueName: 'publicFormSubmissionQueue', requestData: { url: '/api/forms/f/responses' } },
    ];
    vi.stubGlobal('indexedDB', workboxIndexedDB(entries).factory);
    vi.stubGlobal('IDBKeyRange', { only: (v: string) => ({ only: v }) });

    expect(await hasBackgroundSyncCopy('publicFormSubmissionQueue', 'k1')).toBe(true);
    expect(entries).toHaveLength(4);
    expect(await discardBackgroundSyncCopies('publicFormSubmissionQueue', 'k1')).toBe(1);
    expect(entries.map((e) => e.id)).toEqual([2, 3, 4]);
    expect(await hasBackgroundSyncCopy('publicFormSubmissionQueue', 'k1')).toBe(false);
  });

  it('are reported absent, without creating the database, where Workbox never queued anything', async () => {
    const { factory } = workboxIndexedDB(null);
    vi.stubGlobal('indexedDB', factory);
    vi.stubGlobal('IDBKeyRange', { only: (v: string) => ({ only: v }) });
    expect(await hasBackgroundSyncCopy('publicFormSubmissionQueue', 'k1')).toBe(false);
    expect(await discardBackgroundSyncCopies('publicFormSubmissionQueue', 'k1')).toBe(0);
  });

  it('are reported absent where there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await hasBackgroundSyncCopy('publicFormSubmissionQueue', 'k1')).toBe(false);
  });
});

describe('the bodies the submit paths send', () => {
  // Workbox queues the request body as it was sent, so a copy is found only if each path sends JSON
  // with the idempotency key at its top level: the public form (plain), and the app form whose
  // failed POST leaves a copy beside the offline queue's own row.
  it.each([
    ['a public form', (api: typeof import('./api').api) => api.submitResponse('f1', { answers: { q: 'a' }, completionTime: 5, idempotencyKey: 'key-1' })],
    ['an app form', (api: typeof import('./api').api) => api.createAppResponse('shop', 'orders', { answers: { q: 'a' }, idempotencyKey: 'key-1' })],
  ])('carry the key where a queued copy of %s is found by it', async (_name, submit) => {
    const { api } = await import('./api');
    const sent: string[] = [];
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      throw new TypeError('Failed to fetch');
    }));
    await submit(api);
    expect(sent).toHaveLength(1);
    const entries: Entry[] = [{ id: 1, queueName: 'q', requestData: { url: '/x', body: new TextEncoder().encode(sent[0]).buffer as ArrayBuffer } }];
    vi.stubGlobal('indexedDB', workboxIndexedDB(entries).factory);
    vi.stubGlobal('IDBKeyRange', { only: (v: string) => ({ only: v }) });
    expect(await hasBackgroundSyncCopy('q', 'key-1')).toBe(true);
  });
});

describe('what a private form leaves in that queue', () => {
  // Workbox stores the request body as sent. For a private (end-to-end encrypted) form that body
  // is the sealed envelope and the idempotency key, nothing else: the answers are inside the
  // envelope's ciphertext (privateForms.integration.test.ts holds that no answer appears in it).
  it('is the sealed envelope and its key only', async () => {
    const { api } = await import('./api');
    const sent: string[] = [];
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      throw new TypeError('Failed to fetch');
    }));
    const envelope = { __flenc: 1, recordId: 'r', rev: 1, keyId: 'k', epoch: 1, content: 'c', wrap: 'w', schemaVersion: 1, schemaHash: 'h', wrappedDek: 'd', nonce: 'n', ct: 'ciphertext' };
    const result = await api.submitEncryptedResponse('f1', envelope as never, 'key-1');
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ envelope, idempotencyKey: 'key-1' });
  });
});
