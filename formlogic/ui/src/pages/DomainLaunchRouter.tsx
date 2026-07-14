// Resolves the current custom-domain host to its app and renders the branded
// launch surface (spec §20.1 Option A — same SPA, host-aware). Shown only at the
// site root of a custom domain; deeper paths (/app/:slug, /form/:id) render the
// normal app so the domain behaves like the app itself.
import { useEffect, useState } from 'react';
import { fetchLaunchConfig, type LaunchConfig } from '../lib/domainLaunchApi';
import { AppLaunchPage } from './AppLaunchPage';

type State = 'loading' | 'ready' | 'notfound';

export function DomainLaunchRouter({ host }: { host: string }) {
  const [state, setState] = useState<State>('loading');
  const [config, setConfig] = useState<LaunchConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLaunchConfig(host).then((cfg) => {
      if (cancelled) return;
      if (!cfg) {
        setState('notfound');
        return;
      }
      // runtime_direct: this domain IS the app — skip the launch page.
      if (cfg.domain.mode === 'runtime_direct') {
        window.location.replace(`/app/${cfg.app.slug}`);
        return;
      }
      setConfig(cfg);
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-white dark:bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600 dark:border-slate-700 dark:border-t-slate-300" />
      </div>
    );
  }

  if (state === 'notfound' || !config) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-2 bg-white px-6 text-center dark:bg-slate-950">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">This domain isn't connected yet</h1>
        <p className="max-w-sm text-sm text-gray-500 dark:text-slate-400">
          <span className="font-mono">{host}</span> isn't pointing at a published FormLogic app. If you're the owner,
          finish connecting it in Deploy &amp; Share.
        </p>
      </div>
    );
  }

  return <AppLaunchPage config={config} />;
}
