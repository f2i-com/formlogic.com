import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/utils';
import type { App } from '../../types/app';

const statusColors: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400',
  published: 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  archived: 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400',
};

export function AppsDashboard() {
  const navigate = useNavigate();
  const { apps, isLoading, fetchApps, deleteApp } = useAppStore();

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  return (
    <div className="min-h-screen">
      <Header
        title="Apps"
        actions={
          <Button size="sm" onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
            Create App
          </Button>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        <div className="mb-6">
          <p className="text-gray-500 dark:text-slate-400">Build and manage deployable applications</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
          </div>
        ) : apps.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700">
            <Globe className="h-12 w-12 mx-auto text-gray-400 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">No apps yet</h3>
            <p className="text-gray-500 dark:text-slate-400 mb-6">Create your first app to group forms into a deployable application.</p>
            <Button onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
              Create Your First App
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {apps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                onClick={() => navigate(`/apps/${app.id}/settings`)}
                onDelete={() => {
                  if (confirm('Are you sure you want to delete this app?')) {
                    deleteApp(app.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AppCard({ app, onClick, onDelete }: { app: App; onClick: () => void; onDelete: () => void }) {
  return (
    <div
      onClick={onClick}
      className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-6 hover:shadow-lg hover:border-primary-300 dark:hover:border-primary-500/30 transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          {app.logoUrl ? (
            <img src={app.logoUrl} alt={app.name} className="w-10 h-10 rounded-lg object-cover" />
          ) : (
            <div className="w-10 h-10 rounded-lg bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center">
              <Globe className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            </div>
          )}
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors">
              {app.name}
            </h3>
            <span className="text-xs text-gray-500 dark:text-slate-500">/{app.slug}</span>
          </div>
        </div>
        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', statusColors[app.status])}>
          {app.status}
        </span>
      </div>

      {app.description && (
        <p className="text-sm text-gray-600 dark:text-slate-400 mb-4 line-clamp-2">{app.description}</p>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-100 dark:border-slate-700/50">
        <span className="text-xs text-gray-400 dark:text-slate-500">
          Updated {new Date(app.updatedAt).toLocaleDateString()}
        </span>
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {app.status === 'published' && (
            <button
              onClick={() => window.open(`/app/${app.slug}`, '_blank')}
              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
              title="Open app"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            title="Delete app"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
