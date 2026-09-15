import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, RefreshCw, Search, Table2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { NativeRecords } from '../../lib/nativeHosting';
import { Button } from '../ui/Button';
import { NativeRecordEditor } from './NativeRecordEditor';

const valueText = (value: unknown) => value === null || value === undefined ? '—' : String(value);

/** `readOnly` (the shared demo): records and their details can be browsed; adding and editing are not offered. */
export function NativeRecordsBrowser({ appId, version, initialTable = '', readOnly: readOnlyProp = false }: { appId: string; version: number; initialTable?: string; readOnly?: boolean }) {
  const [table, setTable] = useState(initialTable);
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<NativeRecords | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [editor, setEditor] = useState<{ key?: Record<string, string> } | null>(null);
  const [notice, setNotice] = useState('');
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    // Reset the visible page when its request key changes; never display stale rows as current.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setSelected(null); setQuery('');
    void api.getNativeRecords(appId, table || undefined, offset).then(result => {
      if (cancelled) return;
      setLoading(false);
      if (result.error) { setError(result.error); return; }
      setRecords(result.data ?? null);
    }).catch(() => { if (!cancelled) { setLoading(false); setError('Could not load these records. Please try again.'); } });
    return () => { cancelled = true; };
  }, [appId, version, table, offset, reload]);
  useEffect(() => { if (selected !== null) detail.current?.focus(); }, [selected]);
  // The server says so too, for a caller that did not know.
  const readOnly = readOnlyProp || !!records?.readOnly;
  const columns = records?.columns ?? [];
  const rows = records?.rows ?? [];
  const visibleRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => !query.trim() || columns.some(column => valueText(row[column]).toLowerCase().includes(query.trim().toLowerCase())));
  const shownRecord = selected === null ? null : rows[selected];
  const control = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';
  // Audit FL-S06: the server clamps offsets to its browsing window, so the
  // page it answered with is the page shown, not the one asked for; the
  // pager continues from there, and stops where the server says it stops.
  // Its steps are the server's page size (`limit`), not the window (`offsetLimit`).
  // The last page starts at `offsetLimit`, so the browser reaches one page past it.
  const pageSize = records?.limit || 50;
  const reachable = (records?.offsetLimit ?? 100000) + pageSize;
  const effectiveOffset = typeof records?.offset === 'number' && !loading && !error ? records.offset : offset;
  const page = Math.floor(effectiveOffset / pageSize) + 1;
  const end = records?.end ?? (records?.hasMore ? 'more' : 'end');
  const hasData = !!table && !loading && !error;
  const canGoNext = hasData && end === 'more';
  const pagination = <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
    <p aria-live="polite" className="text-sm text-slate-500 dark:text-slate-400">Page {page}{hasData && rows.length > 0 ? ` · Rows ${effectiveOffset + 1}–${effectiveOffset + rows.length}` : ''}</p>
    <div className="flex gap-2"><Button variant="secondary" className="min-h-11" disabled={loading || effectiveOffset === 0} onClick={() => setOffset(Math.max(0, effectiveOffset - pageSize))} leftIcon={<ChevronLeft className="h-4 w-4" />}>Previous</Button><Button variant="secondary" className="min-h-11" disabled={!canGoNext} onClick={() => setOffset(effectiveOffset + pageSize)} rightIcon={<ChevronRight className="h-4 w-4" />}>Next</Button></div>
  </div>;
  return <section aria-label="Database records browser" className="space-y-4">
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Database className="h-4 w-4" />App database<span className="ml-auto rounded-full border border-slate-300 px-2 py-1 text-xs font-normal text-slate-600 dark:border-slate-600 dark:text-slate-300">{readOnly ? 'Read-only' : 'Owner controls'}</span></div>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">{readOnly ? 'Browse the records used by this app and open one to see its values. This is the shared demo, so records cannot be added, edited or deleted.' : 'Browse and manage the records used by this app. Open a record to edit its fields or delete it, or add a new record to the selected table.'}</p>
    </div>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="block min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-200">Table<select aria-label="Database table" className={`${control} mt-2`} value={table} disabled={loading && !records} onChange={event => { setTable(event.target.value); setNotice(''); setOffset(0); setRecords(current => current ? { tables: current.tables, readOnly: current.readOnly } : null); }}><option value="">Choose a table ({records?.tables.length ?? 0})</option>{records?.tables.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <Button variant="secondary" className="min-h-11" isLoading={loading} disabled={loading} onClick={() => setReload(value => value + 1)} leftIcon={<RefreshCw className="h-4 w-4" />}>Refresh records</Button>
    </div>
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{notice}</p>}
    {editor && !readOnly && records?.schema && <NativeRecordEditor appId={appId} table={table} recordKey={editor.key} fields={records.schema.fields} onClose={() => setEditor(null)} onSaved={message => { setEditor(null); setNotice(message); setOffset(0); setReload(value => value + 1); }} />}
    {error && <div role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error} <button className="min-h-11 underline" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
    {loading && <div role="status" className="rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">Loading records…</div>}
    {!table && !loading && !error && <div className="rounded-xl border border-dashed border-slate-300 px-5 py-9 text-center dark:border-slate-700"><Table2 className="mx-auto h-7 w-7 text-slate-400" /><h4 className="mt-3 font-medium text-slate-900 dark:text-white">Choose a table to explore</h4><p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{records?.tables.length ? `${records.tables.length} tables are available in this app.` : 'This app has no application tables yet.'}</p></div>}
    {hasData && <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h4 className="break-words font-semibold text-slate-900 dark:text-white">{table}</h4><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{columns.length} fields shown · up to {pageSize} records per page</p></div>
        {rows.length > 0 && <label className="relative block min-w-0 sm:w-64"><Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><span className="sr-only">Filter records on this page</span><input type="search" aria-label="Filter records on this page" value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} placeholder="Filter this page…" className={`${control} pl-9`} /></label>}
      </div>
      {records?.schema && !readOnly && <div className="flex flex-wrap items-center gap-3"><Button className="min-h-11" disabled={!records.schema.canCreate} onClick={() => setEditor({})}>Add record</Button><p className="flex-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{!records.schema.canCreate ? 'Required private or binary fields must be created through the app.' : !records.schema.primaryKey.length ? 'This table needs a visible primary key before existing records can be edited or deleted.' : 'Open a record below to edit its full values. Primary keys stay unchanged.'}</p></div>}
      {rows.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700"><p className="text-sm text-slate-600 dark:text-slate-400">{columns.length === 0 ? 'This table has no displayable columns.' : effectiveOffset ? 'No more records on this page. Go back to the previous page.' : 'No records in this table yet.'}</p></div> : visibleRows.length === 0 ? <p className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">No matching records on this page. Clear the filter or try another page.</p> : <>
        <div className="hidden max-h-[52vh] overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 sm:block"><table className="w-full text-left text-sm"><thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"><tr><th className="p-3"><span className="sr-only">Record details</span></th>{columns.map(column => <th className="whitespace-nowrap p-3 font-medium" key={column}>{column}</th>)}</tr></thead><tbody>{visibleRows.map(({ row, index }) => <tr key={index} className="border-t border-slate-200 text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800/50"><td className="p-2"><button aria-label={`View record ${effectiveOffset + index + 1}`} className="min-h-11 rounded-lg px-3 text-indigo-700 underline dark:text-indigo-300" onClick={() => setSelected(index)}>View</button></td>{columns.map(column => <td key={column} className="min-w-28 max-w-72 p-3 align-top"><span className="line-clamp-3 break-words">{valueText(row[column])}</span></td>)}</tr>)}</tbody></table></div>
        <div className="space-y-3 sm:hidden">{visibleRows.map(({ row, index }) => <article key={index} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"><div className="flex items-center justify-between gap-2"><h5 className="text-sm font-semibold text-slate-900 dark:text-white">Record {effectiveOffset + index + 1}</h5><button className="min-h-11 text-sm text-indigo-700 underline dark:text-indigo-300" onClick={() => setSelected(index)}>View details</button></div><dl className="mt-2 space-y-3">{columns.slice(0, 3).map(column => <div key={column}><dt className="break-words text-xs text-slate-500 dark:text-slate-400">{column}</dt><dd className="mt-1 line-clamp-3 break-words text-sm text-slate-800 dark:text-slate-200">{valueText(row[column])}</dd></div>)}</dl>{columns.length > 3 && <p className="mt-3 text-xs text-slate-500">+{columns.length - 3} more fields in details</p>}</article>)}</div>
      </>}
      {end === 'limit' && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">This browser shows the first {reachable.toLocaleString()} records of this table. Use the app itself, a narrower table, or an export to reach the rest.</p>}
      {pagination}
      {shownRecord && <div ref={detail} tabIndex={-1} aria-label={`Record ${effectiveOffset + selected! + 1} details`} className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 focus:outline-none dark:border-indigo-500/40 dark:bg-indigo-950/20"><div className="flex items-center justify-between gap-3"><h4 className="font-semibold text-slate-900 dark:text-white">Record {effectiveOffset + selected! + 1}</h4>{!readOnly && records?.keys?.[selected!] && <Button variant="secondary" className="ml-auto min-h-11" onClick={() => setEditor({ key: records.keys![selected!]! })}>Edit record</Button>}<button aria-label="Close record details" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" onClick={() => setSelected(null)}><X className="h-5 w-5" /></button></div>{!readOnly && records?.schema && !records.keys?.[selected!] && <p className="text-xs text-slate-500 dark:text-slate-400">This record needs a complete, visible primary key before it can be edited or deleted.</p>}<dl className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">{columns.map(column => <div key={column} className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4"><dt className="break-words text-xs font-medium text-slate-500 dark:text-slate-400">{column}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-sm text-slate-900 [overflow-wrap:anywhere] dark:text-slate-200">{valueText(shownRecord[column])}</dd></div>)}</dl></div>}
      <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">Common authentication secrets and host metadata are hidden. Text values are previews of up to 400 characters; binary values are labelled. Filtering searches this page only.</p>
    </>}
  </section>;
}
