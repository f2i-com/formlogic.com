import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Eye, Users, CheckCircle, Clock, BarChart3, Lock, ExternalLink } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { api, type FormAnalytics } from '../../lib/api';
import { StatCard } from '../ui/StatCard';
import { Card } from '../ui/Card';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { LoadFailure } from '../ui/LoadFailure';

/**
 * App-runtime analytics view — aggregate stats only (never individual answers).
 * Gated on the view_analytics permission both here and server-side.
 */
export function AppAnalytics() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, canViewAnalytics, canSubmit } = useAppRuntimeStore();
  const [data, setData] = useState<FormAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [appSlug, formId, allowed, reloadKey]);

  const maxCount = useMemo(
    () => Math.max(1, ...(data?.responsesByDate ?? []).map((d) => d.count)),
    [data]
  );

  if (!allowed) {
    return (
      <div className="py-8">
        <EmptyState
          icon={Lock}
          title="No access"
          description="You don't have permission to view analytics for this form."
        />
      </div>
    );
  }

  const avg = data?.averageCompletionTime ?? 0;
  const days = data?.responsesByDate ?? [];
  // Thin the x-axis labels when days collide (show every Nth tick; the per-bar
  // tooltip still carries the exact date for every bar).
  const labelStep = Math.max(1, Math.ceil(days.length / 10));

  return (
    <div>
      <PageHeader
        title={runtimeForm?.displayName || 'Analytics'}
        subtitle="Analytics · aggregate stats only"
        onBack={() => navigate(`/app/${appSlug}`)}
        backLabel="Back to dashboard"
      />

      {error ? (
        <LoadFailure
          title="We couldn't load these figures"
          onRetry={() => { setError(null); setLoading(true); setReloadKey((k) => k + 1); }}
        />
      ) : loading ? (
        // Skeleton mirroring the loaded layout: 4 stat tiles + the chart card.
        <div className="space-y-6" role="status" aria-label="Loading analytics">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2 pt-1">
                    <Skeleton className="h-7 w-14" />
                    <Skeleton className="h-3.5 w-20 max-w-full" />
                  </div>
                  <Skeleton className="h-10 w-10 rounded-xl flex-shrink-0" />
                </div>
              </Card>
            ))}
          </div>
          <Card className="p-5">
            <Skeleton className="h-4 w-44 mb-5" />
            <div className="flex items-end gap-1 sm:gap-1.5 h-40">
              {['h-1/3', 'h-3/5', 'h-2/5', 'h-4/5', 'h-1/2', 'h-2/3', 'h-2/5', 'h-3/4', 'h-1/2', 'h-3/5', 'h-1/3', 'h-2/3'].map((h, i) => (
                <div key={i} className="flex-1 h-full flex items-end min-w-0">
                  <Skeleton className={`w-full rounded-t ${h}`} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Users} iconBg="app-bg-primary-light" iconColor="app-text-primary" value={data?.totalResponses ?? 0} label="Responses" />
            <StatCard icon={CheckCircle} iconBg="app-bg-primary-light" iconColor="app-text-primary" value={`${data?.completionRate ?? 0}%`} label="Completion" />
            <StatCard icon={Clock} iconBg="app-bg-primary-light" iconColor="app-text-primary" value={avg > 60 ? `${Math.floor(avg / 60)}m` : `${avg}s`} label="Avg. time" />
            <StatCard icon={Eye} iconBg="app-bg-primary-light" iconColor="app-text-primary" value={data?.totalViews ?? 0} label="Views" />
          </div>

          <Card className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Submissions over time</h2>
            </div>
            {days.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No submissions yet"
                description="This chart fills in as responses come in."
                className="py-8"
                action={formId && canSubmit(formId) ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/app/${appSlug}/form/${formId}`)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg app-btn-primary transition-all duration-200 cursor-pointer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open the form
                  </button>
                ) : undefined}
              />
            ) : (
              <div className="flex items-end gap-1 sm:gap-1.5 h-44" role="img" aria-label="Bar chart of submissions per day">
                {days.map((d, i) => (
                  <div key={d.date} className="flex-1 h-full flex flex-col items-center min-w-0" title={`${d.date}: ${d.count}`}>
                    <span className="text-[10px] leading-4 text-gray-500 dark:text-slate-400 tabular-nums">{d.count}</span>
                    {/* Light full-height track with the app-accent bar rising from the bottom. */}
                    <div className="w-full flex-1 flex items-end rounded-t bg-gray-100/80 dark:bg-slate-800/50 overflow-hidden">
                      <div
                        className="w-full rounded-t min-h-[2px] motion-safe:transition-[height] motion-safe:duration-300"
                        style={{ height: `${(d.count / maxCount) * 100}%`, backgroundColor: 'var(--app-primary)', opacity: 0.85 }}
                      />
                    </div>
                    <span className="mt-1 text-[10px] leading-4 text-gray-400 dark:text-slate-500 truncate w-full text-center tabular-nums">
                      {i % labelStep === 0 ? d.date.slice(5) : ' '}
                    </span>
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
