import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { RelatedRecordGroup } from '../../lib/api';

interface RelatedRecordsPanelProps {
  appSlug: string;
  formId: string;
  responseId: string;
}

export function RelatedRecordsPanel({ appSlug, formId, responseId }: RelatedRecordsPanelProps) {
  const navigate = useNavigate();
  const [related, setRelated] = useState<Record<string, RelatedRecordGroup>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getRelatedRecords(appSlug, formId, responseId).then((result) => {
      if (result.error) {
        setError(result.error);
      } else if (result.data?.related) {
        setRelated(result.data.related);
      }
      setLoading(false);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load related records');
      setLoading(false);
    });
  }, [appSlug, formId, responseId]);

  const groups = Object.values(related);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
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
    <div className="mt-4 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700/50 flex items-center gap-2">
        <Link2 className="h-4 w-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Related Records</h3>
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
                className="w-full text-left px-5 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300 truncate">
                    {record.display}
                  </p>
                  {record.submittedAt && (
                    <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                      {new Date(record.submittedAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500 flex-shrink-0 ml-2 transition-colors" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
