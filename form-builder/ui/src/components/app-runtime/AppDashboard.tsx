import { useNavigate, useParams } from 'react-router-dom';
import { FileText, Send, Eye } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

export function AppDashboard() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const { config, canSubmit, canViewOwn, canViewAll } = useAppRuntimeStore();

  if (!config) return null;

  const forms = config.forms || [];

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Welcome to {config.app.name}</h1>

      {forms.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No forms available yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {forms.map((form) => (
            <div
              key={form.formId}
              className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-gray-300 transition-all"
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="p-2 rounded-lg app-bg-primary-light">
                  <FileText className="h-5 w-5 app-text-primary" />
                </div>
                <h3 className="font-semibold text-gray-900 flex-1">{form.displayName}</h3>
              </div>

              <div className="flex gap-2 mt-4">
                {canSubmit(form.formId) && (
                  <button
                    onClick={() => navigate(`/app/${appSlug}/form/${form.formId}`)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white app-btn-primary"
                  >
                    <Send className="h-3.5 w-3.5" /> Submit
                  </button>
                )}
                {(canViewOwn(form.formId) || canViewAll(form.formId)) && (
                  <button
                    onClick={() => navigate(`/app/${appSlug}/form/${form.formId}/responses`)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
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
