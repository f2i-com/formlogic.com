// Public launch-config client for custom domains.
//
// When FormLogic is served on a customer's own domain (e.g. mine.management), the
// SPA resolves that host to a PUBLIC-SAFE launch config — display + install
// metadata only, never form schemas or private app data (spec §19). Cached per
// host for the session so the launch page paints once.
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
}

const API_BASE = (import.meta.env.VITE_API_URL as string) || '/api';
const cache = new Map<string, Promise<LaunchConfig | null>>();

async function request(host: string): Promise<LaunchConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/public/launch/by-host?host=${encodeURIComponent(host)}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (data && typeof data === 'object' && 'app' in data && 'landing' in data) {
      return data as LaunchConfig;
    }
    return null;
  } catch (e) {
    logger.error('launch config fetch failed', e);
    return null;
  }
}

/** Resolve a host to its launch config (session-cached), or null if it isn't a connected domain. */
export function fetchLaunchConfig(host: string): Promise<LaunchConfig | null> {
  const key = host.toLowerCase();
  if (!cache.has(key)) cache.set(key, request(key));
  return cache.get(key)!;
}
