// Public launch-config client for custom domains.
//
// When FormLogic is served on a customer's own domain (e.g. mine.management), the
// SPA resolves that host to a PUBLIC-SAFE launch config — display + install
// metadata only, never form schemas or private app data (spec §19). Cached per
// host for the session so the launch page paints once.
//
// Every page on a host the build doesn't know starts with that question, which is every page of a
// self-hosted site. So the answer is remembered per host, a page doesn't wait long for a new one,
// and offline it doesn't ask.
import { logger } from './logger';

export interface LaunchConfig {
  app: {
    slug: string;
    name: string;
    description?: string | null;
    logoUrl?: string | null;
    theme: { primaryColor: string };
  };
  domain: { domain: string; mode: string };
  landing: {
    headline: string;
    subheadline?: string | null;
    description?: string | null;
    logoUrl?: string | null;
    showOpenWebApp: boolean;
    showInstallPwa: boolean;
    showInstallNative: boolean;
    showPoweredBy: boolean;
    supportEmail?: string | null;
    privacyUrl?: string | null;
    termsUrl?: string | null;
  };
  // FormLogic's own address, where this domain's visitors sign in. Null on a server told no address of its own.
  platformUrl?: string | null;
  // Public-safe native-runtime metadata for this domain (never security config). Optional so an older
  // backend that doesn't emit it still type-checks; the launch page treats a missing section as "off".
  native?: {
    enabled: boolean;
    packageName?: string | null;
    minRuntimeVersion?: string | null;
    installUrl?: string | null;
    requireNativeRuntime: boolean;
    showNativeCta: boolean;
  };
}

/** What became of asking. No answer (offline, too slow, a 429 or 5xx) says nothing about the host. */
export interface HostLookup {
  config: LaunchConfig | null;
  answered: boolean;
}

/** What this browser last heard about a host: a customer's domain, or not one. */
export type RememberedHost = 'domain' | 'not-domain';

const API_BASE = (import.meta.env.VITE_API_URL as string) || '/api';
const NO_ANSWER: HostLookup = { config: null, answered: false };
/** How long a page may wait to find out. Past this, the host counts as no customer's domain. */
const LOOKUP_TIMEOUT_MS = 2500;
const REMEMBERED_PREFIX = 'formlogic:domain-host:';
const cache = new Map<string, Promise<LaunchConfig | null>>();
const lookups = new Map<string, Promise<HostLookup>>();

async function request(host: string, signal?: AbortSignal): Promise<HostLookup> {
  try {
    const res = await fetch(`${API_BASE}/public/launch/by-host?host=${encodeURIComponent(host)}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (res.status === 404) return { config: null, answered: true };
    if (!res.ok) return NO_ANSWER;
    const data = (await res.json()) as unknown;
    if (data && typeof data === 'object' && 'app' in data && 'landing' in data) {
      return { config: data as LaunchConfig, answered: true };
    }
    return NO_ANSWER;
  } catch (e) {
    if (!signal?.aborted) logger.error('launch config fetch failed', e);
    return NO_ANSWER;
  }
}

/** Resolve a host to its launch config (session-cached), or null if it isn't a connected domain. */
export function fetchLaunchConfig(host: string): Promise<LaunchConfig | null> {
  const key = host.toLowerCase();
  if (!cache.has(key)) cache.set(key, request(key).then(({ config }) => config));
  return cache.get(key)!;
}

export function rememberedHost(host: string): RememberedHost | null {
  try {
    const value = localStorage.getItem(`${REMEMBERED_PREFIX}${host.toLowerCase()}`);
    return value === 'domain' || value === 'not-domain' ? value : null;
  } catch {
    return null;
  }
}

function remember(host: string, config: LaunchConfig | null): void {
  // FormLogic's own address can still have an app connected from an older version. It isn't a
  // customer's domain: its pages must not wait, and its sign-in is its own.
  const domain = config !== null && !config.platformUrl?.endsWith(`//${host}`);
  try {
    localStorage.setItem(`${REMEMBERED_PREFIX}${host}`, domain ? 'domain' : 'not-domain');
  } catch {
    /* storage blocked: the next page asks again */
  }
}

async function lookUpInTime(host: string): Promise<HostLookup> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    return await request(host, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask whether a host is a connected domain, for a page that may be waiting on the answer. Once per
 * page load, and only a real answer sticks: no answer is asked for again.
 */
export function lookUpHost(host: string): Promise<HostLookup> {
  const key = host.toLowerCase();
  const running = lookups.get(key);
  if (running) return running;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(NO_ANSWER);
  const lookup = lookUpInTime(key).then((result) => {
    if (result.answered) remember(key, result.config);
    else lookups.delete(key);
    return result;
  });
  lookups.set(key, lookup);
  return lookup;
}
