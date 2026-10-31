// Resolves the current custom-domain host to its app and decides what the host shows (spec §20.1
// Option A — same SPA, host-aware). On a domain of an installed SoftN app the app is the site: it
// opens full screen at the domain's own address, on every path but the legal pages. Other apps show
// their launch page at the root, and deeper paths (/app/:slug, /form/:id) render the normal app.
// Anything that takes a password happens on FormLogic itself, whose address the server gives
// (see domainSignIn). A host the server doesn't know renders the normal app too: it may be a
// self-hosted FormLogic this build wasn't told the name of, and only its root says so.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { DomainNativeApp } from '../components/app-runtime/AppEntryRouter';
import { api } from '../lib/api';
import { signInDestination } from '../lib/authRedirect';
import { fetchLaunchConfig, type LaunchConfig } from '../lib/domainLaunchApi';
import { DomainSignInContext, finishDomainSignIn, startDomainSignIn } from '../lib/domainSignIn';
import { AppLaunchPage } from './AppLaunchPage';

const SIGN_IN_PATHS = ['/login', '/signup'];
const PASSWORD_PATHS = ['/forgot-password', '/reset-password', '/accept-invite'];
const LEGAL_PATHS = ['/privacy', '/terms'];

function Spinner() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-white dark:bg-slate-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600 dark:border-slate-700 dark:border-t-slate-300" />
    </div>
  );
}

/** The end of the trip to FormLogic: the code in the address becomes this domain's session. */
function DomainSignInComplete({ platformUrl }: { platformUrl: string }) {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Out of the address bar and the history before anything else can read it.
    window.history.replaceState(null, '', window.location.pathname);
    void finishDomainSignIn(params.get('code'), params.get('state')).then(next => {
      if (next === null) setFailed(true);
      else window.location.replace(next);
    });
  }, []);
  if (!failed) return <Spinner />;
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white">That sign-in didn't finish</h1>
      <p role="alert" className="max-w-sm text-sm text-gray-500 dark:text-slate-400">It may have expired. Please try again.</p>
      <button type="button" className="min-h-11 text-sm text-primary-600 dark:text-primary-400" onClick={() => startDomainSignIn(platformUrl, 'login', '/')}>Sign in</button>
    </div>
  );
}

/** The domain's app manifest, so installing the page installs the app and not the platform. */
function useDomainManifest(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const created = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    const previous = link.getAttribute('href');
    link.setAttribute('href', '/manifest.json');
    return () => {
      if (created) link.remove();
      else if (previous !== null) link.setAttribute('href', previous);
    };
  }, [active]);
}

export function DomainLaunchRouter({ host, children }: { host: string; children: ReactNode }) {
  const { pathname, search } = useLocation();
  const [resolved, setResolved] = useState<{ config: LaunchConfig | null; softnAccess?: 'application' | 'members' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await fetchLaunchConfig(host);
      const entry = config ? await api.getNativeEntry(config.app.slug) : null;
      if (!cancelled) setResolved({ config, softnAccess: entry?.data?.native ? entry.data.access : undefined });
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  const config = resolved?.config ?? null;
  const softnAccess = resolved?.softnAccess;
  const direct = config?.domain.mode === 'runtime_direct';
  const path = pathname.replace(/\/$/, '');
  // Null where FormLogic is this very address: a local `?__flhost=` preview signs in as usual.
  const platformUrl = config?.platformUrl && config.platformUrl !== window.location.origin ? config.platformUrl : null;
  const leaves = !!platformUrl && (SIGN_IN_PATHS.includes(path) || PASSWORD_PATHS.includes(path));
  const finishing = !!platformUrl && path === '/sign-in/complete';
  const accountPage = SIGN_IN_PATHS.includes(path) || PASSWORD_PATHS.includes(path) || LEGAL_PATHS.includes(path);
  const showsApp = !!config && !!softnAccess && !accountPage && !finishing && !(pathname === '/' && !direct);
  useDomainManifest(showsApp);

  useEffect(() => {
    if (!leaves || !platformUrl) return;
    if (SIGN_IN_PATHS.includes(path)) {
      const after = new URLSearchParams(search).get('redirect');
      startDomainSignIn(platformUrl, path === '/signup' ? 'signup' : 'login', signInDestination(after));
    } else {
      window.location.replace(`${platformUrl}${path}${search}`);
    }
  }, [leaves, platformUrl, path, search]);

  // runtime_direct on any other kind of app: this domain IS the app, at the app's usual URL.
  const redirects = !!config && !softnAccess && direct && pathname === '/';
  useEffect(() => {
    if (redirects && config) window.location.replace(`/app/${config.app.slug}`);
  }, [redirects, config]);

  if (!resolved || redirects || leaves) return <Spinner />;
  if (finishing && platformUrl) return <DomainSignInComplete platformUrl={platformUrl} />;
  if (showsApp && config && softnAccess) {
    return <DomainSignInContext.Provider value={platformUrl}><DomainNativeApp slug={config.app.slug} access={softnAccess} /></DomainSignInContext.Provider>;
  }
  if (pathname !== '/' || (config && softnAccess && accountPage)) {
    return <DomainSignInContext.Provider value={platformUrl}>{children}</DomainSignInContext.Provider>;
  }
  if (config) return <AppLaunchPage config={config} />;

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-2 bg-white px-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white">This domain isn't connected yet</h1>
      <p className="max-w-sm text-sm text-gray-500 dark:text-slate-400">
        <span className="font-mono">{host}</span> isn't pointing at a published FormLogic app. If you're the owner,
        finish connecting it in the app's settings.
      </p>
    </div>
  );
}
