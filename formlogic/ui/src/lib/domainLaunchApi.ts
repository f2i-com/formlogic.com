// Public launch-config client for custom domains.
//
// When FormLogic is served on a customer's own domain (e.g. mine.management), the
// SPA resolves that host to a PUBLIC-SAFE launch config — display + install
// metadata only, never form schemas or private app data (spec §19). Cached per
// host for the session so the launch page paints once.
//
// Every page on a host the build doesn't know starts with that question, which is every page of a
// self-hosted site. So the answer is remembered per host, with what it takes to draw the page, and
// only a real answer from the server replaces it. A timeout, a 429, a 5xx or being offline says
// nothing about the host.
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

/**
 * What became of asking. No answer (offline, too slow, a 429 or 5xx) says nothing about the host.
 * `platform`: the server says this host is the site's own address, not a domain that isn't connected.
 */
export interface HostLookup {
  config: LaunchConfig | null;
  answered: boolean;
  platform?: boolean;
}

export type SoftnAccess = 'application' | 'members';

/** What this browser last heard about a host. All of it is public. */
export type RememberedHost =
  /** `platform`: the server said it is the site's own address. Without that its home page can change. */
  | { kind: 'not-domain'; platform?: boolean }
  /** With no config, the word an older version kept: it knows nothing to draw the page with. */
  | { kind: 'domain'; config?: LaunchConfig; softnAccess?: SoftnAccess };

const API_BASE = (import.meta.env.VITE_API_URL as string) || '/api';
const NO_ANSWER: HostLookup = { config: null, answered: false };
/** How long one try may take. Nothing is decided by its running out: it is asked again. */
const LOOKUP_TIMEOUT_MS = 15_000;
const REMEMBERED_PREFIX = 'formlogic:domain-host:';
const answers = new Map<string, Promise<HostLookup>>();
const lookups = new Map<string, Promise<HostLookup>>();

function isLaunchConfig(data: unknown): data is LaunchConfig {
  return !!data && typeof data === 'object' && 'app' in data && 'landing' in data;
}

const isWebAddress = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  try {
    return typeof value === 'string' && /^https?:$/.test(new URL(value, 'https://formlogic.invalid').protocol);
  } catch {
    return false;
  }
};

/**
 * A page draws from a stored config before the server has said anything, so it has to be one the
 * server could have sent: anything else in storage would break the page, or send it somewhere.
 */
function isStoredConfig(data: unknown): data is LaunchConfig {
  if (!isLaunchConfig(data)) return false;
  const { app, domain, landing, platformUrl, native } = data as Partial<LaunchConfig>;
  return typeof app?.slug === 'string'
    && typeof domain?.mode === 'string'
    && !!landing && typeof landing === 'object'
    && [platformUrl, landing.privacyUrl, landing.termsUrl, native?.installUrl].every(isWebAddress);
}

async function request(host: string, signal?: AbortSignal): Promise<HostLookup> {
  try {
    const res = await fetch(`${API_BASE}/public/launch/by-host?host=${encodeURIComponent(host)}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (res.status !== 404 && !res.ok) return NO_ANSWER;
    // The server's 404 is JSON. Any other is a proxy or a page, which knows nothing about the host.
    const data = (await res.json()) as unknown;
    if (res.status === 404) {
      if (!data || typeof data !== 'object') return NO_ANSWER;
      return { config: null, answered: true, ...('platform' in data && data.platform === true ? { platform: true } : {}) };
    }
    return isLaunchConfig(data) ? { config: data, answered: true } : NO_ANSWER;
  } catch (e) {
    if (!signal?.aborted) logger.error('launch config fetch failed', e);
    return NO_ANSWER;
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

/** Ask what a host is. An answer holds for the session, and no answer can be asked for again. */
export function fetchLaunchConfig(host: string): Promise<HostLookup> {
  const key = host.toLowerCase();
  const asked = answers.get(key);
  if (asked) return asked;
  const lookup = lookUpInTime(key).then((result) => {
    if (!result.answered) answers.delete(key);
    return result;
  });
  answers.set(key, lookup);
  return lookup;
}

export function rememberedHost(host: string): RememberedHost | null {
  try {
    const value = localStorage.getItem(`${REMEMBERED_PREFIX}${host.toLowerCase()}`);
    if (value === 'platform') return { kind: 'not-domain', platform: true };
    if (value === 'not-domain') return { kind: 'not-domain' };
    if (value === 'domain') return { kind: 'domain' };
    if (value === null) return null;
    const stored = JSON.parse(value) as { config?: unknown; softnAccess?: SoftnAccess } | null;
    return isStoredConfig(stored?.config)
      ? { kind: 'domain', config: stored.config, ...(stored.softnAccess ? { softnAccess: stored.softnAccess } : {}) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep what the server said about a host. A customer's domain is kept only with its `softnAccess`,
 * which decides what its pages are: kept without it, a SoftN app's domain would show the platform's.
 * `platform` is the server's word that the host is the site's own address.
 */
export function rememberHost(host: string, config: LaunchConfig | null, softnAccess?: SoftnAccess, platform?: boolean): void {
  const key = host.toLowerCase();
  // FormLogic's own address can still have an app connected from an older version. It isn't a
  // customer's domain: its pages must not wait, and its sign-in is its own.
  const domain = config !== null && !config.platformUrl?.endsWith(`//${key}`);
  try {
    localStorage.setItem(`${REMEMBERED_PREFIX}${key}`, domain ? JSON.stringify({ config, softnAccess }) : platform ? 'platform' : 'not-domain');
  } catch {
    /* storage blocked: the next page asks again */
  }
}

/**
 * Ask whether a host is a connected domain. Once per page load, and only a real answer sticks: no
 * answer is asked for again. An answer that it is one isn't kept here, as the caller still has to
 * learn its `softnAccess` (see rememberHost).
 */
export function lookUpHost(host: string): Promise<HostLookup> {
  const key = host.toLowerCase();
  const running = lookups.get(key);
  if (running) return running;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(NO_ANSWER);
  const lookup = lookUpInTime(key).then((result) => {
    if (!result.answered) lookups.delete(key);
    else if (!result.config) rememberHost(key, null, undefined, result.platform);
    return result;
  });
  lookups.set(key, lookup);
  return lookup;
}
