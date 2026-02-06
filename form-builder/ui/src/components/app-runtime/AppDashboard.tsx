import { useNavigate, useParams } from 'react-router-dom';
import { FileText, Send, Eye, LayoutGrid } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

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
        <h1 className="text-2xl font-bold mb-1 text-gray-900 dark:text-white">{config.app.name}</h1>
        {config.app.description && (
          <p className="text-gray-500 dark:text-slate-400">{config.app.description as string}</p>
        )}
      </div>

      {forms.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-14 h-14 mx-auto rounded-full bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-4">
            <LayoutGrid className="h-7 w-7 text-gray-400 dark:text-slate-500" />
          </div>
          <p className="text-gray-500 dark:text-slate-400">No forms available yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {forms.map((form) => (
            <div
              key={form.formId}
              className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-5 hover:shadow-md hover:border-gray-300 dark:hover:border-slate-600 transition-all"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="p-2.5 rounded-lg app-bg-primary-light flex-shrink-0">
                  <FileText className="h-5 w-5 app-text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 dark:text-white truncate">{form.displayName}</h3>
                </div>
              </div>

              <div className="flex gap-2">
                {canSubmit(form.formId) && (
                  <button
                    onClick={() => navigate(`/app/${appSlug}/form/${form.formId}`)}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium text-white app-btn-primary transition-colors"
                  >
                    <Send className="h-3.5 w-3.5" /> Submit
                  </button>
                )}
                {(canViewOwn(form.formId) || canViewAll(form.formId)) && (
                  <button
                    onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/responses`)}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <Eye className="h-3.5 w-3.5" /> View Data
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
