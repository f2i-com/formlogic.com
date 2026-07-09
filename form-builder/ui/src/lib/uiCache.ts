// Tiny per-user localStorage cache for expensive dashboard-style aggregates.
// Stale-while-revalidate: pages hydrate instantly from the last visit's data,
// then refresh in the background and overwrite. Entries are namespaced per
// user id so a shared browser never leaks one account's stats into another.

const PREFIX = 'fl-uicache';
const VERSION = 1;
// Beyond this, cached data is too stale to flash even briefly.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Entry<T> {
  v: number;
  savedAt: number;
  data: T;
}

const keyFor = (key: string, userId: string) => `${PREFIX}:${key}:${userId}`;

export function loadUiCache<T>(key: string, userId: string | null | undefined): { data: T; ageMs: number } | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(keyFor(key, userId));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    if (entry.v !== VERSION || typeof entry.savedAt !== 'number') return null;
    const ageMs = Date.now() - entry.savedAt;
    if (ageMs < 0 || ageMs > MAX_AGE_MS) return null;
    return { data: entry.data, ageMs };
  } catch {
    return null;
  }
}

export function saveUiCache<T>(key: string, userId: string | null | undefined, data: T): void {
  if (!userId) return;
  try {
    const entry: Entry<T> = { v: VERSION, savedAt: Date.now(), data };
    localStorage.setItem(keyFor(key, userId), JSON.stringify(entry));
  } catch {
    // Storage full/unavailable — caching is best-effort.
  }
}
