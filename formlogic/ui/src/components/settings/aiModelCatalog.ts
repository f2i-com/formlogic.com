// Shared 5-minute cache for desktop model catalogs (Site AI plan §5.5) — module
// scope so navigating away and back to Settings doesn't re-fetch over the tunnel,
// and tests can reset it. Kept out of AiSourceCard.tsx so that file stays
// component-only exports (react-refresh).
import type { AiSourceListing } from '../../client-runtime/flows/desktopService';

/** Plan §5.5: the desktop model catalog is cached for 5 minutes. */
export const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

export interface ModelOption {
  id: string;
  label: string;
}

interface CatalogCacheEntry {
  at: number;
  models: ModelOption[];
}

const modelCatalogCache = new Map<string, CatalogCacheEntry>();

/** The cached catalog for a provider, or null when absent/stale. */
export function readModelCatalogCache(providerId: string, now: number = Date.now()): ModelOption[] | null {
  const entry = modelCatalogCache.get(providerId);
  return entry && now - entry.at < MODEL_CATALOG_TTL_MS ? entry.models : null;
}

export function writeModelCatalogCache(providerId: string, models: ModelOption[]): void {
  modelCatalogCache.set(providerId, { at: Date.now(), models });
}

export function deleteModelCatalogCache(providerId: string): void {
  modelCatalogCache.delete(providerId);
}

/** Test hook: drop the whole cache. */
export function clearModelCatalogCacheForTests(): void {
  modelCatalogCache.clear();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

// ── Tunnel provider catalog (kind:'providers') ──────────────────────────────
// For browsers with no paired loopback desktop: Settings still offers a provider
// DROPDOWN, populated over the E2E tunnel. One account-level list, same 5-min TTL.

interface ProviderCacheEntry {
  at: number;
  providers: AiSourceListing[];
}

let providerCatalogCache: ProviderCacheEntry | null = null;

/** The cached tunnel provider list, or null when absent/stale. */
export function readProviderCatalogCache(now: number = Date.now()): AiSourceListing[] | null {
  return providerCatalogCache && now - providerCatalogCache.at < MODEL_CATALOG_TTL_MS
    ? providerCatalogCache.providers
    : null;
}

export function writeProviderCatalogCache(providers: AiSourceListing[]): void {
  providerCatalogCache = { at: Date.now(), providers };
}

/** Test hook: drop the tunnel provider cache. */
export function clearProviderCatalogCacheForTests(): void {
  providerCatalogCache = null;
}

/**
 * One tunnel provider row → the /api/ai/sources union shape the card's dropdown
 * consumes. Rows without an id are dropped; a missing capability list means
 * unrestricted (same convention as the union).
 */
export function providerListingFromTunnel(raw: Record<string, unknown>): AiSourceListing | null {
  const refId = firstString(raw.id, raw.providerId, raw.refId);
  if (!refId) return null;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === 'string')
    : [];
  return {
    id: `provider:${refId}`,
    kind: 'provider',
    refId,
    name: firstString(raw.label, raw.name) ?? refId,
    category: '',
    status: 'provider',
    capabilities,
    url: '',
    model: firstString(raw.model) ?? '',
    enabled: raw.enabled !== false,
  };
}

/** A catalog entry: codex rows carry displayName/model; OpenAI /v1/models rows carry id. */
export function modelOptionFrom(raw: Record<string, unknown>): ModelOption | null {
  const id = firstString(raw.id, raw.model, raw.name);
  if (!id) return null;
  return { id, label: firstString(raw.displayName, raw.name) ?? id };
}
