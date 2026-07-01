import { useEffect, useState } from 'react';
import { ArrowRight, Boxes, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';

type DemoApp = { slug: string; name: string; description: string; logoUrl: string | null };

/**
 * Landing "live demo" band. Fetches the demoable apps (published apps owned by the shared Demo
 * account) and lets a visitor jump straight in — no signup. Clicking mints the Demo session cookie
 * and opens the demo in a NEW TAB (the landing tab stays put). Renders nothing if the demo is
 * disabled / has no apps.
 */
export function LiveDemoSection() {
  const [apps, setApps] = useState<DemoApp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getDemoApps();
        if (!cancelled) setApps(r.data?.apps ?? []);
      } catch {
        /* demo unavailable — section hides itself */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const launch = async (slug?: string) => {
    if (launching) return;
    setLaunching(slug || '__all__');
    try {
      // Mint the Demo session cookie without switching THIS tab into the app, then open the demo
      // in a new tab (same origin → shares the cookie). The landing page stays as it was.
      const res = await api.startDemo();
      if (res.error || !res.data) return;
      window.open(slug ? `/app/${slug}` : '/', '_blank', 'noopener');
    } finally {
      setLaunching(null);
    }
  };

  // Nothing to show until we know there are demoable apps.
  if (!loaded || apps.length === 0) return null;

  const anyLaunching = launching !== null;

  return (
    <section id="demo" className="relative px-4 sm:px-6 lg:px-8 py-20 sm:py-28">
      <div data-reveal className="fl-reveal max-w-6xl mx-auto">
        {/* Header */}
        <div className="fl-mono inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary-600 dark:text-primary-400">
          <span className="fl-dot inline-block h-1.5 w-1.5 rounded-full bg-primary-500" />
          Live demo · no signup
        </div>
        <h2 className="fl-display mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
          Try a real business app <span className="fl-grad">right now</span>
        </h2>
        <p className="mt-3 max-w-2xl text-gray-500 dark:text-slate-400 leading-relaxed">
          Jump into a live workspace as <strong className="text-gray-900 dark:text-white">Demo</strong> — no account,
          no setup. Explore real data, custom dashboards, forms and roles. Like it? Sign up to build your own.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => launch()}
            disabled={anyLaunching}
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {launching === '__all__' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Launch the live demo
          </button>
          <span className="text-xs text-gray-400 dark:text-slate-500">Opens in a new tab with sample data.</span>
        </div>

        {/* App tiles */}
        <div className="mt-9 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {apps.slice(0, 9).map((app) => (
            <button
              key={app.slug}
              type="button"
              onClick={() => launch(app.slug)}
              disabled={anyLaunching}
              className="group flex cursor-pointer items-start gap-3 rounded-2xl border border-gray-200 bg-white p-4 text-left transition hover:border-primary-400 hover:shadow-md hover:shadow-primary-500/5 dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-primary-500/50 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
                {launching === app.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <Boxes className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{app.name}</span>
                  <ArrowRight className="h-3.5 w-3.5 flex-none text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-primary-500 dark:text-slate-600" />
                </div>
                {app.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-slate-400">{app.description}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
