import { api, type MarketplaceDemoSession } from './api';

const SESSION_STORAGE_PREFIX = 'fl-demo-sbx:v1:';
const SESSION_VERIFY_TTL_MS = 5 * 60_000;
const inFlightLaunches = new Map<string, Promise<MarketplaceDemoSession | null>>();

type StoredSandboxSession = MarketplaceDemoSession & { verifiedAt?: number };

export function readStoredSandboxSession(packSlug: string): StoredSandboxSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_PREFIX + packSlug);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSandboxSession;
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.framePath !== 'string' || parsed.slug !== packSlug) {
      return null;
    }
    const exp = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(exp) || exp < Date.now() + 60_000) {
      window.sessionStorage.removeItem(SESSION_STORAGE_PREFIX + packSlug);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredSandboxSession(packSlug: string, session: MarketplaceDemoSession | null): void {
  try {
    if (!session) {
      window.sessionStorage.removeItem(SESSION_STORAGE_PREFIX + packSlug);
    } else {
      const stored: StoredSandboxSession = { ...session, verifiedAt: Date.now() };
      window.sessionStorage.setItem(SESSION_STORAGE_PREFIX + packSlug, JSON.stringify(stored));
    }
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

/**
 * Reuse an active visitor sandbox session for `packSlug` (reusing freshly verified tokens
 * immediately in 0ms, or probing older tokens against the server) or start a fresh isolated
 * ephemeral SQLite sandbox. Shared by BOTH the SoftN App iframe and the real FormLogic Form App
 * so edits made in either app appear live in the other.
 */
export async function ensureSandboxSession(packSlug: string, forceNew = false): Promise<MarketplaceDemoSession | null> {
  if (!packSlug) return null;
  if (!forceNew) {
    const cached = readStoredSandboxSession(packSlug);
    if (
      cached &&
      cached.hasBackend &&
      typeof cached.verifiedAt === 'number' &&
      Date.now() - cached.verifiedAt < SESSION_VERIFY_TTL_MS
    ) {
      return cached;
    }
    const existingFlight = inFlightLaunches.get(packSlug);
    if (existingFlight) return existingFlight;
  }

  let promise: Promise<MarketplaceDemoSession | null> | null = null;
  promise = (async (): Promise<MarketplaceDemoSession | null> => {
    try {
      if (!forceNew) {
        const cached = readStoredSandboxSession(packSlug);
        if (cached && cached.hasBackend) {
          const probe = await api.getMarketplaceDemoTables(packSlug, cached.token);
          if (!probe.error && probe.data) {
            writeStoredSandboxSession(packSlug, cached);
            return cached;
          }
          writeStoredSandboxSession(packSlug, null);
        }
      }
      const res = await api.startMarketplaceDemo(packSlug);
      if (res.error || !res.data) {
        return null;
      }
      writeStoredSandboxSession(packSlug, res.data);
      return res.data;
    } catch {
      return null;
    } finally {
      if (inFlightLaunches.get(packSlug) === promise) {
        inFlightLaunches.delete(packSlug);
      }
    }
  })();

  inFlightLaunches.set(packSlug, promise);
  return promise;
}

/** Reset the shared visitor sandbox SQLite database cleanly for both the SoftN App and Form App. */
export async function resetSandboxSession(packSlug: string): Promise<MarketplaceDemoSession | null> {
  if (!packSlug) return null;
  const cached = readStoredSandboxSession(packSlug);
  if (cached) {
    try {
      const res = await api.resetMarketplaceDemo(packSlug, cached.token);
      if (!res.error && res.data?.reset) {
        const updated: MarketplaceDemoSession = {
          ...cached,
          expiresAt: res.data.expiresAt || cached.expiresAt,
        };
        writeStoredSandboxSession(packSlug, updated);
        return updated;
      }
    } catch {
      // Fall through to starting a fresh session
    }
  }
  return ensureSandboxSession(packSlug, true);
}
