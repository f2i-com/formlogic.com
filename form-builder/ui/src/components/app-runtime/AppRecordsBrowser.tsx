import { useNavigate, useParams } from 'react-router-dom';
import { Database, ChevronRight, ArrowLeft } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
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
  const { config, canViewOwn, canViewAll } = useAppRuntimeStore();

  if (!config) return null;

  const viewable = config.forms.filter((f) => canViewOwn(f.formId) || canViewAll(f.formId));

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
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">Records</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Browse submitted entries by form</p>
        </div>
      </div>

      {viewable.length === 0 ? (
        <div className="text-center py-16">
          <Database className="h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-500 dark:text-slate-400">You don&apos;t have permission to view records in this app.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {viewable.map((f) => (
            <button
              key={f.formId}
              onClick={() => navigate(`/app/${appSlug}/form/${f.formId}/responses`)}
              className="flex items-center gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
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
