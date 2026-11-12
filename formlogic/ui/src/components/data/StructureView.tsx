// The Structure view of a table: its columns, its indexes, and the tables that point at it. To
// read, not to change: the shape belongs to the app's own migrations. A table of columns from
// tablet width up; on a phone, a small card for each column.
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import type { NativeStructure } from '../../lib/nativeHosting';
import { LoadFailure } from '../ui/LoadFailure';
import { count, defaultWords, foreignKeysByColumn, keyWords, mayBeEmpty, type TableInfo } from './format';
import { body, focusRing, line, link, muted, panel, panelHeading, strong } from './styles';

interface StructureViewProps {
  structure?: NativeStructure;
  /** Why the structure could not be loaded. */
  error: string;
  onRetry(): void;
  /** The tables the list shows, for which names are links and how many rows they hold. */
  tables: TableInfo[];
  onOpenTable(table: string): void;
  /** A phone: cards, not a table. */
  phone: boolean;
}

const head = 'h-7 whitespace-nowrap border-b bg-slate-100 px-[5px] text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 first:pl-3 last:pr-3 dark:bg-slate-900 dark:text-slate-400';
const cell = 'h-[26px] whitespace-nowrap border-b border-slate-100 px-[5px] first:pl-3 last:pr-3 dark:border-slate-800/70';

export function StructureView({ structure, error, onRetry, tables, onOpenTable, phone }: StructureViewProps) {
  if (error) return <LoadFailure compact className="m-3" title="This table’s structure could not be loaded" message={error} onRetry={onRetry} />;
  if (!structure) return <p role="status" className={cn('px-3 py-8 text-center text-xs', muted)}>Loading the structure…</p>;

  const listed = new Map(tables.map(table => [table.name, table]));
  const foreign = foreignKeysByColumn(structure);
  const primary = structure.columns.filter(column => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey).map(column => column.name);
  const indexes = structure.indexes.filter(index => index.origin !== 'pk');
  /** A table's name as a way to it, where the list shows that table. */
  const tableLink = (table: string, text: string) => listed.has(table)
    ? <button type="button" className={cn('max-w-full rounded-sm text-left font-mono [overflow-wrap:anywhere] max-sm:min-h-10', link, focusRing)} onClick={() => onOpenTable(table)} aria-label={`${text}: open ${table}`}>{text}</button>
    : <span className="font-mono [overflow-wrap:anywhere]">{text}</span>;
  /** Where a column points, and what a delete over there does here. */
  const linksTo = (name: string): ReactNode => {
    const key = foreign[name];
    if (!key) return null;
    const to = key.to?.[key.columns.indexOf(name)];
    return <>{tableLink(key.table, to ? `${key.table}.${to}` : key.table)}{key.onDelete && key.onDelete.toUpperCase() !== 'NO ACTION' && <span className={muted}> · on delete: {key.onDelete.toLowerCase()}</span>}</>;
  };

  return <div className="flex flex-col gap-3 p-3">
    {phone
      ? <ul aria-label={`Columns of ${structure.table}`} className="flex flex-col gap-2">
        {structure.columns.map((column, index) => {
          const key = keyWords(column, structure), start = defaultWords(column, structure), to = linksTo(column.name);
          return <li key={column.name} className={cn(panel, 'px-3 py-2')}>
            <p className="flex items-baseline gap-2">
              <span className={cn('font-mono text-[11px] tabular-nums', muted)}>{index + 1}</span>
              <span className={cn('min-w-0 font-mono text-[13px] font-semibold [overflow-wrap:anywhere]', column.hidden ? muted : strong)}>{column.name}</span>
              <span className={cn('ml-auto flex-none font-mono text-xs', body)}>{column.type || 'any'}</span>
            </p>
            {column.hidden && <p className={cn('text-xs', muted)}>Values never shown.</p>}
            <dl className={cn('mt-1 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 text-xs', body)}>
              <dt className={muted}>May be empty</dt><dd>{mayBeEmpty(column) ? 'yes' : 'no'}</dd>
              {start && <><dt className={muted}>Default</dt><dd className="font-mono [overflow-wrap:anywhere]">{start}</dd></>}
              {key && <><dt className={muted}>Key</dt><dd className="font-semibold text-primary-700 dark:text-primary-400">{key}</dd></>}
              {to && <><dt className={muted}>Links to</dt><dd className="min-w-0">{to}</dd></>}
            </dl>
          </li>;
        })}
      </ul>
      : <div className={cn(panel, 'overflow-x-auto')}>
        <table className="w-full border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Columns of {structure.table}</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(head, line, 'w-8')}><abbr title="Position" className="no-underline">#</abbr></th>
              <th scope="col" className={cn(head, line)}>Column</th>
              <th scope="col" className={cn(head, line)}>Type</th>
              <th scope="col" className={cn(head, line)}>May be empty</th>
              <th scope="col" className={cn(head, line)}>Default</th>
              <th scope="col" className={cn(head, line)}>Key</th>
              <th scope="col" className={cn(head, line)}>Links to</th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((column, index) => <tr key={column.name}>
              <td className={cn(cell, muted, 'font-mono tabular-nums')}>{index + 1}</td>
              <th scope="row" title={column.name} className={cn(cell, 'max-w-[20rem] overflow-hidden text-ellipsis text-left font-mono font-normal', column.hidden ? muted : strong)}>
                {column.name}{column.hidden && <span className="font-sans"> · values never shown</span>}
              </th>
              <td className={cn(cell, 'font-mono', body)}>{column.type || <span className={muted}>any</span>}</td>
              <td className={cn(cell, body)}>{mayBeEmpty(column) ? 'yes' : 'no'}</td>
              <td className={cn(cell, 'max-w-[16rem] overflow-hidden text-ellipsis font-mono', body)} title={column.defaultValue ?? undefined}>{defaultWords(column, structure)}</td>
              <td className={cn(cell, 'font-semibold text-primary-700 dark:text-primary-400')}>{keyWords(column, structure)}</td>
              <td className={cn(cell, body)}>{linksTo(column.name)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}

    <div className="flex flex-wrap gap-3">
      <section aria-label="Indexes" className={cn(panel, 'flex min-w-0 flex-[1_1_320px] flex-col gap-1 px-3 py-2.5')}>
        <h3 className={cn(panelHeading, 'mb-0.5')}>Indexes</h3>
        {primary.length > 0 && <p className={cn('font-mono text-xs [overflow-wrap:anywhere]', body)}>PRIMARY ({primary.join(', ')})</p>}
        {indexes.map(index => <p key={index.name} className={cn('font-mono text-xs [overflow-wrap:anywhere]', body)}>
          {/* SQLite names the index of a UNIQUE constraint itself: the name says nothing, the columns do. */}
          {index.name.startsWith('sqlite_autoindex_') ? 'UNIQUE' : index.name} ({index.columns.join(', ')}){index.unique && !index.name.startsWith('sqlite_autoindex_') && <span className="font-sans"> · unique</span>}
        </p>)}
        {primary.length === 0 && indexes.length === 0 && <p className={cn('text-xs', muted)}>This table has no indexes.</p>}
      </section>

      <section aria-label="Used by" className={cn(panel, 'flex min-w-0 flex-[1_1_320px] flex-col gap-1 px-3 py-2.5')}>
        <h3 className={cn(panelHeading, 'mb-0.5')}>Used by</h3>
        {structure.referencedBy.map(use => {
          const rows = listed.get(use.table)?.rows;
          return <p key={`${use.table}.${use.columns.join(',')}`} className={cn('text-xs', body)}>
            {tableLink(use.table, `${use.table}.${use.columns.join(', ')}`)}{typeof rows === 'number' && <> · {count(rows, 'row')}</>}
          </p>;
        })}
        {structure.referencedBy.length === 0 && <p className={cn('text-xs', muted)}>No other table points at this one.</p>}
        <p className={cn('text-xs', muted)}>The shape is read-only here: tables and columns change through the app’s own migrations.</p>
      </section>
    </div>
  </div>;
}
