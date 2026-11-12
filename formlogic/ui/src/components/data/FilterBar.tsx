// The filters on a table's rows: one chip each, in plain words, with its own way out, and a small
// form to add another.
import { useRef, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { NativeFilter, NativeFilterOp, NativeRecordField } from '../../lib/nativeHosting';
import { Popover } from '../ui/Popover';
import { FILTER_OPS, MAX_FILTERS, filterText, isNumericType, looksLikeDate, opWords, takesValue } from './format';
import { field, focusRing, muted, primaryButton } from './styles';

interface FilterBarProps {
  /** The table's shown columns, in order. */
  columns: string[];
  fields: Record<string, NativeRecordField>;
  filters: NativeFilter[];
  onAdd(filter: NativeFilter): void;
  onRemove(index: number): void;
}

export function FilterBar({ columns, fields, filters, onAdd, onRemove }: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const isDate = (column: string) => looksLikeDate(column, fields[column]?.type);
  const full = filters.length >= MAX_FILTERS;

  return <>
    {filters.map((filter, index) => {
      const date = isDate(filter.column);
      // max-sm:order-2: on a phone the filters come after the search and Add filter, which share the first line.
      return <span key={`${index}:${filterText(filter)}`} className="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 rounded-md bg-slate-200/70 pl-2 pr-1 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200 max-sm:order-2 max-sm:pr-0">
        <span className="min-w-0 truncate" title={filterText(filter, date)}><span className="font-mono">{filter.column}</span> {opWords(filter.op, date)}{takesValue(filter.op) && <> <span className="font-mono">{filter.value}</span></>}</span>
        <button type="button" aria-label={`Remove the filter: ${filterText(filter, date)}`} onClick={() => onRemove(index)}
          className={cn('inline-flex h-5 w-5 flex-none items-center justify-center rounded text-slate-500 hover:bg-slate-300/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-white max-sm:h-10 max-sm:w-10', focusRing)}>
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </span>;
    })}
    <button ref={anchor} type="button" aria-haspopup="dialog" aria-expanded={open} disabled={full || columns.length === 0} title={full ? `A table takes up to ${MAX_FILTERS} filters at once.` : undefined}
      onClick={() => setOpen(value => !value)}
      className={cn('inline-flex h-6 flex-none items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-xs font-medium hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:hover:border-slate-500 dark:hover:text-white max-sm:h-10 max-sm:px-3', muted, focusRing)}>
      <Plus className="h-3 w-3" aria-hidden="true" />Add filter
    </button>
    <Popover isOpen={open} onClose={() => setOpen(false)} anchorRef={anchor} ariaLabel="Add a filter" className="w-72 max-w-[calc(100vw-1rem)] rounded-xl p-3">
      <FilterForm columns={columns} fields={fields} isDate={isDate} onAdd={filter => { onAdd(filter); setOpen(false); }} />
    </Popover>
  </>;
}

/** A column, how to compare it, and the value to compare it with. */
function FilterForm({ columns, fields, isDate, onAdd }: { columns: string[]; fields: Record<string, NativeRecordField>; isDate(column: string): boolean; onAdd(filter: NativeFilter): void }) {
  const [column, setColumn] = useState(columns[0] ?? '');
  // Text is most often searched for a part of it; a number or a date for the value itself.
  const usual = (name: string): NativeFilterOp => isNumericType(fields[name]?.type) || isDate(name) ? 'eq' : 'contains';
  const [op, setOp] = useState<NativeFilterOp>(() => usual(columns[0] ?? ''));
  const [value, setValue] = useState('');
  const needsValue = takesValue(op);
  const date = isDate(column);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!column || (needsValue && value === '')) return;
    onAdd(needsValue ? { column, op, value } : { column, op });
  };
  const control = cn(field, 'w-full px-2');
  const label = 'flex flex-col gap-1 text-xs font-medium text-slate-700 dark:text-slate-300';

  return <form onSubmit={submit} className="flex flex-col gap-2.5">
    <label className={label}>Column
      <select value={column} onChange={event => { setColumn(event.target.value); setOp(usual(event.target.value)); }} className={cn(control, 'font-mono')}>
        {columns.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    <label className={label}>Rule
      <select value={op} onChange={event => setOp(event.target.value as NativeFilterOp)} className={control}>
        {FILTER_OPS.map(candidate => <option key={candidate} value={candidate}>{opWords(candidate, date)}</option>)}
      </select>
    </label>
    {needsValue && <label className={label}>Value
      <input type="text" value={value} onChange={event => setValue(event.target.value)} className={cn(control, 'font-mono')} autoComplete="off" spellCheck={false} />
    </label>}
    <button type="submit" disabled={!column || (needsValue && value === '')} className={primaryButton}>Add filter</button>
  </form>;
}
