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
      <div className="max-w-6xl mx-auto">
        <div
          data-reveal
          className="fl-reveal relative overflow-hidden rounded-3xl border border-primary-500/20 bg-gradient-to-br from-primary-600 via-primary-700 to-slate-900 p-8 sm:p-12"
        >
          {/* ambient glow */}
          <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-primary-400/20 blur-3xl" />
          <div className="relative">
            <div className="fl-mono inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-primary-foreground/90 backdrop-blur">
              <span className="fl-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
              Live demo · no signup
            </div>

            <h2 className="fl-display mt-5 text-3xl sm:text-4xl font-bold tracking-tight text-primary-foreground">
              Try a real internal app — right now
            </h2>
            <p className="mt-3 max-w-2xl text-primary-foreground/80 leading-relaxed">
              Jump into a live workspace as <strong className="text-primary-foreground">Demo</strong> — no account, no
              setup. Explore the apps below with real data, custom dashboards, forms and roles. Like it? Sign up
              anytime to build your own.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => launch()}
                disabled={anyLaunching}
                className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-primary-700 shadow-lg shadow-black/10 transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {launching === '__all__' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Launch the live demo
              </button>
              <span className="text-xs text-primary-foreground/70">Opens the full product with sample data.</span>
            </div>

            {/* App cards */}
            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {apps.slice(0, 9).map((app) => (
                <button
                  key={app.slug}
                  type="button"
                  onClick={() => launch(app.slug)}
                  disabled={anyLaunching}
                  className="group flex cursor-pointer items-start gap-3 rounded-2xl border border-white/15 bg-white/[0.06] p-4 text-left backdrop-blur transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-white/15 text-primary-foreground">
                    {launching === app.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <Boxes className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-primary-foreground">{app.name}</span>
                      <ArrowRight className="h-3.5 w-3.5 flex-none text-primary-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-primary-foreground" />
                    </div>
                    {app.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-primary-foreground/70">{app.description}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
