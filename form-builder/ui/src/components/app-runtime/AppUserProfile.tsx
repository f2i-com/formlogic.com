import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, User, LogOut } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

export function AppUserProfile() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { config } = useAppRuntimeStore();

  return (
    <div className="max-w-md mx-auto">
      <button onClick={() => navigate(`/app/${appSlug}`)} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 mb-6 text-sm">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
        <div className="w-16 h-16 mx-auto rounded-full app-bg-primary-light flex items-center justify-center mb-4">
          <User className="h-8 w-8 app-text-primary" />
        </div>
        <h2 className="text-lg font-semibold">{user?.name || 'User'}</h2>
        <p className="text-sm text-gray-500">{user?.email}</p>

        {config && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400">App: {config.app.name}</p>
          </div>
        )}

        <button
          onClick={() => navigate('/')}
          className="mt-6 flex items-center gap-2 mx-auto px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          <LogOut className="h-4 w-4" /> Exit App
        </button>
      </div>
    </div>
  );
}
