// Tests for the Site Chat history store (plan §7 + Phase 6 step 6).
//
// Covers: thread CRUD + activity ordering, message paging (beforeSeq cursor + hasMore),
// seq monotonicity across a reopen (a fresh ChatStore over the same database continues
// from the persisted max), per-user database isolation, and the honest in-memory
// fallback when IndexedDB is unavailable (`persistent` false, chat keeps working).
//
// The IDB code path is driven through a tiny fake implementing exactly the surface the
// store uses (open/upgradeneeded, objectStoreNames, transaction→objectStore,
// put/getAll/delete) with data persisted per database name across open() calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetChatStoresForTests,
  __setChatStoreIndexedDbForTests,
  ChatStore,
  getChatStore,
} from './chatStore';
import { logger } from '../../lib/logger';

// ---------------------------------------------------------------------------
// Fake IndexedDB (persists per database name for reopen tests).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeRequest {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: unknown;
  error: Error | null = null;
}

function settle(result: unknown): FakeRequest {
  const req = new FakeRequest();
  req.result = result;
  queueMicrotask(() => req.onsuccess?.());
  return req;
}

class FakeObjectStore {
  constructor(private readonly rows: Map<string, Row>) {}
  put(value: Row): FakeRequest {
    this.rows.set(String(value.id), JSON.parse(JSON.stringify(value)) as Row);
    return settle(undefined);
  }
  getAll(): FakeRequest {
    return settle([...this.rows.values()].map((row) => ({ ...row })));
  }
  delete(key: string): FakeRequest {
    this.rows.delete(key);
    return settle(undefined);
  }
}

class FakeDb {
  private readonly stores = new Map<string, Map<string, Row>>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): FakeObjectStore {
    this.stores.set(name, new Map());
    return new FakeObjectStore(this.stores.get(name)!);
  }
  transaction(name: string): { objectStore: (n: string) => FakeObjectStore } {
    const rows = this.stores.get(name);
    if (!rows) throw new Error(`no object store ${name}`);
    return { objectStore: () => new FakeObjectStore(rows) };
  }
}

class FakeIdbFactory {
  readonly dbs = new Map<string, FakeDb>();
  readonly openCalls: string[] = [];
  failOpen = false;
  open(name: string): FakeRequest {
    this.openCalls.push(name);
    if (this.failOpen) throw new Error('IndexedDB disabled');
    let db = this.dbs.get(name);
    const isNew = !db;
    if (!db) {
      db = new FakeDb();
      this.dbs.set(name, db);
    }
    const req = new FakeRequest() as FakeRequest & { onupgradeneeded: (() => void) | null; onblocked: (() => void) | null };
    req.result = db;
    queueMicrotask(() => {
      if (isNew) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }
}

let factory: FakeIdbFactory;

beforeEach(() => {
  __resetChatStoresForTests();
  factory = new FakeIdbFactory();
  __setChatStoreIndexedDbForTests(factory as unknown as IDBFactory);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  __resetChatStoresForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Threads.
// ---------------------------------------------------------------------------

describe('threads', () => {
  it('creates, lists (most recently active first), renames, and deletes threads', async () => {
    const store = getChatStore('u1');
    const t1 = await store.createThread('First', 1_000);
    const t2 = await store.createThread('Second', 2_000);
    expect((await store.listThreads()).map((t) => t.id)).toEqual([t2.id, t1.id]);

    // Appending to the older thread bumps its activity stamp above the newer one.
    await store.appendMessage(t1.id, 'user', 'hello again', 3_000);
    expect((await store.listThreads()).map((t) => t.id)).toEqual([t1.id, t2.id]);

    await store.renameThread(t1.id, 'Renamed');
    expect((await store.listThreads()).find((t) => t.id === t1.id)?.title).toBe('Renamed');

    await store.deleteThread(t1.id);
    expect((await store.listThreads()).map((t) => t.id)).toEqual([t2.id]);
    // The thread's messages are gone with it.
    expect((await store.listMessages(t1.id)).messages).toEqual([]);
  });

  it('renaming an unknown thread is a no-op and appending to a deleted thread still stores the message', async () => {
    const store = getChatStore('u1');
    await store.renameThread('missing', 'x'); // must not throw
    const message = await store.appendMessage('missing-thread', 'assistant', 'orphan ok');
    expect(message.seq).toBe(1);
    expect((await store.listMessages('missing-thread')).messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Messages + paging.
// ---------------------------------------------------------------------------

describe('message paging', () => {
  it('pages newest-first with a beforeSeq cursor, oldest-first within each page', async () => {
    const store = getChatStore('u1');
    const thread = await store.createThread();
    for (let i = 1; i <= 5; i += 1) {
      await store.appendMessage(thread.id, i % 2 === 1 ? 'user' : 'assistant', `m${i}`, 1_000 + i);
    }

    const page1 = await store.listMessages(thread.id, { limit: 2 });
    expect(page1.messages.map((m) => m.content)).toEqual(['m4', 'm5']);
    expect(page1.hasMore).toBe(true);

    const page2 = await store.listMessages(thread.id, { limit: 2, beforeSeq: page1.messages[0].seq });
    expect(page2.messages.map((m) => m.content)).toEqual(['m2', 'm3']);
    expect(page2.hasMore).toBe(true);

    const page3 = await store.listMessages(thread.id, { limit: 2, beforeSeq: page2.messages[0].seq });
    expect(page3.messages.map((m) => m.content)).toEqual(['m1']);
    expect(page3.hasMore).toBe(false);
  });

  it('orders by seq even when createdAt timestamps collide', async () => {
    const store = getChatStore('u1');
    const thread = await store.createThread();
    await store.appendMessage(thread.id, 'user', 'first', 5_000);
    await store.appendMessage(thread.id, 'assistant', 'second', 5_000); // same millisecond
    const { messages } = await store.listMessages(thread.id);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
    expect(messages[1].seq).toBeGreaterThan(messages[0].seq);
  });

  it('keeps seq monotonic across a store reopen (continues from the persisted max)', async () => {
    const first = getChatStore('u1');
    const thread = await first.createThread();
    for (let i = 0; i < 3; i += 1) await first.appendMessage(thread.id, 'user', `m${i}`);
    expect((await first.listMessages(thread.id)).messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    // "Reopen": a fresh ChatStore over the SAME fake database (new page load).
    __resetChatStoresForTests();
    __setChatStoreIndexedDbForTests(factory as unknown as IDBFactory);
    const reopened = getChatStore('u1');
    expect(reopened).not.toBe(first);
    const next = await reopened.appendMessage(thread.id, 'assistant', 'after reopen');
    expect(next.seq).toBe(4);
    expect((await reopened.listMessages(thread.id)).messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Per-user isolation + store cache.
// ---------------------------------------------------------------------------

describe('per-user stores', () => {
  it('opens one database per user and never mixes their threads', async () => {
    const a = getChatStore('user-a');
    const b = getChatStore('user-b');
    await a.createThread('A thread');
    await b.createThread('B thread');

    expect(factory.openCalls).toEqual(['formlogic-chat:user-a', 'formlogic-chat:user-b']);
    expect((await a.listThreads()).map((t) => t.title)).toEqual(['A thread']);
    expect((await b.listThreads()).map((t) => t.title)).toEqual(['B thread']);
  });

  it('returns the same instance for the same user id', () => {
    expect(getChatStore('u1')).toBe(getChatStore('u1'));
    expect(getChatStore('u1')).not.toBe(getChatStore('u2'));
  });
});

// ---------------------------------------------------------------------------
// IndexedDB-unavailable fallback.
// ---------------------------------------------------------------------------

describe('in-memory fallback', () => {
  it('falls back to memory when no IndexedDB factory exists (persistent=false, chat still works)', async () => {
    __setChatStoreIndexedDbForTests(null);
    const store = new ChatStore('u1');
    const thread = await store.createThread('Ephemeral');
    await store.appendMessage(thread.id, 'user', 'hi');

    expect(store.persistent).toBe(false);
    expect((await store.listMessages(thread.id)).messages.map((m) => m.content)).toEqual(['hi']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to memory when the factory open() throws', async () => {
    factory.failOpen = true;
    const store = new ChatStore('u1');
    await store.createThread('Still works');
    expect(store.persistent).toBe(false);
    expect((await store.listThreads()).map((t) => t.title)).toEqual(['Still works']);
  });
});
