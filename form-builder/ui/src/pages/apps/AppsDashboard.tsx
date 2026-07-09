import { useEffect, useState, useMemo, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink, Search, Package, Plug, Upload, FileText } from 'lucide-react';
import { DynamicIcon } from '../../components/ui/DynamicIcon';
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
import type { PackInstallation } from '../../lib/api';
import { cn, formatRelativeTime } from '../../lib/utils';
import { KIND_LABELS } from '../../types/app';
import type { App } from '../../types/app';

const APPS_PAGE = 9;

// Accent hex lands in an inline CSS custom property, so keep the format strict
// (mirrors the marketplace's DemoAppCard identity-tile pattern).
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

export function AppsDashboard() {
  const navigate = useNavigate();
  const { apps, isLoading, fetchApps, deleteApp } = useAppStore();
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [appLimit, setAppLimit] = useState(APPS_PAGE);
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [showHandToAi, setShowHandToAi] = useState(false);

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
      (appPackMap[app.id]?.toLowerCase().includes(q) ?? false)
    );
  }, [apps, searchQuery, appPackMap]);

  return (
    <div className="min-h-screen">
      <Header
        title="Apps"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowHandToAi(true)} leftIcon={<Plug className="h-4 w-4" />} title="Share a temporary MCP link so your own AI can build a new app">
              Connect an AI
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImport(true)} leftIcon={<Upload className="h-4 w-4" />} title="Import an app from a .json bundle exported from FormLogic">
              Import
            </Button>
            <Button size="sm" onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
              Create app
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
              {/* New-app CTA rides along in the grid (hidden while searching) — same wizard entry as the header button. */}
              {!searchQuery.trim() && <NewAppCard onClick={() => navigate('/apps/new')} />}
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
        title="Delete app"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This will permanently remove all forms, users, roles, and data associated with this app. This action cannot be undone.`}
        confirmLabel="Delete app"
        variant="danger"
        isLoading={deleting}
      />

      {showImport && <PackImportModal isOpen onClose={() => { setShowImport(false); fetchApps(); }} initialTab="upload" />}
      <ConnectAiModal isOpen={showHandToAi} onClose={() => { setShowHandToAi(false); fetchApps(); }} creator />
    </div>
  );
}

function AppCard({ app, packName, onClick, onDelete }: { app: App; packName: string | null; onClick: () => void; onDelete: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  // App identity tile: logo image → curated icon on the app's accent → monogram initial (muted, on the accent).
  const showLogo = Boolean(app.logoUrl) && !imgFailed;
  const icon = app.settings?.icon;
  const accent = app.theme?.primaryColor;
  const accented = !showLogo && isHexColor(accent);
  const monogram = (app.name?.trim().charAt(0) || '?').toUpperCase();
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
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      aria-label={`Manage ${app.name}`}
      className={cn(
        'flex h-full flex-col bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200/80 dark:border-white/[0.06] shadow-sm shadow-gray-900/[0.03] p-6',
        'hover:shadow-lg hover:shadow-gray-900/[0.06] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600',
        'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 outline-none',
        'transition-all duration-200 cursor-pointer group'
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            style={accented ? ({ '--fl-a': accent } as CSSProperties) : undefined}
            className={cn(
              'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden',
              showLogo
                ? 'bg-gray-50 dark:bg-slate-800/60'
                : accented
                  ? 'bg-[color-mix(in_srgb,var(--fl-a)_11%,transparent)] text-[color:var(--fl-a)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--fl-a)_25%,transparent)] dark:bg-[color-mix(in_srgb,var(--fl-a)_16%,transparent)] dark:text-[color:color-mix(in_srgb,var(--fl-a)_62%,white)]'
                  : 'bg-primary-100 dark:bg-primary-500/20 text-primary-600 dark:text-primary-400'
            )}
          >
            {showLogo ? (
              <img
                src={app.logoUrl}
                alt=""
                loading="lazy"
                onError={() => setImgFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : icon ? (
              <DynamicIcon name={icon} className="h-5 w-5" fallback={<span className="text-sm font-semibold" aria-hidden="true">{monogram}</span>} />
            ) : (
              <span className="text-sm font-semibold" aria-hidden="true">{monogram}</span>
            )}
          </div>
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
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {kindLabel && (
            <Badge variant="default" size="sm" className="whitespace-nowrap" title="App type">
              {kindLabel}
            </Badge>
          )}
          <Badge
            variant={app.status === 'published' ? 'success' : app.status === 'draft' ? 'warning' : 'default'}
            size="sm"
            className="capitalize"
          >
            {app.status}
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
