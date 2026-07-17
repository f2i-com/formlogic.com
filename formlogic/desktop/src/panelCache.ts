import { aiProviders, models, plugins, python } from './api';

/**
 * Module-level panel data cache (the servicesStore idea, generalized).
 *
 * App.tsx mounts only the SELECTED section, so panels using component-local
 * state used to start cold on every tab switch — the Models section sat on a
 * spinner for the 1–2 s disk scan each visit. This cache keeps each panel's
 * last good snapshot at module level:
 *
 *   - panels seed their initial state from the cache (instant paint) and
 *     write fresh results back through it, so a revisit shows data
 *     immediately while the panel's own polling revalidates;
 *   - `prefetchPanelData()` warms the slow endpoints once at app start, so
 *     even the FIRST visit to a section usually paints with data.
 *
 * Values are whatever the panel's fetcher returns — the cache never inspects
 * them, and errors during prefetch are swallowed (the panel's own fetch path
 * owns error display).
 */

const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export function getPanelCache<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setPanelCache<T>(key: string, value: T): void {
  cache.set(key, value);
}

/** Fetch-and-cache with per-key coalescing; errors resolve to undefined. */
export function primePanelCache<T>(key: string, fetcher: () => Promise<T>): Promise<T | undefined> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | undefined>;
  const p = fetcher()
    .then((v) => {
      cache.set(key, v);
      return v as T | undefined;
    })
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export const PANEL_CACHE_KEYS = {
  modelsList: 'models.list',
  modelsCatalog: 'models.catalog',
  pythonStatus: 'python.status',
  pluginsList: 'plugins.list',
  aiProviders: 'ai.providers',
} as const;

/** Warm the slow section endpoints once at app start (fire-and-forget). */
export function prefetchPanelData(): void {
  void primePanelCache(PANEL_CACHE_KEYS.modelsList, () => models.list());
  void primePanelCache(PANEL_CACHE_KEYS.modelsCatalog, () => models.catalog());
  void primePanelCache(PANEL_CACHE_KEYS.pythonStatus, () => python.status());
  void primePanelCache(PANEL_CACHE_KEYS.pluginsList, () => plugins.list());
  void primePanelCache(PANEL_CACHE_KEYS.aiProviders, () => aiProviders.list());
}
