import { useEffect, useState, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Globe, Trash2, ExternalLink, Search, Package, Plug, Upload, LayoutGrid, List, Settings, RotateCcw, MoreHorizontal, SlidersHorizontal, Database } from 'lucide-react';
import { AppTile } from '../../components/apps/AppTile';
import { AppsTable } from '../../components/apps/AppsTable';
import { appTools, holds, who } from '../../lib/appFacts';
import { EmptyState } from '../../components/ui/EmptyState';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { appClickPath, appDataLink, appSettingsPath } from '../../lib/appNavigation';
import { Header } from '../../components/layout/Header';
import { PageBody } from '../../components/layout/PageBody';
import { Popover } from '../../components/ui/Popover';
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
import { KIND_LABELS, viewerOwnsApp } from '../../types/app';
import { listedStatus, statusTone } from '../../lib/appStatus';
import type { App, AppSummary } from '../../types/app';
import { isSoftnApp } from '../../lib/softnApps';

/** The card view shows this many, then more on request. The table shows every app. */
const APPS_PAGE = 9;
const menuItem = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-200 dark:hover:bg-slate-800';
type KindFilter = 'all' | 'web' | 'forms';
type StatusFilter = 'any' | 'live' | 'draft' | 'archived';
const KINDS: readonly (readonly [KindFilter, string])[] = [['all', 'All kinds'], ['web', 'Web apps'], ['forms', 'Forms']];
const STATUSES: readonly (readonly [StatusFilter, string])[] = [['any', 'Any status'], ['live', 'Live'], ['draft', 'Draft'], ['archived', 'Archived']];

export function AppsDashboard() {
  const navigate = useNavigate();
  const userId = useAuthStore(s => s.user?.id);
  const { apps, isLoading, fetchApps, deleteApp } = useAppStore();
  const loadError = useAppStore((s) => s.error);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [params] = useSearchParams();
  const { pathname, hash } = useLocation();
  const searchQuery = params.get('q') ?? '';
  const requestedKind = params.get('kind');
  const kind = requestedKind === 'softn' ? 'web' : KINDS.find(([value]) => value === requestedKind)?.[0] ?? 'all';
  const status = STATUSES.find(([value]) => value === params.get('status'))?.[0] ?? 'any';
  const activeFilters = Number(kind !== 'all') + Number(status !== 'any');
  const [showFilters, setShowFilters] = useState(activeFilters > 0);
  const [showActions, setShowActions] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
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
  const updateFilters = (values: { q?: string; kind?: KindFilter; status?: StatusFilter }) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (!value || (key === 'kind' && value === 'all') || (key === 'status' && value === 'any')) next.delete(key);
      else next.set(key, value);
    }
    setAppLimit(APPS_PAGE);
    navigate({ pathname, search: next.toString(), hash }, { replace: true, preventScrollReset: true });
  };
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
    const q = searchQuery.trim().toLowerCase().replace(/\/$/, '');
    return apps.filter((app) =>
      (kind === 'all' || appTools(app, summaries[app.id])[kind]) &&
      (status === 'any' || app.status === (status === 'live' ? 'published' : status)) &&
      (!q ||
        app.name.toLowerCase().includes(q) ||
        // The slug is printed on every card and used in the /app/<slug> URL, so it is
        // the obvious thing to paste in. The sidebar's search already matched it.
        (window.location.origin + '/app/' + app.slug).toLowerCase().includes(q) ||
        // Its own domain is its address too.
        (!!summaries[app.id]?.domain && ('https://' + summaries[app.id].domain).toLowerCase().includes(q)) ||
        (appPackMap[app.id]?.toLowerCase().includes(q) ?? false))
    );
  }, [apps, searchQuery, appPackMap, kind, status, summaries]);
  const filtering = !!searchQuery.trim() || kind !== 'all' || status !== 'any';
  const clearFilters = () => updateFilters({ q: '', kind: 'all', status: 'any' });
  function openAction(action: 'import' | 'connect') {
    // The menu item disappears. The dialog should return focus to its persistent launcher.
    actionsRef.current?.focus();
    setShowActions(false);
    if (action === 'import') setShowImport(true);
    else setShowHandToAi(true);
  }
  const liveCount = apps.filter(app => app.status === 'published').length;

  return (
    <div className="min-h-screen">
      <Header
        title="Apps"
        actions={
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => navigate('/apps/new')} leftIcon={<Plus className="size-4" aria-hidden="true" />}>Create app</Button>
            <Button ref={actionsRef} variant="ghost" size="iconOnly" onClick={event => { event.currentTarget.focus(); setShowActions(open => !open); }}
              aria-label="More app actions" aria-haspopup="dialog" aria-expanded={showActions} title="More app actions">
              <MoreHorizontal className="size-5" aria-hidden="true" />
            </Button>
            <Popover isOpen={showActions} onClose={() => setShowActions(false)} anchorRef={actionsRef} placement="bottom-end" ariaLabel="More app actions" className="w-52 p-1.5">
              <button type="button" className={menuItem} onClick={() => openAction('import')}>
                <Upload className="size-4" aria-hidden="true" />Import an app
              </button>
              <button type="button" className={menuItem} onClick={() => openAction('connect')}>
                <Plug className="size-4" aria-hidden="true" />Connect an AI
              </button>
            </Popover>
          </div>
        }
      />

      <PageBody className="@container/apps flex-1">
        {apps.length > 0 && (
          <div className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 w-full items-center gap-2 @2xl/apps:w-auto @2xl/apps:flex-1 @2xl/apps:max-w-lg">
                <div className="min-w-0 flex-1">
                  <Input type="search" placeholder="Find an app…" aria-label="Search apps by name, address or template"
                    value={searchQuery} onChange={e => updateFilters({ q: e.target.value })} leftIcon={<Search className="size-4" aria-hidden="true" />} />
                </div>
                <Button type="button" variant={activeFilters ? 'secondary' : 'outline'} size="sm" aria-expanded={showFilters}
                  aria-controls="app-filters" onClick={() => setShowFilters(open => !open)} leftIcon={<SlidersHorizontal className="size-4" aria-hidden="true" />}>
                  Filters{activeFilters > 0 && <span className="rounded bg-primary-100 px-1.5 text-xs tabular-nums text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">{activeFilters}</span>}
                </Button>
              </div>
              <div className="flex w-full items-center justify-between gap-3 @2xl/apps:w-auto">
                <span role="status" className="text-sm text-slate-600 dark:text-slate-300">{filtering ? `${filteredApps.length} of ${apps.length} ${apps.length === 1 ? 'app' : 'apps'}` : `${apps.length} ${apps.length === 1 ? 'app' : 'apps'} · ${liveCount} live`}</span>
                <div role="group" aria-label="View mode" className="flex shrink-0 gap-0.5 rounded-lg border border-slate-200 bg-slate-100/70 p-0.5 dark:border-slate-700 dark:bg-slate-900">
                  {([['table', 'Table', List], ['grid', 'Cards', LayoutGrid]] as const).map(([mode, label, Icon]) => (
                    <button key={mode} type="button" aria-label={label} title={label} aria-pressed={viewMode === mode}
                      onClick={() => changeViewMode(mode)} className={cn('inline-flex min-h-9 min-w-9 items-center justify-center rounded-md max-sm:min-h-11 max-sm:min-w-11 focus-visible:outline-2 focus-visible:outline-primary-500',
                        viewMode === mode ? 'bg-white text-primary-700 shadow-sm dark:bg-slate-700 dark:text-primary-200' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white')}>
                      <Icon className="size-4" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div id="app-filters" hidden={!showFilters} className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900">
              <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
                <Segmented label="App type" options={KINDS} value={kind} onChange={kind => updateFilters({ kind })} />
                <Segmented label="Status" options={STATUSES.filter(([value]) => value !== 'archived' || status === 'archived' || apps.some(app => app.status === 'archived'))}
                  value={status} onChange={status => updateFilters({ status })} />
                {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
              </div>
            </div>
          </div>
        )}

        {loadError && apps.length > 0 && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Couldn't refresh your apps. Showing the last list.
          <Button size="sm" variant="ghost" onClick={() => void fetchApps()}>Try again</Button>
        </div>}
        {isLoading && apps.length === 0 ? (
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
            description="Create an app, upload a JavaScript, React, or Vue app as a ZIP, or start with a marketplace template."
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
                    summary={summaries[app.id]}
                    packName={appPackMap[app.id] ?? null}
                    canManage={viewerOwnsApp(app, userId)}
                    to={appClickPath(app, userId)}
                    onDelete={() => setDeleteTarget(app)}
                  />
                ))}
              </div>
            ) : (
              <AppsTable apps={filteredApps} summaries={summaries} packNames={appPackMap} userId={userId} onDelete={setDeleteTarget} footer={null} />
            )}
            {viewMode === 'grid' && <ShowMore shown={Math.min(appLimit, filteredApps.length)} total={filteredApps.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" />}
          </>
        )}
      </PageBody>

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

/** A filter with a few choices, one of them on: a row of buttons that reads as one control. */
function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (next: T) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">{label}</legend>
      <div className="flex flex-wrap gap-1">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'min-h-9 rounded-md px-2.5 py-1 text-sm font-medium transition-colors cursor-pointer max-sm:min-h-11 focus-visible:outline-2 focus-visible:outline-primary-500',
            value === option ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
          )}
        >
          {text}
        </button>
      ))}
      </div>
    </fieldset>
  );
}

function AppCard({ app, summary, packName, canManage, to, onDelete }: {
  app: App; summary?: AppSummary; packName: string | null; canManage: boolean; to: string; onDelete: () => void;
}) {
  const tools = appTools(app, summary);
  const kind = tools.web ? tools.label : (app.settings?.appKind && KIND_LABELS[app.settings.appKind]) || tools.label;
  const address = summary?.domain || `/app/${app.slug}`;
  const facts = isSoftnApp(app)
    ? (canManage ? [holds(app, summary), who(app, summary)].filter(Boolean) : [])
    : [holds(app, summary)];
  const settingsPath = appSettingsPath(app);
  const data = canManage ? appDataLink(app, summary) : undefined;
  const actionStyle = 'relative z-10 inline-flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-primary-700 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-primary-300 max-sm:size-11';

  return <article className="group relative flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-400 focus-within:border-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500">
    <div className="flex items-start justify-between gap-3">
      <AppTile app={app} />
      <Badge variant={statusTone(app)} size="sm">{listedStatus(app, summary)}</Badge>
    </div>
    <h2 className="mt-3 break-words text-lg font-semibold leading-tight tracking-tight text-slate-950 dark:text-white">
      <Link to={to} className="after:absolute after:inset-0 after:rounded-xl hover:text-primary-700 focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:text-primary-300">{app.name}</Link>
    </h2>
    <span title={address} className="mt-1 block truncate font-mono text-xs text-slate-600 dark:text-slate-400">{address}</span>
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
      <span>{kind}</span>
      {isDemoLocalId(app.id) && <span>· Browser only</span>}
      {packName && <span className="inline-flex min-w-0 items-center gap-1"><Package className="size-3 shrink-0" aria-hidden="true" /><span className="break-words">{packName}</span></span>}
    </p>
    {app.description && <p className="mt-2 line-clamp-2 text-sm text-slate-600 dark:text-slate-300">{app.description}</p>}
    {facts.length > 0 && <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-700 dark:text-slate-300">{facts.map(fact => <span key={fact}>{fact}</span>)}</p>}
    <div className="mt-auto pt-4">
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-slate-200 pt-1 dark:border-slate-700">
        <span className="text-xs text-slate-600 dark:text-slate-400">Updated {formatRelativeTime(app.updatedAt)}</span>
        <div className="ml-auto flex shrink-0">
          {app.status === 'published' && <a href={summary?.domain ? `https://${summary.domain}` : address} target="_blank" rel="noopener noreferrer" className={actionStyle}
            title="Open live app" aria-label={`Open live app ${app.name}`}><ExternalLink className="size-4" aria-hidden="true" /></a>}
          {canManage && <>
            {data && <Link to={data.to} aria-label={`Data of ${app.name}`} title={data.label} className={actionStyle}><Database className="size-4" aria-hidden="true" /></Link>}
            <Link to={settingsPath} aria-label={`Manage ${app.name}`} title="App settings" className={actionStyle}><Settings className="size-4" aria-hidden="true" /></Link>
            <button type="button" onClick={onDelete} aria-label={`Delete ${app.name}`} title="Delete app" className={cn(actionStyle, 'hover:text-red-700 dark:hover:text-red-300')}><Trash2 className="size-4" aria-hidden="true" /></button>
          </>}
        </div>
      </div>
    </div>
  </article>;
}
