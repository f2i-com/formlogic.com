import { useCallback, useEffect, useState } from 'react';
import { deferEffect } from '../../lib/deferredEffect';

type Fetcher<T> = () => Promise<{ data?: T; error?: string }>;

/** Keep refresh failures visible and discard responses from an obsolete query. */
export function useAdminQuery<T>(fetcher: Fetcher<T>) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{
    source: Fetcher<T>; data?: T; error?: string; loading: boolean;
  }>({ source: fetcher, loading: true });
  useEffect(() => {
    let cancelled = false;
    const stop = deferEffect(() => {
      setState(previous => ({ source: fetcher, data: previous.source === fetcher ? previous.data : undefined, loading: true }));
      void fetcher().then(result => {
        if (cancelled) return;
        setState(previous => ({ source: fetcher, loading: false,
          data: result.data ?? previous.data,
          error: result.data ? undefined : result.error || 'Could not load this section. Please try again.',
        }));
      }).catch(() => {
        if (!cancelled) setState(previous => ({ ...previous, loading: false, error: 'Could not connect. Please try again.' }));
      });
    });
    return () => { cancelled = true; stop(); };
  }, [fetcher, tick]);
  const refresh = useCallback(() => {
    setState(previous => ({ ...previous, loading: true, error: undefined }));
    setTick(value => value + 1);
  }, []);
  // Hide the previous account/search immediately, before effects have run.
  return { ...(state.source === fetcher ? state : { loading: true, data: undefined, error: undefined }), refresh };
}
