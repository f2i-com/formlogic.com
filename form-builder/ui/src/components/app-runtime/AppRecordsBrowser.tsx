import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Database, ChevronRight } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

/**
 * A lightweight records hub: lists every form in the app the member is allowed to view, each opening
 * that form's records grid (AppDataTable). This is the single entry point to submitted data — it
 * works for chromeless custom-dashboard apps (via the floating Records button) and for apps with the
 * standard nav alike. Responsive: a single column on phones, two/three up on wider screens.
 */
export function AppRecordsBrowser() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, canViewOwn, canViewAll } = useAppRuntimeStore();

  if (!config) return null;

  const viewable = config.forms.filter((f) => canViewOwn(f.formId) || canViewAll(f.formId));

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
        subtitle="Browse each form's records"
        onBack={goBack}
        backLabel="Back to dashboard"
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
          {viewable.map((f) => (
            <button
              key={f.formId}
              onClick={() => navigate(`/app/${appSlug}/form/${f.formId}/responses`)}
              className="flex items-center gap-3 p-4 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-colors duration-200 text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
            >
              <div className="p-2 rounded-lg app-bg-primary-light shrink-0">
                <DynamicIcon name={f.icon ?? null} className="h-5 w-5 app-text-primary" fallback={<Database className="h-5 w-5 app-text-primary" />} />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{f.displayName}</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400">View records</span>
              </div>
              <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
