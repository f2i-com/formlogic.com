import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, Users, CheckCircle, Clock, BarChart3 } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { api, type FormAnalytics } from '../../lib/api';
import { StatCard } from '../ui/StatCard';
import { Card } from '../ui/Card';

/**
 * App-runtime analytics view — aggregate stats only (never individual answers).
 * Gated on the view_analytics permission both here and server-side.
 */
export function AppAnalytics() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, canViewAnalytics } = useAppRuntimeStore();
  const [data, setData] = useState<FormAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const allowed = formId ? canViewAnalytics(formId) : false;

  useEffect(() => {
    // Not-allowed is handled in render (permission-denied) before the loading branch, so we
    // don't need to touch state here. Keep all setState in async callbacks so we never call
    // it synchronously inside the effect body.
    if (!appSlug || !formId || !allowed) return;
    let cancelled = false;
    api.getAppAnalytics(appSlug, formId).then((res) => {
      if (cancelled) return;
      if (res.data?.analytics) setData(res.data.analytics);
      else setError(res.error || 'Failed to load analytics');
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [appSlug, formId, allowed]);

  const maxCount = useMemo(
    () => Math.max(1, ...(data?.responsesByDate ?? []).map((d) => d.count)),
    [data]
  );

  if (!allowed) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <p className="text-gray-500 dark:text-slate-400">You don&apos;t have permission to view analytics for this form.</p>
      </div>
    );
  }

  const avg = data?.averageCompletionTime ?? 0;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(`/app/${appSlug}`)}
          aria-label="Back to dashboard"
          className="p-2.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">
          {runtimeForm?.displayName || 'Analytics'}
        </h1>
      </div>

      {error ? (
        <div className="text-center py-12" role="alert">
          <p className="text-red-600 dark:text-red-400">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading analytics" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Users} iconBg="bg-blue-500/10" iconColor="text-blue-500" value={data?.totalResponses ?? 0} label="Responses" />
            <StatCard icon={CheckCircle} iconBg="bg-green-500/10" iconColor="text-green-500" value={`${data?.completionRate ?? 0}%`} label="Completion" />
            <StatCard icon={Clock} iconBg="bg-purple-500/10" iconColor="text-purple-500" value={avg > 60 ? `${Math.floor(avg / 60)}m` : `${avg}s`} label="Avg. Time" />
            <StatCard icon={Eye} iconBg="bg-sky-500/10" iconColor="text-sky-500" value={data?.totalViews ?? 0} label="Views" />
          </div>

          <Card className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Submissions over time</h2>
            </div>
            {(data?.responsesByDate?.length ?? 0) === 0 ? (
              <p className="text-sm text-gray-500 dark:text-slate-400 py-8 text-center">No submissions yet.</p>
            ) : (
              <div className="flex items-end gap-1.5 h-40" role="img" aria-label="Bar chart of submissions per day">
                {data!.responsesByDate.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0" title={`${d.date}: ${d.count}`}>
                    <span className="text-[10px] text-gray-500 dark:text-slate-400 tabular-nums">{d.count}</span>
                    <div
                      className="w-full rounded-t bg-primary-500/80 min-h-[2px]"
                      style={{ height: `${(d.count / maxCount) * 100}%` }}
                    />
                    <span className="text-[9px] text-gray-400 dark:text-slate-500 truncate w-full text-center">{d.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
