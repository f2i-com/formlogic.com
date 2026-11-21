import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Box, ClipboardList, Layers } from 'lucide-react';
import { api, type MarketplaceDemoSession } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import NativeAppPage from '../../pages/apps/NativeAppPage';
import { MarketplaceDemoFrame } from '../marketplace/MarketplaceDemoFrame';
import { DemoManagementView } from '../marketplace/DemoManagementView';
import { AppSplash } from '../studio/AppSplash';
import { rememberedLook } from '../../lib/appLook';
import { AppRuntimeRoot } from './AppRuntimeRoot';
import { AppRuntimeAuthGuard } from './AppRuntimeAuthGuard';
import { startFlowDispatcher } from '../../client-runtime/flows/flowDispatcher';
import { cn } from '../../lib/utils';

interface NativeEntryInfo {
  home: boolean;
  access?: string;
  demoSandboxSlug?: string | null;
  appId?: string | null;
  appName?: string | null;
  linkedFormAppSlug?: string | null;
  linkedFormAppName?: string | null;
}

function DemoSoftnSandboxPage({ entry, slug }: { entry: NativeEntryInfo; slug: string }) {
  const signedIn = useAuthStore((s) => !!s.user);
  const location = useLocation();
  const initialTab = new URLSearchParams(location.search).get('view') === 'management' ? 'management' : 'softn';
  const [activeTab, setActiveTab] = useState<'softn' | 'management'>(initialTab);
  const [mgmtMounted, setMgmtMounted] = useState<boolean>(initialTab === 'management');
  const [sandboxSession, setSandboxSession] = useState<MarketplaceDemoSession | null>(null);
  const [softnRefreshSignal, setSoftnRefreshSignal] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);
  const [mgmtRefreshTrigger, setMgmtRefreshTrigger] = useState(0);
  const [hasMgmtChanges, setHasMgmtChanges] = useState(false);
  const dirtyForSoftnRef = useRef(false);

  const rawTitle = entry.appName || slug;
  const cleanTitle = rawTitle.replace(/\s*\(SoftN App\)\s*$/i, '').trim() || rawTitle;

  const handleSelectSoftn = useCallback(() => {
    setActiveTab('softn');
    if (dirtyForSoftnRef.current) {
      dirtyForSoftnRef.current = false;
      setHasMgmtChanges(false);
      setSoftnRefreshSignal((n) => n + 1);
    }
  }, []);

  const handleSelectManagement = useCallback(() => {
    setMgmtMounted(true);
    setActiveTab('management');
    setMgmtRefreshTrigger((n) => n + 1);
  }, []);

  const handleManagementDataMutated = useCallback(() => {
    dirtyForSoftnRef.current = true;
    setHasMgmtChanges(true);
  }, []);

  const handleSessionReset = useCallback(() => {
    dirtyForSoftnRef.current = false;
    setHasMgmtChanges(false);
    setMgmtRefreshTrigger((n) => n + 1);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-slate-50 dark:bg-slate-950">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 shadow-xs dark:border-slate-800 dark:bg-slate-900 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {signedIn && (
            <Link
              to="/apps"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Apps
            </Link>
          )}
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
            <Box className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{cleanTitle}</h1>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
              Live Demo · Shared SQLite between SoftN App &amp; Management
            </p>
          </div>
        </div>

        {/* Unified live-linked 2-section switcher: SoftN App ↔ Management (Forms & Charts) */}
        <nav
          aria-label="App mode switcher"
          className="inline-flex items-center rounded-xl border border-slate-200 bg-slate-100/90 p-0.5 dark:border-slate-700 dark:bg-slate-800/80"
        >
          <button
            type="button"
            onClick={handleSelectSoftn}
            aria-pressed={activeTab === 'softn'}
            className={cn(
              'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition',
              activeTab === 'softn'
                ? 'bg-primary-600 text-primary-foreground shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-700 dark:hover:text-white',
            )}
          >
            <Box className="h-3.5 w-3.5" aria-hidden="true" />
            SoftN App
            {hasMgmtChanges && activeTab === 'management' && (
              <span
                className="ml-0.5 inline-block h-2 w-2 rounded-full bg-emerald-500"
                title="Updated in Management — click to view live changes in SoftN App"
              />
            )}
          </button>
          <button
            type="button"
            onClick={handleSelectManagement}
            aria-pressed={activeTab === 'management'}
            className={cn(
              'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition',
              activeTab === 'management'
                ? 'bg-primary-600 text-primary-foreground shadow-xs'
                : 'text-slate-700 hover:bg-white hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-700 dark:hover:text-white',
            )}
          >
            <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
            Management (Forms &amp; Charts)
          </button>
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          {signedIn && entry.appId && (
            <Link
              to={`/apps/${encodeURIComponent(entry.appId)}/web`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              Inspect Workspace
            </Link>
          )}
        </div>
      </header>
      <main className="relative min-h-0 flex-1">
        <div className={cn('h-full w-full', activeTab !== 'softn' && 'hidden')}>
          <MarketplaceDemoFrame
            slug={entry.demoSandboxSlug!}
            name={cleanTitle}
            sourceProtected={false}
            hasBackend
            backendRuntime="PHP + SQLite"
            autoLaunch
            fullHeight
            refreshSignal={softnRefreshSignal}
            resetSignal={resetSignal}
            onSessionReady={setSandboxSession}
            onSessionReset={handleSessionReset}
          />
        </div>
        {mgmtMounted && (
          <div className={cn('h-full w-full', activeTab !== 'management' && 'hidden')}>
            <DemoManagementView
              slug={entry.demoSandboxSlug!}
              appName={cleanTitle}
              session={sandboxSession}
              active={activeTab === 'management'}
              refreshTrigger={mgmtRefreshTrigger}
              legacyFormAppSlug={entry.linkedFormAppSlug}
              onDataMutated={handleManagementDataMutated}
              onRequestReset={() => setResetSignal((n) => n + 1)}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function MemberNativeApp({ slug, signInTo, onDomain = false }: { slug: string; signInTo?: string; onDomain?: boolean }) {
  const { initialize, reset, config } = useAppRuntimeStore();
  const canRunFlows = useAppRuntimeStore(state => state.canRunFlows());
  useEffect(() => { void initialize(slug); return () => reset(); }, [slug, initialize, reset]);
  const appId = config?.app?.id;
  // Flows run for the owner and roles granted execute_flows; the server answers any other member's
  // request for them 403, which every visit of theirs used to log.
  useEffect(() => {
    if (appId && config?.app?.slug === slug && canRunFlows) return startFlowDispatcher(slug, { id: appId });
  }, [slug, appId, config?.app?.slug, canRunFlows]);
  return <AppRuntimeAuthGuard><NativeAppPage slug={slug} signInTo={signInTo} onDomain={onDomain} /></AppRuntimeAuthGuard>;
}

/** An installed app on its own domain: it is the site, so the way back in is the site's root. */
export function DomainNativeApp({ slug, access }: { slug: string; access: 'application' | 'members' }) {
  return access === 'members' ? <MemberNativeApp slug={slug} signInTo="/" onDomain /> : <NativeAppPage slug={slug} signInTo="/" onDomain />;
}

const nativeEntryCache = new Map<string, NativeEntryInfo>();

function AppEntryContent({ slug, isHome }: { slug: string; isHome: boolean }) {
  const userId = useAuthStore(state => state.user?.id);
  const cacheKey = `${slug}:${userId ?? 'anon'}`;
  const cached = nativeEntryCache.get(cacheKey) ?? null;
  const [loaded, setLoaded] = useState<{ key: string; entry: NativeEntryInfo } | null>(null);
  const [error, setError] = useState('');

  const entry = cached ?? (loaded?.key === cacheKey ? loaded.entry : null);

  useEffect(() => {
    if (!isHome && entry) return;
    let cancelled = false;
    void api.getNativeEntry(slug).then(result => {
      if (cancelled) return;
      if (result.error) {
        if (isHome) setError(result.error);
      } else {
        const resolved = result.data ?? { home: false };
        nativeEntryCache.set(cacheKey, resolved);
        setLoaded({ key: cacheKey, entry: resolved });
      }
    });
    return () => { cancelled = true; };
  }, [slug, cacheKey, isHome, entry]);

  if (isHome && error) return <p role="alert" className="p-6 text-slate-800 dark:text-slate-200">{error}</p>;
  // Only block on the splash while the server says whether the root URL is a native/demo SoftN app.
  // Sub-routes (forms, records, reports, profile) mount AppRuntimeRoot directly and keep it mounted
  // across all internal navigations (including back to the Dashboard root) so the sidebar menu never flashes.
  if (isHome && !entry) return <div className="h-dvh"><AppSplash look={rememberedLook(slug)} /></div>;
  if (isHome && entry?.demoSandboxSlug) return <DemoSoftnSandboxPage entry={entry} slug={slug} />;
  if (isHome && entry?.home) {
    return entry.access === 'members' ? <MemberNativeApp slug={slug} /> : <NativeAppPage />;
  }
  return <AppRuntimeRoot />;
}

/** The normal app URL also serves an imported website, including custom-domain launches. */
export function AppEntryRouter() {
  const { appSlug = '' } = useParams();
  const location = useLocation();
  const isHome = location.pathname.replace(/\/$/, '') === `/app/${appSlug}`;
  return <AppEntryContent key={appSlug} slug={appSlug} isHome={isHome} />;
}
