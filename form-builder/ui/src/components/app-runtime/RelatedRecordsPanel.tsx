import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { RelatedRecordGroup } from '../../lib/api';
import { ListRowSkeleton } from '../ui/Skeleton';
import { parseServerDate } from '../../lib/utils';

const PAGE_SIZE = 50;

interface RelatedRecordsPanelProps {
  appSlug: string;
  formId: string;
  responseId: string;
}

export function RelatedRecordsPanel({ appSlug, formId, responseId }: RelatedRecordsPanelProps) {
  const navigate = useNavigate();
  const [related, setRelated] = useState<Record<string, RelatedRecordGroup>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
  }, [appSlug, formId, responseId]);

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

  const groups = Object.values(related);

  if (loading) {
    // Mirror the final layout (a short list of linked rows) so the page doesn't jump on load.
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

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 dark:border-slate-700/40 flex items-center gap-2">
        <Link2 className="h-4 w-4 app-text-primary" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-tight">Related records</h3>
      </div>

      {groups.map((group) => (
        <div key={group.formId} className="border-b last:border-b-0 border-gray-100 dark:border-slate-700/30">
          <div className="px-5 py-2.5 bg-gray-50 dark:bg-slate-800/50 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">
              {group.displayName}
            </span>
            <span className="text-xs font-medium text-gray-400 dark:text-slate-500 bg-gray-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">
              {group.count}
            </span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/30">
            {group.records.map((record) => (
              <button
                key={record.id}
                type="button"
                onClick={() => navigate(`/app/${appSlug}/form/${group.formId}/responses/${record.id}`)}
                className="w-full text-left px-5 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-all duration-200 cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300 truncate">
                    {record.display}
                  </p>
                  {record.submittedAt && (
                    <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                      {parseServerDate(record.submittedAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500 flex-shrink-0 ml-2 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      ))}

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
    </div>
  );
}
