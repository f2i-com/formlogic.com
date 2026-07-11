import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Loader2, Inbox } from 'lucide-react';
import type { DashboardWidget } from '../../types/app';
import type { WidgetDataForm } from './widgetData';
import { useDisplayTimezone, formatDateTimeInZone, formatDateOnly, isIsoDateTime } from '../../lib/timezone';

type FieldOption = { value: string; label?: string };
interface Col { id: string; label: string; type: string; options?: FieldOption[] }
type RawField = { id: string; label?: string; type?: string; properties?: { options?: FieldOption[] } };

const SIMPLE_TYPES = ['short_text', 'long_text', 'email', 'phone', 'url', 'number', 'dropdown', 'date', 'checkboxes'];
const CHOICE_TYPES = ['dropdown', 'multiple_choice', 'checkboxes'];

function toCol(f: RawField | undefined, id: string): Col {
  const col: Col = { id, label: f?.label ?? id, type: f?.type ?? 'text' };
  if (f && CHOICE_TYPES.includes(f.type ?? '') && f.properties?.options?.length) col.options = f.properties.options;
  return col;
}

/** Columns for the grid: the widget's chosen fields, else the form's first few simple fields. */
function deriveColumns(form: WidgetDataForm | undefined, columnFieldIds?: string[]): Col[] {
  const fields = (form?.fields ?? []) as RawField[];
  if (columnFieldIds && columnFieldIds.length) {
    return columnFieldIds.map((id) => toCol(fields.find((x) => x.id === id), id));
  }
  return fields
    .filter((f) => SIMPLE_TYPES.includes(f.type ?? ''))
    .slice(0, 4)
    .map((f) => toCol(f, f.id));
}

/** Format a cell: choice values map to their option label; dates localize;
 *  datetimes (and ISO-8601 text) render in the viewer's timezone; arrays join. */
function cell(v: unknown, col: Col, tz: string): string {
  const labelFor = (x: unknown): string => col.options?.find((o) => o.value === x)?.label ?? String(x);
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map(labelFor).join(', ') : '—';
  if (typeof v === 'object') return '—';
  if (col.type === 'date' && typeof v === 'string') {
    return formatDateOnly(v);
  }
  if (typeof v === 'string' && (col.type === 'datetime' || isIsoDateTime(v))) {
    return formatDateTimeInZone(v, tz);
  }
  return labelFor(v);
}

type GridRow = { id?: unknown; answers?: Record<string, unknown> };

interface RecordsGridWidgetProps {
  widget: DashboardWidget;
  form?: WidgetDataForm;
  /** Runtime only: server-paginated page fetch. Absent on the builder canvas → static preview.
   *  Sort is pushed to the server so ordering spans all rows, composing with pagination. */
  fetchPage?: (formId: string, opts: { limit: number; offset: number; sort?: string; sortDir?: 'asc' | 'desc' }) => Promise<{ rows: unknown[]; total: number }>;
  onOpenRecord?: (formId: string, recordId: string) => void;
}

export function RecordsGridWidget({ widget, form, fetchPage, onOpenRecord }: RecordsGridWidgetProps) {
  const tz = useDisplayTimezone();
  const cfg = widget.grid;
  const formId = cfg?.formId ?? '';
  const pageSize = Math.max(1, Math.min(cfg?.pageSize ?? 10, 50));
  const cols = useMemo(() => deriveColumns(form, cfg?.columnFieldIds), [form, cfg?.columnFieldIds]);
  // Page state is KEYED by the query (form + page size): when either changes the
  // key no longer matches and the derived page falls back to 0 — no reset effect,
  // and no double fetch with a stale page number.
  const pageKey = `${formId}|${pageSize}`;
  const [pageState, setPageState] = useState({ key: pageKey, page: 0 });
  const page = pageState.key === pageKey ? pageState.page : 0;
  const gotoPage = (p: number) => setPageState({ key: pageKey, page: Math.max(0, p) });
  // Server-side column sort (keyed like the page so a form switch resets it).
  const [sortState, setSortState] = useState<{ key: string; sort: string | null; dir: 'asc' | 'desc' }>({ key: pageKey, sort: null, dir: 'desc' });
  const sort = sortState.key === pageKey ? sortState.sort : null;
  const sortDir = sortState.key === pageKey ? sortState.dir : 'desc';
  const toggleSort = (fieldId: string) => {
    const nextDir: 'asc' | 'desc' = sort === fieldId ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    setSortState({ key: pageKey, sort: fieldId, dir: nextDir });
    gotoPage(0); // a new order restarts pagination
  };
  const [rows, setRows] = useState<GridRow[]>([]);
  const [total, setTotal] = useState(0);
  // The builder canvas (no fetchPage) and an unconfigured widget never load — start settled.
  const [loading, setLoading] = useState(!!fetchPage && !!formId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fetchPage || !formId) return; // static preview / unconfigured — nothing to load
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: the in-flight status must reset synchronously when the query changes
    setLoading(true);
    setError(null);
    fetchPage(formId, { limit: pageSize, offset: page * pageSize, sort: sort ?? undefined, sortDir: sort ? sortDir : undefined }).then((r) => {
      if (cancelled) return;
      setRows((r.rows ?? []) as GridRow[]);
      setTotal(r.total ?? 0);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : 'Failed to load records');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchPage, formId, pageSize, page, sort, sortDir]);

  // Sortable when live (fetchPage present): the header click pushes the sort
  // to the server so ordering spans every row, not just the visible page.
  const sortable = !!fetchPage;
  const headerRow = (
    <tr className="text-left text-xs font-semibold text-gray-400 dark:text-slate-500 border-b border-gray-100 dark:border-slate-700/40">
      {cols.length ? cols.map((c) => (
        <th
          key={c.id}
          aria-sort={sortable ? (sort === c.id ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
          className="px-4 py-2 font-semibold whitespace-nowrap"
        >
          {sortable ? (
            <button
              type="button"
              onClick={() => toggleSort(c.id)}
              className="inline-flex items-center gap-1 font-semibold hover:text-gray-600 dark:hover:text-slate-300 cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 app-ring-primary rounded"
            >
              {c.label}
              {sort === c.id && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
            </button>
          ) : (
            c.label
          )}
        </th>
      ))
        : <th className="px-4 py-2 font-semibold">Record</th>}
    </tr>
  );

  // Builder canvas: no runtime fetch — show the column shape so the author sees the layout.
  if (!fetchPage) {
    return (
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-3">
        <table className="w-full text-sm"><thead>{headerRow}</thead>
          <tbody>
            <tr><td colSpan={Math.max(cols.length, 1)} className="px-4 py-6 text-center text-xs text-gray-400 dark:text-slate-500">
              {formId ? 'Records appear here in the app.' : 'Pick a form in the widget settings.'}
            </td></tr>
          </tbody>
        </table>
      </div>
    );
  }

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  const canPrev = page > 0;
  const canNext = (page + 1) * pageSize < total;
  const clickable = !!onOpenRecord;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto px-2">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-gray-400" role="status" aria-label="Loading records">
            <Loader2 className="h-5 w-5 motion-safe:animate-spin" />
          </div>
        ) : error && rows.length === 0 ? (
          <p className="text-center text-sm text-red-500 dark:text-red-400 py-6">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400 dark:text-slate-500">
            <Inbox className="h-6 w-6 opacity-70" />
            {/* page>0 with no rows = records shrank under us — offer a way back, not a dead end. */}
            {page > 0 ? (
              <button type="button" onClick={() => gotoPage(0)} className="mt-1 text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer">
                No records on this page — back to the start
              </button>
            ) : (
              <span className="mt-1 text-xs">No records yet</span>
            )}
          </div>
        ) : (
          <table className={`w-full text-sm ${loading ? 'opacity-50' : ''}`}>
            <thead>{headerRow}</thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
              {rows.map((r) => {
                const id = String(r.id ?? '');
                const answers = r.answers ?? {};
                return (
                  <tr
                    key={id}
                    onClick={() => clickable && onOpenRecord!(formId, id)}
                    className={`${clickable ? 'cursor-pointer' : ''} transition-colors hover:bg-gray-50 dark:hover:bg-slate-800/50 focus-visible:outline-none focus-visible:ring-2 app-ring-primary`}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpenRecord!(formId, id); } }}
                  >
                    {cols.length ? cols.map((c, i) => (
                      <td key={c.id} className={`px-4 py-2.5 text-gray-700 dark:text-slate-300 max-w-[14rem] truncate ${i === 0 ? 'font-medium' : ''}`}>
                        {cell(answers[c.id], c, tz)}
                      </td>
                    )) : <td className="px-4 py-2.5 font-medium text-gray-700 dark:text-slate-300">{`Record ${id.slice(0, 8)}`}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {total > pageSize && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-gray-100 dark:border-slate-700/40 shrink-0">
          <span className="text-xs text-gray-400 dark:text-slate-500 tabular-nums">{from}–{to} of {total}</span>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous page" disabled={!canPrev || loading} onClick={() => gotoPage(page - 1)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-default cursor-pointer">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Next page" disabled={!canNext || loading} onClick={() => gotoPage(page + 1)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-default cursor-pointer">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
