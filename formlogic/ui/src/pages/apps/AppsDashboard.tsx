import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink, Search, Package, Plug, Upload, FileText, LayoutGrid, List, Settings , RotateCcw } from 'lucide-react';
import { AppTile } from '../../components/apps/AppTile';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ConnectAiModal } from '../../components/mcp/ConnectAiModal';
import { PackImportModal } from '../../components/builder/PackImportModal';
import { ShowMore } from '../../components/ui/ShowMore';
import { FormCardSkeleton } from '../../components/ui/Skeleton';
import { api } from '../../lib/api';
import { isDemoLocalId } from '../../lib/demoLocal';
import type { PackInstallation } from '../../lib/api';
import { cn, formatRelativeTime } from '../../lib/utils';
import { KIND_LABELS } from '../../types/app';
import { statusLabel, statusTone } from '../../lib/appStatus';
import type { App } from '../../types/app';

const APPS_PAGE = 9;

// Accent hex lands in an inline CSS custom property, so keep the format strict
// (mirrors the marketplace's DemoAppCard identity-tile pattern).

export function AppsDashboard() {
  const navigate = useNavigate();
  const { apps, isLoading, fetchApps, deleteApp } = useAppStore();
  const loadError = useAppStore((s) => s.error);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [appLimit, setAppLimit] = useState(APPS_PAGE);
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showHandToAi, setShowHandToAi] = useState(false);
  // Card grid vs compact list — remembered across visits.
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try { return localStorage.getItem('appsDashboard.viewMode') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const changeViewMode = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    try { localStorage.setItem('appsDashboard.viewMode', mode); } catch { /* ignore */ }
  };

  // Open a "creator" MCP connection so an external AI can build a brand-new app itself — no placeholder.

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
      // The slug is printed on every card and used in the /app/<slug> URL, so it is
      // the obvious thing to paste in. The sidebar's search already matched it.
      app.slug.toLowerCase().includes(q) ||
      (appPackMap[app.id]?.toLowerCase().includes(q) ?? false)
    );
  }, [apps, searchQuery, appPackMap]);

  return (
    <div className="min-h-screen">
      <Header
        title="Apps"
        actions={
          <div className="flex items-center gap-2">
            {/* Labels collapse on phones — three full-width buttons pushed the theme
                toggle and user menu past a clipped edge, making them unreachable. */}
            <Button variant="outline" size="sm" onClick={() => setShowHandToAi(true)} leftIcon={<Plug className="h-4 w-4" />} aria-label="Connect an AI" title="Share a temporary MCP link so your own AI can build a new app">
              <span className="hidden sm:inline">Connect an AI</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImport(true)} leftIcon={<Upload className="h-4 w-4" />} aria-label="Import an app" title="Import an app from a .json bundle exported from FormLogic">
              <span className="hidden sm:inline">Import</span>
            </Button>
            <Button size="sm" onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />} aria-label="Create app">
              <span className="hidden sm:inline">Create app</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        }
      />

      <div className="@container/apps w-full flex-1 p-4 @2xl/apps:p-6 @5xl/apps:p-8">
        <div className="mb-6">
          <p className="text-gray-500 dark:text-slate-400">Build and manage deployable applications</p>
        </div>

        {/* Search + view toggle */}
        {apps.length > 0 && (
          <div className="mb-4 sm:mb-6 flex items-center gap-3">
            <Input
              placeholder="Search…"
              aria-label="Search apps by name, address or template"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setAppLimit(APPS_PAGE); }}
              leftIcon={<Search className="h-4 w-4" />}
              className="w-full sm:max-w-xs lg:max-w-md"
            />
            <div className="flex flex-none rounded-lg border border-gray-300 dark:border-slate-700 overflow-hidden ml-auto" role="group" aria-label="View mode">
              <button
                type="button"
                onClick={() => changeViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                title="Card view"
                className={`px-3 py-2.5 transition-colors cursor-pointer ${viewMode === 'grid' ? 'bg-primary-50 dark:bg-primary-500/15 text-primary-600 dark:text-primary-400' : 'bg-white dark:bg-slate-900/60 text-gray-400 hover:text-gray-700 dark:hover:text-slate-300'}`}
              >
                <LayoutGrid className="h-4 w-4" /><span className="sr-only">Card view</span>
              </button>
              <button
                type="button"
                onClick={() => changeViewMode('list')}
                aria-pressed={viewMode === 'list'}
                title="List view"
                className={`px-3 py-2.5 border-l border-gray-300 dark:border-slate-700 transition-colors cursor-pointer ${viewMode === 'list' ? 'bg-primary-50 dark:bg-primary-500/15 text-primary-600 dark:text-primary-400' : 'bg-white dark:bg-slate-900/60 text-gray-400 hover:text-gray-700 dark:hover:text-slate-300'}`}
              >
                <List className="h-4 w-4" /><span className="sr-only">List view</span>
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 @2xl/apps:grid-cols-2 @2xl/apps:gap-6 @5xl/apps:grid-cols-3" aria-busy="true" aria-label="Loading apps">
            {Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)}
          </div>
        ) : loadError && apps.length === 0 ? (
          /* A failed fetch is not "you have no apps" — that reading has users create a
             duplicate of an app they already own. */
          <EmptyState
            icon={Globe}
            title="Couldn't load your apps"
            description={loadError}
            action={<Button onClick={() => void fetchApps()} leftIcon={<RotateCcw className="h-4 w-4" />}>Try again</Button>}
          />
        ) : filteredApps.length === 0 && apps.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No apps yet"
            description="Create your first app to group forms into a deployable application — or install a ready-made one from the marketplace."
            action={
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <Button onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
                  Create an app
                </Button>
                <Button variant="outline" onClick={() => navigate('/packs')} leftIcon={<Package className="h-4 w-4" />}>
                  Browse the marketplace
                </Button>
              </div>
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
            {viewMode === 'grid' ? (
              <div className="grid grid-cols-1 gap-4 @2xl/apps:grid-cols-2 @2xl/apps:gap-6 @5xl/apps:grid-cols-3">
                {filteredApps.slice(0, appLimit).map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    packName={appPackMap[app.id] ?? null}
                    canManage={canManageApp(app)}
                    // A member goes straight to the runtime; the studio would only
                    // bounce them there anyway.
                    onClick={() => navigate(canManageApp(app) ? `/apps/${app.id}/studio` : `/app/${app.slug}`)}
                    onManage={() => navigate(`/apps/${app.id}/settings`)}
                    onDelete={() => setDeleteTarget(app)}
                  />
                ))}
                {/* New-app CTA rides along in the grid (hidden while searching) — same wizard entry as the header button. */}
                {!searchQuery.trim() && <NewAppCard onClick={() => navigate('/apps/new')} />}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 divide-y divide-gray-100 dark:divide-slate-800">
                {filteredApps.slice(0, appLimit).map((app) => (
                  <AppRow
                    key={app.id}
                    app={app}
                    packName={appPackMap[app.id] ?? null}
                    canManage={canManageApp(app)}
                    onManage={() => navigate(canManageApp(app) ? `/apps/${app.id}/studio` : `/app/${app.slug}`)}
                    onSettings={() => navigate(`/apps/${app.id}/settings`)}
                    onDelete={() => setDeleteTarget(app)}
                  />
                ))}
              </div>
            )}
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
        title="Delete app"
        message={deleteTarget && isDemoLocalId(deleteTarget.id)
          ? `Delete "${deleteTarget.name}"? This browser-only app is removed from this device immediately and cannot be restored.`
          : `Delete "${deleteTarget?.name}"? The app (with its flows, roles and members) moves to the recycle bin, restorable for 30 days. Its forms and their records stay in your workspace.`}
        confirmLabel="Delete app"
        variant="danger"
        isLoading={deleting}
      />

      {showImport && <PackImportModal isOpen onClose={() => { setShowImport(false); fetchApps(); }} initialTab="upload" />}
      <ConnectAiModal isOpen={showHandToAi} onClose={() => { setShowHandToAi(false); fetchApps(); }} creator />
    </div>
  );
}

/**
 * Whether this user can edit the app, not merely open it. The apps list carries
 * `canManage`; a persisted slice from before that flag existed falls back to ownerId.
 * Members were shown Delete and Settings on apps they only belong to — the delete
 * confirmed, then failed with "App not found or access denied".
 */
function canManageApp(app: App): boolean {
  return app.canManage ?? !!app.ownerId;
}

// Compact list-mode row: click opens the App Studio; explicit View app / Settings / Remove actions.
function AppRow({ app, packName, canManage, onManage, onSettings, onDelete }: { app: App; packName: string | null; canManage: boolean; onManage: () => void; onSettings: () => void; onDelete: () => void }) {
  const formCount = app.formCount ?? app.navConfig?.length ?? 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onManage}
      // Only the row itself opens the app. Without the target check, Enter on the
      // nested Settings / Remove buttons was preventDefaulted here, so those controls
      // were unreachable without a mouse.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onManage(); }
      }}
      title="Edit app"
      className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
    >
      <AppTile app={app} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{app.name}</span>
          {packName && (
            <Badge variant="info" size="sm" className="hidden md:inline-flex max-w-full whitespace-nowrap flex-none">
              <Package className="h-3 w-3 mr-1 inline shrink-0" /><span className="truncate">{packName}</span>
            </Badge>
          )}
          {isDemoLocalId(app.id) && <Badge variant="primary" size="sm">Browser only</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400 min-w-0">
          <span className="font-mono truncate max-w-[45%]">/{app.slug}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums flex-none">{formCount} form{formCount === 1 ? '' : 's'}</span>
        </div>
      </div>
      <Badge
        variant={statusTone(app)}
        size="sm"
        className="flex-none whitespace-nowrap"
      >
        {statusLabel(app)}
      </Badge>
      <div className="flex items-center gap-0.5 flex-none" onClick={(e) => e.stopPropagation()}>
        {app.status === 'published' && (
          <button
            type="button"
            onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer')}
            title="Open app"
            aria-label={`Open ${app.name}`}
            className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        )}
        {/* Settings and Remove are owner-only on the server; offering them to a member
            produced a confirmed delete that then failed with "access denied". */}
        {canManage && (
          <>
            <button
              type="button"
              onClick={onSettings}
              title="App settings"
              aria-label={`Manage ${app.name}`}
              className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-primary-50 hover:text-primary-600 dark:text-slate-400 dark:hover:bg-primary-500/10 dark:hover:text-primary-400"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="Remove app"
              aria-label={`Remove ${app.name}`}
              className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AppCard({ app, packName, canManage, onClick, onManage, onDelete }: { app: App; packName: string | null; canManage: boolean; onClick: () => void; onManage: () => void; onDelete: () => void }) {
  // Real count from the list endpoint; navConfig is only a stale-cache fallback (it can be empty
  // on pack-provisioned apps — the "0 forms" bug).
  const formCount = app.formCount ?? app.navConfig?.length ?? 0;
  // Optional portal type (T29): unknown/absent values render nothing (server data is untrusted).
  const kindLabel = app.settings?.appKind ? KIND_LABELS[app.settings.appKind] : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      aria-label={`Edit ${app.name}`}
      className={cn(
        'flex h-full flex-col bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200/80 dark:border-white/[0.06] shadow-sm shadow-gray-900/[0.03] p-6',
        'hover:shadow-lg hover:shadow-gray-900/[0.06] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600',
        'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 outline-none',
        'transition-all duration-200 cursor-pointer group'
      )}
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
          <AppTile app={app} />
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors truncate">
              {app.name}
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 dark:text-slate-500 font-mono truncate max-w-[140px]">/{app.slug}</span>
              {packName && (
                <Badge variant="info" size="sm" className="max-w-full whitespace-nowrap">
                  <Package className="h-3 w-3 mr-1 inline shrink-0" />
                  <span className="truncate" title={packName}>{packName}</span>
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="ml-[52px] flex flex-shrink-0 items-center gap-1.5 sm:ml-0">
          {isDemoLocalId(app.id) && (
            <Badge variant="primary" size="sm" className="whitespace-nowrap">
              Browser only
            </Badge>
          )}
          {kindLabel && (
            <Badge variant="default" size="sm" className="whitespace-nowrap" title="App type">
              {kindLabel}
            </Badge>
          )}
          <Badge
            variant={statusTone(app)}
            size="sm"
            className="whitespace-nowrap"
          >
            {statusLabel(app)}
          </Badge>
        </div>
      </div>

      {app.description && (
        <p className="text-sm text-gray-600 dark:text-slate-400 mb-4 line-clamp-2">{app.description}</p>
      )}

      {/* mt-auto pins the meta/actions row to the bottom so cards in a row stay footer-aligned. */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-4 border-t border-gray-100 dark:border-slate-700/40">
        <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-slate-500 min-w-0">
          <FileText className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="flex-shrink-0 tabular-nums">{formCount} form{formCount === 1 ? '' : 's'}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">Updated {formatRelativeTime(app.updatedAt)}</span>
        </div>
        <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {app.status === 'published' && (
            <button
              onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer')}
              className="p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors cursor-pointer"
              aria-label="Open app"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          {canManage && (
            <>
              <button
                type="button"
                onClick={onManage}
                title="App settings"
                aria-label={`Manage ${app.name}`}
                className="cursor-pointer rounded-lg p-2.5 text-gray-500 transition-colors hover:bg-primary-50 hover:text-primary-600 dark:text-slate-400 dark:hover:bg-primary-500/10 dark:hover:text-primary-400"
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="cursor-pointer rounded-lg p-2.5 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                aria-label={`Delete ${app.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Dashed "create" tile at the end of the grid — the same wizard entry as the header's Create app button. */
function NewAppCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex h-full min-h-[11rem] flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed p-6',
        'border-gray-200 dark:border-slate-700/70 text-gray-500 dark:text-slate-400',
        'hover:border-primary-400 dark:hover:border-primary-500/50 hover:text-primary-600 dark:hover:text-primary-400',
        'hover:bg-primary-50/50 dark:hover:bg-primary-500/[0.06] motion-safe:transition-colors cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950'
      )}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-500 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 group-hover:text-primary-600 dark:group-hover:text-primary-400 motion-safe:transition-colors">
        <Plus className="h-5 w-5" />
      </span>
      <span className="text-sm font-medium">Create app</span>
      <span className="text-xs text-gray-400 dark:text-slate-500">Group forms into a deployable app</span>
    </button>
  );
}
