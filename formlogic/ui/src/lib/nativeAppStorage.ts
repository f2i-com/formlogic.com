// The parent owns persistence; an isolated app receives only its own bounded snapshot.
//
// Audit FL-S07: a stored map is either whole and readable or it is not. A
// map that parses but carries an entry this helper would never have written
// (a key over 256 characters, a value that is not a string, a value over the
// per-key limit) is treated as damaged: reads refuse it, ordinary writes
// refuse to touch it, and the original bytes stay where they are until the
// owner exports or resets them. Filtering the bad entries out and writing the
// rest back would have destroyed the only copy of whatever went wrong.
//
// Where it is kept: IndexedDB, one record per app (and per member), so an app
// may keep what a game's saved state needs — megabytes, where WebStorage gives
// the whole site about five. A browser without IndexedDB (or that refuses to
// open it) keeps the map in localStorage under the limits it always had, and
// the frame is told those. A map kept in localStorage by a FormLogic before
// v0.1.24 moves to IndexedDB the first time its app opens: written there
// first, and removed from localStorage only once that write has committed.
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent } from './sessionGeneration';

/** What a map may hold, in UTF-16 units as `JSON.stringify` counts them. */
export interface NativeStorageLimits {
  /** The whole map's JSON. */
  map: number;
  key: number;
  value: number;
  entries: number;
  /** One save as the frame sends it (its JSON), which also bounds the port message. */
  input: number;
  /** Saves the frame may hold waiting at once. */
  queued: number;
}
/** localStorage's, as they always were. */
export const SMALL_STORAGE_LIMITS: NativeStorageLimits = Object.freeze({ map: 256 * 1024, key: 256, value: 30000, entries: 200, input: 32768, queued: 256 * 1024 });
/** IndexedDB's: a save of a few megabytes, and room for a game's slots. Within SoftN's frame maxima. */
export const LARGE_STORAGE_LIMITS: NativeStorageLimits = Object.freeze({ map: 32 * 1024 * 1024, key: 256, value: 4 * 1024 * 1024, entries: 1000, input: 8 * 1024 * 1024 + 4096, queued: 32 * 1024 * 1024 });
// SoftN names an app's keys after the id the frame gives it.
const APP_KEY = /^(xdb|softn):native-([a-zA-Z0-9_-]*):/;
const MEMBER_PREFIX = 'formlogic:native-member-storage:v1:';
// By app id, because a slug is reusable: rename an app and another can claim its
// old slug, and it was then handed what a visitor had saved in the first. A prefix
// of its own, so no slug can name a key here (see adoptSlugMap).
const APPLICATION_PREFIX = 'formlogic:native-app-storage:v1:';
const DATABASE = 'formlogic-native-storage';
const STORE = 'maps';
const pendingMemberPurges = new Map<string, Promise<boolean>>();

/** Returned only after the server has admitted the request to this installation. */
export type NativeStorageScope =
  | { access: 'members'; appId: string; userId: string }
  | { access: 'application'; appId: string };

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function isNativeStorageScope(value: unknown): value is NativeStorageScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return validIdentity(scope.appId) && (scope.access === 'application'
    || (scope.access === 'members' && validIdentity(scope.userId)));
}

/**
 * The id a frame is given, which names the keys inside a map. By app id, as the map itself is:
 * by slug, a renamed app found none of its keys and opened empty, and added its seeds again.
 */
export const nativeFrameAppId = (appId: string) => `native-${appId}`;

/**
 * Moves keys named after a slug to the id, the current slug's first, so an older name never
 * replaces what is already there. Anything that cannot move stays as it is, unread but not lost.
 */
function adoptKeyNames(saved: Record<string, string>, slug: string, appId: string, keyLimit: number): Record<string, string> | null {
  const entries = Object.entries(saved).filter(([name]) => { const match = APP_KEY.exec(name); return match && match[2] !== appId; });
  if (entries.length === 0) return null;
  const adopted = new Map(Object.entries(saved));
  const ofThisSlug = ([name]: [string, string]) => APP_KEY.exec(name)?.[2] === slug ? 0 : 1;
  for (const [name, value] of entries.sort((a, b) => ofThisSlug(a) - ofThisSlug(b))) {
    const moved = name.replace(APP_KEY, (_all, store) => `${store}:${nativeFrameAppId(appId)}:`);
    if (adopted.has(moved) || moved.length > keyLimit) continue;
    adopted.delete(name);
    adopted.set(moved, value);
  }
  return Object.fromEntries(adopted);
}

/**
 * SoftN's names for an app's keys in a page's own localStorage, when the app IS the page: its
 * runtime's `softn:<id>:<key>`, the id with anything but letters, digits, `_` and `-` made `_`
 * (core's storage bridges), and its XDB store's `xdb:<id>:<collection>` and `xdb:<id>::<name>`, the
 * id as it is (core's xdb-registry and xdb-service). What an app hosted on its own, as SoftN's
 * single-app pages host one, left in its visitors' browsers.
 */
const SCRIPT_KEY = /^softn:([a-zA-Z0-9_-]+):/;
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
/** The frame's own ids, and SoftN's for a preview's throwaway store: never an earlier site's app. */
const NOT_A_SITE_APP = /^(native-|__softn_preview__)/;
/** Each app's mark that it has looked at what an earlier page left, once per browser (earlierSiteMap). */
const EARLIER_SITE_PREFIX = 'formlogic:native-earlier-site:v1:';

/** An XDB key's app id and what follows it (`:<collection>` or `::<name>`), or null for one no app owns. */
function xdbKey(name: string): { id: string; rest: string } | null {
  if (!name.startsWith('xdb:')) return null;
  const body = name.slice(4);
  // A collection's name never has a colon in it; an app id may (`served:/index.php:outerstead`).
  const meta = body.indexOf('::');
  const cut = meta > 0 ? meta : body.lastIndexOf(':');
  // A bare `xdb:<collection>` is from before XDB kept apps apart: it names no app.
  return cut > 0 ? { id: body.slice(0, cut), rest: body.slice(cut) } : null;
}

/**
 * What the site's earlier SoftN page left in this browser for its app, under the names the frame
 * gives the app (`softn:native-<app id>:`, `xdb:native-<app id>:`), so a game hosted on its own
 * domain, then moved to FormLogic on the same domain, opens on its players' saves. Null where there
 * is nothing of an earlier app's here at all; otherwise `site` is the map to take, or null where it
 * cannot be taken: two earlier apps (which one this was is not ours to guess), or a key over a limit
 * here (whole or not at all, rather than an app opening on half a save).
 *
 * Only where the page IS the app's own domain (one app per origin) and its map is shared by everyone
 * in this browser (application scope): on the platform's origin every app's keys are mixed, and no
 * earlier save says which member it was. Copied, never moved: nothing says this app is the one the
 * page served, so a different app connected first must not take the only copy. Each app looks once
 * per browser (EARLIER_SITE_PREFIX), so a reset of its data does not bring them back.
 */
function earlierSiteMap(appId: string, limits: NativeStorageLimits): { site: EarlierSite | null } | null {
  const frame = nativeFrameAppId(appId);
  const groups = new Map<string, { keys: [string, string][]; xdbIds: Set<string> }>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name) continue;
      let id: string | null = null;
      let renamed = '';
      let xdbId: string | null = null;
      const script = SCRIPT_KEY.exec(name);
      const xdb = script ? null : xdbKey(name);
      if (script) { id = script[1]; renamed = `softn:${safeId(frame)}:${name.slice(script[0].length)}`; }
      else if (xdb) { id = safeId(xdb.id); xdbId = xdb.id; renamed = `xdb:${frame}${xdb.rest}`; }
      if (id === null || NOT_A_SITE_APP.test(id)) continue;
      let group = groups.get(id);
      if (!group) groups.set(id, group = { keys: [], xdbIds: new Set() });
      group.keys.push([name, renamed]);
      if (xdbId !== null) group.xdbIds.add(xdbId);
    }
    if (groups.size === 0) return null;
    const [group] = groups.values();
    // Two apps, or two whose ids are the same only once made safe.
    if (groups.size !== 1 || group.xdbIds.size > 1 || group.keys.length > limits.entries) return { site: null };
    const map: Record<string, string> = {};
    for (const [name, renamed] of group.keys) {
      const value = localStorage.getItem(name);
      if (value === null || renamed.length > limits.key || value.length > limits.value) return { site: null };
      map[renamed] = value;
    }
    const raw = JSON.stringify(map);
    return { site: raw.length <= limits.map ? { raw } : null };
  } catch {
    return null; // No localStorage to read: nothing was left.
  }
}

// ---- where maps are kept ---------------------------------------------------------------------

/** A change to one record, worked out from what it holds, inside one transaction. */
type Step<T> = (raw: string | null) => { write?: string | null; result: T };
/** What a site's earlier SoftN page left in its own localStorage, as one map under the frame's names. */
interface EarlierSite { raw: string }
interface MapStore {
  readonly kind: 'indexeddb' | 'localStorage';
  readonly limits: NativeStorageLimits;
  /**
   * Runs `step` on the record as it is, and writes what it says, as one: no other tab's write lands
   * between. An empty record first takes what an older FormLogic left (`legacy`), which moves, or
   * else, where `earlier` is given, a copy of what the site's earlier SoftN page left (earlierSiteMap):
   * the IndexedDB store only, which calls `earlier` whenever it opens a record it carries nothing into.
   */
  atomic<T>(key: string, step: Step<T>, legacy?: string[], earlier?: (limits: NativeStorageLimits) => EarlierSite | null): Promise<T>;
  /** Removes every record whose key starts with `prefix`. */
  removePrefix(prefix: string): Promise<void>;
}

const localStore: MapStore = {
  kind: 'localStorage',
  limits: SMALL_STORAGE_LIMITS,
  async atomic(key, step, legacy = []) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
      // What a FormLogic before maps were kept by id saved under the slug moves here, once.
      for (const name of legacy) {
        if (raw !== null) break;
        const saved = localStorage.getItem(name);
        if (saved !== null) { localStorage.setItem(key, saved); localStorage.removeItem(name); raw = saved; }
      }
    } catch { throw new NativeStorageError('Browser storage is not available.', 'unavailable'); }
    // `earlier` is not looked at here. This store's limits are a fraction of IndexedDB's and share the
    // site's five megabytes with the earlier copy itself, so a game's saves would be refused, and a
    // look counts once: one opening without IndexedDB would leave the app empty for good. The next
    // opening that has IndexedDB looks.
    const { write, result } = step(raw);
    // The browser's own refusal (a full store) goes to the app as the browser said it, as always.
    if (write !== undefined) { if (write === null) localStorage.removeItem(key); else localStorage.setItem(key, write); }
    return result;
  },
  async removePrefix(prefix) {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name?.startsWith(prefix)) keys.push(name);
    }
    for (const name of keys) localStorage.removeItem(name);
  },
};

function indexedStore(db: IDBDatabase): MapStore {
  const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // A request's error, which is the transaction's only once it has aborted: a full disk is told as
    // a full disk (QuotaExceededError), not as storage that is not there.
    tx.onerror = (event) => reject((event.target as { error?: DOMException | null } | null)?.error ?? tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('The transaction was aborted', 'AbortError'));
  });
  return {
    kind: 'indexeddb',
    limits: LARGE_STORAGE_LIMITS,
    async atomic(key, step, legacy = [], earlier) {
      // What localStorage holds for this map (a FormLogic before v0.1.24 kept it there), read
      // before the transaction: a transaction must not wait on anything but its own requests.
      let carried: { name: string; raw: string } | null = null;
      try {
        for (const name of [key, ...legacy]) {
          const raw = localStorage.getItem(name);
          if (raw !== null) { carried = { name, raw }; break; }
        }
      } catch { /* No localStorage: nothing older to carry. */ }
      // What the site's earlier SoftN page left, read before the transaction for the same reason.
      const site = !carried && earlier ? earlier(LARGE_STORAGE_LIMITS) : null;
      let tx: IDBTransaction;
      try { tx = db.transaction(STORE, 'readwrite'); }
      catch { throw new NativeStorageError('Browser storage is not available.', 'unavailable'); }
      const store = tx.objectStore(STORE);
      const finished = done(tx);
      let outcome: { result: unknown } | { error: unknown } | undefined;
      let moved = false;
      const got = store.get(key);
      got.onsuccess = () => {
        let raw = typeof got.result === 'string' ? got.result : null;
        // Only into an empty record: what IndexedDB already holds is newer than what was left behind.
        if (raw === null && carried) { raw = carried.raw; store.put(raw, key); moved = true; }
        else if (raw === null && site) { raw = site.raw; store.put(raw, key); }
        try {
          const { write, result } = step(raw);
          if (write === null) store.delete(key);
          else if (write !== undefined) store.put(write, key);
          outcome = { result };
        } catch (error) {
          outcome = { error };
          // Nothing of a refused change is written, the move included: it is tried again next time.
          tx.abort();
        }
      };
      try { await finished; }
      catch (error) {
        if (outcome && 'error' in outcome) throw outcome.error;
        const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
        throw quota ? new NativeStorageError('This app has reached its browser storage limit.', 'limit') : new NativeStorageError('Browser storage is not available.', 'unavailable');
      }
      // Committed: the older copy may go now, and only now.
      if (moved && carried) { try { localStorage.removeItem(carried.name); } catch { /* It is read again next time and found already moved. */ } }
      if (!outcome) throw new NativeStorageError('Browser storage is not available.', 'unavailable');
      if ('error' in outcome) throw outcome.error;
      return outcome.result as never;
    },
    async removePrefix(prefix) {
      const tx = db.transaction(STORE, 'readwrite');
      const finished = done(tx);
      // Every key with the prefix: from it up to the prefix with its last character's successor.
      const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      tx.objectStore(STORE).delete(IDBKeyRange.bound(prefix, upper, false, true));
      await finished;
    },
  };
}

let opening: Promise<MapStore> | null = null;
/** The store maps are kept in: IndexedDB once it has opened, localStorage where it cannot. */
function mapStore(): Promise<MapStore> {
  opening ??= (async () => {
    if (typeof indexedDB === 'undefined' || !indexedDB) return localStore;
    try {
      const open = indexedDB.open(DATABASE, 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE); };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new DOMException('blocked', 'InvalidStateError'));
      });
      // Another tab's newer FormLogic asking for a version this one does not know: let it.
      db.onversionchange = () => { db.close(); opening = null; };
      // A sign-out's purge that the page closed before it finished is finished now.
      for (const userId of purgeList()) if (!pendingMemberPurges.has(userId)) void clearNativeMemberStorage(userId);
      return indexedStore(db);
    } catch {
      return localStore;
    }
  })();
  return opening;
}

/** For tests: forget the opened store, so the next handle opens it again. */
export function resetNativeStorageForTests(): void { opening = null; }

// Another tab's save, said in this one: localStorage's `storage` event says nothing of IndexedDB.
// Each message names the handle that wrote, so a page does not take its own save for another's.
const CHANNEL = 'formlogic-native-storage';
let announcer: BroadcastChannel | null | undefined;
let handles = 0;
function announce(key: string, from: string): void {
  try {
    announcer ??= typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    announcer?.postMessage({ key, from });
  } catch { /* A browser without it has the storage event, for localStorage. */ }
}
/** Calls `listener` with the key of each map another handle saved or reset, in any tab. */
export function onNativeStorageChange(listener: (key: string, from: string) => void): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  let channel: BroadcastChannel;
  try { channel = new BroadcastChannel(CHANNEL); } catch { return () => {}; }
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { key?: unknown; from?: unknown } | null;
    if (data && typeof data.key === 'string' && typeof data.from === 'string') listener(data.key, data.from);
  };
  return () => channel.close();
}

/**
 * The members whose data a sign-out is still erasing, kept in localStorage at once: IndexedDB's
 * removal finishes later, and a page closed before then would leave it undone. The next opening
 * of the store finishes it.
 */
const PURGE_LIST = 'formlogic:native-member-purges:v1';
function purgeList(): string[] {
  try {
    const listed: unknown = JSON.parse(localStorage.getItem(PURGE_LIST) ?? '[]');
    return Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string' && validIdentity(id)) : [];
  } catch { return []; }
}
function setPurgeList(ids: string[]): void {
  try { if (ids.length) localStorage.setItem(PURGE_LIST, JSON.stringify(ids)); else localStorage.removeItem(PURGE_LIST); }
  catch { /* The purge still runs; only a page closed first would leave it for a later sign-out. */ }
}

/** No legacy slug maps are attributed to a member, including during cleanup. Resolves once done. */
export function clearNativeMemberStorage(userId: string): Promise<boolean> {
  if (!validIdentity(userId)) return Promise.resolve(true);
  setPurgeList([...new Set([...purgeList(), userId])]);
  const prefix = `${MEMBER_PREFIX}${encodeURIComponent(userId)}:`;
  const run = async (): Promise<boolean> => {
    try {
      // Both: a map left in localStorage by an older FormLogic is this member's too.
      await localStore.removePrefix(prefix);
      const store = await mapStore();
      if (store.kind === 'indexeddb') await store.removePrefix(prefix);
      if (pendingMemberPurges.get(userId) === purge) pendingMemberPurges.delete(userId);
      // Done only where IndexedDB was reached, or the browser has none: a page that could not open it
      // leaves the member listed for the next page that can.
      if (store.kind === 'indexeddb' || typeof indexedDB === 'undefined' || !indexedDB) setPurgeList(purgeList().filter(id => id !== userId));
      return true;
    } catch {
      // A later access by this member retries the purge before reading any private bytes.
      // Other principals have different keys even if the browser refuses removal.
      return false;
    }
  };
  const purge = run();
  pendingMemberPurges.set(userId, purge);
  return purge;
}

export type NativeStorageFailure = 'unavailable' | 'too-large' | 'corrupt' | 'invalid' | 'limit' | 'stale';

export class NativeStorageError extends Error {
  readonly code: NativeStorageFailure;
  constructor(message: string, code: NativeStorageFailure) {
    super(message);
    this.name = 'NativeStorageError';
    this.code = code;
  }
}

export type NativeStorageStatus =
  | { state: 'empty' }
  | { state: 'healthy'; entries: number }
  | { state: 'corrupt' | 'too-large' | 'unavailable'; message: string };

export const CORRUPT_STORAGE_MESSAGE = 'This app’s saved browser data is damaged. Export or reset it before the app can use browser storage again.';

/**
 * `domain`: the page is the app's own domain, where the site's earlier SoftN page may have left its
 * saves (earlierSiteMap). Never set it on the platform's origin.
 */
export function nativeAppStorage(slug: string, inputScope: NativeStorageScope | null | undefined, options: { domain?: boolean } = {}) {
  // Copy scalar identities: a response object mutated later cannot retarget this handle.
  const scope: NativeStorageScope | null = isNativeStorageScope(inputScope)
    ? inputScope.access === 'members'
      ? { access: 'members', appId: inputScope.appId, userId: inputScope.userId }
      : { access: 'application', appId: inputScope.appId }
    : null;
  const generation = currentSessionGeneration();
  const key = scope?.access === 'members'
    ? `${MEMBER_PREFIX}${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.appId)}`
    : `${APPLICATION_PREFIX}${encodeURIComponent(scope?.appId ?? slug)}`;
  /**
   * What was saved under the slug, before maps were kept by id, moves to the id's record the
   * first time its app asks, so nothing a person saved is lost. A member's map never does:
   * nothing says whose an unbound slug map was.
   */
  const legacy = scope?.access === 'application' ? [`formlogic:native-storage:${encodeURIComponent(slug)}`] : [];
  // A member's map never takes the site's earlier saves either: nothing says whose they were.
  const earlierFor = options.domain === true && scope?.access === 'application' ? scope.appId : null;
  const earlierMark = earlierFor === null ? '' : `${EARLIER_SITE_PREFIX}${encodeURIComponent(earlierFor)}`;
  // Each key as this handle last read or saved it: a frame holds a snapshot and writes a whole
  // collection from it, so a key that moved since is another tab's work about to be replaced.
  let seen: Map<string, string> | null = null;
  let limits: NativeStorageLimits = SMALL_STORAGE_LIMITS;
  /** This handle, as its saves are announced to the others. */
  const id = `${Date.now().toString(36)}-${++handles}-${Math.random().toString(36).slice(2)}`;
  async function assertScope(): Promise<void> {
    if (!scope) throw new NativeStorageError('A valid app storage scope is required.', 'invalid');
    if (scope.access !== 'members') return; // Independent native login persists across platform logout.
    const owned = () => isSessionGenerationCurrent(generation) && currentSessionOwner() === scope.userId;
    if (!owned()) throw new NativeStorageError('This member session is no longer available.', 'unavailable');
    // A purge of this member's data that has not finished (or failed) goes first: it is retried
    // here, and nothing of theirs is read until it has been.
    const pending = pendingMemberPurges.get(scope.userId);
    if (pending && !(await pending) && !(await clearNativeMemberStorage(scope.userId))) {
      throw new NativeStorageError('Private browser storage could not be cleared.', 'unavailable');
    }
    if (!owned()) throw new NativeStorageError('This member session is no longer available.', 'unavailable');
  }
  /** The whole stored map, or the reason it cannot be trusted. Never partial. */
  function parse(raw: string | null): Record<string, string> {
    if (!raw) return {};
    if (raw.length > limits.map) throw new NativeStorageError('This app’s saved browser data is too large.', 'too-large');
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new NativeStorageError('This app’s saved browser data could not be read.', 'corrupt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeStorageError('This app’s saved browser data could not be read.', 'corrupt');
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.entries) throw new NativeStorageError(CORRUPT_STORAGE_MESSAGE, 'corrupt');
    for (const [name, stored] of entries) {
      if (name.length > limits.key || typeof stored !== 'string' || stored.length > limits.value) throw new NativeStorageError(CORRUPT_STORAGE_MESSAGE, 'corrupt');
    }
    return Object.fromEntries(entries as [string, string][]);
  }
  /**
   * The map as it is now, with keys named after a slug moved to the id. Ids are longer than slugs,
   * so a map at its limit can't take them yet: it keeps the old names and opens under the new ones
   * until a save brings it back under, which is why this runs at every opening.
   */
  function current(raw: string | null): { map: Record<string, string>; write?: string } {
    const saved = parse(raw);
    const adopted = scope ? adoptKeyNames(saved, slug, scope.appId, limits.key) : null;
    if (!adopted) return { map: saved };
    const data = JSON.stringify(adopted);
    return data.length <= limits.map ? { map: adopted, write: data } : { map: adopted };
  }
  async function withStore<T>(step: Step<T>, earlier?: (limits: NativeStorageLimits) => EarlierSite | null): Promise<T> {
    // The store first: opening it resumes a purge a closed page left unfinished, which the scope
    // check then waits for before anything of the member's is read.
    const store = await mapStore();
    await assertScope();
    limits = store.limits;
    return store.atomic(key, step, legacy, earlier);
  }
  async function read(): Promise<Record<string, string>> {
    // The site's earlier saves come in only as the app opens, which reads first: never on a reset,
    // an export or a status check. Once looked at, never again in this browser (earlierSiteMap).
    let looked = false;
    let marked = true;
    try { marked = earlierFor === null || localStorage.getItem(earlierMark) !== null; } catch { /* No localStorage: nothing was left. */ }
    const earlier = marked ? undefined : (limits: NativeStorageLimits) => {
      const found = earlierSiteMap(earlierFor!, limits);
      looked = found !== null;
      return found?.site ?? null;
    };
    const saved = await withStore((raw) => { const { map, write } = current(raw); return { write, result: map }; }, earlier);
    // Only once the record is written: an opening that failed looks again next time.
    if (looked) { try { localStorage.setItem(earlierMark, '1'); } catch { /* Looked at again next time, and taken only into an empty record. */ } }
    seen = new Map(Object.entries(saved));
    return saved;
  }
  async function mutate(input: Record<string, unknown>) {
    limits = (await mapStore()).limits;
    await assertScope();
    let serialized: string | undefined;
    try { serialized = JSON.stringify(input); } catch { /* Invalid structured-clone input. */ }
    if (!input || typeof input !== 'object' || Array.isArray(input) || serialized === undefined || serialized.length > limits.input) {
      throw new NativeStorageError('Invalid storage input.', 'invalid');
    }
    const replacement = (value: unknown): { key: string; value: string } => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeStorageError('Invalid storage replacement.', 'invalid');
      const item = value as Record<string, unknown>;
      if (typeof item.key !== 'string' || item.key.length > limits.key || typeof item.value !== 'string' || item.value.length > limits.value) {
        throw new NativeStorageError('Invalid storage replacement.', 'invalid');
      }
      return { key: item.key, value: item.value };
    };
    // Validate the whole batch before reading/changing the candidate map. No
    // prefix can be saved when a later replacement is invalid or over quota.
    let replacements: { key: string; value: string }[] | undefined;
    if (input.operation === 'batch') {
      if (!Array.isArray(input.replacements) || input.replacements.length > limits.entries) throw new NativeStorageError('Invalid storage replacements.', 'invalid');
      replacements = input.replacements.map(replacement);
      if (new Set(replacements.map(item => item.key)).size !== replacements.length) throw new NativeStorageError('Duplicate storage replacement.', 'invalid');
    } else if (input.operation !== 'clear') {
      if (typeof input.key !== 'string' || input.key.length > limits.key) throw new NativeStorageError('Invalid storage key.', 'invalid');
      if (!(input.operation === 'remove' || (input.operation === 'set' && typeof input.value === 'string' && input.value.length <= limits.value))) {
        throw new NativeStorageError('Invalid storage operation.', 'invalid');
      }
    }
    const known = seen;
    const touchedKeys = (before: Map<string, string>, held: Map<string, string>) => input.operation === 'clear' ? [...new Set([...before.keys(), ...held.keys()])]
      : replacements ? replacements.map(item => item.key) : [input.key as string];
    const result = await withStore((raw) => {
      // Refused before any change when the stored map is not whole: the
      // original bytes are the owner's to export or reset, not ours to rewrite.
      const before = new Map(Object.entries(current(raw).map));
      const entries = new Map(before);
      const held = known ?? new Map(before);
      if (input.operation === 'clear') entries.clear();
      else if (replacements) { for (const item of replacements) entries.set(item.key, item.value); }
      else if (input.operation === 'remove') entries.delete(input.key as string);
      else entries.set(input.key as string, input.value as string);
      const data = JSON.stringify(Object.fromEntries(entries));
      if (entries.size > limits.entries || data.length > limits.map) throw new NativeStorageError('This app has reached its browser storage limit.', 'limit');
      const touched = touchedKeys(before, held);
      if (touched.some(name => before.get(name) !== held.get(name))) {
        throw new NativeStorageError('This app’s saved data changed in another tab.', 'stale');
      }
      return { write: data, result: { touched, entries, held } };
    });
    for (const name of result.touched) {
      const value = result.entries.get(name);
      if (value === undefined) result.held.delete(name);
      else result.held.set(name, value);
    }
    seen = result.held;
    announce(key, id);
    return { saved: true as const };
  }
  /** What the owner can be told before the app starts: healthy, empty, or how it failed. */
  async function status(): Promise<NativeStorageStatus> {
    let raw: string | null;
    try { raw = await withStore((value) => ({ result: value })); } catch (reason) { return { state: 'unavailable', message: (reason as Error).message }; }
    if (!raw) return { state: 'empty' };
    try { return { state: 'healthy', entries: Object.keys(parse(raw)).length }; }
    catch (reason) {
      const failure = reason instanceof NativeStorageError ? reason : new NativeStorageError('This app’s saved browser data could not be read.', 'corrupt');
      return { state: failure.code === 'too-large' ? 'too-large' : 'corrupt', message: failure.message };
    }
  }
  /** The stored bytes as they are, damaged or not, so nothing is lost before a reset. */
  async function exportRaw(): Promise<string | null> {
    return withStore((value) => ({ result: value }));
  }
  /** Deliberate recovery for this app only; other apps' data is untouched. */
  async function reset(): Promise<void> {
    await assertScope();
    try {
      await withStore(() => ({ write: null, result: undefined }));
      // The older copies, if any were never moved (an older FormLogic's, the slug's, or one saved while
      // IndexedDB would not open): each would otherwise move back in next time.
      try { for (const name of [key, ...legacy]) if (localStorage.getItem(name) !== null) localStorage.removeItem(name); }
      catch { /* No localStorage: nothing older there. */ }
    } catch (reason) {
      if (reason instanceof NativeStorageError && reason.code !== 'unavailable') throw reason;
      throw new NativeStorageError('Browser storage is not available.', 'unavailable');
    }
    seen = null;
    announce(key, id);
  }
  /** The limits this map is held to, which the frame is told: known once the store has opened. */
  async function storageLimits(): Promise<NativeStorageLimits> {
    limits = (await mapStore()).limits;
    return limits;
  }
  return { key, id, read, mutate, status, exportRaw, reset, storageLimits };
}
