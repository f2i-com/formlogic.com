// The parent owns persistence; an isolated app receives only its own bounded snapshot.
//
// Audit FL-S07: a stored map is either whole and readable or it is not. A
// map that parses but carries an entry this helper would never have written
// (a key over 256 characters, a value that is not a string, a value over the
// per-key limit) is treated as damaged: reads refuse it, ordinary writes
// refuse to touch it, and the original bytes stay where they are until the
// owner exports or resets them. Filtering the bad entries out and writing the
// rest back would have destroyed the only copy of whatever went wrong.
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent } from './sessionGeneration';

const LIMIT = 256 * 1024;
const KEY_LIMIT = 256;
const VALUE_LIMIT = 30000;
const ENTRY_LIMIT = 200;
// This is the action INPUT limit used by the private hosted-runtime port,
// measured in UTF-16 code units after JSON escaping, like the existing map.
const INPUT_LIMIT = 32768;
// SoftN names an app's keys after the id the frame gives it.
const APP_KEY = /^(xdb|softn):native-([a-zA-Z0-9_-]*):/;
const MEMBER_PREFIX = 'formlogic:native-member-storage:v1:';
// By app id, because a slug is reusable: rename an app and another can claim its
// old slug, and it was then handed what a visitor had saved in the first. A prefix
// of its own, so no slug can name a key here (see adoptSlugMap).
const APPLICATION_PREFIX = 'formlogic:native-app-storage:v1:';
const pendingMemberPurges = new Set<string>();

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
function adoptKeyNames(saved: Record<string, string>, slug: string, appId: string): Record<string, string> | null {
  const entries = Object.entries(saved).filter(([name]) => { const match = APP_KEY.exec(name); return match && match[2] !== appId; });
  if (entries.length === 0) return null;
  const adopted = new Map(Object.entries(saved));
  const ofThisSlug = ([name]: [string, string]) => APP_KEY.exec(name)?.[2] === slug ? 0 : 1;
  for (const [name, value] of entries.sort((a, b) => ofThisSlug(a) - ofThisSlug(b))) {
    const moved = name.replace(APP_KEY, (_all, store) => `${store}:${nativeFrameAppId(appId)}:`);
    if (adopted.has(moved) || moved.length > KEY_LIMIT) continue;
    adopted.delete(name);
    adopted.set(moved, value);
  }
  return Object.fromEntries(adopted);
}

/** No legacy slug maps are attributed to a member, including during cleanup. */
export function clearNativeMemberStorage(userId: string): void {
  if (!validIdentity(userId)) return;
  pendingMemberPurges.add(userId);
  const prefix = `${MEMBER_PREFIX}${encodeURIComponent(userId)}:`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    pendingMemberPurges.delete(userId);
  } catch {
    // A later access by this member retries the purge before reading any private bytes.
    // Other principals have different keys even if the browser refuses removal.
  }
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

export function nativeAppStorage(slug: string, inputScope: NativeStorageScope | null | undefined) {
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
  const slugKey = scope?.access === 'application' ? `formlogic:native-storage:${encodeURIComponent(slug)}` : null;
  // Each key as this handle last read or saved it: a frame holds a snapshot and writes a whole
  // collection from it, so a key that moved since is another tab's work about to be replaced.
  let seen: Map<string, string> | null = null;
  /**
   * What was saved under the slug, before maps were kept by id, moves here the
   * first time its app asks, so nothing a person saved is lost. A member's map
   * never does: nothing says whose an unbound slug map was.
   */
  function adoptSlugMap(): string | null {
    const saved = slugKey ? localStorage.getItem(slugKey) : null;
    if (slugKey && saved !== null) {
      localStorage.setItem(key, saved);
      localStorage.removeItem(slugKey);
    }
    return saved;
  }
  function assertScope(): void {
    if (!scope) throw new NativeStorageError('A valid app storage scope is required.', 'invalid');
    if (scope.access !== 'members') return; // Independent native login persists across platform logout.
    if (!isSessionGenerationCurrent(generation) || currentSessionOwner() !== scope.userId) {
      throw new NativeStorageError('This member session is no longer available.', 'unavailable');
    }
    if (pendingMemberPurges.has(scope.userId)) clearNativeMemberStorage(scope.userId);
    if (pendingMemberPurges.has(scope.userId)) {
      throw new NativeStorageError('Private browser storage could not be cleared.', 'unavailable');
    }
  }
  function rawValue(): string | null {
    assertScope();
    try { return localStorage.getItem(key) ?? adoptSlugMap(); }
    catch { throw new NativeStorageError('Browser storage is not available.', 'unavailable'); }
  }
  /** The whole stored map, or the reason it cannot be trusted. Never partial. */
  function parse(raw: string | null): Record<string, string> {
    if (!raw) return {};
    if (raw.length > LIMIT) throw new NativeStorageError('This app’s saved browser data is too large.', 'too-large');
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new NativeStorageError('This app’s saved browser data could not be read.', 'corrupt'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeStorageError('This app’s saved browser data could not be read.', 'corrupt');
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > ENTRY_LIMIT) throw new NativeStorageError(CORRUPT_STORAGE_MESSAGE, 'corrupt');
    for (const [name, stored] of entries) {
      if (name.length > KEY_LIMIT || typeof stored !== 'string' || stored.length > VALUE_LIMIT) throw new NativeStorageError(CORRUPT_STORAGE_MESSAGE, 'corrupt');
    }
    return Object.fromEntries(entries as [string, string][]);
  }
  function current(): Record<string, string> {
    const saved = parse(rawValue());
    const adopted = scope ? adoptKeyNames(saved, slug, scope.appId) : null;
    if (!adopted) return saved;
    // Ids are longer than slugs, so a map at its limit can't take them yet. It keeps the old names
    // and opens under the new ones until a save brings it back under: this runs at every opening.
    const data = JSON.stringify(adopted);
    if (data.length <= LIMIT) try { localStorage.setItem(key, data); } catch { /* As above. */ }
    return adopted;
  }
  function read(): Record<string, string> {
    const saved = current();
    seen = new Map(Object.entries(saved));
    return saved;
  }
  function mutate(input: Record<string, unknown>) {
    assertScope();
    let serialized: string | undefined;
    try { serialized = JSON.stringify(input); } catch { /* Invalid structured-clone input. */ }
    if (!input || typeof input !== 'object' || Array.isArray(input) || serialized === undefined || serialized.length > INPUT_LIMIT) {
      throw new NativeStorageError('Invalid storage input.', 'invalid');
    }
    const replacement = (value: unknown): { key: string; value: string } => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeStorageError('Invalid storage replacement.', 'invalid');
      const item = value as Record<string, unknown>;
      if (typeof item.key !== 'string' || item.key.length > KEY_LIMIT || typeof item.value !== 'string' || item.value.length > VALUE_LIMIT) {
        throw new NativeStorageError('Invalid storage replacement.', 'invalid');
      }
      return { key: item.key, value: item.value };
    };
    // Validate the whole batch before reading/changing the candidate map. No
    // prefix can be saved when a later replacement is invalid or over quota.
    let replacements: { key: string; value: string }[] | undefined;
    if (input.operation === 'batch') {
      if (!Array.isArray(input.replacements) || input.replacements.length > ENTRY_LIMIT) throw new NativeStorageError('Invalid storage replacements.', 'invalid');
      replacements = input.replacements.map(replacement);
      if (new Set(replacements.map(item => item.key)).size !== replacements.length) throw new NativeStorageError('Duplicate storage replacement.', 'invalid');
    }
    // Refused before any change when the stored map is not whole: the
    // original bytes are the owner's to export or reset, not ours to rewrite.
    const before = new Map(Object.entries(current()));
    const entries = new Map(before);
    const known = seen ?? new Map(before);
    if (input.operation === 'clear') entries.clear();
    else if (replacements) {
      for (const item of replacements) entries.set(item.key, item.value);
    }
    else {
      if (typeof input.key !== 'string' || input.key.length > KEY_LIMIT) throw new NativeStorageError('Invalid storage key.', 'invalid');
      if (input.operation === 'remove') entries.delete(input.key);
      else if (input.operation === 'set' && typeof input.value === 'string' && input.value.length <= VALUE_LIMIT) entries.set(input.key, input.value);
      else throw new NativeStorageError('Invalid storage operation.', 'invalid');
    }
    const data = JSON.stringify(Object.fromEntries(entries));
    if (entries.size > ENTRY_LIMIT || data.length > LIMIT) throw new NativeStorageError('This app has reached its browser storage limit.', 'limit');
    const touched = input.operation === 'clear' ? [...new Set([...before.keys(), ...known.keys()])]
      : replacements ? replacements.map(item => item.key) : [input.key as string];
    if (touched.some(name => before.get(name) !== known.get(name))) {
      throw new NativeStorageError('This app’s saved data changed in another tab.', 'stale');
    }
    localStorage.setItem(key, data);
    for (const name of touched) {
      const value = entries.get(name);
      if (value === undefined) known.delete(name);
      else known.set(name, value);
    }
    seen = known;
    return { saved: true };
  }
  /** What the owner can be told before the app starts: healthy, empty, or how it failed. */
  function status(): NativeStorageStatus {
    let raw: string | null;
    try { raw = rawValue(); } catch (reason) { return { state: 'unavailable', message: (reason as Error).message }; }
    if (!raw) return { state: 'empty' };
    try { return { state: 'healthy', entries: Object.keys(parse(raw)).length }; }
    catch (reason) {
      const failure = reason instanceof NativeStorageError ? reason : new NativeStorageError('This app’s saved browser data could not be read.', 'corrupt');
      return { state: failure.code === 'too-large' ? 'too-large' : 'corrupt', message: failure.message };
    }
  }
  /** The stored bytes as they are, damaged or not, so nothing is lost before a reset. */
  function exportRaw(): string | null {
    return rawValue();
  }
  /** Deliberate recovery for this app only; other apps' data is untouched. */
  function reset(): void {
    assertScope();
    try {
      localStorage.removeItem(key);
      if (slugKey && localStorage.getItem(slugKey) !== null) localStorage.removeItem(slugKey);
      seen = null;
    } catch { throw new NativeStorageError('Browser storage is not available.', 'unavailable'); }
  }
  return { key, read, mutate, status, exportRaw, reset };
}
