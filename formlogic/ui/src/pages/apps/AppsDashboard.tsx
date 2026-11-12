import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink, Search, Package, Plug, Upload, FileText, LayoutGrid, List, Settings , RotateCcw } from 'lucide-react';
import { AppTile } from '../../components/apps/AppTile';
import { AppsTable } from '../../components/apps/AppsTable';
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
import type { App, AppSummary } from '../../types/app';
import { isSoftnApp, softnWorkspacePath } from '../../lib/softnApps';

/** The card view shows this many, then more on request. The table shows every app. */
const APPS_PAGE = 9;
type KindFilter = 'all' | 'softn' | 'forms';
type StatusFilter = 'any' | 'live' | 'draft';
const KINDS: readonly (readonly [KindFilter, string])[] = [['all', 'All kinds'], ['softn', 'SoftN'], ['forms', 'Forms']];
const STATUSES: readonly (readonly [StatusFilter, string])[] = [['any', 'Any status'], ['live', 'Live'], ['draft', 'Draft']];

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
  // The table (every app on one screen) or the cards — remembered across visits. The table is the
  // default, and what an earlier visit saved as the "list" opens as the table.
  const [viewMode, setViewMode] = useState<'grid' | 'table'>(() => {
    try { return localStorage.getItem('appsDashboard.viewMode') === 'grid' ? 'grid' : 'table'; } catch { return 'table'; }
  });
  const changeViewMode = (mode: 'grid' | 'table') => {
    setViewMode(mode);
    try { localStorage.setItem('appsDashboard.viewMode', mode); } catch { /* ignore */ }
  };
  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('any');
  // What the table shows beside each app. A server from before the summary answers 404: the
  // table then shows what the apps themselves say.
  const [summaries, setSummaries] = useState<Record<string, AppSummary>>({});
  useEffect(() => {
    const stop = new AbortController();
    void api.getAppsSummary(stop.signal).then((result) => {
      if (!stop.signal.aborted && !result.error && result.data?.apps) setSummaries(result.data.apps);
    });
    return () => stop.abort();
  }, [apps.length]);

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
    return apps.filter((app) =>
      (kind === 'all' || (kind === 'softn') === isSoftnApp(app)) &&
      (status === 'any' || (status === 'live') === (app.status === 'published')) &&
      (!q ||
        app.name.toLowerCase().includes(q) ||
        // The slug is printed on every card and used in the /app/<slug> URL, so it is
        // the obvious thing to paste in. The sidebar's search already matched it.
        app.slug.toLowerCase().includes(q) ||
        // Its own domain is its address too.
        (summaries[app.id]?.domain?.toLowerCase().includes(q) ?? false) ||
        (appPackMap[app.id]?.toLowerCase().includes(q) ?? false))
    );
  }, [apps, searchQuery, appPackMap, kind, status, summaries]);
  const filtering = !!searchQuery.trim() || kind !== 'all' || status !== 'any';
  const clearFilters = () => { setSearchQuery(''); setKind('all'); setStatus('any'); };

  return (
    <div className="min-h-screen">
      <Header
        title="Apps"
        actions={
          <div className="flex items-center gap-2">
            {/* Labels collapse on phones — three full-width buttons pushed the theme
                toggle and user menu past a clipped edge, making them unreachable, and
                even "New" left the page's own title cut to "A…". */}
            <Button variant="outline" size="sm" onClick={() => setShowHandToAi(true)} leftIcon={<Plug className="h-4 w-4" />} aria-label="Connect an AI" title="Share a temporary MCP link so your own AI can build a new app">
              <span className="hidden sm:inline">Connect an AI</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowImport(true)} leftIcon={<Upload className="h-4 w-4" />} aria-label="Import an app" title="Import an app: a SoftN app (.softn), or a FormLogic export (.json, .zip, .formlogic)">
              <span className="hidden sm:inline">Import</span>
            </Button>
            <Button size="sm" onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />} aria-label="Create app">
              <span className="hidden sm:inline">Create app</span>
            </Button>
          </div>
        }
      />

      {/* The page frame every workspace page has (components/layout/PageBody): the header's gutter. */}
      <div className="@container/apps w-full flex-1 px-4 pb-24 pt-4 sm:px-6">
        {/* Search, the two filters and the view toggle, on one line where there is room. */}
        {apps.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search name or address…"
              aria-label="Search apps by name, address or template"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setAppLimit(APPS_PAGE); }}
              leftIcon={<Search className="h-4 w-4" />}
              className="w-full sm:w-64"
            />
            <Segmented label="Kind" options={KINDS} value={kind} onChange={(next) => { setKind(next); setAppLimit(APPS_PAGE); }} />
            <Segmented label="Status" options={STATUSES} value={status} onChange={(next) => { setStatus(next); setAppLimit(APPS_PAGE); }} />
            <div className="ml-auto flex flex-none overflow-hidden rounded-lg border border-gray-300 dark:border-slate-700" role="group" aria-label="View mode">
              <button
                type="button"
                onClick={() => changeViewMode('table')}
                aria-pressed={viewMode === 'table'}
                title="Table"
                className={`px-3 py-2 max-sm:min-h-11 transition-colors cursor-pointer ${viewMode === 'table' ? 'bg-primary-50 dark:bg-primary-500/15 text-primary-600 dark:text-primary-400' : 'bg-white dark:bg-slate-900/60 text-gray-400 hover:text-gray-700 dark:hover:text-slate-300'}`}
              >
                <List className="h-4 w-4" /><span className="sr-only">Table</span>
              </button>
              <button
                type="button"
                onClick={() => changeViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                title="Cards"
                className={`px-3 py-2 max-sm:min-h-11 border-l border-gray-300 dark:border-slate-700 transition-colors cursor-pointer ${viewMode === 'grid' ? 'bg-primary-50 dark:bg-primary-500/15 text-primary-600 dark:text-primary-400' : 'bg-white dark:bg-slate-900/60 text-gray-400 hover:text-gray-700 dark:hover:text-slate-300'}`}
              >
                <LayoutGrid className="h-4 w-4" /><span className="sr-only">Cards</span>
              </button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 @2xl/apps:grid-cols-2 @2xl/apps:gap-6 @5xl/apps:grid-cols-3" role="status" aria-busy="true" aria-label="Loading apps">
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
            description="Create your first app, bring one you already have (a .softn file), or install a ready-made one from the marketplace."
            action={
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <Button onClick={() => navigate('/apps/new')} leftIcon={<Plus className="h-4 w-4" />}>
                  Create an app
                </Button>
                <Button variant="outline" onClick={() => setShowImport(true)} leftIcon={<Upload className="h-4 w-4" />}>
                  Import an app
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
            title="No apps match"
            description="Nothing fits the search and filters above."
            action={
              <Button variant="outline" onClick={clearFilters}>
                Show every app
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
                    onClick={() => navigate(canManageApp(app) ? manageApp(app) : `/app/${app.slug}`)}
                    // A SoftN app's settings are a section of its own page; the forms-era page knows nothing of it.
                    onManage={() => navigate(isSoftnApp(app) ? softnWorkspacePath(app.id, 'settings') : `/apps/${app.id}/settings`)}
                    onDelete={() => setDeleteTarget(app)}
                  />
                ))}
                {/* New-app CTA rides along in the grid (hidden while filtering) — same wizard entry as the header button. */}
                {!filtering && <NewAppCard onClick={() => navigate('/apps/new')} />}
              </div>
            ) : (
              <AppsTable apps={filteredApps} summaries={summaries} packNames={appPackMap} canManage={canManageApp} managePath={manageApp} onDelete={setDeleteTarget} />
            )}
            {viewMode === 'grid' && <ShowMore shown={Math.min(appLimit, filteredApps.length)} total={filteredApps.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" />}
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
          // A SoftN app's source and database stay on disk while it is in the bin (AppStorageEraser),
          // and it has no forms of its own to speak of.
          : deleteTarget && isSoftnApp(deleteTarget)
            ? `Delete "${deleteTarget.name}"? The app moves to the recycle bin with its database and members, restorable for 30 days. After that it is erased for good.`
            : `Delete "${deleteTarget?.name}"? The app (with its flows, roles and members) moves to the recycle bin, restorable for 30 days. Its forms and their records stay in your workspace.`}
        confirmLabel="Delete app"
        variant="danger"
        isLoading={deleting}
      />

      {showImport && <PackImportModal isOpen onClose={() => { setShowImport(false); fetchApps(); }} initialTab="upload" forApps />}
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

/** Where the owner manages an app: a SoftN app's page, or the App Studio. */
const manageApp = (app: App) => (isSoftnApp(app) ? softnWorkspacePath(app.id) : `/apps/${app.id}/studio`);

/** A filter with a few choices, one of them on: a row of buttons that reads as one control. */
function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (next: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-none overflow-hidden rounded-lg border border-gray-300 dark:border-slate-700">
      {options.map(([option, text], index) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'px-3 py-2 text-xs font-medium transition-colors cursor-pointer max-sm:min-h-11',
            index > 0 && 'border-l border-gray-300 dark:border-slate-700',
            value === option ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300' : 'bg-white text-gray-600 hover:text-gray-900 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:text-white',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function AppCard({ app, packName, canManage, onClick, onManage, onDelete }: { app: App; packName: string | null; canManage: boolean; onClick: () => void; onManage: () => void; onDelete: () => void }) {
  // Real count from the list endpoint; navConfig is only a stale-cache fallback (it can be empty
  // on pack-provisioned apps — the "0 forms" bug).
  const formCount = app.formCount ?? app.navConfig?.length ?? 0;
  // Optional portal type (T29): unknown/absent values render nothing (server data is untrusted).
  const kindLabel = isSoftnApp(app) ? 'SoftN app' : app.settings?.appKind ? KIND_LABELS[app.settings.appKind] : undefined;
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
        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400 min-w-0">
          {/* A SoftN app is its own project, not a group of forms: a count of them says nothing. */}
          {!isSoftnApp(app) && <>
            <FileText className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="flex-shrink-0 tabular-nums">{formCount} form{formCount === 1 ? '' : 's'}</span>
            <span aria-hidden="true">·</span>
          </>}
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
      <span className="text-xs text-gray-500 dark:text-slate-400">Build one, or bring a .softn file</span>
    </button>
  );
}
