// The page of a table's rows that the address asks for, as the server answered. What is asked
// (the search, the filters, the order, where the page starts) comes from the address; this only
// fetches it, and keeps the page before in hand while the next one is on its way.
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { NativeBrowse, NativeFilter, NativeSort } from '../../lib/nativeHosting';
import { pageOf, type BrowseState } from './address';

export interface TablePage {
  /** The last page of rows that loaded. While `loading`, it is the page being replaced. */
  data: NativeBrowse | null;
  loading: boolean;
  /** Why the page asked for could not be loaded. The page before it is then not shown as if it were current. */
  error: string;
  /** Where the page shown starts, as the server says (it clamps a request past its window). */
  offset: number;
  /** The page size the server used. */
  pageSize: number;
  /** Which page of which rows is asked for, as one string: the same across a reload, new for any other page. */
  scope: string;
  /** Ask for the same page again: after a change, or to retry. */
  reload(): void;
  /** How many times that was asked: what is read beside the page (the open row) is read again with it. */
  reloads: number;
}

interface Answer { key: string; data?: NativeBrowse; error?: string }

/**
 * `showing`: the Browse view is on screen, so the page is fetched afresh each time it comes back.
 * `wanted`: the page is needed in the other views too, once for each thing asked (its answer says
 * whether rows can be added here, and how many rows an export of the matching ones would hold).
 * `onPastEnd`: the page asked for lies past the last row, and is told where the last page that
 * has rows starts.
 */
export function useTablePage(appId: string, version: number, table: string, state: BrowseState, limit: number, showing: boolean, wanted: boolean, onPastEnd: (offset: number) => void): TablePage {
  const [reloads, setReloads] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const pastEnd = useRef(onPastEnd);
  useEffect(() => { pastEnd.current = onPastEnd; }, [onPastEnd]);

  const scope = pageOf(state, limit);
  const key = JSON.stringify([appId, version, table, scope, reloads]);
  const fetching = showing || (wanted && answer?.key !== key);
  const { offset } = state;
  useEffect(() => {
    if (!fetching) return;
    // What to ask for is read back from `scope`, the one string that says it. The address hands
    // over a new `state` whenever anything in it changes, the open row too, and its `sort` and
    // `filters` are then new objects that say the same thing: that alone must not fetch again.
    const [from, size, sort, q, filters] = JSON.parse(scope) as [number, number, NativeSort | null, string, NativeFilter[]];
    const stop = new AbortController();
    const failed = 'The rows could not be loaded. Try again.';
    void api.browseNativeRecords(appId, table, { offset: from, limit: size, sort, q, filters }, stop.signal).then(result => {
      if (stop.signal.aborted) return;
      const data = result.data;
      if (result.error || !data) { setAnswer({ key, error: result.error || failed }); return; }
      // A page past the last row (its rows were deleted, or the search now finds fewer): the
      // address is put right, and the page before stays up meanwhile, never an empty one.
      const pageSize = data.limit || size, start = data.offset ?? from;
      if (!data.rows?.length && start > 0 && typeof data.matching === 'number') { pastEnd.current(Math.max(0, (Math.ceil(data.matching / pageSize) - 1) * pageSize)); return; }
      setAnswer({ key, data });
    }).catch(() => { if (!stop.signal.aborted) setAnswer({ key, error: failed }); });
    return () => stop.abort();
  }, [fetching, appId, table, scope, key]);

  const data = answer?.data ?? null;
  const loading = answer?.key !== key;
  return {
    data, loading,
    error: !loading && answer?.error ? answer.error : '',
    offset: data?.offset ?? offset,
    pageSize: data?.limit || limit,
    scope,
    reload: () => setReloads(count => count + 1),
    reloads,
  };
}
