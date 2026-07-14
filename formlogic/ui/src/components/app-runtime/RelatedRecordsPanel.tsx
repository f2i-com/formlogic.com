import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { RelatedRecordGroup } from '../../lib/api';
import { ListRowSkeleton } from '../ui/Skeleton';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { parseServerDate } from '../../lib/utils';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useDisplayTimezone, formatDateTimeInZone, formatDateOnly, isIsoDateTime } from '../../lib/timezone';
import { useFittedColumns } from '../../hooks/useFittedColumns';

type RelatedColumn = NonNullable<RelatedRecordGroup['columns']>[number];

interface RelatedRecordsPanelProps {
  appSlug: string;
  formId: string;
  responseId: string;
  // Owner-mode overrides (the builder responses page): when provided, the panel uses these
  // instead of the app-runtime store + app routes. Provide STABLE (useCallback'd) functions —
  // a new identity each render forces a refetch. All absent = the app-runtime behavior.
  fetchRelated?: () => Promise<{ related?: Record<string, RelatedRecordGroup>; error?: string }>;
  deleteRecord?: (formId: string, recordId: string) => Promise<boolean>;
  canAddFn?: (formId: string) => boolean;
  canDeleteFn?: (formId: string) => boolean;
  onOpenRecord?: (formId: string, recordId: string) => void;
  onAddRecord?: (group: RelatedRecordGroup) => void;
  /** Groups a record widget renders itself (recordScreen.consumesRelated) — hidden here.
   *  Entries are either a bare fieldId, or 'packFormId.fieldId' to pin the source form when
   *  several forms link here through the same field name (e.g. transcript-turns.call_link
   *  vs follow-up-tasks.call_link). */
  excludeFieldIds?: string[];
}

/** Render one related-record cell: arrays join, choice values map to their
 *  option label, datetimes (incl. ISO-8601 text) show in the viewer's timezone. */
function formatCell(value: unknown, col: RelatedColumn, tz: string): string {
  const labelFor = (v: unknown): string => {
    const opt = col.options?.find((o) => o.value === v);
    return opt ? opt.label : String(v);
  };
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(labelFor).join(', ') : '—';
  if (typeof value === 'object') return '—';
  if (col.type === 'date' && typeof value === 'string') {
    return formatDateOnly(value);
  }
  if (typeof value === 'string' && (col.type === 'datetime' || isIsoDateTime(value))) {
    return formatDateTimeInZone(value, tz);
  }
  return labelFor(value);
}

type RelatedRecord = RelatedRecordGroup['records'][number];

interface RelatedGroupSectionProps {
  group: RelatedRecordGroup;
  tz: string;
  mayAdd: boolean;
  mayDelete: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: (group: RelatedRecordGroup) => void;
  onOpen: (formId: string, recordId: string) => void;
  onRequestDelete: (record: RelatedRecord) => void;
}

/** One relationship group: fits as many field columns as the container's ACTUAL width
 *  allows (no horizontal scroll), and collapses to stacked cards on phone-sized widths. */
function RelatedGroupSection({ group, tz, mayAdd, mayDelete, isExpanded, onToggleExpanded, onAdd, onOpen, onRequestDelete }: RelatedGroupSectionProps) {
  const cols = group.columns && group.columns.length ? group.columns : null;
  // Reserve room for the always-present "Added" timestamp (w-48) + actions (w-12)
  // columns; itemMinPx includes each field cell's px-5 padding. These estimates only
  // decide how MANY columns are readable — the table itself is `table-fixed`, so a
  // misestimate squeezes cells (truncated, with title tooltips) instead of ever
  // overflowing the container horizontally.
  const { ref: fitRef, count: fitCount, cards } = useFittedColumns<HTMLDivElement>({
    itemCount: cols ? cols.length : 1,
    itemMinPx: 160,
    reservedPx: mayDelete ? 250 : 210,
  });
  const visibleCols = cols ? cols.slice(0, Math.max(1, fitCount)) : null;

  // Newest first (link-table order is effectively random), capped at the
  // relationship's configured page size behind a per-group "Show all".
  const sorted = [...group.records].sort((a, b) => {
    const ta = a.submittedAt ? parseServerDate(a.submittedAt).getTime() : 0;
    const tb = b.submittedAt ? parseServerDate(b.submittedAt).getTime() : 0;
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
  const cap = Math.max(1, group.pageSize ?? 8);
  const visible = isExpanded ? sorted : sorted.slice(0, cap);
  const hiddenCount = sorted.length - visible.length;

  return (
    <div className="border-b last:border-b-0 border-gray-100 dark:border-slate-700/30">
      <div className="px-5 py-2.5 bg-gray-50 dark:bg-slate-800/50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider truncate">
            {group.displayName}
          </span>
          <span className="text-xs font-medium text-gray-400 dark:text-slate-500 bg-gray-100 dark:bg-slate-800 px-2 py-0.5 rounded-full flex-shrink-0">
            {group.count}
          </span>
        </div>
        {mayAdd && (
          <button
            type="button"
            onClick={() => onAdd(group)}
            className="inline-flex items-center gap-1 text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 app-ring-primary rounded px-1.5 py-0.5"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        )}
      </div>

      <div ref={fitRef}>
        {cards ? (
          /* Stacked cards — too narrow for a table. Every column shows as label/value;
           * delete is always visible (no hover on touch). */
          <div className="px-4 py-3 space-y-2">
            {visible.map((record) => (
              <div
                key={record.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(group.formId, record.id)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(group.formId, record.id); } }}
                className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-3 flex items-start justify-between gap-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  {cols ? (
                    cols.map((c, i) => (
                      <div key={c.id} className="flex gap-2 text-sm">
                        <span className="text-gray-400 dark:text-slate-500 shrink-0">{c.label}:</span>
                        <span className={`text-gray-900 dark:text-slate-200 min-w-0 truncate ${i === 0 ? 'font-medium' : ''}`}>
                          {formatCell(record.fields?.[c.id], c, tz)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm font-medium text-gray-900 dark:text-slate-200 truncate">{record.display}</p>
                  )}
                  <p className="text-xs text-gray-400 dark:text-slate-500">
                    {record.submittedAt ? formatDateTimeInZone(record.submittedAt, tz) : '—'}
                  </p>
                </div>
                {mayDelete && (
                  <button
                    type="button"
                    aria-label="Delete related record"
                    onClick={(e) => { e.stopPropagation(); onRequestDelete(record); }}
                    className="shrink-0 p-1.5 rounded-lg text-gray-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          /* table-fixed: column widths come from the header row (Added w-48, actions
           * w-12, field columns share the rest equally) and the table is EXACTLY the
           * container width — it structurally cannot overflow into a horizontal
           * scroll. Cell content truncates instead (full value in the title). */
          <div>
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-gray-400 dark:text-slate-500 border-b border-gray-100 dark:border-slate-700/30">
                  {visibleCols
                    ? visibleCols.map((c) => <th key={c.id} className="px-5 py-2 font-semibold truncate" title={c.label}>{c.label}</th>)
                    : <th className="px-5 py-2 font-semibold">Record</th>}
                  <th className="w-48 px-4 py-2 font-semibold">Added</th>
                  <th className="w-12 px-3 py-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700/30">
                {visible.map((record) => (
                  <tr
                    key={record.id}
                    className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group/row"
                    onClick={() => onOpen(group.formId, record.id)}
                  >
                    {visibleCols
                      ? visibleCols.map((c, i) => {
                          const text = formatCell(record.fields?.[c.id], c, tz);
                          return (
                            <td key={c.id} className={`px-5 py-3 text-gray-700 dark:text-slate-300 ${i === 0 ? 'font-medium' : ''} truncate`} title={text}>
                              {text}
                            </td>
                          );
                        })
                      : <td className="px-5 py-3 font-medium text-gray-700 dark:text-slate-300 truncate" title={record.display}>{record.display}</td>}
                    <td className="px-4 py-3 text-xs text-gray-400 dark:text-slate-500 truncate" title={record.submittedAt ? formatDateTimeInZone(record.submittedAt, tz) : undefined}>
                      {record.submittedAt ? formatDateTimeInZone(record.submittedAt, tz) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {mayDelete && (
                        <button
                          type="button"
                          aria-label="Delete related record"
                          onClick={(e) => { e.stopPropagation(); onRequestDelete(record); }}
                          className="p-1.5 rounded-lg text-gray-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer opacity-0 group-hover/row:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {(hiddenCount > 0 || (isExpanded && sorted.length > cap)) && (
        <div className="px-5 py-2 border-t border-gray-100 dark:border-slate-700/30">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary rounded px-1 py-0.5"
          >
            {isExpanded ? 'Show fewer' : `Show all ${sorted.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

export function RelatedRecordsPanel(props: RelatedRecordsPanelProps) {
  const { appSlug, formId, responseId, fetchRelated, deleteRecord, onOpenRecord, onAddRecord } = props;
  const navigate = useNavigate();
  const store = useAppRuntimeStore();
  const tz = useDisplayTimezone();
  const [related, setRelated] = useState<Record<string, RelatedRecordGroup>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<{ formId: string; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Per-group "Show all" expansion (keyed by the relationship key).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // The backend now returns every related group in one call (no cross-group paging) —
  // fetch once. Depend on the SPECIFIC fetch fn (not the whole props object) so an
  // unrelated parent re-render (status change, opening the delete dialog) doesn't refetch.
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: status reset must be synchronous when deps change
    setLoading(true);
    setError(null);
    const run = fetchRelated
      ? fetchRelated()
      : api.getRelatedRecords(appSlug, formId, responseId, { limit: 2000, offset: 0 }).then((r) => ({ related: r.data?.related, error: r.error }));
    run.then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else if (result.related) setRelated(result.related);
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load related records');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchRelated, appSlug, formId, responseId, refreshTick]);

  const openRecord = useCallback((groupFormId: string, recordId: string) => {
    if (onOpenRecord) onOpenRecord(groupFormId, recordId);
    else navigate(`/app/${appSlug}/form/${groupFormId}/responses/${recordId}`);
  }, [onOpenRecord, appSlug, navigate]);

  const addRelated = useCallback((group: RelatedRecordGroup) => {
    if (onAddRecord) { onAddRecord(group); return; }
    if (!group.fieldId) return;
    navigate(`/app/${appSlug}/form/${group.formId}?new=1&linkField=${encodeURIComponent(group.fieldId)}&linkTo=${encodeURIComponent(responseId)}`);
  }, [onAddRecord, appSlug, responseId, navigate]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const del = deleteRecord ?? store.deleteResponse;
    const ok = await del(deleteTarget.formId, deleteTarget.id);
    setDeleting(false);
    if (ok) {
      setDeleteTarget(null);
      setRefreshTick((t) => t + 1); // reload so counts + rows stay truthful
    }
  }, [deleteTarget, deleteRecord, store]);

  const canAdd = props.canAddFn ?? store.canSubmit;
  const canDel = props.canDeleteFn ?? store.canDelete;
  const excluded = props.excludeFieldIds;
  const isConsumed = (g: RelatedRecordGroup): boolean =>
    !!excluded?.some((entry) => {
      // Field ids are machine keys (no dots), so a dot always separates packFormId.fieldId.
      const dot = entry.indexOf('.');
      if (dot < 0) return entry === (g.fieldId ?? '');
      if (entry.slice(dot + 1) !== (g.fieldId ?? '')) return false;
      const sourceForm = store.config?.forms.find((f) => f.formId === g.formId);
      return sourceForm?.packFormId === entry.slice(0, dot);
    });
  const groups = Object.values(related).filter((g) => !isConsumed(g));

  if (loading) {
    return (
      <div className="mt-4 space-y-2" role="status" aria-label="Loading related records">
        <ListRowSkeleton />
        <ListRowSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 text-center py-4">
        <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (groups.length === 0) return null;

  return (
    <div className="mt-4 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 dark:border-slate-700/40 flex items-center gap-2">
        <Link2 className="h-4 w-4 app-text-primary" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-tight">Related records</h3>
      </div>

      {groups.map((group) => {
        const gkey = group.key ?? group.formId;
        return (
          <RelatedGroupSection
            key={gkey}
            group={group}
            tz={tz}
            mayAdd={!!group.fieldId && group.allowAdd !== false && canAdd(group.formId)}
            mayDelete={group.allowDelete !== false && canDel(group.formId)}
            isExpanded={!!expanded[gkey]}
            onToggleExpanded={() => setExpanded((prev) => ({ ...prev, [gkey]: !prev[gkey] }))}
            onAdd={addRelated}
            onOpen={openRecord}
            onRequestDelete={(record) => setDeleteTarget({ formId: group.formId, id: record.id, label: record.display })}
          />
        );
      })}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete related record"
        message={deleteTarget ? `Delete "${deleteTarget.label}"? This can't be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleting}
      />
    </div>
  );
}
