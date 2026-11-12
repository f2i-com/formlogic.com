// Under the rows: which rows these are, of how many, how many to a page, and the way to the
// first, previous, next and last page. On a phone each part has its own line and the page
// buttons are a finger wide.
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { PAGE_SIZES, count, number } from './format';
import { field, iconButton, line, muted, quietSurface } from './styles';
import type { TablePage } from './useTablePage';

interface PagerProps {
  page: TablePage;
  /** A search or a filter is narrowing the rows. */
  narrowed: boolean;
  /** The rows-per-page choice. */
  limit: number;
  onLimit(size: number): void;
  onGo(offset: number): void;
  /** What else there is to say under the rows: how to edit, what is not shown. */
  notes: string[];
}

export function Pager({ page, narrowed, limit, onLimit, onGo, notes }: PagerProps) {
  const { data, offset, pageSize, loading } = page;
  const shown = data?.rows?.length ?? 0;
  // What is paged through: the rows that pass the search and filters. An older server sends no count.
  const matching = typeof data?.matching === 'number' ? data.matching : undefined;
  const end = data?.end ?? (data?.hasMore ? 'more' : 'end');
  // The server pages within a window: no page starts past `offsetLimit`.
  const reach = data?.offsetLimit ?? 100000;
  const last = matching === undefined ? undefined : Math.min(Math.max(0, Math.ceil(matching / pageSize) - 1) * pageSize, Math.floor(reach / pageSize) * pageSize);
  const at = Math.floor(offset / pageSize) + 1;
  const pages = last === undefined ? undefined : Math.max(at, last / pageSize + 1);
  const ready = !!data && !loading && !page.error;
  const canGoBack = ready && offset > 0;
  const canGoOn = ready && end === 'more';
  const of = matching === undefined ? '' : ` of ${number(matching)}${narrowed ? ' matching' : ''}`;
  const hiddenColumns = data?.hiddenColumns ?? 0;
  const said = [hiddenColumns > 0 ? `${count(hiddenColumns, 'column')} not shown (${hiddenColumns === 1 ? 'looks like a secret' : 'they look like secrets'})` : '', ...notes].filter(Boolean);

  // lg:pr-20: on a wide screen the page's chat button floats over the bottom right corner.
  return <div className={cn('flex min-h-[34px] flex-none flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1 text-xs max-sm:flex-col max-sm:items-stretch max-sm:gap-y-2 max-sm:py-2 lg:pr-20', line, quietSurface, muted)}>
    <span aria-live="polite">{shown > 0 ? `Rows ${number(offset + 1)}–${number(offset + shown)}${of}` : data && !page.error ? 'No rows' : ''}</span>
    <label className="flex items-center gap-1.5">Per page
      <select aria-label="Rows per page" value={limit} onChange={event => onLimit(Number(event.target.value))} className={cn(field, 'h-6 px-1')}>
        {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
    <span className="flex items-center gap-0.5 max-sm:justify-between">
      <button type="button" aria-label="First page" disabled={!canGoBack} onClick={() => onGo(0)} className={iconButton}><ChevronsLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button type="button" aria-label="Previous page" disabled={!canGoBack} onClick={() => onGo(Math.max(0, offset - pageSize))} className={iconButton}><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
      <span className="px-1.5 tabular-nums text-slate-800 dark:text-slate-200">{pages === undefined ? `Page ${number(at)}` : `${number(at)} / ${number(pages)}`}</span>
      <button type="button" aria-label="Next page" disabled={!canGoOn} onClick={() => onGo(offset + pageSize)} className={iconButton}><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button type="button" aria-label="Last page" disabled={!canGoOn || last === undefined} onClick={() => { if (last !== undefined) onGo(last); }} className={iconButton}><ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
    </span>
    {said.length > 0 && <span className="sm:ml-auto">{said.join(' · ')}</span>}
  </div>;
}
