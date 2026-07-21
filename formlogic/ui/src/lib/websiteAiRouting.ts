/**
 * Audited website-generation routing policy.
 *
 * A Desktop provider is not a drop-in replacement for hosted endpoints that
 * perform file extraction or validate executable scripts/screens. Keep this
 * table exhaustive so adding a new website AI surface requires an explicit
 * transport decision instead of accidentally sending it to the default route.
 */
import type { AiPreferencesState } from './api';

export const WEBSITE_AI_ROUTE_MATRIX = {
  'form.create.text': { hosted: true, desktopProvider: true },
  'form.edit.text': { hosted: true, desktopProvider: false },
  'form.create.photo': { hosted: true, desktopProvider: false },
  'form.create.document': { hosted: true, desktopProvider: false },
  'app.plan': { hosted: true, desktopProvider: false },
  'app.form.generate': { hosted: true, desktopProvider: false },
  'screen.generate': { hosted: true, desktopProvider: false },
  'script.generate': { hosted: true, desktopProvider: false },
  'script.improve': { hosted: true, desktopProvider: false },
} as const;

export type WebsiteAiOperation = keyof typeof WEBSITE_AI_ROUTE_MATRIX;
export type WebsiteAiRequestedRoute = 'hosted' | 'desktop-provider';
export type WebsiteAiResolvedRoute = WebsiteAiRequestedRoute | 'unsupported';

/**
 * Resolve only an explicitly selected route. A failed or unsupported Desktop
 * selection never silently spends hosted quota (or runs the request twice).
 */
export function resolveWebsiteAiRoute(
  operation: WebsiteAiOperation,
  requested: WebsiteAiRequestedRoute,
): WebsiteAiResolvedRoute {
  const policy = WEBSITE_AI_ROUTE_MATRIX[operation];
  if (requested === 'desktop-provider') {
    return policy.desktopProvider ? 'desktop-provider' : 'unsupported';
  }
  return policy.hosted ? 'hosted' : 'unsupported';
}

// ── v2: default AI source resolution (Site AI plan §5.6) ──────────────────────
// Consumers that only need "what does the user's Default alias point at" read the
// preferences cached by the last successful load/save (the Settings AiSourceCard
// primes it) instead of fetching on every decision.

export type DefaultAiSource = 'site' | 'desktop' | 'custom';

export interface ResolvedDefaultAiSource {
  source: DefaultAiSource;
  /** Desktop provider id (source 'desktop') or browser-local provider id (source 'custom'); null for 'site'. */
  providerId: string | null;
  /** Desktop model id; null = the provider's own default / not applicable. */
  model: string | null;
}

export type DefaultAiSourceFailure =
  | 'no_cached_preferences'
  | 'desktop_provider_missing'
  | 'custom_provider_missing';

export type DefaultAiSourceResolution =
  | { ok: true; source: ResolvedDefaultAiSource }
  | { ok: false; reason: DefaultAiSourceFailure };

let cachedPreferences: AiPreferencesState | null = null;

/** Record freshly loaded/saved AI preferences so resolveDefaultAiSource() stays synchronous. */
export function cacheAiPreferences(preferences: AiPreferencesState | null): void {
  cachedPreferences = preferences;
}

/** Drop the module-level preferences cache (logout; also the test hook). */
export function clearCachedAiPreferences(): void {
  cachedPreferences = null;
}

/**
 * The acting user's default AI source (Site AI plan §5.6), resolved from the
 * cached preferences. Fails closed with a typed reason — an unresolvable default
 * never silently hops to another source.
 */
export function resolveDefaultAiSource(): DefaultAiSourceResolution {
  const prefs = cachedPreferences;
  if (!prefs) return { ok: false, reason: 'no_cached_preferences' };
  switch (prefs.aiSource) {
    case 'site':
      return { ok: true, source: { source: 'site', providerId: null, model: null } };
    case 'desktop':
      if (!prefs.desktopProviderId) return { ok: false, reason: 'desktop_provider_missing' };
      return { ok: true, source: { source: 'desktop', providerId: prefs.desktopProviderId, model: prefs.desktopModel } };
    case 'custom':
      if (!prefs.customProviderId) return { ok: false, reason: 'custom_provider_missing' };
      return { ok: true, source: { source: 'custom', providerId: prefs.customProviderId, model: null } };
  }
}
