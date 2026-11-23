import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Box, ClipboardList, Database, Layers, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import NativeAppPage from '../../pages/apps/NativeAppPage';
import { MarketplaceDemoFrame } from '../marketplace/MarketplaceDemoFrame';
import { AppSplash } from '../studio/AppSplash';
import { rememberedLook } from '../../lib/appLook';
import { extractPlatformAppSubpath, isFormAppSubroute } from '../../lib/nativeRouteAddress';
import { AppRuntimeRoot } from './AppRuntimeRoot';
import { AppRuntimeAuthGuard } from './AppRuntimeAuthGuard';
import { startFlowDispatcher } from '../../client-runtime/flows/flowDispatcher';

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
  const navigate = useNavigate();
  const [openingManagement, setOpeningManagement] = useState(false);

  const rawTitle = entry.appName || slug;
  const cleanTitle = rawTitle.replace(/\s*\(SoftN App\)\s*$/i, '').trim() || rawTitle;

  const openManagementApp = useCallback(async () => {
    if (!entry.linkedFormAppSlug || openingManagement) return;
    setOpeningManagement(true);
    try {
      // Visitors opening a Demo SoftN App from the landing page aren't signed in yet.
      // Start the read-only Demo session seamlessly (never touching a real signed-in account)
      // so the real FormLogic Form App loads immediately without a login screen, wired to
      // the exact same visitor SQLite sandbox via sessionStorage.
      if (!useAuthStore.getState().user) {
        await useAuthStore.getState().startDemo();
      }
      navigate(`/app/${encodeURIComponent(entry.linkedFormAppSlug)}`);
    } finally {
      setOpeningManagement(false);
    }
  }, [entry.linkedFormAppSlug, navigate, openingManagement]);

  useEffect(() => {
    if (entry.linkedFormAppSlug && new URLSearchParams(location.search).get('view') === 'management') {
      void Promise.resolve().then(() => openManagementApp());
    }
  }, [entry.linkedFormAppSlug, location.search, openManagementApp]);

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
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{cleanTitle}</h1>
              <span className="hidden items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 sm:inline-flex">
                <Database className="h-3 w-3" aria-hidden="true" />
                Live Shared SQLite
              </span>
            </div>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
              Live Demo · Changes sync instantly with the Form App
            </p>
          </div>
        </div>

        {/* Unified live-linked 2-section switcher: SoftN App ↔ Real FormLogic Form App */}
        <nav
          aria-label="App mode switcher"
          className="inline-flex items-center rounded-xl border border-slate-200 bg-slate-100/90 p-0.5 dark:border-slate-700 dark:bg-slate-800/80"
        >
          <span
            aria-current="page"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-semibold text-primary-foreground shadow-xs"
          >
            <Box className="h-3.5 w-3.5" aria-hidden="true" />
            SoftN App
          </span>
          {entry.linkedFormAppSlug && (
            <button
              type="button"
              onClick={() => void openManagementApp()}
              disabled={openingManagement}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-slate-700 transition hover:bg-white hover:text-slate-950 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700 dark:hover:text-white"
            >
              {openingManagement
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                : <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />}
              Management (Forms &amp; Charts)
            </button>
          )}
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
        <MarketplaceDemoFrame
          slug={entry.demoSandboxSlug!}
          name={cleanTitle}
          sourceProtected={false}
          hasBackend
          backendRuntime="PHP + SQLite"
          autoLaunch
          fullHeight
        />
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

const NATIVE_ENTRY_FRESH_MS = 30_000;
const nativeEntryCache = new Map<string, { entry: NativeEntryInfo; at: number }>();

function AppEntryContent({ slug, checkNative }: { slug: string; checkNative: boolean }) {
  const userId = useAuthStore(state => state.user?.id);
  const cacheKey = `${slug}:${userId ?? 'anon'}`;
  const cachedRecord = nativeEntryCache.get(cacheKey) ?? null;
  const cached = cachedRecord?.entry ?? null;
  const [loaded, setLoaded] = useState<{ key: string; entry: NativeEntryInfo } | null>(null);
  const [error, setError] = useState('');

  const entry = cached ?? (loaded?.key === cacheKey ? loaded.entry : null);

  useEffect(() => {
    if (entry && (!checkNative || (cachedRecord && Date.now() - cachedRecord.at < NATIVE_ENTRY_FRESH_MS))) return;
    let cancelled = false;
    void api.getNativeEntry(slug).then(result => {
      if (cancelled) return;
      if (result.error) {
        if (checkNative) setError(result.error);
      } else {
        const resolved = result.data ?? { home: false };
        nativeEntryCache.set(cacheKey, { entry: resolved, at: Date.now() });
        setLoaded({ key: cacheKey, entry: resolved });
      }
    });
    return () => { cancelled = true; };
  }, [slug, cacheKey, checkNative, entry, cachedRecord]);

  if (checkNative && error) return <p role="alert" className="p-6 text-slate-800 dark:text-slate-200">{error}</p>;
  // Only block on the splash while the server says whether this route belongs to a native/demo SoftN app.
  // Form App sub-routes (forms, records, reports, profile) mount AppRuntimeRoot directly and keep it mounted
  // across all internal navigations so the sidebar menu never flashes, while SoftN clean page paths
  // (e.g. /app/mysite/about.html) mount NativeAppPage directly with that page opened.
  if (checkNative && !entry) return <div className="h-dvh"><AppSplash look={rememberedLook(slug)} /></div>;
  if (checkNative && entry?.demoSandboxSlug) return <DemoSoftnSandboxPage entry={entry} slug={slug} />;
  if (checkNative && entry?.home) {
    return entry.access === 'members' ? <MemberNativeApp slug={slug} /> : <NativeAppPage />;
  }
  return <AppRuntimeRoot />;
}

/** The normal app URL also serves an imported website (and its clean subpage paths like /about.html), including custom-domain launches. */
export function AppEntryRouter() {
  const { appSlug = '' } = useParams();
  const location = useLocation();
  const subpath = extractPlatformAppSubpath(location.pathname, appSlug) ?? '';
  const checkNative = subpath === '' || !isFormAppSubroute(subpath);
  return <AppEntryContent key={appSlug} slug={appSlug} checkNative={checkNative} />;
}
