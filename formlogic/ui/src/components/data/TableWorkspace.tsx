// One open table: its name and counts, the views as tabs, Add row, and the view that is showing.
// On a wide screen it is a column as tall as the manager: the name and the tabs stay at the top,
// the view scrolls in the middle, and (in Browse) the pager stays at the bottom.
import { useCallback, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { NativeStructure } from '../../lib/nativeHosting';
import { NativeRecordEditor, type RowSaved } from '../studio/NativeRecordEditor';
import type { BrowseState } from './address';
import { BrowseView } from './BrowseView';
import { ExportView } from './ExportView';
import { DATA_VIEWS, VIEW_LABELS, count, resolveRow, rowId, type DataView, type Notice, type TableInfo } from './format';
import { StructureView } from './StructureView';
import { focusRing, line, muted, smallButton, strong } from './styles';
import { useTablePage } from './useTablePage';
import { useViewport } from './useViewport';

interface TableWorkspaceProps {
  appId: string;
  appSlug?: string;
  version: number;
  table: TableInfo;
  /** Every table the list shows. */
  tables: TableInfo[];
  view: DataView;
  /** The shared demo, by the page's word or the server's. */
  readOnly: boolean;
  /** This table's structure, once it has been fetched. */
  structure?: NativeStructure;
  onStructure(table: string, structure: NativeStructure): void;
  /** What the address asks the Browse view to show. */
  state: BrowseState;
  /** The rows-per-page choice. */
  limit: number;
  onLimit(size: number): void;
  importPanel?: ReactNode;
  onView(view: DataView): void;
  /** Ask the page to change what Browse shows. `replace`: without a new entry in the history. */
  onState(patch: Partial<BrowseState>, options?: { replace?: boolean }): void;
  /** Open another table in Browse, on the rows named (all of them when none are). */
  onOpenTable(table: string, patch?: Partial<BrowseState>): void;
  /** How many rows the table holds, as a page of it just said. */
  onRows(table: string, rows: number): void;
  /** Rows were added or removed: the tables' counts are no longer right. */
  onChanged(): void;
}

export function TableWorkspace({ appId, appSlug, version, table, tables, view, readOnly: readOnlyProp, structure, onStructure, state, limit, onLimit, importPanel, onView, onState, onOpenTable, onRows, onChanged }: TableWorkspaceProps) {
  const base = useId();
  const name = table.name;
  const viewport = useViewport();
  // Import is the page's own panel: without one there is no such view.
  const views = importPanel ? DATA_VIEWS : DATA_VIEWS.filter(each => each !== 'import');
  const shown = views.includes(view) ? view : 'browse';
  // The page of rows is wanted in every view: its answer says whether rows can be added here, so
  // Add row is the same wherever it is pressed. In read-only mode nothing is added: Browse alone needs it.
  const page = useTablePage(appId, version, name, state, limit, shown === 'browse', !readOnlyProp,
    useCallback((offset: number) => onState({ offset }, { replace: true }), [onState]));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editor, setEditor] = useState<{ key?: Record<string, string> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [structureFailure, setStructureFailure] = useState<{ attempt: number; text: string } | null>(null);

  // The structure is fetched once per table (the manager keeps it): Browse reads its foreign keys, Structure shows it all.
  const wanted = (shown === 'browse' || shown === 'structure') && !structure;
  useEffect(() => {
    if (!wanted) return;
    const stop = new AbortController();
    const failed = 'The structure could not be loaded. Try again.';
    void api.getNativeStructure(appId, name, stop.signal).then(result => {
      if (stop.signal.aborted) return;
      if (result.error || !result.data) setStructureFailure({ attempt, text: result.error || failed });
      else onStructure(name, result.data);
    }).catch(() => { if (!stop.signal.aborted) setStructureFailure({ attempt, text: failed }); });
    return () => stop.abort();
  }, [wanted, appId, name, attempt, onStructure]);

  // A page of rows counts the table as it is now: the list and the line above follow it.
  const total = page.data?.total;
  useEffect(() => { if (typeof total === 'number') onRows(name, total); }, [name, total, onRows]);

  const readOnly = readOnlyProp || !!page.data?.readOnly || !!structure?.readOnly;
  const schema = page.data?.schema;
  // The counts in the line above: what a page of the rows last said, else what the list said.
  const rows = total ?? table.rows;
  const columns = page.data?.columns?.length ?? table.columns;
  const listed = new Set(tables.map(each => each.name));

  const saved = (outcome: RowSaved, made?: Record<string, string>) => {
    const removed = outcome === 'deleted';
    const added = outcome === 'created';
    setEditor(null);
    setNotice({ tone: 'done', text: added ? 'Row added.' : removed ? 'Row deleted.' : 'Row saved.' });
    // A row that is gone has no details to show: if it is the open one, it closes.
    const open = resolveRow(state.row, page.data);
    if (removed && open && editor?.key && rowId(open) === rowId(editor.key)) onState({ row: null }, { replace: true });
    // A row added is opened beside the rows, wherever it falls among them (usually on the last page), with what the database gave it: its number, its defaults.
    else if (added && made && shown === 'browse') onState({ row: made });
    page.reload();
    if (added || removed) onChanged();
  };

  // The tab pattern, activated by hand: the arrow keys move between tabs, Enter or Space opens one.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const to = event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (at < 0 || to < 0) return;
    event.preventDefault();
    tabs[to].focus();
  };

  return <section aria-label={`Table ${name}`} className="flex min-w-0 flex-1 flex-col lg:min-h-0">
    <div className={cn('flex min-h-10 flex-none flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-[5px]', line)}>
      {/* Below a wide screen the picker above already names the table and counts its rows: the heading is there for a screen reader, and the room goes to the tabs and Add row. */}
      <h2 className={cn('min-w-0 max-w-full truncate font-mono text-sm font-semibold max-lg:sr-only', strong)} title={name}>{name}</h2>
      <span className={cn('text-xs max-lg:sr-only', muted)}>{[typeof rows === 'number' ? count(rows, 'row') : '', typeof columns === 'number' ? count(columns, 'column') : ''].filter(Boolean).join(' · ')}</span>
      {readOnly && <span className="rounded border border-slate-300 px-1.5 py-px text-[11px] font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300">Read-only</span>}
      {/* The tabs scroll sideways if they ever outgrow their line; Add row moves to the next one when there is no room beside them. */}
      <div role="tablist" aria-label="Table views" className="flex min-w-0 max-w-full gap-0.5 overflow-x-auto sm:ml-1.5" onKeyDown={onTabKey}>
        {views.map(each => {
          const selected = each === shown;
          return <button key={each} type="button" role="tab" id={`${base}-tab-${each}`} aria-selected={selected} aria-controls={`${base}-panel`} tabIndex={selected ? 0 : -1} onClick={() => onView(each)}
            className={cn('h-7 flex-none rounded-md px-2.5 text-xs font-medium max-sm:h-10 max-sm:px-3', focusRing,
              selected ? 'bg-slate-200/80 text-slate-900 dark:bg-slate-800 dark:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-white')}>
            {VIEW_LABELS[each]}
          </button>;
        })}
      </div>
      {/* The same in every view: offered once the table has said rows can be made here, and the reason given when they cannot.
          At the end of the tabs' line, on a phone as a plus a finger wide, so it takes no line of its own. */}
      {!readOnly && schema && (schema.canCreate
        ? <button type="button" title="Add row" className={cn(smallButton, 'ml-auto h-7 px-2.5 max-sm:w-10 max-sm:px-0')} onClick={() => setEditor({})}>
          <Plus className="h-3 w-3 max-sm:h-4 max-sm:w-4" strokeWidth={2.4} aria-hidden="true" /><span className="max-sm:sr-only">Add row</span>
        </button>
        : <span className={cn('ml-auto text-xs', muted)}>Add rows in the app: a required column here is secret or binary.</span>)}
    </div>

    {notice && <div role={notice.tone === 'problem' ? 'alert' : 'status'}
      className={cn('flex flex-none items-start gap-2 border-b px-3 py-1.5 text-xs', line, notice.tone === 'problem' ? 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200')}>
      <span className="min-w-0 flex-1 break-words">{notice.text}</span>
      <button type="button" aria-label="Dismiss this message" onClick={() => setNotice(null)} className={cn('-my-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 max-sm:-my-2 max-sm:h-10 max-sm:w-10', focusRing)}><X className="h-3 w-3" aria-hidden="true" /></button>
    </div>}

    <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${shown}`} className={cn('flex min-w-0 flex-1 flex-col lg:min-h-0', shown !== 'browse' && 'lg:overflow-y-auto')}>
      {shown === 'browse' && <BrowseView appId={appId} table={name} page={page} state={state} limit={limit} onLimit={onLimit} onState={onState} viewport={viewport} readOnly={readOnly}
        structure={structure} tables={listed} onOpenTable={onOpenTable} onEditRow={key => setEditor({ key })} onNotice={setNotice} onChanged={onChanged} />}
      {shown === 'structure' && <StructureView structure={structure} error={!structure && structureFailure?.attempt === attempt ? structureFailure.text : ''} onRetry={() => setAttempt(tries => tries + 1)}
        tables={tables} onOpenTable={onOpenTable} phone={viewport === 'phone'} />}
      {shown === 'export' && <ExportView appId={appId} appSlug={appSlug} table={table} tables={tables} state={state} matching={page.loading ? undefined : page.data?.matching} />}
      {shown === 'import' && <div className="p-3">{importPanel}</div>}
    </div>

    {editor && !readOnly && schema && <NativeRecordEditor appId={appId} table={name} recordKey={editor.key} fields={schema.fields} onClose={() => setEditor(null)} onSaved={saved} />}
  </section>;
}
