import { useEffect, useRef, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Send, Eye, LayoutGrid, BarChart3 } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { cn } from '../../lib/utils';

export function AppDashboard() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const { config, canSubmit, canViewOwn, canViewAll, canViewAnalytics } = useAppRuntimeStore();
  const redirectedRef = useRef(false);

  const forms = useMemo(() => config?.forms || [], [config]);

  // Honor the app's configured landing page: redirect once per session to the
  // chosen form. Guarded by a ref + sessionStorage so returning to the
  // dashboard manually doesn't bounce the user back out.
  const landingPage = config?.app?.settings?.landingPage as string | undefined;
  useEffect(() => {
    if (redirectedRef.current || !landingPage || !appSlug) return;
    const key = `applanding:${appSlug}`;
    if (sessionStorage.getItem(key)) return;
    const target = forms.find((f) => f.formId === landingPage);
    if (target) {
      redirectedRef.current = true;
      sessionStorage.setItem(key, '1');
      // Send the user where they can actually act: the fill route if they can
      // submit, otherwise the data view if they can read. If they can do neither,
      // stay on the dashboard rather than bounce them to a "no permission" wall.
      if (canSubmit(landingPage)) {
        navigate(`/app/${appSlug}/form/${landingPage}`, { replace: true });
      } else if (canViewOwn(landingPage) || canViewAll(landingPage)) {
        navigate(`/app/${appSlug}/form/${landingPage}/responses`, { replace: true });
      }
    }
  }, [landingPage, appSlug, forms, navigate, canSubmit, canViewOwn, canViewAll]);

  if (!config) return null;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Welcome header */}
      <div className="mb-8">
        <p className="text-sm font-medium app-text-primary mb-1">Welcome to</p>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white tracking-tight">{config.app.name}</h1>
        {config.app.description && (
          <p className="text-gray-500 dark:text-slate-400 mt-2 max-w-xl leading-relaxed">{config.app.description as string}</p>
        )}
      </div>

      {forms.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-slate-900/30 rounded-2xl border border-dashed border-gray-200 dark:border-slate-700">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-4">
            <LayoutGrid className="h-8 w-8 text-gray-400 dark:text-slate-500" />
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-1 tracking-tight">No forms yet</h3>
          <p className="text-gray-500 dark:text-slate-400 text-sm">Forms will appear here once they've been added to this app.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {forms.map((form) => {
            const showSubmit = canSubmit(form.formId);
            const showView = canViewOwn(form.formId) || canViewAll(form.formId);
            const showAnalytics = canViewAnalytics(form.formId);

            return (
              <div
                key={form.formId}
                className={cn(
                  'group bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5',
                  'hover:shadow-lg hover:shadow-gray-900/[0.04] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600',
                  'focus-within:ring-2 app-ring-primary transition-all duration-300'
                )}
              >
                <div className="flex items-start gap-3.5 mb-5">
                  <div className="p-2.5 rounded-xl app-bg-primary-light flex-shrink-0">
                    <DynamicIcon name={form.icon} className="h-5 w-5 app-text-primary" />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <h3 className="font-semibold text-gray-900 dark:text-white truncate tracking-tight">{form.displayName}</h3>
                    {form.description && (
                      <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5 line-clamp-2">{String(form.description).length > 80 ? String(form.description).substring(0, 80) + '\u2026' : String(form.description)}</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {showSubmit && (
                    <button
                      onClick={() => navigate(`/app/${appSlug}/form/${form.formId}`)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium app-btn-primary transition-all duration-200 hover:shadow-md cursor-pointer"
                    >
                      <Send className="h-3.5 w-3.5" /> Submit
                    </button>
                  )}
                  {showView && (
                    <button
                      onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/responses`)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200/80 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-all duration-200 cursor-pointer"
                    >
                      <Eye className="h-3.5 w-3.5" /> View Data
                    </button>
                  )}
                  {showAnalytics && (
                    <button
                      onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/analytics`)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200/80 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-all duration-200 cursor-pointer"
                    >
                      <BarChart3 className="h-3.5 w-3.5" /> Analytics
                    </button>
                  )}
                  {!showSubmit && !showView && !showAnalytics && (
                    <span className="text-sm text-gray-400 dark:text-slate-500 italic">No actions available</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
