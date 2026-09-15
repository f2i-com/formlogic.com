// The parent owns persistence; an isolated app receives only its own bounded snapshot.
//
// Audit FL-S07: a stored map is either whole and readable or it is not. A
// map that parses but carries an entry this helper would never have written
// (a key over 256 characters, a value that is not a string, a value over the
// per-key limit) is treated as damaged: reads refuse it, ordinary writes
// refuse to touch it, and the original bytes stay where they are until the
// owner exports or resets them. Filtering the bad entries out and writing the
// rest back would have destroyed the only copy of whatever went wrong.
const LIMIT = 256 * 1024;
const KEY_LIMIT = 256;
const VALUE_LIMIT = 30000;
const ENTRY_LIMIT = 200;

export type NativeStorageFailure = 'unavailable' | 'too-large' | 'corrupt' | 'invalid' | 'limit';

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

export function nativeAppStorage(slug: string) {
  const key = `formlogic:native-storage:${encodeURIComponent(slug)}`;
  function rawValue(): string | null {
    try { return localStorage.getItem(key); }
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
  function read(): Record<string, string> {
    return parse(rawValue());
  }
  function mutate(input: Record<string, unknown>) {
    // Refused before any change when the stored map is not whole: the
    // original bytes are the owner's to export or reset, not ours to rewrite.
    const entries = new Map(Object.entries(read()));
    if (input.operation === 'clear') entries.clear();
    else {
      if (typeof input.key !== 'string' || input.key.length > KEY_LIMIT) throw new NativeStorageError('Invalid storage key.', 'invalid');
      if (input.operation === 'remove') entries.delete(input.key);
      else if (input.operation === 'set' && typeof input.value === 'string' && input.value.length <= VALUE_LIMIT) entries.set(input.key, input.value);
      else throw new NativeStorageError('Invalid storage operation.', 'invalid');
    }
    const data = JSON.stringify(Object.fromEntries(entries));
    if (entries.size > ENTRY_LIMIT || data.length > LIMIT) throw new NativeStorageError('This app has reached its browser storage limit.', 'limit');
    localStorage.setItem(key, data);
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
    try { localStorage.removeItem(key); }
    catch { throw new NativeStorageError('Browser storage is not available.', 'unavailable'); }
  }
  return { read, mutate, status, exportRaw, reset };
}
