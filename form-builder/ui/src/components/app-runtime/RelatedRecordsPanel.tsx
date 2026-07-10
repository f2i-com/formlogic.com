import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, Loader2, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { RelatedRecordGroup } from '../../lib/api';
import { ListRowSkeleton } from '../ui/Skeleton';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { parseServerDate } from '../../lib/utils';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

const PAGE_SIZE = 50;

interface RelatedRecordsPanelProps {
  appSlug: string;
  formId: string;
  responseId: string;
}

/** Render one related-record cell value: arrays join, empty shows an em dash. */
function formatCell(value: unknown): string {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join(', ') : '—';
  if (typeof value === 'object') return '—';
  return String(value);
}

export function RelatedRecordsPanel({ appSlug, formId, responseId }: RelatedRecordsPanelProps) {
  const navigate = useNavigate();
  const { canSubmit, canDelete, deleteResponse } = useAppRuntimeStore();
  const [related, setRelated] = useState<Record<string, RelatedRecordGroup>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<{ formId: string; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: status reset must be synchronous when deps change
    setLoading(true);
    setError(null);
    setOffset(0);
    let cancelled = false;
    api.getRelatedRecords(appSlug, formId, responseId, { limit: PAGE_SIZE, offset: 0 }).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
      } else if (result.data?.related) {
        setRelated(result.data.related);
        const totalRecords = Object.values(result.data.related).reduce((sum, g) => sum + g.records.length, 0);
        setHasMore(totalRecords >= PAGE_SIZE);
      }
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load related records');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [appSlug, formId, responseId, refreshTick]);

  const loadMore = useCallback(async () => {
    const nextOffset = offset + PAGE_SIZE;
    setLoadingMore(true);
    try {
      const result = await api.getRelatedRecords(appSlug, formId, responseId, { limit: PAGE_SIZE, offset: nextOffset });
      if (result.data?.related) {
        setRelated((prev) => {
          const merged = { ...prev };
          for (const [key, group] of Object.entries(result.data!.related)) {
            if (merged[key]) {
              merged[key] = { ...merged[key], records: [...merged[key].records, ...group.records], count: merged[key].count + group.count };
            } else {
              merged[key] = group;
            }
          }
          return merged;
        });
        const newRecords = Object.values(result.data.related).reduce((sum, g) => sum + g.records.length, 0);
        setHasMore(newRecords >= PAGE_SIZE);
        setOffset(nextOffset);
      } else {
        setHasMore(false);
      }
    } catch {
      // silently fail on load more
    }
    setLoadingMore(false);
  }, [appSlug, formId, responseId, offset]);

  const openRecord = useCallback((groupFormId: string, recordId: string) => {
    navigate(`/app/${appSlug}/form/${groupFormId}/responses/${recordId}`);
  }, [appSlug, navigate]);

  const addRelated = useCallback((group: RelatedRecordGroup) => {
    if (!group.fieldId) return;
    // Deep-link into the source form's entry with the link back to THIS record
    // pre-seeded (AppFormView reads linkField/linkTo).
    navigate(`/app/${appSlug}/form/${group.formId}?new=1&linkField=${encodeURIComponent(group.fieldId)}&linkTo=${encodeURIComponent(responseId)}`);
  }, [appSlug, responseId, navigate]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const ok = await deleteResponse(deleteTarget.formId, deleteTarget.id);
    setDeleting(false);
    if (ok) {
      setDeleteTarget(null);
      setRefreshTick((t) => t + 1); // reload the panel so counts + rows stay truthful
    }
  }, [deleteTarget, deleteResponse]);

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
        const mayAdd = !!group.fieldId && group.allowAdd !== false && canSubmit(group.formId);
        const mayDelete = group.allowDelete !== false && canDelete(group.formId);
        return (
          <div key={group.formId} className="border-b last:border-b-0 border-gray-100 dark:border-slate-700/30">
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
                  {group.records.map((record) => (
                    <tr
                      key={record.id}
                      className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group/row"
                      onClick={() => openRecord(group.formId, record.id)}
                    >
                      {cols
                        ? cols.map((c, i) => (
                            <td key={c.id} className={`px-5 py-3 text-gray-700 dark:text-slate-300 ${i === 0 ? 'font-medium' : ''} max-w-[16rem] truncate`}>
                              {formatCell(record.fields?.[c.id])}
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
          </div>
        );
      })}

      {hasMore && (
        <div className="px-5 py-3 border-t border-gray-100 dark:border-slate-700/40">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full text-center text-sm font-medium app-text-primary hover:opacity-80 disabled:opacity-50 cursor-pointer"
          >
            {loadingMore ? (
              <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 motion-safe:animate-spin" /> Loading…</span>
            ) : (
              'Load more'
            )}
          </button>
        </div>
      )}

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
