// One page of a table's rows on a phone: a card per row. Its key (or its first column) is the
// card's title and the way into the row's details; the next few columns follow as a summary, name
// over value, two to a line, so a screen holds several rows. A card opens out to every column, and
// there an editable value has its own Edit button: the same read-then-update, in a box with Save
// and Cancel. Every value reads by the same rules as in the grid.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, ChevronUp, Pencil } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { NativeBrowse, NativeFilter, NativeForeignKey, NativeRecordField } from '../../lib/nativeHosting';
import { CellEditor, CellValue, Tick } from './cells';
import { cellKind, cellText, count, foreignKeyFilters, isNumericType, rowId, rowName } from './format';
import { body, focusRing, line, link, muted, openRow, strong, tickedRow } from './styles';
import { useCellEdit } from './useCellEdit';

/** How many columns a card shows under its title before it is opened out. */
export const CARD_LINES = 4;

interface RowCardsProps {
  appId: string;
  table: string;
  data: NativeBrowse;
  fields: Record<string, NativeRecordField>;
  stale: boolean;
  editable: boolean;
  selected: ReadonlySet<string>;
  onSelect(ids: string[], on: boolean): void;
  foreignKeys: Record<string, NativeForeignKey>;
  tables: ReadonlySet<string>;
  onFollow(table: string, filters: NativeFilter[]): void;
  onOpenRow(key: Record<string, string>): void;
  openId: string | null;
  onSaved(): void;
  onStale(): void;
}

export function RowCards({ appId, table, data, fields, stale, editable, selected, onSelect, foreignKeys, tables, onFollow, onOpenRow, openId, onSaved, onStale }: RowCardsProps) {
  const list = useRef<HTMLUListElement>(null);
  const columns = data.columns ?? [];
  const rows = data.rows ?? [];
  const keys = data.keys ?? [];
  const ticks = editable && keys.some(Boolean);
  const editing = useCellEdit({ appId, table, page: data, fields, editable, onSaved, onStale });
  const { edit, refusal } = editing;
  // The cards opened out to all their columns.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // Where the focus goes back to when an edit closes: the Edit button it began from.
  const back = useRef<string | null>(null);
  useEffect(() => {
    if (edit || !back.current) return;
    const mark = back.current;
    back.current = null;
    [...(list.current?.querySelectorAll<HTMLElement>('[data-edit]') ?? [])].find(node => node.dataset.edit === mark)?.focus();
  }, [edit]);

  // The title: the key's columns, or the first column of a table that has no key.
  const titled = data.schema?.primaryKey.length ? data.schema.primaryKey.filter(name => columns.includes(name)) : columns.slice(0, 1);
  const lines = columns.filter(column => !titled.includes(column));

  return <ul ref={list} aria-label={`Rows of ${table}`} aria-busy={stale || undefined} className={cn('transition-opacity', stale && 'opacity-60')}>
    {rows.map((row, index) => {
      const key = keys[index] ?? null, id = key ? rowId(key) : null;
      const card = id ?? `#${index}`;
      const isTicked = id !== null && selected.has(id);
      const isOpen = id !== null && id === openId;
      const cut = data.cut?.[String(index)] ?? [];
      const name = key ? rowName(key) : String((data.offset ?? 0) + index + 1);
      const all = opened.has(card);
      // A value being edited stays in view, whether or not its card is opened out.
      const shown = all ? lines : lines.filter((column, at) => at < CARD_LINES || (edit?.id === id && edit.column === column));
      const title = <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {titled.map(column => <span key={column} className="flex min-w-0 max-w-full items-baseline gap-1.5">
          <span className={cn('max-w-[9rem] flex-none truncate text-[11px] font-normal', muted)}>{column}</span>
          <span className="min-w-0 truncate"><CellValue value={row[column]} cut={cut.includes(column)} /></span>
        </span>)}
      </span>;

      const toggle = () => setOpened(before => { const next = new Set(before); if (all) next.delete(card); else next.add(card); return next; });

      return <li key={card} data-open={isOpen ? '' : undefined} className={cn('border-b px-3', line, isOpen ? openRow : isTicked && tickedRow)}>
        <div className="flex items-center gap-1">
          {ticks && (key && id !== null
            ? <label className="-ml-3 flex h-11 w-11 flex-none cursor-pointer items-center justify-center"><Tick aria-label={`Select row ${name}`} checked={isTicked} onChange={event => onSelect([id], event.target.checked)} /></label>
            : <span className="w-2 flex-none" />)}
          <h3 className={cn('min-w-0 flex-1 font-mono text-[13px] font-semibold', strong)}>
            {key
              ? <button type="button" onClick={() => onOpenRow(key)} aria-label={`Open row ${name}`} aria-expanded={isOpen} className={cn('flex min-h-11 w-full min-w-0 items-center gap-1 rounded text-left', focusRing)}>
                {title}<ChevronRight className={cn('h-4 w-4 flex-none', muted)} aria-hidden="true" />
              </button>
              : <span className="flex min-h-11 items-center">{title}</span>}
          </h3>
          {/* The card as it comes is a summary; opened out it lists every column, each with its Edit. */}
          {lines.length > 0 && <button type="button" aria-expanded={all} onClick={toggle}
            aria-label={all ? 'Show fewer columns' : `Show all ${count(columns.length, 'column')}`}
            className={cn('-mr-2 inline-flex h-11 w-11 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white', focusRing)}>
            {all ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>}
        </div>

        <dl className={cn(all ? 'pb-1' : 'grid grid-cols-2 gap-x-4 pb-2')}>
          {shown.map(column => {
            const value = row[column];
            const kind = cellKind(value);
            const field = fields[column];
            const editingHere = edit !== null && edit.id === id && edit.column === column ? edit : null;
            const boxed = editingHere !== null && editingHere.phase !== 'reading';
            const foreign = kind === 'value' ? foreignKeys[column] : undefined;
            const target = foreign && tables.has(foreign.table) ? foreignKeyFilters(foreign, row) : null;
            const canEdit = editable && editing.locked(index, column) === '';
            const mark = `${card}:${column}`;
            if (editingHere && boxed) return <div key={column} data-column={column} className="col-span-2 py-1.5">
              <dt className={cn('truncate pb-1 font-mono text-[11px]', muted)} title={column}>{column}</dt>
              <dd><CellEditor buttons label={`${column}, row ${name}`} original={editingHere.original ?? null} numeric={isNumericType(field?.type)} nullable={!field?.required} busy={editingHere.phase === 'saving'} error={editingHere.error}
                onSave={next => { back.current = mark; editing.save(next); }} onCancel={refocus => { if (refocus) back.current = mark; editing.cancel(); }} /></dd>
            </div>;
            const refusedHere = refusal !== null && refusal.index === index && refusal.column === column ? refusal.text : '';
            const follow = target && foreign
              ? <button type="button" onClick={() => onFollow(foreign.table, target)}
                  aria-label={`${cellText(value)}: open ${foreign.table} where ${target.map(filter => `${filter.column} is ${filter.value}`).join(' and ')}`}
                  // In the summary the link is one line of text: its press area reaches past the line, over the name above it.
                  className={cn('inline-flex max-w-full items-center gap-1 rounded-sm', all ? 'min-h-10' : '-my-2.5 py-2.5', link, focusRing)}>
                  <span className="min-w-0 truncate">{cellText(value)}</span><ArrowUpRight className="h-3 w-3 flex-none" strokeWidth={2.4} aria-hidden="true" />
                </button>
              : null;

            // The summary: the column's name over its value, two to a line, to read down a page of rows.
            if (!all) return <div key={column} data-column={column} className={cn('min-w-0 pb-1', editingHere && 'opacity-60')}>
              <dt className={cn('truncate font-mono text-[10.5px] leading-4', muted)} title={column}>{column}</dt>
              <dd data-kind={kind === 'value' && cut.includes(column) ? 'cut' : kind} className={cn('truncate font-mono text-xs leading-5', body)}>
                {follow ?? <CellValue value={value} cut={cut.includes(column)} />}
              </dd>
              {refusedHere && <p role="alert" className="pb-1 text-[11px] leading-normal text-red-700 dark:text-red-300">{refusedHere}</p>}
            </div>;

            return <div key={column} data-column={column} className={cn('flex flex-wrap items-center gap-x-2', canEdit ? 'min-h-10' : 'min-h-7', editingHere && 'opacity-60')}>
              <dt className={cn('w-[36%] flex-none truncate font-mono text-[11px]', muted)} title={column}>{column}</dt>
              <dd data-kind={kind === 'value' && cut.includes(column) ? 'cut' : kind} className={cn('min-w-0 flex-1 py-1 font-mono text-xs', body)}>
                {follow ?? <CellValue value={value} cut={cut.includes(column)} wrap />}
              </dd>
              {/* One value is edited at a time: a press here while another is open goes back to that one, where its text is. */}
              {canEdit && <button type="button" data-edit={mark} disabled={editingHere !== null}
                onClick={() => { if (editing.start(index, column) === 'held') list.current?.querySelector<HTMLElement>('[data-cell-editor] input, [data-cell-editor] textarea')?.focus(); }}
                aria-label={`Edit ${column} of row ${name}`} className={cn('-mr-2 inline-flex h-10 w-10 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white', focusRing)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>}
              {/* Why this value did not open for editing, said beside it. */}
              {refusedHere && <p role="alert" className="basis-full pb-1 text-[11px] leading-normal text-red-700 dark:text-red-300">{refusedHere}</p>}
            </div>;
          })}
        </dl>
      </li>;
    })}
  </ul>;
}
