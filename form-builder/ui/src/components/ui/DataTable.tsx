import { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, Search, Inbox } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (item: T) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyField?: string;
  pageSize?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
  className?: string;
  actions?: (item: T) => React.ReactNode;
  totalCount?: number;
  searchBarExtra?: React.ReactNode;
  /** Render shimmer skeleton rows instead of the empty/data state while fetching. */
  isLoading?: boolean;
}

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  keyField = 'id',
  pageSize = 10,
  searchable = false,
  searchPlaceholder = 'Search...',
  onRowClick,
  emptyMessage = 'No data found',
  className,
  actions,
  totalCount,
  searchBarExtra,
  isLoading = false,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return data;
    const lower = search.toLowerCase();
    return data.filter((item) =>
      columns.some((col) => {
        const val = item[col.key];
        return val != null && String(val).toLowerCase().includes(lower);
      })
    );
  }, [data, search, columns]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const aVal = a[sortKey] ?? '';
      const bVal = b[sortKey] ?? '';
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      let cmp: number;
      if (aVal !== '' && bVal !== '' && !isNaN(aNum) && !isNaN(bNum)) {
        cmp = aNum - bNum;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const safePage = totalPages > 0 ? Math.min(page, totalPages - 1) : 0;
  const paged = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  };

  return (
    <div className={cn('w-full', className)}>
      {searchable && (
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder={searchPlaceholder}
              aria-label="Search table"
              className="w-full pl-9 pr-3.5 py-2 border border-gray-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder:text-gray-400 dark:placeholder:text-slate-500 transition-all duration-200"
            />
          </div>
          {searchBarExtra}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200/80 dark:border-slate-700/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/80 dark:bg-slate-800/80 border-b border-gray-200/80 dark:border-slate-700/60 sticky top-0 z-10">
              {columns.map((col) => (
                <th
                  key={col.key}
                  // Keep the columnheader role so aria-sort is honored; the sort
                  // control is an inner <button> (so the header isn't a role=button).
                  aria-sort={col.sortable ? (sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                  className={cn('px-4 py-3 text-left font-medium text-gray-600 dark:text-slate-400', col.className)}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className="-mx-1 px-1 inline-flex items-center gap-1 rounded font-medium hover:text-gray-900 dark:hover:text-slate-200 select-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50"
                    >
                      {col.label}
                      {sortKey === col.key ? (
                        sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 text-gray-300 dark:text-slate-600" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    <div className="flex items-center gap-1">{col.label}</div>
                  )}
                </th>
              ))}
              {actions && <th className="px-4 py-3 text-right font-medium text-gray-600 dark:text-slate-400">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: Math.min(pageSize, 5) }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-gray-100 dark:border-slate-700/40">
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      <div className="h-4 rounded bg-gray-100 dark:bg-slate-800 shimmer" />
                    </td>
                  ))}
                  {actions && (
                    <td className="px-4 py-3">
                      <div className="h-4 w-16 ml-auto rounded bg-gray-100 dark:bg-slate-800 shimmer" />
                    </td>
                  )}
                </tr>
              ))
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (actions ? 1 : 0)} className="px-4 py-12 text-center">
                  <Inbox className="h-8 w-8 mx-auto text-gray-300 dark:text-slate-600 mb-2" />
                  <p className="text-sm text-gray-500 dark:text-slate-400">{emptyMessage}</p>
                </td>
              </tr>
            ) : (
              paged.map((item) => (
                <tr
                  key={String(item[keyField])}
                  onClick={() => onRowClick?.(item)}
                  tabIndex={onRowClick ? 0 : undefined}
                  // Only act when the row itself is the target — so Enter/Space on a
                  // row-action button (Delete etc.) isn't hijacked into row navigation.
                  onKeyDown={onRowClick ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRowClick(item); } } : undefined}
                  className={cn(
                    'border-b border-gray-100 dark:border-slate-700/40 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors duration-150',
                    onRowClick && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 focus-visible:bg-primary-50 dark:focus-visible:bg-primary-500/10'
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn('px-4 py-3 text-gray-900 dark:text-slate-200', col.className)}>
                      {col.render ? col.render(item) : String(item[col.key] ?? '')}
                    </td>
                  ))}
                  {actions && (
                    <td className="px-4 py-3 text-right">
                      {actions(item)}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-600 dark:text-slate-400">
          <span>
            Showing {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sorted.length)} of {sorted.length}{totalCount != null && sorted.length !== totalCount ? ` (${totalCount} total)` : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              aria-label="Previous page"
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="tabular-nums">Page {safePage + 1} of {totalPages}</span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={safePage >= totalPages - 1}
              aria-label="Next page"
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
