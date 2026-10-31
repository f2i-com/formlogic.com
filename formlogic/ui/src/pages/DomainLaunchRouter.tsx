// Resolves the current custom-domain host to its app and decides what the host shows (spec §20.1
// Option A — same SPA, host-aware). On a domain of an installed SoftN app the app is the site: it
// opens full screen at the domain's own address, on every path but the account pages a visitor
// still needs. Other apps show their launch page at the root, and deeper paths (/app/:slug,
// /form/:id) render the normal app. A host the server doesn't know renders the normal app too: it
// may be a self-hosted FormLogic this build wasn't told the name of, and only its root says so.
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { DomainNativeApp } from '../components/app-runtime/AppEntryRouter';
import { api } from '../lib/api';
import { fetchLaunchConfig, type LaunchConfig } from '../lib/domainLaunchApi';
import { AppLaunchPage } from './AppLaunchPage';

const ACCOUNT_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password', '/accept-invite', '/privacy', '/terms'];

function Spinner() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-white dark:bg-slate-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600 dark:border-slate-700 dark:border-t-slate-300" />
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
  const { pathname } = useLocation();
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
  const accountPage = ACCOUNT_PATHS.includes(pathname.replace(/\/$/, ''));
  const showsApp = !!config && !!softnAccess && !accountPage && !(pathname === '/' && !direct);
  useDomainManifest(showsApp);

  // runtime_direct on any other kind of app: this domain IS the app, at the app's usual URL.
  const redirects = !!config && !softnAccess && direct && pathname === '/';
  useEffect(() => {
    if (redirects && config) window.location.replace(`/app/${config.app.slug}`);
  }, [redirects, config]);

  if (!resolved || redirects) return <Spinner />;
  if (showsApp && config && softnAccess) return <DomainNativeApp slug={config.app.slug} access={softnAccess} />;
  if (pathname !== '/' || (config && softnAccess && accountPage)) return <>{children}</>;
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
