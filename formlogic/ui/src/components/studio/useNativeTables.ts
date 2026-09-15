import { useEffect, useState } from 'react';
import { deferEffect } from '../../lib/deferredEffect';
import { api } from '../../lib/api';

/** `readOnly`: the shared demo, which browses the app database but cannot change it. `error`: what to tell the owner, empty when loaded. */
export interface NativeTableState { installed: boolean; tables: string[]; loading: boolean; error: string; readOnly: boolean }
const empty: NativeTableState = { installed: false, tables: [], loading: false, error: '', readOnly: false };
const NATIVE_TABLES_UNAVAILABLE = 'Could not load database tables. Reload this section to try again.';

/**
 * The server's own explanation when it answered with one (a rate limit, an installation being
 * updated or needing recovery); the generic retry advice for a network failure, or an error body
 * the client had to make up.
 */
function explain(result: { error?: string; status?: number }): string {
  if (!result.error) return '';
  return result.status !== undefined && !/^(Server error \(\d+\)|An error occurred)$/.test(result.error) ? result.error : NATIVE_TABLES_UNAVAILABLE;
}

export function useNativeTables(appId: string | undefined, refreshKey: string): NativeTableState {
  const [state, setState] = useState<NativeTableState & { appId?: string }>({ ...empty });
  useEffect(() => deferEffect(() => {
    let cancelled = false;
    if (!appId) { setState(empty); return; }
    setState(current => ({ ...(current.appId === appId ? current : empty), appId, loading: true, error: '' }));
    void api.getNativeRecords(appId).then(result => {
      if (!cancelled) setState({ appId, installed: !!result.data?.installed, tables: result.data?.tables ?? [], loading: false, error: explain(result), readOnly: !!result.data?.readOnly });
    }).catch(() => { if (!cancelled) setState({ ...empty, appId, error: NATIVE_TABLES_UNAVAILABLE }); });
    return () => { cancelled = true; };
  }), [appId, refreshKey]);
  return state.appId === appId ? state : { ...empty, loading: !!appId };
}
