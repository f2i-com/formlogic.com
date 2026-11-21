import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Database, ChevronRight, Plus } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { ExportDataMenu } from '../apps/ExportDataMenu';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

/**
 * A lightweight records hub: lists every form in the app the member is allowed to view, each opening
 * that form's records grid (AppDataTable). This is the single entry point to submitted data — it
 * works for chromeless custom-dashboard apps (via the floating Records button) and for apps with the
 * standard nav alike. Responsive: a single column on phones, two/three up on wider screens.
 * The app OWNER additionally gets whole-app data exports (SQLite bundle / MySQL / SQL Server).
 */
export function AppRecordsBrowser() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, canSubmit, canViewOwn, canViewAll, isOwner, runReportBatch, fetchResponsePage } = useAppRuntimeStore();
  const [counts, setCounts] = useState<Record<string, number>>({});

  const viewable = config ? config.forms.filter((f) => canViewOwn(f.formId) || canViewAll(f.formId)) : [];
  const viewableKey = viewable.map((f) => f.formId).join(',');

  useEffect(() => {
    if (!config || viewable.length === 0) return;
    let cancelled = false;
    // Fetch all form row counts in ONE batched round trip via runReportBatch, falling back to
    // per-form fetchResponsePage only for forms whose report cannot run (e.g. private E2EE forms).
    const specs = viewable.map((f) => ({ formId: f.formId, viz: 'kpi' as const, measure: { fn: 'count' as const } }));
    void runReportBatch(specs).then(async (results) => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      const missing: typeof viewable = [];
      viewable.forEach((f, idx) => {
        const res = results[idx];
        if (res && typeof res.value === 'number' && Number.isFinite(res.value)) {
          next[f.formId] = Math.round(res.value);
        } else {
          missing.push(f);
        }
      });
      if (Object.keys(next).length > 0) setCounts(next);
      if (missing.length > 0) {
        const fallback = await Promise.all(
          missing.map(async (f) => {
            try {
              const { total } = await fetchResponsePage(f.formId, { limit: 1, offset: 0 });
              return [f.formId, total] as const;
            } catch {
              return null;
            }
          })
        );
        if (cancelled) return;
        const merged = { ...next };
        for (const entry of fallback) {
          if (entry) merged[entry[0]] = entry[1];
        }
        setCounts(merged);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSlug, viewableKey, runReportBatch, fetchResponsePage]);

  if (!config) return null;

  // History-aware back: return to wherever the user came from (dashboard, custom screen, …);
  // fall back to the app home on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/app/${appSlug}`);
  };

  return (
    <div>
      <PageHeader
        title="Records"
        subtitle="Browse and manage each form's records"
        onBack={goBack}
        backLabel="Back to dashboard"
        actions={isOwner() && config.app.id ? <ExportDataMenu appId={config.app.id} appSlug={appSlug ?? 'app'} variant="app" /> : undefined}
      />

      {viewable.length === 0 ? (
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50">
          <EmptyState
            icon={Database}
            title="No records to browse"
            description="You don't have permission to view records in this app. Ask the app owner to grant you access."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {viewable.map((f) => {
            const count = counts[f.formId];
            const allowNew = canSubmit(f.formId) && f.customScreen?.allowNewResponses !== false;
            return (
              <div
                key={f.formId}
                className="flex items-stretch rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 hover:border-gray-300 dark:hover:border-slate-600 transition-colors duration-200 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/app/${appSlug}/form/${f.formId}/responses`)}
                  className="flex min-w-0 flex-1 items-center gap-3 p-4 hover:bg-gray-50 dark:hover:bg-slate-800/80 transition-colors duration-200 text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary"
                >
                  <div className="p-2 rounded-lg app-bg-primary-light shrink-0">
                    <DynamicIcon name={f.icon ?? null} className="h-5 w-5 app-text-primary" fallback={<Database className="h-5 w-5 app-text-primary" />} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{f.displayName}</span>
                      {typeof count === 'number' && (
                        <span className="shrink-0 rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-gray-600 dark:text-slate-300">
                          {count}
                        </span>
                      )}
                    </div>
                    <span className="block text-xs text-gray-500 dark:text-slate-400">
                      {typeof count === 'number'
                        ? `View records · ${count} ${count === 1 ? 'row' : 'rows'}`
                        : 'View records'}
                    </span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 shrink-0" />
                </button>
                {allowNew && (
                  <button
                    type="button"
                    onClick={() => navigate(`/app/${appSlug}/form/${f.formId}?new=1`)}
                    aria-label={`Add new ${f.displayName}`}
                    title={`New ${f.displayName}`}
                    className="flex items-center justify-center border-l border-gray-100 dark:border-slate-800 px-3 text-gray-400 hover:bg-gray-50 hover:text-primary-600 dark:hover:bg-slate-800 dark:hover:text-primary-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
