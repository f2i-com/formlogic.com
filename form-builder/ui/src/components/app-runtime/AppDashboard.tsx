import { useNavigate, useParams } from 'react-router-dom';
import { FileText, Send, Eye, LayoutGrid } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { cn } from '../../lib/utils';

export function AppDashboard() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const { config, canSubmit, canViewOwn, canViewAll } = useAppRuntimeStore();

  if (!config) return null;

  const forms = config.forms || [];

  return (
    <div className="max-w-4xl mx-auto">
      {/* Welcome header */}
      <div className="mb-8">
        <p className="text-sm font-medium app-text-primary mb-1">Welcome to</p>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white">{config.app.name}</h1>
        {config.app.description && (
          <p className="text-gray-500 dark:text-slate-400 mt-2 max-w-xl">{config.app.description as string}</p>
        )}
      </div>

      {forms.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-slate-900/30 rounded-2xl border border-dashed border-gray-200 dark:border-slate-700">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-4">
            <LayoutGrid className="h-8 w-8 text-gray-400 dark:text-slate-500" />
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-1">No forms yet</h3>
          <p className="text-gray-500 dark:text-slate-400 text-sm">Forms will appear here once they've been added to this app.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {forms.map((form) => {
            const showSubmit = canSubmit(form.formId);
            const showView = canViewOwn(form.formId) || canViewAll(form.formId);

            return (
              <div
                key={form.formId}
                className={cn(
                  'group bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700/80 p-5',
                  'hover:shadow-lg hover:shadow-gray-200/50 dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600',
                  'focus-within:ring-2 focus-within:ring-primary-500/30 transition-all duration-200'
                )}
              >
                <div className="flex items-start gap-3.5 mb-5">
                  <div className="p-2.5 rounded-xl app-bg-primary-light flex-shrink-0">
                    <FileText className="h-5 w-5 app-text-primary" />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <h3 className="font-semibold text-gray-900 dark:text-white truncate">{form.displayName}</h3>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {showSubmit && (
                    <button
                      onClick={() => navigate(`/app/${appSlug}/form/${form.formId}`)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white app-btn-primary transition-all hover:shadow-md"
                    >
                      <Send className="h-3.5 w-3.5" /> Submit
                    </button>
                  )}
                  {showView && (
                    <button
                      onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/responses`)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <Eye className="h-3.5 w-3.5" /> View Data
                    </button>
                  )}
                  {!showSubmit && !showView && (
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
