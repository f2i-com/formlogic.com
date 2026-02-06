import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, User, LogOut } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

export function AppUserProfile() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { config, reset } = useAppRuntimeStore();

  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={() => navigate(`/app/${appSlug}`)}
        className="flex items-center gap-2 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 mb-6 text-sm transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-8 text-center">
        <div className="w-16 h-16 mx-auto rounded-full app-bg-primary-light flex items-center justify-center mb-4">
          <User className="h-8 w-8 app-text-primary" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{user?.name || 'User'}</h2>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">{user?.email}</p>

        {config && (
          <div className="mt-5 pt-5 border-t border-gray-100 dark:border-slate-700">
            <p className="text-xs text-gray-400 dark:text-slate-500">App: {config.app.name}</p>
          </div>
        )}

        <button
          onClick={() => { reset(); navigate('/'); }}
          className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-slate-300 border border-gray-200 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
        >
          <LogOut className="h-4 w-4" /> Exit App
        </button>
      </div>
    </div>
  );
}
