// The Export view: which rows, and as what. The download is a plain link to the server's export
// address, so the browser saves the file with the session's cookies and nothing is held in memory.
import { useId, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { BrowseState } from './address';
import { count, number, type TableInfo } from './format';
import { focusRing, muted, panel, panelHeading } from './styles';

/** The most rows of one table the server puts in a file. */
const EXPORT_ROWS = 100000;

type What = 'table' | 'matching' | 'all';

interface ExportViewProps {
  appId: string;
  appSlug?: string;
  table: TableInfo;
  /** Every table the list shows. */
  tables: TableInfo[];
  /** The search, filters and order of the Browse view, from the address. */
  state: BrowseState;
  /** How many rows they leave, when a page of them has said. */
  matching?: number;
}

/** A radio button drawn for both themes: a ring, filled in when it is chosen. */
const radio = cn('h-4 w-4 flex-none cursor-pointer appearance-none rounded-full border border-slate-400 bg-white checked:border-[5px] checked:border-primary-600 disabled:cursor-not-allowed dark:border-slate-500 dark:bg-slate-900 dark:checked:border-primary-500 dark:checked:bg-slate-950', focusRing);
const option = 'flex min-h-6 items-center gap-2 text-slate-800 dark:text-slate-200 max-sm:min-h-10';

export function ExportView({ appId, appSlug, table, tables, state, matching }: ExportViewProps) {
  const group = useId();
  const [chosen, setChosen] = useState<What>('table');
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  // The matching rows are on offer while a search or a filter narrows them.
  const narrowed = state.q !== '' || state.filters.length > 0;
  const what: What = chosen === 'matching' && !narrowed ? 'table' : chosen;
  // Every table goes in one file, which CSV cannot be.
  const as = what === 'all' ? 'json' : format;
  const url = what === 'all' ? api.nativeExportUrl(appId, '*', 'json')
    : api.nativeExportUrl(appId, table.name, as, what === 'matching' ? { q: state.q, filters: state.filters, sort: state.sort } : {});
  // The server names the file itself; this is the name the browser falls back on.
  const file = `${appSlug ? `${appSlug}-` : ''}${what === 'all' ? 'all' : table.name}.${as}`;
  const cut = what === 'all' ? tables.some(each => (each.rows ?? 0) > EXPORT_ROWS) : (what === 'matching' ? matching ?? 0 : table.rows ?? 0) > EXPORT_ROWS;

  return <div className="flex flex-wrap items-start gap-3 p-3 text-[13px]">
    <fieldset className={cn(panel, 'flex min-w-0 flex-[1_1_260px] flex-col gap-1 px-3 pb-2.5 pt-1.5')}>
      <legend className={cn(panelHeading, 'px-1')}>What</legend>
      <label className={option}><input type="radio" name={`${group}-what`} className={radio} checked={what === 'table'} onChange={() => setChosen('table')} />
        <span>This table, {typeof table.rows === 'number' ? `all ${count(table.rows, 'row')}` : 'all its rows'}</span></label>
      {narrowed && <label className={option}><input type="radio" name={`${group}-what`} className={radio} checked={what === 'matching'} onChange={() => setChosen('matching')} />
        <span>{typeof matching === 'number' ? `The ${count(matching, 'row')}` : 'The rows'} matching the search and filters</span></label>}
      <label className={option}><input type="radio" name={`${group}-what`} className={radio} checked={what === 'all'} onChange={() => setChosen('all')} />
        <span>Every table ({number(tables.length)}), as JSON</span></label>
    </fieldset>

    <fieldset className={cn(panel, 'flex min-w-0 flex-[1_1_260px] flex-col gap-1 px-3 pb-2.5 pt-1.5')}>
      <legend className={cn(panelHeading, 'px-1')}>As</legend>
      <label className={cn(option, what === 'all' && 'opacity-50')}><input type="radio" name={`${group}-as`} className={radio} checked={as === 'csv'} disabled={what === 'all'} onChange={() => setFormat('csv')} />
        <span>CSV, for a spreadsheet</span></label>
      <label className={option}><input type="radio" name={`${group}-as`} className={radio} checked={as === 'json'} onChange={() => setFormat('json')} />
        <span>JSON</span></label>
      <p className={cn('text-xs', muted)}>Secret columns and binary values are left out of every export.</p>
      {cut && <p className="text-xs text-amber-800 dark:text-amber-200">A file holds the first {number(EXPORT_ROWS)} rows of a table. There are more here: filter the rows to export the rest in parts.</p>}
    </fieldset>

    {url
      ? <a href={url} download={file} className={cn('inline-flex h-[30px] flex-none items-center gap-1.5 rounded-lg bg-primary-600 px-3.5 text-[13px] font-semibold text-primary-foreground hover:bg-primary-700 dark:hover:bg-primary-500 max-sm:h-11 max-sm:w-full max-sm:justify-center', focusRing)}>
        <Download className="h-3.5 w-3.5" aria-hidden="true" />Download
      </a>
      : <p role="note" className={cn('text-xs', muted)}>Rows are not shown to an administrator acting for another account, so there is nothing to download.</p>}
  </div>;
}
