import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { RelatedRecordGroup } from '../../lib/api';
import { ListRowSkeleton } from '../ui/Skeleton';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { parseServerDate } from '../../lib/utils';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

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
}

/** Render one related-record cell: arrays join, choice values map to their option label. */
function formatCell(value: unknown, col: RelatedColumn): string {
  const labelFor = (v: unknown): string => {
    const opt = col.options?.find((o) => o.value === v);
    return opt ? opt.label : String(v);
  };
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(labelFor).join(', ') : '—';
  if (typeof value === 'object') return '—';
  if (col.type === 'date' && typeof value === 'string') {
    const d = new Date(value + 'T00:00:00');
    return isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return labelFor(value);
}

export function RelatedRecordsPanel(props: RelatedRecordsPanelProps) {
  const { appSlug, formId, responseId, fetchRelated, deleteRecord, onOpenRecord, onAddRecord } = props;
  const navigate = useNavigate();
  const store = useAppRuntimeStore();
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
  const groups = Object.values(related);

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
        const cols = group.columns && group.columns.length ? group.columns : null;
        const mayAdd = !!group.fieldId && group.allowAdd !== false && canAdd(group.formId);
        const mayDelete = group.allowDelete !== false && canDel(group.formId);
        // Newest first (link-table order is effectively random), capped at the
        // relationship's configured page size behind a per-group "Show all".
        const sorted = [...group.records].sort((a, b) => {
          const ta = a.submittedAt ? parseServerDate(a.submittedAt).getTime() : 0;
          const tb = b.submittedAt ? parseServerDate(b.submittedAt).getTime() : 0;
          return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
        });
        const cap = Math.max(1, group.pageSize ?? 8);
        const gkey = group.key ?? group.formId;
        const isExpanded = !!expanded[gkey];
        const visible = isExpanded ? sorted : sorted.slice(0, cap);
        const hiddenCount = sorted.length - visible.length;
        return (
          <div key={gkey} className="border-b last:border-b-0 border-gray-100 dark:border-slate-700/30">
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
                  onClick={() => addRelated(group)}
                  className="inline-flex items-center gap-1 text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 app-ring-primary rounded px-1.5 py-0.5"
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-400 dark:text-slate-500 border-b border-gray-100 dark:border-slate-700/30">
                    {cols
                      ? cols.map((c) => <th key={c.id} className="px-5 py-2 font-semibold whitespace-nowrap">{c.label}</th>)
                      : <th className="px-5 py-2 font-semibold">Record</th>}
                    <th className="px-5 py-2 font-semibold whitespace-nowrap">Added</th>
                    <th className="px-3 py-2 w-10" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700/30">
                  {visible.map((record) => (
                    <tr
                      key={record.id}
                      className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group/row"
                      onClick={() => openRecord(group.formId, record.id)}
                    >
                      {cols
                        ? cols.map((c, i) => (
                            <td key={c.id} className={`px-5 py-3 text-gray-700 dark:text-slate-300 ${i === 0 ? 'font-medium' : ''} max-w-[16rem] truncate`}>
                              {formatCell(record.fields?.[c.id], c)}
                            </td>
                          ))
                        : <td className="px-5 py-3 font-medium text-gray-700 dark:text-slate-300 max-w-[20rem] truncate">{record.display}</td>}
                      <td className="px-5 py-3 text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">
                        {record.submittedAt ? parseServerDate(record.submittedAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-3 w-10">
                        {mayDelete && (
                          <button
                            type="button"
                            aria-label="Delete related record"
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget({ formId: group.formId, id: record.id, label: record.display }); }}
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
            {(hiddenCount > 0 || (isExpanded && sorted.length > cap)) && (
              <div className="px-5 py-2 border-t border-gray-100 dark:border-slate-700/30">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [gkey]: !isExpanded }))}
                  className="text-xs font-semibold app-text-primary hover:opacity-80 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary rounded px-1 py-0.5"
                >
                  {isExpanded ? 'Show fewer' : `Show all ${sorted.length}`}
                </button>
              </div>
            )}
          </div>
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
