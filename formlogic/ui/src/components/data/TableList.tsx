// The app's tables with their row counts. On a wide screen, a list down the left that fills the
// height it is given and scrolls within it; narrower, one picker above the rows.
import { useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { count, formatBytes, number, type TableInfo } from './format';
import { field, focusRing, line, muted, quietSurface } from './styles';

interface TableListProps {
  tables: TableInfo[];
  /** The open table. */
  current?: string;
  /** The database file's size, when the server said. */
  bytes?: number;
  /** How many tables are kept from the list (the host's own, and SQLite's). */
  hiddenTables?: number;
  onPick(table: string): void;
}

export function TableList({ tables, current, bytes, hiddenTables = 0, onPick }: TableListProps) {
  const [find, setFind] = useState('');
  const wanted = find.trim().toLowerCase();
  const shown = wanted ? tables.filter(table => table.name.toLowerCase().includes(wanted)) : tables;
  const counted = tables.every(table => typeof table.rows === 'number');
  const totals = [count(tables.length, 'table'), counted ? count(tables.reduce((sum, table) => sum + (table.rows ?? 0), 0), 'row') : '', bytes === undefined ? '' : formatBytes(bytes)].filter(Boolean).join(' · ');
  const hidden = hiddenTables > 0 ? `${count(hiddenTables, 'system table')} not shown` : '';

  return <nav aria-label="Tables" className={cn('flex-none border-b lg:flex lg:min-h-0 lg:w-[216px] lg:flex-col lg:border-b-0 lg:border-r', line, quietSurface)}>
    {/* Below a wide screen: one picker and the totals, so the rows start near the top and keep the width. */}
    <div className="flex flex-col gap-1 p-2 lg:hidden">
      <select aria-label="Table" value={current ?? ''} onChange={event => onPick(event.target.value)} className={cn(field, 'w-full min-w-0 px-2 font-mono')}>
        {current === undefined || tables.some(table => table.name === current) ? null : <option value={current}>{current}</option>}
        {tables.map(table => <option key={table.name} value={table.name}>{table.name}{typeof table.rows === 'number' ? ` · ${count(table.rows, 'row')}` : ''}</option>)}
      </select>
      <p className={cn('px-1 text-[11px] leading-normal', muted)}>{totals}{hidden && ` · ${hidden}`}</p>
    </div>

    {/* Wide: the list is as tall as the manager. The totals stand at its top, and its last table can
        scroll clear of the bottom corner, where the page's own floating button sits. */}
    <div className="hidden min-h-0 flex-1 flex-col gap-1.5 p-2 pb-0 lg:flex">
      <label className={cn(field, 'flex flex-none items-center gap-1.5 px-2 focus-within:ring-2 focus-within:ring-primary-500', muted)}>
        <Search className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <input type="search" aria-label="Find a table" placeholder="Find a table" value={find} onChange={event => setFind(event.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-slate-900 outline-none placeholder:text-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400" />
      </label>
      <p className={cn('flex-none border-b px-2 pb-1.5 text-[11px] leading-normal', line, muted)}>{totals}{hidden && <><br />{hidden}</>}</p>
      <ul className="min-h-0 flex-1 overflow-y-auto pb-12">
        {shown.map(table => {
          const open = table.name === current;
          return <li key={table.name}>
            <button type="button" aria-current={open ? 'true' : undefined} onClick={() => onPick(table.name)} title={table.name}
              className={cn('flex h-[26px] w-full items-center gap-2 rounded-[5px] px-2 text-left', focusRing,
                open ? 'bg-slate-200/80 text-slate-900 dark:bg-slate-800 dark:text-white' : 'text-slate-700 hover:bg-slate-200/50 dark:text-slate-300 dark:hover:bg-slate-800/60')}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{table.name}</span>
              {typeof table.rows === 'number' && <span className={cn('flex-none text-[11px] tabular-nums', muted)}><span className="sr-only">, </span>{number(table.rows)}<span className="sr-only"> rows</span></span>}
            </button>
          </li>;
        })}
        {shown.length === 0 && <li className={cn('px-2 py-1 text-xs', muted)}>No table has “{find.trim()}” in its name.</li>}
      </ul>
    </div>
  </nav>;
}
