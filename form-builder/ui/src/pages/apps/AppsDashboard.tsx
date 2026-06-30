import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink, Search, Package, Wand2, Plug, Loader2, Upload } from 'lucide-react';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { GenerateAppModal } from '../../components/ai-app-builder/GenerateAppModal';
import { ConnectAiModal } from '../../components/mcp/ConnectAiModal';
import { PackImportModal } from '../../components/builder/PackImportModal';
import { ShowMore } from '../../components/ui/ShowMore';
import { useAiAvailable } from '../../hooks/useAiAvailable';
import { FormCardSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
import type { PackInstallation } from '../../lib/api';
import { cn, formatRelativeTime } from '../../lib/utils';
import type { App } from '../../types/app';

const APPS_PAGE = 9;

export function AppsDashboard() {
  const navigate = useNavigate();
  const { apps, isLoading, fetchApps, deleteApp, createApp } = useAppStore();
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [appLimit, setAppLimit] = useState(APPS_PAGE);
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [handing, setHanding] = useState(false);
  const [mcpAppId, setMcpAppId] = useState<string | null>(null);
  const aiAvailable = useAiAvailable();

  // Create a blank app and immediately offer an MCP connection link so an external AI can build it out.
  const handToAi = async () => {
    setHanding(true);
    const app = await createApp({ name: 'Untitled app' });
    setHanding(false);
    if (app) setMcpAppId(app.id);
  };

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

  // Filter apps by search — matches the app name OR its pack's name.
  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((app) =>
      app.name.toLowerCase().includes(q) ||
      (appPackMap[app.id]?.toLowerCase().includes(q) ?? false)
    );
  }, [apps, searchQuery, appPackMap]);

  return (
    <div className="min-h-screen">
      <Header
        title="Apps"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handToAi} disabled={handing} leftIcon={handing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} title="Create a blank app and hand it to your own AI to build via MCP">
              Hand to an AI
            </Button>
            {aiAvailable && (
              <Button variant="outline" size="sm" onClick={() => setShowGenerate(true)} leftIcon={<Wand2 className="h-4 w-4" />}>
                Generate with AI
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowImport(true)} leftIcon={<Upload className="h-4 w-4" />} title="Import an app from a .json bundle exported from FormLogic">
              Import
            </Button>
            <Button size="sm" onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
              Create App
            </Button>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        <div className="mb-6">
          <p className="text-gray-500 dark:text-slate-400">Build and manage deployable applications</p>
        </div>

        {/* Search */}
        {apps.length > 0 && (
          <div className="mb-4 sm:mb-6">
            <Input
              placeholder={Object.keys(appPackMap).length > 0 ? 'Search apps or packs…' : 'Search apps…'}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setAppLimit(APPS_PAGE); }}
              leftIcon={<Search className="h-4 w-4" />}
              className="w-full sm:max-w-xs lg:max-w-md"
            />
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6" aria-busy="true" aria-label="Loading apps">
            {Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)}
          </div>
        ) : filteredApps.length === 0 && apps.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No apps yet"
            description="Create your first app to group forms into a deployable application."
            action={
              <Button onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
                Create Your First App
              </Button>
            }
          />
        ) : filteredApps.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No apps match your search"
            description="Try a different search term to see your apps."
            action={
              <Button variant="outline" onClick={() => setSearchQuery('')}>
                Clear search
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {filteredApps.slice(0, appLimit).map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  packName={appPackMap[app.id] ?? null}
                  onClick={() => navigate(`/apps/${app.id}/settings`)}
                  onDelete={() => setDeleteTarget(app)}
                />
              ))}
            </div>
            <ShowMore shown={Math.min(appLimit, filteredApps.length)} total={filteredApps.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" />
          </>
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

      <GenerateAppModal isOpen={showGenerate} onClose={() => { setShowGenerate(false); fetchApps(); }} />
      {showImport && <PackImportModal isOpen onClose={() => { setShowImport(false); fetchApps(); }} initialTab="upload" />}
      <ConnectAiModal isOpen={mcpAppId !== null} onClose={() => { setMcpAppId(null); fetchApps(); }} appId={mcpAppId ?? undefined} appName="your new app" />
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
        'bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200/80 dark:border-white/[0.06] shadow-sm shadow-gray-900/[0.03] p-6',
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
        <Badge
          variant={app.status === 'published' ? 'success' : app.status === 'draft' ? 'warning' : 'default'}
          size="sm"
          className="capitalize flex-shrink-0"
        >
          {app.status}
        </Badge>
      </div>

      {app.description && (
        <p className="text-sm text-gray-600 dark:text-slate-400 mb-4 line-clamp-2">{app.description}</p>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-100 dark:border-slate-700/40">
        <span className="text-xs text-gray-400 dark:text-slate-500">
          Updated {formatRelativeTime(app.updatedAt)}
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
