// One page of a table's rows, as a grid (from tablet width up): sortable headers, a tick per row,
// the key as the way into a row's details, links along foreign keys, and cells edited in place.
//
// The keyboard: the grid is one stop in the tab order. Arrow keys, Home and End move between
// cells (a header's sort button and a row's tick are their cell's stop); Enter or F2 on a cell
// edits it; in the editor Enter saves and Escape cancels. A cell that opens a row or follows a
// foreign key holds a button, reached with Tab from that cell.
import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { NativeBrowse, NativeFilter, NativeForeignKey, NativeRecordField, NativeSort } from '../../lib/nativeHosting';
import { CellEditor, CellValue, Tick } from './cells';
import { cellKind, cellText, foreignKeyFilters, isNumericType, rowId, rowName } from './format';
import { body, focusRing, line, link, openRow, strong, tickedRow } from './styles';
import { useCellEdit } from './useCellEdit';

interface DataGridProps {
  appId: string;
  table: string;
  /** The page of rows shown. */
  data: NativeBrowse;
  fields: Record<string, NativeRecordField>;
  /** A newer page is on its way: these rows stay, dimmed. */
  stale: boolean;
  sort: NativeSort | null;
  /** A header was pressed: ascending, then descending, then the table's own order. */
  onSort(column: string): void;
  /** Rows can be ticked and cells edited (never in read-only mode). */
  editable: boolean;
  /** The ticked rows, by `rowId`. */
  selected: ReadonlySet<string>;
  onSelect(ids: string[], on: boolean): void;
  foreignKeys: Record<string, NativeForeignKey>;
  /** The tables the list shows: a key that points at any other is not a link. */
  tables: ReadonlySet<string>;
  /** Follow a foreign key to the row it points at. */
  onFollow(table: string, filters: NativeFilter[]): void;
  /** Open a row's details. */
  onOpenRow(key: Record<string, string>): void;
  /** The row whose details are open, by `rowId`. */
  openId: string | null;
  /** A cell was saved: load this same page again. */
  onSaved(): void;
  /** The server said the row changed under an edit: load this page again. */
  onStale(): void;
}

const cellBase = 'h-[26px] scroll-mt-7 border-b border-slate-100 px-[5px] first:pl-3 last:pr-3 dark:border-slate-800/70';
/** The cell that has the focus is ringed, by click as by key: Enter edits it. */
const cellFocus = 'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500';
const headCell = 'sticky top-0 z-10 h-7 border-b bg-slate-100 dark:bg-slate-900';
/**
 * The last cell of every row: empty, and as wide as whatever the columns leave. The columns then
 * keep the width of what they hold and sit together at the left, as in a database tool, instead of
 * being spread across a wide screen; the row's line and its hover still run the whole width.
 */
const filler = (className: string) => <td aria-hidden="true" data-filler="" className={cn(className, 'w-full p-0 first:pl-0 last:pr-0')} />;

export function DataGrid({ appId, table, data, fields, stale, sort, onSort, editable, selected, onSelect, foreignKeys, tables, onFollow, onOpenRow, openId, onSaved, onStale }: DataGridProps) {
  const grid = useRef<HTMLTableElement>(null);
  const columns = data.columns ?? [];
  const rows = data.rows ?? [];
  const keys = data.keys ?? [];
  const ticks = editable && keys.some(Boolean);
  const [active, setActive] = useState({ row: 1, col: ticks ? 1 : 0 });
  const editing = useCellEdit({ appId, table, page: data, fields, editable, onSaved, onStale });
  const { edit, refusal } = editing;

  const ids = keys.map(key => key ? rowId(key) : null);
  const tickable = ids.filter((id): id is string => id !== null);
  const ticked = tickable.filter(id => selected.has(id));
  // The one cell that is in the tab order, kept inside the rows there are.
  const activeRow = Math.min(active.row, rows.length), activeCol = Math.min(active.col, columns.length - 1 + (ticks ? 1 : 0));
  const stop = (row: number, col: number) => row === activeRow && col === activeCol ? 0 : -1;

  /** When an edit closes by the keyboard, the focus goes back to its cell, for the arrow keys. */
  const backToCell = () => grid.current?.querySelector<HTMLElement>('td[data-editing]')?.focus();
  const startEdit = (index: number, column: string) => {
    // One edit at a time: an open one holds the person's text, so it keeps the focus.
    if (editing.start(index, column) === 'held') grid.current?.querySelector<HTMLElement>('[data-cell-editor] input, [data-cell-editor] textarea')?.focus();
  };

  const focusCell = (row: number, col: number): boolean => {
    const cell = grid.current?.rows[row]?.cells[col];
    if (!cell || cell.dataset.filler !== undefined) return false;
    (cell.querySelector<HTMLElement>('[data-focus]') ?? cell).focus();
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-cell-editor]')) return;
    const cell = target.closest<HTMLTableCellElement>('th,td');
    const row = cell?.parentElement as HTMLTableRowElement | null | undefined;
    if (!cell || !row || !grid.current) return;
    let to: [number, number];
    switch (event.key) {
      case 'ArrowRight': to = [row.rowIndex, cell.cellIndex + 1]; break;
      case 'ArrowLeft': to = [row.rowIndex, cell.cellIndex - 1]; break;
      case 'ArrowDown': to = [row.rowIndex + 1, cell.cellIndex]; break;
      case 'ArrowUp': to = [row.rowIndex - 1, cell.cellIndex]; break;
      case 'Home': to = [event.ctrlKey ? 0 : row.rowIndex, 0]; break;
      case 'End': to = [event.ctrlKey ? grid.current.rows.length - 1 : row.rowIndex, columns.length - 1 + (ticks ? 1 : 0)]; break;
      case 'Enter':
      case 'F2':
        // On the cell itself: a link or a tick inside it keeps its own Enter.
        if (target === cell && cell.dataset.column !== undefined && row.rowIndex > 0) { event.preventDefault(); startEdit(row.rowIndex - 1, cell.dataset.column); }
        return;
      default: return;
    }
    if (focusCell(to[0], to[1])) event.preventDefault();
  };

  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>('th,td');
    const row = cell?.parentElement as HTMLTableRowElement | null | undefined;
    if (cell && row) setActive(current => current.row === row.rowIndex && current.col === cell.cellIndex ? current : { row: row.rowIndex, col: cell.cellIndex });
  };

  const offset = ticks ? 1 : 0;
  return <table ref={grid} role="grid" aria-label={`Rows of ${table}`} aria-busy={stale || undefined} aria-readonly={!editable || undefined} onKeyDown={onKeyDown} onFocus={onFocus}
    className={cn('w-full border-separate border-spacing-0 font-mono text-xs transition-opacity', stale && 'opacity-60')}>
    <thead>
      <tr>
        {ticks && <th scope="col" className={cn(headCell, 'w-7 pl-3 pr-[5px] text-left', line)}>
          <Tick data-focus="" className="block" tabIndex={stop(0, 0)} aria-label="Select every row on this page" checked={tickable.length > 0 && ticked.length === tickable.length}
            indeterminate={ticked.length > 0 && ticked.length < tickable.length} onChange={event => onSelect(tickable, event.target.checked)} />
        </th>}
        {columns.map((column, at) => {
          const sorted = sort?.column === column ? sort.dir : null;
          const numeric = isNumericType(fields[column]?.type);
          return <th key={column} scope="col" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
            className={cn(headCell, 'px-[5px] text-[11px] font-semibold first:pl-3 last:pr-3', line)}>
            <button type="button" data-focus="" tabIndex={stop(0, at + offset)} onClick={() => onSort(column)}
              title={sorted === 'asc' ? `Sorted by ${column}, smallest first. Press for largest first.` : sorted === 'desc' ? `Sorted by ${column}, largest first. Press for the table’s own order.` : `Sort by ${column}`}
              className={cn('flex h-6 w-full max-w-[16rem] items-center gap-1 whitespace-nowrap rounded-sm', numeric && 'ml-auto justify-end', focusRing,
                sorted ? strong : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white')}>
              <span className="min-w-0 truncate">{column}</span>
              {sorted === 'asc' && <ArrowUp className="h-2.5 w-2.5 flex-none text-primary-600 dark:text-primary-400" strokeWidth={3} aria-hidden="true" />}
              {sorted === 'desc' && <ArrowDown className="h-2.5 w-2.5 flex-none text-primary-600 dark:text-primary-400" strokeWidth={3} aria-hidden="true" />}
            </button>
          </th>;
        })}
        {filler(cn(headCell, line))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row, index) => {
        const key = keys[index] ?? null, id = ids[index];
        const isTicked = id !== null && selected.has(id);
        const isOpen = id !== null && id === openId;
        const cut = data.cut?.[String(index)] ?? [];
        const name = key ? rowName(key) : String((data.offset ?? 0) + index + 1);
        return <tr key={id ?? `#${index}`} aria-selected={ticks ? isTicked : undefined} data-open={isOpen ? '' : undefined}
          className={isOpen ? openRow : isTicked ? tickedRow : 'hover:bg-slate-50 dark:hover:bg-slate-900/60'}>
          {ticks && <td tabIndex={key ? undefined : stop(index + 1, 0)} className={cn(cellBase, 'w-7', !key && cellFocus)}>
            {key && id !== null && <Tick data-focus="" className="block" tabIndex={stop(index + 1, 0)} aria-label={`Select row ${name}`} checked={isTicked} onChange={event => onSelect([id], event.target.checked)} />}
          </td>}
          {columns.map((column, at) => {
            const value = row[column];
            const kind = cellKind(value);
            const field = fields[column];
            const numeric = isNumericType(field?.type);
            const editingHere = edit !== null && edit.id === id && edit.column === column ? edit : null;
            const boxed = editingHere !== null && editingHere.phase !== 'reading';
            const isCut = kind === 'value' && cut.includes(column);
            const text = kind === 'value' ? cellText(value) : '';
            const foreign = kind === 'value' ? foreignKeys[column] : undefined;
            const target = foreign && tables.has(foreign.table) ? foreignKeyFilters(foreign, row) : null;
            const canEdit = editable && editing.locked(index, column) === '';
            const refusedHere = refusal !== null && refusal.index === index && refusal.column === column ? refusal.text : '';
            const inside = 'inline-flex max-w-full items-center gap-1 rounded-sm align-top';
            return <td key={column} data-column={column} data-kind={isCut ? 'cut' : kind} data-editing={boxed ? '' : undefined}
              tabIndex={stop(index + 1, at + offset)} aria-readonly={canEdit ? undefined : true} aria-busy={editingHere?.phase === 'reading' || undefined}
              onDoubleClick={editable && !editingHere ? () => startEdit(index, column) : undefined}
              title={!boxed && text.length > 40 ? text : undefined}
              className={cn(cellBase, cellFocus, numeric && 'text-right tabular-nums',
                boxed ? 'min-w-[12rem] py-0.5 align-top' : 'max-w-[22rem] overflow-hidden text-ellipsis whitespace-nowrap',
                editingHere?.phase === 'reading' && 'opacity-60',
                field?.primary ? cn(strong, 'font-semibold') : body)}>
              {editingHere && boxed
                ? <CellEditor label={`${column}, row ${name}`} original={editingHere.original ?? null} numeric={numeric} nullable={!field?.required} busy={editingHere.phase === 'saving'} error={editingHere.error}
                    onSave={next => editing.save(next, backToCell)} onCancel={refocus => { if (refocus) backToCell(); editing.cancel(); }} />
                // The key is the way into the row.
                : field?.primary && key && kind === 'value' ? <button type="button" tabIndex={stop(index + 1, at + offset)} onClick={() => onOpenRow(key)} aria-label={`${text}: open row ${name}`} aria-expanded={isOpen}
                    className={cn(inside, link, focusRing)}><span className="min-w-0 truncate">{text}</span></button>
                : target && foreign ? <button type="button" tabIndex={stop(index + 1, at + offset)} onClick={() => onFollow(foreign.table, target)}
                    aria-label={`${text}: open ${foreign.table} where ${target.map(filter => `${filter.column} is ${filter.value}`).join(' and ')}`}
                    className={cn(inside, link, focusRing)}>
                    <span className="min-w-0 truncate">{text}</span><ArrowUpRight className="h-2.5 w-2.5 flex-none" strokeWidth={2.4} aria-hidden="true" />
                  </button>
                : <CellValue value={value} cut={isCut} />}
              {/* Why this cell did not open for editing, said in the cell. */}
              {refusedHere && <p role="alert" className="max-w-[20rem] whitespace-normal py-0.5 text-left font-sans text-[11px] font-normal leading-normal text-red-700 dark:text-red-300">{refusedHere}</p>}
            </td>;
          })}
          {filler(cellBase)}
        </tr>;
      })}
    </tbody>
  </table>;
}
