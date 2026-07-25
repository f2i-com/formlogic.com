import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CatalogPack } from '../lib/api';

/**
 * MKT-601: the one place the marketplace catalog is browsed.
 *
 * The popup and the routed gallery were fetching independently, and they had drifted into
 * different behaviour for the same screen: the gallery cancelled stale responses, surfaced load
 * errors and offered a retry; the popup swallowed every failure in an empty `catch` and rendered
 * an empty catalog. An empty catalog and a failed request look identical to a user, and only one
 * of them is worth waiting for — which is exactly why "no silent empty-state errors" is the
 * acceptance criterion rather than a preference.
 *
 * Three behaviours are load-bearing and easy to lose when this is written twice:
 *
 * - **One initial fetch.** Mounting does not fire two requests, and the debounce that follows a
 *   keystroke does not race the initial load.
 * - **Stale-response cancellation.** Only the newest request may apply results. Without this a
 *   slow earlier query overwrites a newer one, and the list silently shows the wrong search.
 * - **Explicit retry.** A failure is a state with an action, not a blank grid.
 *
 * `loading` is DERIVED from whether the displayed result answers the query being asked, rather
 * than flipped inside the effect. That distinction mattered in practice: with `loading` starting
 * false, callers saw "not loading, no results" for the whole debounce window and acted on an
 * emptiness that had never been measured — the routed gallery flashed "No apps found" on every
 * visit, and the Packs modal fired its catalog bootstrap before it had read anything at all.
 */
export interface PackBrowseOptions {
  /** Skip fetching entirely (a closed modal, or the demo account's local-only catalog). */
  enabled?: boolean;
  search?: string;
  sort?: string;
  category?: string;
  tag?: string;
  page?: number;
  limit?: number;
  /** Debounce before a search fires. 0 = immediate (used for non-search-driven surfaces). */
  debounceMs?: number;
}

export interface PackBrowseResult {
  packs: CatalogPack[];
  totalPages: number;
  /** True whenever what is displayed does not yet answer the current query. */
  loading: boolean;
  /** Non-null means the catalog could NOT be read — never rendered as "no packs". */
  error: string | null;
  /** Re-run the current query. */
  retry: () => void;
}

/** A completed result, tagged with the query it answered. */
interface SettledResult {
  key: string;
  packs: CatalogPack[];
  totalPages: number;
  error: string | null;
}

export function usePackBrowse(options: PackBrowseOptions): PackBrowseResult {
  const {
    enabled = true,
    search = '',
    sort = 'popular',
    category = '',
    tag = '',
    page = 1,
    limit = 12,
    debounceMs = 300,
  } = options;

  const [retryToken, setRetryToken] = useState(0);
  const [settled, setSettled] = useState<SettledResult | null>(null);

  // The question currently being asked. A settled result carries the key it answered, so
  // "loading" is just "what is on screen is not an answer to this".
  const key = JSON.stringify({ enabled, search, sort, category, tag, page, limit, retryToken });

  // Monotonic request id: only the newest response may apply. A slow earlier query must never
  // overwrite a newer one — the user would see results for a search they have moved on from.
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const run = () => {
      const seq = ++seqRef.current;
      void api
        .browsePacks({
          search: search || undefined,
          sort,
          category: category || undefined,
          tag: tag || undefined,
          page,
          limit,
        })
        .then((result) => {
          if (seq !== seqRef.current) return; // a newer request has taken over
          setSettled(
            result.error
              ? {
                  key,
                  packs: [],
                  totalPages: 1,
                  error: typeof result.error === 'string' ? result.error : 'Could not load the marketplace catalog.',
                }
              : {
                  key,
                  packs: result.data?.packs ?? [],
                  totalPages: result.data?.totalPages ?? 1,
                  error: null,
                }
          );
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          // Honest failure, not an empty grid: a user can retry a failure, but they cannot
          // retry a catalog that simply appears to have nothing in it.
          setSettled({
            key,
            packs: [],
            totalPages: 1,
            error: 'Could not load the marketplace catalog. Check your connection and try again.',
          });
        });
    };

    if (debounceMs > 0) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, debounceMs);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
    run();
    return undefined;
  }, [enabled, search, sort, category, tag, page, limit, debounceMs, key]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  const answered = settled !== null && settled.key === key;
  return {
    packs: answered ? settled.packs : [],
    totalPages: answered ? settled.totalPages : 1,
    // Disabled means nothing is pending: not loading, simply without an answer.
    loading: enabled && !answered,
    error: answered ? settled.error : null,
    retry,
  };
}
