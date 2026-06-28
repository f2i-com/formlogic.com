import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink, Search, Package } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FormCardSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
import type { PackInstallation } from '../../lib/api';
import { cn, parseServerDate } from '../../lib/utils';
import type { App } from '../../types/app';

const statusColors: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400',
  published: 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  archived: 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400',
};

export function AppsDashboard() {
  const navigate = useNavigate();
  const { apps, isLoading, fetchApps, deleteApp } = useAppStore();
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [packFilter, setPackFilter] = useState<string>('all');
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  // Fetch installed packs on mount
  useEffect(() => {
    api.getInstalledPacks().then((result) => {
      if (!result.error && result.data) {
        setInstalledPacks(result.data.installations);
      }
    });
  }, []);

  // Build appId → packName map
  const appPackMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const appId of pack.appIds ?? []) {
        map[appId] = pack.packName;
      }
    }
    return map;
  }, [installedPacks]);

  // Build appId → packId map for filtering
  const appPackIdMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const appId of pack.appIds ?? []) {
        map[appId] = pack.packId;
      }
    }
    return map;
  }, [installedPacks]);

  // Unique pack names for filter options
  const packOptions = useMemo(() => {
    const packs = installedPacks
      .filter((p) => (p.appIds ?? []).length > 0)
      .map((p) => ({ id: p.packId, name: p.packName }));
    const seen = new Set<string>();
    return packs.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [installedPacks]);

  // Filter apps by search + pack
  const filteredApps = useMemo(() =>
    apps.filter((app) => {
      if (searchQuery && !app.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (packFilter === 'all') return true;
      if (packFilter === 'none') return !appPackIdMap[app.id];
      return appPackIdMap[app.id] === packFilter;
    }),
    [apps, searchQuery, packFilter, appPackIdMap]
  );

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

        {/* Search and Filter */}
        {apps.length > 0 && (
          <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row gap-3 sm:items-center">
            <Input
              placeholder="Search apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="h-4 w-4" />}
              className="w-full sm:max-w-xs lg:max-w-md"
            />
            {packOptions.length > 0 && (
              <select
                value={packFilter}
                onChange={(e) => setPackFilter(e.target.value)}
                aria-label="Filter by pack"
                className="px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-all duration-200 cursor-pointer w-full sm:w-auto"
              >
                <option value="all">All Packs</option>
                <option value="none">No Pack</option>
                {packOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6" aria-busy="true" aria-label="Loading apps">
            {Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)}
          </div>
        ) : filteredApps.length === 0 && apps.length === 0 ? (
          <div className="text-center py-20 bg-white dark:bg-slate-900/30 rounded-2xl border border-dashed border-gray-200 dark:border-slate-700">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <Globe className="h-8 w-8 text-gray-400 dark:text-slate-500" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-1 tracking-tight">No apps yet</h3>
            <p className="text-gray-500 dark:text-slate-400 mb-6 text-sm max-w-sm mx-auto">Create your first app to group forms into a deployable application.</p>
            <Button onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
              Create Your First App
            </Button>
          </div>
        ) : filteredApps.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-slate-400">
            No apps match your filters.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {filteredApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                packName={appPackMap[app.id] ?? null}
                onClick={() => navigate(`/apps/${app.id}/settings`)}
                onDelete={() => setDeleteTarget(app)}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleting(true);
          try { await deleteApp(deleteTarget.id); setDeleteTarget(null); }
          finally { setDeleting(false); }
        }}
        title="Delete App"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This will permanently remove all forms, users, roles, and data associated with this app. This action cannot be undone.`}
        confirmLabel="Delete App"
        variant="danger"
        isLoading={deleting}
      />
    </div>
  );
}

function AppCard({ app, packName, onClick, onDelete }: { app: App; packName: string | null; onClick: () => void; onDelete: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={cn(
        'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6',
        'hover:shadow-lg hover:shadow-gray-900/[0.06] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600',
        'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 outline-none',
        'transition-all duration-200 cursor-pointer group'
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          {app.logoUrl ? (
            <img src={app.logoUrl} alt={app.name} className="w-10 h-10 rounded-xl object-cover flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          ) : (
            <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center flex-shrink-0">
              <Globe className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors truncate">
              {app.name}
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 dark:text-slate-500 font-mono truncate max-w-[140px]">/{app.slug}</span>
              {packName && (
                <Badge variant="info" size="sm">
                  <Package className="h-3 w-3 mr-1 inline" />
                  {packName}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium capitalize flex-shrink-0', statusColors[app.status])}>
          {app.status}
        </span>
      </div>

      {app.description && (
        <p className="text-sm text-gray-600 dark:text-slate-400 mb-4 line-clamp-2">{app.description}</p>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-100 dark:border-slate-700/40">
        <span className="text-xs text-gray-400 dark:text-slate-500">
          Updated {parseServerDate(app.updatedAt).toLocaleDateString()}
        </span>
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {app.status === 'published' && (
            <button
              onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer')}
              className="p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors cursor-pointer"
              aria-label="Open app"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-2.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
            aria-label="Delete app"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
