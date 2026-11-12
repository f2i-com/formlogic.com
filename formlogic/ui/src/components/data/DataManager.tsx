// The data manager of a SoftN app: its tables down the left, and the open table beside them
// (browse, structure, export, import). It owns no address: the page says which table and view are
// open and what the Browse view shows (its query string), and is asked to change them.
//
// The page gives it its height. On a wide screen it is as tall as the box it is mounted in, and
// the table list and the rows scroll inside it; narrower, it flows with the page.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Database } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { NativeDataSummary, NativeStructure } from '../../lib/nativeHosting';
import { LoadFailure } from '../ui/LoadFailure';
import { NOTHING, readQuery, writeQuery, type BrowseState } from './address';
import { rememberPageSize, rememberedPageSize, type DataView, type TableInfo } from './format';
import { muted, strong } from './styles';
import { TableList } from './TableList';
import { TableWorkspace } from './TableWorkspace';

export interface DataManagerProps {
  appId: string;
  appSlug?: string;
  /** The installed project's version; reload when it changes. */
  version: number;
  /** The shared demo: browse only. The server says so too (`readOnly` in its answers). */
  readOnly?: boolean;
  /** The table and view to show, from the page's address. No table: open the first one. */
  table?: string;
  view?: DataView;
  /**
   * The address's query string without the "?": `q`, `filter` (the API's JSON array), `sort`,
   * `dir`, `offset`, and `row` (the open row's key as a JSON object). Rows per page is not here:
   * it is the choice this browser remembers.
   */
  query?: string;
  /**
   * Ask the page to change its address. `replace` for a change that should not add an entry to
   * the history (typing in the search box); everything else adds one.
   */
  onNavigate: (table: string | undefined, view: DataView, query?: string, options?: { replace?: boolean }) => void;
  /** What the Import view shows (the page passes its existing import panel). Without one there is no Import view. */
  importPanel?: ReactNode;
  /** Classes for the outer box, over its own. */
  className?: string;
}

/** The table list as it last loaded, and for which app. A reload that fails keeps the list it had. */
interface Loaded { appId: string; key: string; data?: NativeDataSummary; error?: string }

const shell = 'flex min-w-0 flex-col bg-white text-[13px] leading-snug text-slate-800 dark:bg-slate-950 dark:text-slate-200 lg:h-full lg:min-h-0';

export function DataManager({ appId, appSlug, version, readOnly = false, table, view = 'browse', query = '', onNavigate, importPanel, className }: DataManagerProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  // Each table's structure, fetched once for this version of the app.
  const [structures, setStructures] = useState<Record<string, NativeStructure>>({});
  const [limit, setLimit] = useState(rememberedPageSize);
  // What Browse shows is the address's to hold: read from it here, and written by asking the page.
  const state = useMemo(() => readQuery(query), [query]);

  const key = `${appId}|${version}|${reloads}`;
  useEffect(() => {
    const stop = new AbortController();
    const failed = 'The tables could not be loaded. Try again.';
    void api.getNativeDataSummary(appId, stop.signal).then(result => {
      if (stop.signal.aborted) return;
      setLoaded(before => result.error || !result.data
        ? { appId, key, data: before?.appId === appId ? before.data : undefined, error: result.error || failed }
        : { appId, key, data: result.data });
    }).catch(() => { if (!stop.signal.aborted) setLoaded(before => ({ appId, key, data: before?.appId === appId ? before.data : undefined, error: failed })); });
    return () => stop.abort();
  }, [appId, key]);

  const scope = `${appId}|${version}|`;
  const onStructure = useCallback((name: string, structure: NativeStructure) => setStructures(known => ({ ...known, [scope + name]: structure })), [scope]);
  const onRows = useCallback((name: string, rows: number) => setLoaded(before => {
    const summary = before?.data?.summary;
    if (!before?.data || !summary || !summary.tables.some(each => each.name === name && each.rows !== rows)) return before;
    return { ...before, data: { ...before.data, summary: { ...summary, tables: summary.tables.map(each => each.name === name ? { ...each, rows } : each) } } };
  }), []);
  const recount = useCallback(() => setReloads(count => count + 1), []);

  const data = loaded?.appId === appId ? loaded.data : undefined;
  const tables: TableInfo[] = data?.summary?.tables ?? data?.tables.map(name => ({ name })) ?? [];
  const current = table ?? tables[0]?.name;
  /** Ask the page for a table, a view and what Browse shows. Whatever else the address's query holds is kept. */
  const go = useCallback((name: string | undefined, next: DataView, shown: BrowseState, options?: { replace?: boolean }) => onNavigate(name, next, writeQuery(shown, query), options), [onNavigate, query]);
  const onState = useCallback((patch: Partial<BrowseState>, options?: { replace?: boolean }) => go(current, view, { ...state, ...patch }, options), [go, current, view, state]);

  if (!data) {
    return <div className={cn(shell, 'p-3', className)}>
      {loaded?.appId === appId && loaded.key === key && loaded.error
        ? <LoadFailure compact title="The app’s tables could not be loaded" message={loaded.error} onRetry={recount} />
        : <p role="status" className={cn('py-8 text-center text-xs', muted)}>Loading the tables…</p>}
    </div>;
  }

  if (data.backend === false || data.installed === false || tables.length === 0 || current === undefined) {
    return <div className={cn(shell, 'p-4', className)}>
      <div className="flex items-start gap-3">
        <Database className={cn('mt-0.5 h-5 w-5 flex-none', muted)} aria-hidden="true" />
        <div className="min-w-0">
          {data.backend === false ? <>
            <p className={cn('font-semibold', strong)}>This app keeps its data in each person’s browser</p>
            <p className={cn('mt-1', muted)}>It has no database on this site, so there are no tables to show here.</p>
          </> : data.installed === false ? <>
            <p className={cn('font-semibold', strong)}>This app has no version installed yet</p>
            <p className={cn('mt-1', muted)}>Its tables appear here once it is published.</p>
          </> : <>
            <p className={cn('font-semibold', strong)}>No tables yet</p>
            <p className={cn('mt-1', muted)}>The app makes them the first time it runs.{data.summary?.hiddenTables ? ` ${data.summary.hiddenTables === 1 ? '1 system table is' : `${data.summary.hiddenTables.toLocaleString()} system tables are`} not shown.` : ''}</p>
          </>}
        </div>
      </div>
    </div>;
  }

  const open = tables.find(each => each.name === current);
  const onLimit = (size: number) => {
    rememberPageSize(size);
    setLimit(size);
    // The page that holds the row the person was looking at.
    const offset = Math.floor(state.offset / size) * size;
    if (offset !== state.offset) onState({ offset }, { replace: true });
  };

  return <div className={cn(shell, 'lg:flex-row', className)}>
    {/* A table opened from the list shows all of it: no search, no filter, its own order, from the first row, none open. */}
    <TableList tables={tables} current={current} bytes={data.summary?.bytes} hiddenTables={data.summary?.hiddenTables} onPick={name => go(name, view, NOTHING)} />
    {open
      ? <TableWorkspace key={current} appId={appId} appSlug={appSlug} version={version} table={open} tables={tables} view={view}
          readOnly={readOnly || !!data.readOnly} structure={structures[scope + current]} onStructure={onStructure}
          state={state} limit={limit} onLimit={onLimit} importPanel={importPanel}
          onView={next => go(current, next, state)} onState={onState}
          onOpenTable={(name, patch) => go(name, 'browse', { ...NOTHING, ...patch })}
          onRows={onRows} onChanged={recount} />
      : <div className="flex min-w-0 flex-1 flex-col gap-1 p-4">
        <p className={cn('font-semibold', strong)}>This app has no table called <span className="break-all font-mono">{current}</span></p>
        <p className={muted}>It may have been renamed or removed by a newer version. Pick a table from the list.</p>
      </div>}
  </div>;
}
