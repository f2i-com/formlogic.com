// The Browse view of a table: a search across every column, filters, the page of rows (a grid,
// or cards on a phone), what to do with the ticked rows, the open row's details, and the pager.
// What is shown comes from the page's address; every change of it is asked of the page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { NativeFilter, NativeSort, NativeStructure } from '../../lib/nativeHosting';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadFailure } from '../ui/LoadFailure';
import type { BrowseState } from './address';
import { Tick } from './cells';
import { DataGrid } from './DataGrid';
import { FilterBar } from './FilterBar';
import { MAX_SEARCH, count, fieldsByName, foreignKeysByColumn, number, resolveRow, rowId, type Notice } from './format';
import { Pager } from './Pager';
import { RowCards } from './RowCards';
import { RowDetails } from './RowDetails';
import { danger, field, iconButton, line, link, muted, quietSurface, smallButton } from './styles';
import type { TablePage } from './useTablePage';
import type { Viewport } from './useViewport';

/** How long typing rests before the search is sent. */
export const SEARCH_PAUSE_MS = 300;

interface BrowseViewProps {
  appId: string;
  table: string;
  page: TablePage;
  /** What the address asks for. */
  state: BrowseState;
  limit: number;
  onLimit(size: number): void;
  /** Ask the page to change what is shown. `replace`: without a new entry in the history. */
  onState(patch: Partial<BrowseState>, options?: { replace?: boolean }): void;
  viewport: Viewport;
  readOnly: boolean;
  structure?: NativeStructure;
  /** The tables the list shows. */
  tables: ReadonlySet<string>;
  /** Open another table on these rows. */
  onOpenTable(table: string, patch: Partial<BrowseState>): void;
  /** Open the full editor on one row. */
  onEditRow(key: Record<string, string>): void;
  onNotice(notice: Notice | null): void;
  /** Rows were deleted: the tables' counts are no longer right. */
  onChanged(): void;
}

const NONE: ReadonlySet<string> = new Set();

export function BrowseView({ appId, table, page, state, limit, onLimit, onState, viewport, readOnly, structure, tables, onOpenTable, onEditRow, onNotice, onChanged }: BrowseViewProps) {
  const { data } = page;
  const phone = viewport === 'phone';
  // The ticks belong to one page of rows: they last through a reload of it, and no further.
  const [selection, setSelection] = useState<{ scope: string; ids: ReadonlySet<string> }>({ scope: page.scope, ids: NONE });
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Why the ticked rows were not deleted, for the phone's bar: what is said above the table may be a long way up from it.
  const [refused, setRefused] = useState<{ scope: string; text: string } | null>(null);

  // The search box holds what is typed; the address holds what was sent. `seen` is the address's
  // search this text already answers to, `sent` the one on its way there. When the address changes
  // to anything else (Back, a link), the box takes the address's text.
  const [box, setBox] = useState<{ text: string; seen: string; sent: string | null }>({ text: state.q, seen: state.q, sent: null });
  if (box.seen !== state.q) setBox({ text: state.q === box.sent ? box.text : state.q, seen: state.q, sent: null });
  const send = useRef(onState);
  useEffect(() => { send.current = onState; }, [onState]);
  useEffect(() => {
    const next = box.text.trim().slice(0, MAX_SEARCH);
    if (next === state.q || next === box.sent) return;
    // Typing rewrites the address in place: a search is one step back, not one per letter.
    const timer = setTimeout(() => { setBox(now => ({ ...now, sent: next })); send.current({ q: next, offset: 0 }, { replace: true }); }, SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [box.text, box.sent, state.q]);

  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const keys = data?.keys ?? [];
  const fields = fieldsByName(data?.schema?.fields);
  const narrowed = state.q !== '' || state.filters.length > 0;
  const keyed = !!data?.schema?.primaryKey.length;
  const selected = selection.scope === page.scope ? selection.ids : NONE;
  // What Delete sends: each ticked row still on the page, with the stamp this page gave it.
  const picked = keys.flatMap((key, index) => key && selected.has(rowId(key)) ? [{ key, stamp: data?.stamps?.[index] ?? '' }] : []);
  const tickable = keys.flatMap(key => key ? [rowId(key)] : []);

  // The open row: the one the address names, where this table has it.
  const open = useMemo(() => resolveRow(state.row, data), [state.row, data]);
  const openId = open ? rowId(open) : null;
  const openAt = openId === null ? -1 : keys.findIndex(key => key !== null && rowId(key) === openId);
  const neighbour = (step: 1 | -1) => { for (let at = openAt + step; openAt >= 0 && at >= 0 && at < keys.length; at += step) if (keys[at]) return keys[at]; return null; };

  const select = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    setSelection({ scope: page.scope, ids: next });
  };
  const sortBy = (sort: NativeSort | null) => onState({ sort, offset: 0 });
  const cycleSort = (column: string) => sortBy(state.sort?.column !== column ? { column, dir: 'asc' } : state.sort.dir === 'asc' ? { column, dir: 'desc' } : null);
  // A foreign key leads to one row: its table opens on that row alone, with the row open.
  const follow = (to: string, filters: NativeFilter[]) => onOpenTable(to, { filters, row: Object.fromEntries(filters.map(filter => [filter.column, filter.value ?? ''])) });

  const remove = async () => {
    setDeleting(true);
    const refuse = (text: string) => { onNotice({ tone: 'problem', text }); setRefused({ scope: page.scope, text }); };
    try {
      const result = await api.deleteNativeRecords(appId, table, picked);
      if (result.error) {
        refuse(result.error);
        // Some of these rows changed or are gone: show the page as it is now.
        if (result.status === 409) page.reload();
      } else {
        setSelection({ scope: page.scope, ids: NONE });
        setRefused(null);
        onNotice({ tone: 'done', text: `${count(result.data?.deleted ?? picked.length, 'row')} deleted.` });
        page.reload();
        onChanged();
      }
    } catch {
      refuse('The rows could not be deleted. Try again.');
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const reach = (data?.offsetLimit ?? 100000) + page.pageSize;
  const ticks = !readOnly && tickable.length > 0;
  const rowsProps = {
    appId, table, fields, stale: page.loading, editable: !readOnly, selected, onSelect: select, foreignKeys: foreignKeysByColumn(structure), tables,
    onFollow: follow, onOpenRow: (key: Record<string, string>) => onState({ row: key }), openId, onSaved: page.reload, onStale: page.reload,
    // The search the rows on screen answer (the address's, not the box's while it is typed in), marked where each matched.
    mark: state.q,
  };
  const chosen = <>
    <span role="status" className="text-xs font-semibold text-primary-700 dark:text-primary-400">{number(picked.length)} selected</span>
    <button type="button" className={smallButton} disabled={picked.length !== 1} title={picked.length === 1 ? undefined : 'Tick one row alone to edit it.'} onClick={() => onEditRow(picked[0].key)}>Edit</button>
    <button type="button" className={cn(smallButton, danger)} onClick={() => setConfirming(true)}>Delete</button>
  </>;
  const details = open && data && <RowDetails appId={appId} table={table} rowKey={open} reloads={page.reloads} preview={openAt >= 0 ? rows[openAt] : undefined} cut={openAt >= 0 ? data.cut?.[String(openAt)] : undefined}
    columns={columns} structure={structure} tables={tables} readOnly={readOnly} hiddenColumns={data.hiddenColumns ?? 0} previous={neighbour(-1)} next={neighbour(1)} sheet={viewport !== 'desktop'} mark={state.q}
    onStep={key => onState({ row: key })} onClose={() => onState({ row: null })} onFollow={follow} onUsedBy={(to, filters) => onOpenTable(to, { filters })} onEdit={onEditRow}
    onDeleted={() => { onNotice({ tone: 'done', text: 'Row deleted.' }); onState({ row: null }, { replace: true }); page.reload(); onChanged(); }} />;

  return <>
    <div className={cn('flex min-h-[38px] flex-none flex-wrap items-center gap-2 border-b px-3 py-[5px]', line, quietSurface)}>
      {/* On a phone the search and Add filter share the first line, and the filters follow under them. */}
      <label className={cn(field, 'flex max-w-[240px] flex-[1_1_180px] items-center gap-1.5 px-2 focus-within:ring-2 focus-within:ring-primary-500 max-sm:max-w-none max-sm:basis-[150px]', muted)}>
        <Search className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <input type="search" aria-label="Search this table" placeholder="Search every column" maxLength={MAX_SEARCH} value={box.text} onChange={event => setBox(now => ({ ...now, text: event.target.value }))}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-slate-900 outline-none placeholder:text-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400" />
      </label>
      <FilterBar columns={columns} fields={fields} filters={state.filters} onAdd={filter => onState({ filters: [...state.filters, filter], offset: 0 })}
        onRemove={index => onState({ filters: state.filters.filter((_, at) => at !== index), offset: 0 })} />
      <span className="flex-1 max-sm:hidden" />
      {!phone && picked.length > 0 && <span className="flex flex-wrap items-center gap-1.5">{chosen}</span>}
    </div>

    {/* A phone has no column headers to press: the order is chosen here, and so is every row of the page. */}
    {phone && data && columns.length > 0 && <div className={cn('flex flex-none items-center gap-2 border-b px-3 py-1', line)}>
      {ticks && <label className="-ml-3 flex h-11 w-11 flex-none cursor-pointer items-center justify-center">
        <Tick aria-label="Select every row on this page" checked={picked.length === tickable.length} indeterminate={picked.length > 0 && picked.length < tickable.length} onChange={event => select(tickable, event.target.checked)} />
      </label>}
      <label className={cn('flex min-w-0 flex-1 items-center gap-2 text-xs', muted)}><span className="flex-none">Sort by</span>
        <select aria-label="Sort by" value={state.sort?.column ?? ''} onChange={event => sortBy(event.target.value ? { column: event.target.value, dir: state.sort?.dir ?? 'asc' } : null)} className={cn(field, 'min-w-0 flex-1 px-2 font-mono')}>
          <option value="">its own order</option>
          {columns.map(column => <option key={column} value={column}>{column}</option>)}
          {state.sort && !columns.includes(state.sort.column) && <option value={state.sort.column}>{state.sort.column}</option>}
        </select>
      </label>
      {/* The arrow alone, to leave the width to the column's name: up is smallest first. */}
      <button type="button" className={cn(iconButton, 'border border-slate-300 dark:border-slate-700')} disabled={!state.sort} onClick={() => { if (state.sort) sortBy({ column: state.sort.column, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }); }}
        aria-label={state.sort?.dir === 'desc' ? 'Largest first. Change to smallest first.' : 'Smallest first. Change to largest first.'}>
        {state.sort?.dir === 'desc' ? <ArrowDown className="h-4 w-4" aria-hidden="true" /> : <ArrowUp className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>}

    {data?.schema && !keyed && !page.error && <p className={cn('flex-none border-b px-3 py-1.5 text-xs', line, muted)}>
      This table has no primary key, so its rows cannot be {readOnly ? 'opened one by one' : 'opened, ticked or changed'} here.
    </p>}

    <div className="flex min-w-0 lg:min-h-0 lg:flex-1">
      {/* From tablet width the grid scrolls sideways in its own box; on a wide screen it scrolls down in it too, under its header. */}
      <div className="min-w-0 flex-1 sm:overflow-x-auto lg:overflow-y-auto">
        {page.error ? <LoadFailure compact className="m-3" title="These rows could not be loaded" message={page.error} onRetry={page.reload} />
          : !data ? <p role="status" className={cn('px-3 py-8 text-center text-xs', muted)}>Loading rows…</p>
          : columns.length === 0 ? <p className={cn('px-3 py-8 text-center text-xs', muted)}>This table has no columns that can be shown.</p>
          : <>
            {phone ? <RowCards {...rowsProps} data={data} /> : <DataGrid {...rowsProps} data={data} sort={state.sort} onSort={cycleSort} />}
            {rows.length === 0 && !page.loading && <p className={cn('sticky left-0 px-3 py-8 text-center text-xs', muted)}>
              {narrowed
                ? <>No rows match. <button type="button" className={cn(link, 'font-medium max-sm:min-h-10')} onClick={() => onState({ q: '', filters: [], offset: 0 })}>Clear the search and filters</button></>
                : readOnly || data.schema?.canCreate === false ? 'No rows in this table yet.' : 'No rows in this table yet. Add row puts the first one in.'}
            </p>}
          </>}
      </div>
      {viewport === 'desktop' && details}
    </div>
    {viewport !== 'desktop' && details}

    {data?.end === 'limit' && !page.error && <p role="status" className="flex-none border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
      Paging reaches the first {number(reach)} rows. To see the rest, narrow them with a search or a filter, or export the table.
    </p>}
    <Pager page={page} narrowed={narrowed} limit={limit} onLimit={onLimit} onGo={offset => onState({ offset })}
      notes={!readOnly && keyed ? [phone ? 'Open a row out to edit its values' : 'Double-click a cell to edit', 'Edits go straight to the app’s database'] : []} />

    {/* On a phone the ticked rows' buttons stay in reach while the cards scroll: above the page's bottom navigation, with room left under the pager to scroll clear of them. */}
    {phone && picked.length > 0 && <>
      <div className="h-16 flex-none" aria-hidden="true" />
      {createPortal(<div role="group" aria-label="Ticked rows" className="fixed inset-x-2 bottom-[calc(var(--fl-mobile-nav-h,0px)+0.5rem)] z-40 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-1.5 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        {refused?.scope === page.scope && <p role="alert" className="basis-full text-xs leading-normal text-red-700 dark:text-red-300">{refused.text}</p>}
        {chosen}
        <button type="button" className={cn(iconButton, 'ml-auto')} aria-label="Untick every row" onClick={() => { setSelection({ scope: page.scope, ids: NONE }); setRefused(null); }}><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>, document.body)}
    </>}

    <ConfirmDialog isOpen={confirming} variant="danger" isLoading={deleting}
      title={picked.length === 1 ? 'Delete this row?' : `Delete ${number(picked.length)} rows?`}
      message={`${picked.length === 1 ? 'The row is' : 'The rows are'} removed from ${table} for good, and the app sees it at once. Rows in other tables that depend on ${picked.length === 1 ? 'it' : 'them'} may be deleted too, and the app’s delete automations run.`}
      confirmLabel={picked.length === 1 ? 'Delete the row' : `Delete ${number(picked.length)} rows`}
      onClose={() => { if (!deleting) setConfirming(false); }} onConfirm={() => void remove()} />
  </>;
}
