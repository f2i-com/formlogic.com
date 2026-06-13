import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, User, ArrowLeftFromLine, Shield, Mail } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

export function AppUserProfile() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { config, roleName: storeRoleName } = useAppRuntimeStore();

  const roleName = storeRoleName || 'Member';

  return (
    <div className="max-w-md mx-auto">
      <button
        onClick={() => navigate(`/app/${appSlug}`)}
        className="flex items-center gap-2 text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 mb-6 text-sm transition-all duration-200 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 px-3 py-2 -ml-3 cursor-pointer"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 overflow-hidden shadow-sm">
        {/* Profile header with gradient accent */}
        <div className="h-20 app-bg-primary-light relative">
          <div className="absolute -bottom-10 left-1/2 -translate-x-1/2">
            <div className="w-20 h-20 rounded-2xl bg-white dark:bg-slate-800 border-4 border-white dark:border-slate-900 flex items-center justify-center shadow-sm">
              <User className="h-9 w-9 app-text-primary" />
            </div>
          </div>
        </div>

        <div className="pt-14 pb-6 px-6 text-center">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">{user?.name || 'User'}</h2>

          {user?.email && (
            <div className="flex items-center justify-center gap-1.5 mt-1.5 text-sm text-gray-500 dark:text-slate-400">
              <Mail className="h-3.5 w-3.5" />
              <span>{user.email}</span>
            </div>
          )}

          <div className="mt-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium app-bg-primary-light app-text-primary">
              <Shield className="h-3 w-3" />
              {roleName}
            </span>
          </div>
        </div>

        {config && (
          <div className="mx-6 py-4 border-t border-gray-100 dark:border-slate-700/50">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400 dark:text-slate-500">App</span>
              <span className="font-medium text-gray-700 dark:text-slate-300">{config.app.name}</span>
            </div>
          </div>
        )}

        <div className="px-6 pb-6">
          <button
            onClick={async () => { await useAuthStore.getState().logout(); navigate('/'); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-slate-300 border border-gray-200/80 dark:border-slate-600 rounded-xl hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-500 transition-all duration-200 cursor-pointer"
          >
            <ArrowLeftFromLine className="h-4 w-4" /> Sign Out
          </button>
          <p className="mt-2 text-center text-xs text-gray-400 dark:text-slate-500">Ends your session on this device. Use “Back” to return to the app.</p>
        </div>
      </div>
    </div>
  );
}
