// Site Chat history store (plan docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §7 + Phase 6
// step 6): chat history is CLIENT-SIDE ONLY in v1 — IndexedDB `formlogic-chat:<userId>`,
// no server-side transcripts. One database per signed-in user so an account switch never
// shows another user's threads.
//
// Honest degradation: IndexedDB can be unavailable (private windows, storage-blocked
// embeds, quota errors). Any failure at open or first use falls back to an in-memory
// store for the session with ONE console note — chat keeps working, history just does
// not persist. `persistent` exposes which mode the store landed in.
//
// Schema v1: object stores `threads` + `messages` (both keyPath 'id'). Reads use
// getAll() + in-memory filtering — chat-scale data (hundreds of rows) does not justify
// cursor/index plumbing, and it keeps the fake-IDB test seam tiny.
import { logger } from '../../lib/logger';
import { generateId } from '../../lib/utils';

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type ChatMessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: number;
  /** Monotonic per store — stable ordering when two messages share a millisecond. */
  seq: number;
}

export interface ChatMessagePage {
  /** Oldest-first. */
  messages: ChatMessage[];
  /** True when older messages exist beyond this page (page again with beforeSeq). */
  hasMore: boolean;
}

const DB_PREFIX = 'formlogic-chat:';
const DB_VERSION = 1;
export const DEFAULT_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Backend seam — the IndexedDB factory is injectable so tests can drive the real
// IDB code path with a fake (node has no IndexedDB, jsdom does not implement it).
// ---------------------------------------------------------------------------

type IdbFactorySource = () => IDBFactory | null;

let idbFactoryForTests: IDBFactory | null | undefined;

/** Test-only: force the IndexedDB factory (undefined restores auto-detection). */
export function __setChatStoreIndexedDbForTests(factory: IDBFactory | null | undefined): void {
  idbFactoryForTests = factory;
}

const defaultIdbFactory: IdbFactorySource = () => {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
};

function activeIdbFactory(): IDBFactory | null {
  if (idbFactoryForTests !== undefined) return idbFactoryForTests;
  return defaultIdbFactory();
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(factory: IDBFactory, userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(`${DB_PREFIX}${userId}`, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

// ---------------------------------------------------------------------------
// Backends — identical raw surfaces; ChatStore owns the semantics.
// ---------------------------------------------------------------------------

interface Backend {
  readonly persistent: boolean;
  putThread(thread: ChatThread): Promise<void>;
  allThreads(): Promise<ChatThread[]>;
  deleteThread(threadId: string): Promise<void>;
  putMessage(message: ChatMessage): Promise<void>;
  allMessages(): Promise<ChatMessage[]>;
  deleteMessagesForThread(threadId: string): Promise<void>;
}

class IdbBackend implements Backend {
  readonly persistent = true;
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  private store(name: 'threads' | 'messages', mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async putThread(thread: ChatThread): Promise<void> {
    await requestToPromise(this.store('threads', 'readwrite').put(thread));
  }

  async allThreads(): Promise<ChatThread[]> {
    return (await requestToPromise(this.store('threads', 'readonly').getAll())) as ChatThread[];
  }

  async deleteThread(threadId: string): Promise<void> {
    await requestToPromise(this.store('threads', 'readwrite').delete(threadId));
  }

  async putMessage(message: ChatMessage): Promise<void> {
    await requestToPromise(this.store('messages', 'readwrite').put(message));
  }

  async allMessages(): Promise<ChatMessage[]> {
    return (await requestToPromise(this.store('messages', 'readonly').getAll())) as ChatMessage[];
  }

  async deleteMessagesForThread(threadId: string): Promise<void> {
    const doomed = (await this.allMessages()).filter((m) => m.threadId === threadId);
    for (const message of doomed) {
      await requestToPromise(this.store('messages', 'readwrite').delete(message.id));
    }
  }
}

class MemoryBackend implements Backend {
  readonly persistent = false;
  private readonly threads = new Map<string, ChatThread>();
  private readonly messages = new Map<string, ChatMessage>();

  async putThread(thread: ChatThread): Promise<void> {
    this.threads.set(thread.id, { ...thread });
  }

  async allThreads(): Promise<ChatThread[]> {
    return [...this.threads.values()].map((t) => ({ ...t }));
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async putMessage(message: ChatMessage): Promise<void> {
    this.messages.set(message.id, { ...message });
  }

  async allMessages(): Promise<ChatMessage[]> {
    return [...this.messages.values()].map((m) => ({ ...m }));
  }

  async deleteMessagesForThread(threadId: string): Promise<void> {
    for (const message of this.messages.values()) {
      if (message.threadId === threadId) this.messages.delete(message.id);
    }
  }
}

// ---------------------------------------------------------------------------
// ChatStore — one per signed-in user.
// ---------------------------------------------------------------------------

export class ChatStore {
  readonly userId: string;
  private backend: Backend | null = null;
  private initPromise: Promise<Backend> | null = null;
  private seq = 0;

  constructor(userId: string) {
    this.userId = userId;
  }

  /** True once the store settled on IndexedDB; false for the in-memory fallback. */
  get persistent(): boolean {
    return this.backend?.persistent ?? true;
  }

  private ready(): Promise<Backend> {
    if (this.backend) return Promise.resolve(this.backend);
    if (!this.initPromise) {
      this.initPromise = this.open();
    }
    return this.initPromise;
  }

  private async open(): Promise<Backend> {
    const factory = activeIdbFactory();
    if (factory) {
      try {
        const backend = new IdbBackend(await openDatabase(factory, this.userId));
        this.backend = backend;
        return backend;
      } catch (e) {
        logger.warn('[chat-store] IndexedDB unavailable — chat history stays in memory for this session only.', e);
      }
    } else {
      logger.warn('[chat-store] IndexedDB unavailable — chat history stays in memory for this session only.');
    }
    this.backend = new MemoryBackend();
    return this.backend;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Initialize the seq counter from persisted messages (callers never await this directly). */
  private async primeSeq(backend: Backend): Promise<void> {
    if (this.seq > 0) return;
    const messages = await backend.allMessages();
    for (const message of messages) {
      if (typeof message.seq === 'number' && message.seq > this.seq) this.seq = message.seq;
    }
  }

  async listThreads(): Promise<ChatThread[]> {
    const backend = await this.ready();
    const threads = await backend.allThreads();
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createThread(title = 'New chat', now = Date.now()): Promise<ChatThread> {
    const backend = await this.ready();
    const thread: ChatThread = { id: generateId(), title, createdAt: now, updatedAt: now };
    await backend.putThread(thread);
    return thread;
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const backend = await this.ready();
    const threads = await backend.allThreads();
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    await backend.putThread({ ...thread, title });
  }

  async deleteThread(threadId: string): Promise<void> {
    const backend = await this.ready();
    await backend.deleteMessagesForThread(threadId);
    await backend.deleteThread(threadId);
  }

  async appendMessage(
    threadId: string,
    role: ChatMessageRole,
    content: string,
    now = Date.now()
  ): Promise<ChatMessage> {
    const backend = await this.ready();
    await this.primeSeq(backend);
    const message: ChatMessage = {
      id: generateId(),
      threadId,
      role,
      content,
      createdAt: now,
      seq: this.nextSeq(),
    };
    await backend.putMessage(message);
    // Bump the thread's activity stamp so the list re-sorts; tolerate a missing thread
    // (a message must never fail because its thread row is gone).
    const threads = await backend.allThreads();
    const thread = threads.find((t) => t.id === threadId);
    if (thread) await backend.putThread({ ...thread, updatedAt: now });
    return message;
  }

  /**
   * Oldest-first paging (plan Phase 6: history loads newest page first, older pages on
   * demand): without a cursor the NEWEST `limit` messages are returned (oldest-first
   * within the page); pass the oldest seen `beforeSeq` to page backwards.
   */
  async listMessages(
    threadId: string,
    options: { limit?: number; beforeSeq?: number } = {}
  ): Promise<ChatMessagePage> {
    const backend = await this.ready();
    const limit = Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE);
    const all = (await backend.allMessages())
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => (a.seq - b.seq) || (a.createdAt - b.createdAt));
    const eligible = options.beforeSeq === undefined ? all : all.filter((m) => m.seq < (options.beforeSeq as number));
    const page = eligible.slice(-limit);
    return { messages: page, hasMore: eligible.length > page.length };
  }
}

// ---------------------------------------------------------------------------
// Per-user store cache.
// ---------------------------------------------------------------------------

const stores = new Map<string, ChatStore>();

/** The chat store for one signed-in user (created lazily, shared per user id). */
export function getChatStore(userId: string): ChatStore {
  let store = stores.get(userId);
  if (!store) {
    store = new ChatStore(userId);
    stores.set(userId, store);
  }
  return store;
}

/** Test-only: drop the per-user cache AND the injected factory. */
export function __resetChatStoresForTests(): void {
  stores.clear();
  idbFactoryForTests = undefined;
}
