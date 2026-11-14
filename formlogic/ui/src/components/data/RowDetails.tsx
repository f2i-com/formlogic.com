// One row, opened: every shown column with its whole value (the list holds 400-character
// previews; the row is read for the rest), links along its foreign keys, the tables that point at
// it, and Edit and Delete. Beside the grid on a wide screen; over the page on a narrower one.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { NativeFilter, NativeRecordDetail, NativeStructure } from '../../lib/nativeHosting';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CellValue, Marked } from './cells';
import { count, foreignKeyFilters, foreignKeysByColumn, rowId, rowTitle } from './format';
import { body, danger, focusRing, iconButton, line, link, muted, panelHeading, quietSurface, smallButton, strong } from './styles';

interface RowDetailsProps {
  appId: string;
  table: string;
  /** The row's key. */
  rowKey: Record<string, string>;
  /** The row as the page of rows holds it, when it is on the page: previews, shown until the whole row has been read. */
  preview?: Record<string, unknown>;
  /** The preview's columns whose text was cut. */
  cut?: string[];
  /** The table's shown columns, in order. */
  columns: string[];
  structure?: NativeStructure;
  /** The tables the list shows. */
  tables: ReadonlySet<string>;
  /** Read-only mode: the row is not read (a read is a request the shared demo refuses), nor changed. */
  readOnly: boolean;
  /** Counts the changes made on this page of rows: the row is read again after each, since it may be the one changed. */
  reloads: number;
  /** How many of the table's columns are never shown. */
  hiddenColumns: number;
  /** The rows before and after this one on the page of rows. */
  previous?: Record<string, string> | null;
  next?: Record<string, string> | null;
  /** Over the page (a phone, a tablet) rather than beside the grid. */
  sheet: boolean;
  onStep(key: Record<string, string>): void;
  onClose(): void;
  /** Follow a foreign key to the row it points at. */
  onFollow(table: string, filters: NativeFilter[]): void;
  /** Open a table that points here, filtered to the rows that point at this one. */
  onUsedBy(table: string, filters: NativeFilter[]): void;
  /** Open the whole row in the row editor. */
  onEdit(key: Record<string, string>): void;
  /** The row was deleted. */
  onDeleted(): void;
  /** What the rows were searched for: marked in the values (cells' Marked). */
  mark?: string;
}

interface Read { id: string; record?: NativeRecordDetail; error?: string }

export function RowDetails({ appId, table, rowKey, preview, cut = [], columns, structure, tables, readOnly, reloads, hiddenColumns, previous, next, sheet, onStep, onClose, onFollow, onUsedBy, onEdit, onDeleted, mark }: RowDetailsProps) {
  const id = rowId(rowKey);
  const [read, setRead] = useState<Read | null>(null);
  const [again, setAgain] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refusal, setRefusal] = useState<{ id: string; text: string } | null>(null);

  // The key as text: the page hands over a new object that says the same key each time its rows or
  // its address change, and that alone must not read the row again.
  const keyText = JSON.stringify(rowKey);
  useEffect(() => {
    if (readOnly) return;
    let dropped = false;
    const unread = 'This row could not be read. Try again.';
    void api.manageNativeRecord(appId, { table, action: 'read', key: JSON.parse(keyText) as Record<string, string> }).then(result => {
      if (dropped) return;
      const record = result.data?.record;
      setRead(result.error || !record ? { id, error: result.error || unread } : { id, record });
    }).catch(() => { if (!dropped) setRead({ id, error: unread }); });
    return () => { dropped = true; };
  }, [appId, table, keyText, id, readOnly, again, reloads]);

  // What was read belongs to one row: stepping to another shows that row's preview, not this one's values.
  const record = read?.id === id ? read.record : undefined;
  const failure = read?.id === id && !record ? read.error ?? '' : '';
  const names = columns.length ? columns : record?.fields.map(field => field.name) ?? Object.keys(rowKey);
  const foreign = foreignKeysByColumn(structure);
  /** A column's value: the whole one once the row is read, the list's preview until then. `undefined`: neither holds it. */
  const valueOf = (column: string): unknown => record && column in record.values ? record.values[column] : preview && column in preview ? preview[column] : column in rowKey ? rowKey[column] : undefined;
  const isPreview = (column: string) => !(record && column in record.values) && cut.includes(column);
  const values: Record<string, unknown> = Object.fromEntries(names.map(column => [column, valueOf(column)]));
  const waiting = !readOnly && !record && !failure;
  const usedBy = (structure?.referencedBy ?? []).filter(use => tables.has(use.table)).map(use => {
    // The rows of the other table that point at this one: each of its columns holds this row's value of the column it points at.
    const filters: NativeFilter[] = [];
    for (let at = 0; at < use.columns.length; at++) {
      const value = values[use.to?.[at] ?? ''];
      if (value === null || value === undefined) return null;
      filters.push({ column: use.columns[at], op: 'eq', value: String(value) });
    }
    return { use, filters };
  }).filter((each): each is NonNullable<typeof each> => each !== null);

  const remove = async () => {
    setDeleting(true);
    const undone = 'The row could not be deleted. Try again.';
    try {
      const result = await api.manageNativeRecord(appId, { table, action: 'delete', key: rowKey, revision: record?.revision });
      if (result.error) {
        setRefusal({ id, text: result.error });
        // The row changed since it was read: read it again, so what is shown is what would be deleted.
        if (result.status === 409) setAgain(turn => turn + 1);
      } else onDeleted();
    } catch { setRefusal({ id, text: undone }); }
    finally { setDeleting(false); setConfirming(false); }
  };

  const title = rowTitle(rowKey);
  const content = <>
    <header className={cn('flex flex-none items-center gap-1 border-b px-2 py-1.5', line, quietSurface)}>
      {sheet && <button type="button" onClick={onClose} className={cn(smallButton, 'h-8 border-0 px-2 max-sm:h-11')}><ArrowLeft className="h-4 w-4" aria-hidden="true" />Back</button>}
      <div className="min-w-0 flex-1 px-1">
        <p className={cn('truncate font-mono text-[11px]', muted)} title={table}>{table}</p>
        <h3 className={cn('truncate font-mono text-[13px] font-semibold', strong)} title={title}>{title}</h3>
      </div>
      <button type="button" className={iconButton} disabled={!previous} onClick={() => { if (previous) onStep(previous); }} aria-label="Previous row on this page"><ChevronUp className="h-4 w-4" aria-hidden="true" /></button>
      <button type="button" className={iconButton} disabled={!next} onClick={() => { if (next) onStep(next); }} aria-label="Next row on this page"><ChevronDown className="h-4 w-4" aria-hidden="true" /></button>
      {!sheet && <button type="button" className={iconButton} onClick={onClose} aria-label="Close this row"><X className="h-4 w-4" aria-hidden="true" /></button>}
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {failure && <div role="alert" className="mb-2 rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-500/10 dark:text-red-200">
        {failure} <button type="button" className={cn('font-medium underline underline-offset-2', focusRing)} onClick={() => setAgain(turn => turn + 1)}>Try again</button>
      </div>}
      {waiting && <p role="status" className={cn('mb-1 text-[11px]', muted)}>{preview ? 'Reading the whole row…' : 'Reading the row…'}</p>}
      {readOnly && cut.length > 0 && <p className={cn('mb-1 text-[11px]', muted)}>Long text is shown in part here.</p>}
      {/* Read-only mode reads no row by itself: a row that is not among the rows shown has nothing to show. */}
      {readOnly && !preview && <p className={cn('text-xs', muted)}>This row is not among the rows shown. Find it in the table to see its values.</p>}

      {(preview || record) && <dl aria-busy={waiting || undefined}>
        {names.map(column => {
          const value = values[column];
          const key = value !== null && value !== undefined && value !== '' ? foreign[column] : undefined;
          const target = key && tables.has(key.table) ? foreignKeyFilters(key, values) : null;
          return <div key={column} data-column={column} className={cn('border-b py-1.5 last:border-b-0', line)}>
            <dt className={cn('truncate font-mono text-[11px]', muted)} title={column}>{column}</dt>
            <dd className={cn('mt-0.5 max-h-56 overflow-y-auto font-mono text-xs', body)}>
              {value === undefined ? <span className={muted}>Not shown here: binary, or too long.</span>
                : target && key ? <button type="button" onClick={() => onFollow(key.table, target)}
                    aria-label={`${String(value)}: open ${key.table} where ${target.map(filter => `${filter.column} is ${filter.value}`).join(' and ')}`}
                    className={cn('inline-flex max-w-full items-center gap-1 rounded-sm text-left max-sm:min-h-10', link, focusRing)}>
                    <span className="min-w-0 [overflow-wrap:anywhere]"><Marked text={String(value)} mark={mark} /></span><ArrowUpRight className="h-3 w-3 flex-none" strokeWidth={2.4} aria-hidden="true" />
                  </button>
                : <CellValue value={value} cut={isPreview(column)} wrap mark={mark} />}
            </dd>
          </div>;
        })}
      </dl>}
      {hiddenColumns > 0 && <p className={cn('mt-2 text-[11px]', muted)}>{count(hiddenColumns, 'column')} not shown.</p>}

      {structure && <section aria-label="Used by" className="mt-3">
        <h4 className={panelHeading}>Used by</h4>
        {usedBy.length === 0
          ? <p className={cn('mt-1 text-xs', muted)}>{structure.referencedBy.length ? 'The tables that point here cannot be opened from this row.' : 'No other table points at this one.'}</p>
          : <ul className="mt-1">
            {usedBy.map(({ use, filters }) => <li key={`${use.table}.${use.columns.join(',')}`}>
              <button type="button" onClick={() => onUsedBy(use.table, filters)}
                aria-label={`${use.table}.${use.columns.join(', ')}: open ${use.table} where ${filters.map(filter => `${filter.column} is ${filter.value}`).join(' and ')}`}
                className={cn('inline-flex min-h-6 max-w-full items-center gap-1 rounded-sm text-left font-mono text-xs max-sm:min-h-10', link, focusRing)}>
                <span className="min-w-0 [overflow-wrap:anywhere]">{use.table}.{use.columns.join(', ')}</span><ArrowUpRight className="h-3 w-3 flex-none" strokeWidth={2.4} aria-hidden="true" />
              </button>
            </li>)}
          </ul>}
      </section>}
    </div>

    {!readOnly && <footer className={cn('flex flex-none flex-wrap items-center gap-2 border-t px-3 py-2', line, quietSurface)}>
      {refusal?.id === id && <p role="alert" className="basis-full text-xs text-red-700 dark:text-red-300">{refusal.text}</p>}
      <button type="button" className={cn(smallButton, 'h-7')} onClick={() => onEdit(rowKey)}>Edit</button>
      <button type="button" className={cn(smallButton, 'h-7', danger)} disabled={!record} onClick={() => setConfirming(true)}>Delete</button>
    </footer>}

    <ConfirmDialog isOpen={confirming} variant="danger" isLoading={deleting} title="Delete this row?"
      message={`The row is removed from ${table} for good, and the app sees it at once. Rows in other tables that depend on it may be deleted too, and the app’s delete automations run.`}
      confirmLabel="Delete the row" onClose={() => { if (!deleting) setConfirming(false); }} onConfirm={() => void remove()} />
  </>;

  const label = `Row ${title} of ${table}`;
  if (sheet) return <Sheet label={label} onClose={onClose}>{content}</Sheet>;
  // Escape closes the panel from inside it. A dialog opened from it (the delete's question) is elsewhere in the page: its Escape is its own.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => { if (event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) { event.stopPropagation(); onClose(); } };
  return <aside aria-label={label} onKeyDown={onKeyDown} className={cn('flex w-[360px] flex-none flex-col border-l xl:w-[400px] 2xl:w-[420px]', line)}>{content}</aside>;
}

/**
 * The details over the page: the whole screen on a phone, a panel down the right on a tablet.
 * A dialog: the focus moves into it and stays, Escape and Back close it, and the page behind
 * does not scroll.
 */
function Sheet({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  useFocusTrap(surface, true, onClose);
  return createPortal(<div className="fixed inset-0 z-50 flex justify-end">
    <div className="absolute inset-0 bg-black/50 max-sm:hidden" onMouseDown={onClose} aria-hidden="true" />
    <div ref={surface} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      className="relative flex h-full w-full flex-col bg-white pb-[env(safe-area-inset-bottom)] text-[13px] leading-snug text-slate-800 shadow-2xl outline-none dark:bg-slate-950 dark:text-slate-200 sm:w-[26rem] sm:border-l sm:border-slate-200 sm:dark:border-slate-800">
      {children}
    </div>
  </div>, document.body);
}
