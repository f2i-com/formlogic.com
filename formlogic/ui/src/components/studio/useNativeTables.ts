import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export interface NativeTableState { installed: boolean; tables: string[]; loading: boolean; error: string }
const empty: NativeTableState = { installed: false, tables: [], loading: false, error: '' };

export function useNativeTables(appId: string | undefined, refreshKey: string): NativeTableState {
  const [state, setState] = useState<NativeTableState & { appId?: string }>({ ...empty });
  useEffect(() => {
    let cancelled = false;
    if (!appId) { setState(empty); return; }
    setState(current => ({ ...(current.appId === appId ? current : empty), appId, loading: true, error: '' }));
    void api.getNativeRecords(appId).then(result => {
      if (!cancelled) setState({ appId, installed: !!result.data?.installed, tables: result.data?.tables ?? [], loading: false, error: result.error ?? '' });
    }).catch(() => { if (!cancelled) setState({ ...empty, appId, error: 'Could not load the app database.' }); });
    return () => { cancelled = true; };
  }, [appId, refreshKey]);
  return state.appId === appId ? state : { ...empty, loading: !!appId };
}
