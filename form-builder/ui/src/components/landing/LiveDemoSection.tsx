import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, Search, Sparkles, X } from 'lucide-react';
import { api } from '../../lib/api';
import { DynamicIcon } from '../ui/DynamicIcon';

const PAGE_SIZE = 9;

type DemoApp = {
  slug: string;
  name: string;
  description: string;
  logoUrl: string | null;
  icon?: string | null;
  accent?: string | null;
  packName?: string;
  tags?: string[];
};

// Pack-authored accents arrive as hex; anything else is ignored (the value lands in an
// inline CSS custom property, so keep the format strict).
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

// Deterministic accent for apps without a logo: hash the name into a small
// palette so the grid reads as a varied catalog, not 19 identical tiles.
// Each entry pairs a light tint with a dark-mode tint.
const ACCENTS = [
  'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300',
  'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
  'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300',
];

function accentFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

function DemoAppCard({ app, launching, disabled, onLaunch }: {
  app: DemoApp;
  launching: boolean;
  disabled: boolean;
  onLaunch: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showLogo = Boolean(app.logoUrl) && !imgFailed;
  // Pack-authored icon on the app's own accent — each demo app ships its glyph in settings.icon.
  const showIcon = !showLogo && Boolean(app.icon);
  const accented = showIcon && isHexColor(app.accent);
  const tags = (app.tags ?? []).slice(0, 3);

  return (
    <button
      type="button"
      onClick={onLaunch}
      disabled={disabled}
      aria-label={`Open ${app.name} in the live demo`}
      className="group flex cursor-pointer items-start gap-3.5 rounded-2xl border border-gray-200 bg-white p-4 text-left transition duration-200 hover:border-primary-400 hover:shadow-md hover:shadow-primary-500/5 motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-primary-500/50 dark:focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div
        style={accented ? ({ '--fl-a': app.accent } as CSSProperties) : undefined}
        className={`flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded-lg ${
          showLogo
            ? 'bg-gray-50 text-primary-600 dark:bg-slate-800/60 dark:text-primary-400'
            : accented
              ? 'bg-[color-mix(in_srgb,var(--fl-a)_11%,transparent)] text-[color:var(--fl-a)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--fl-a)_25%,transparent)] dark:bg-[color-mix(in_srgb,var(--fl-a)_16%,transparent)] dark:text-[color:color-mix(in_srgb,var(--fl-a)_62%,white)]'
              : accentFor(app.name)
        }`}
      >
        {launching ? (
          <Loader2 className="h-4 w-4 animate-spin text-current" />
        ) : showLogo ? (
          <img
            src={app.logoUrl ?? undefined}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : showIcon ? (
          <DynamicIcon
            name={app.icon}
            className="h-[18px] w-[18px]"
            fallback={<span className="fl-mono text-xs font-semibold">{initialsFor(app.name)}</span>}
          />
        ) : (
          <span className="fl-mono text-xs font-semibold">{initialsFor(app.name)}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {app.packName && (
          <div className="fl-mono mb-1 truncate text-[10px] uppercase tracking-[0.14em] text-primary-600 dark:text-primary-400">
            {app.packName}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{app.name}</span>
          <ArrowRight className="h-3.5 w-3.5 flex-none text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-primary-500 dark:text-slate-600" />
        </div>
        {app.description && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500 dark:text-slate-400">{app.description}</p>
        )}
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t) => (
              <span
                key={t}
                className="fl-mono rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] lowercase text-gray-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

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
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const revealRef = useRef<HTMLDivElement | null>(null);

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

  // Reveal-on-scroll, self-registered. This section mounts AFTER Landing's useReveal()
  // observer has already scanned the page (we render nothing until the apps load), so it
  // runs its own observer once the section exists. Falls back to instantly visible when
  // IntersectionObserver is unavailable or the user prefers reduced motion.
  useEffect(() => {
    const el = revealRef.current;
    if (!el) return;
    if (
      !('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      el.classList.add('fl-in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('fl-in');
            io.disconnect();
          }
        });
      },
      { threshold: 0.05, rootMargin: '0px 0px -48px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loaded, apps.length]);

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

  // Search across name + description + tags + pack name. Tokenised partial match: every whitespace-
  // separated term must appear somewhere (so "invoice job" matches "Job & Invoice Management").
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length === 0
    ? apps
    : apps.filter((a) => {
        const hay = `${a.name} ${a.description ?? ''} ${(a.tags ?? []).join(' ')} ${a.packName ?? ''}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount); // stay in range as the filter shrinks
  const paged = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <section id="demo" className="relative px-4 sm:px-6 lg:px-8 py-20 sm:py-28">
      <div ref={revealRef} className="fl-reveal max-w-6xl mx-auto">
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
            onClick={() => launch(apps[0]?.slug)}
            disabled={anyLaunching}
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {launching === '__all__' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Launch the live demo
          </button>
          <span className="text-xs text-gray-400 dark:text-slate-500">Opens in a new tab with sample data.</span>
        </div>

        {/* Search + count */}
        <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
              placeholder="Search apps…"
              aria-label="Search demo apps"
              className="fl-mono w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500/50 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-slate-800 dark:bg-slate-900/50 dark:text-white dark:placeholder:text-slate-500"
            />
          </div>
          <span className="text-xs text-gray-400 dark:text-slate-500">
            {filtered.length} app{filtered.length === 1 ? '' : 's'}{terms.length ? ` matching “${query.trim()}”` : ''}
          </span>
        </div>

        {/* App tiles */}
        {paged.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-gray-200 py-10 text-center dark:border-slate-800">
            <p className="text-sm text-gray-500 dark:text-slate-400">No apps match — try a different term</p>
            <button
              type="button"
              onClick={() => { setQuery(''); setPage(1); }}
              className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:border-primary-400 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300 dark:hover:border-primary-500/50 dark:hover:text-primary-400"
            >
              <X className="h-3.5 w-3.5" />
              Clear search
            </button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {paged.map((app) => (
              <DemoAppCard
                key={app.slug}
                app={app}
                launching={launching === app.slug}
                disabled={anyLaunching}
                onLaunch={() => launch(app.slug)}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {pageCount > 1 && (
          <div className="mt-6 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPage(current - 1)}
              disabled={current <= 1}
              aria-label="Previous page"
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <span className="px-2 text-xs text-gray-500 dark:text-slate-400" aria-live="polite">Page {current} of {pageCount}</span>
            <button
              type="button"
              onClick={() => setPage(current + 1)}
              disabled={current >= pageCount}
              aria-label="Next page"
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Cross-link to the marketplace */}
        <div className="mt-8 text-center">
          <Link
            to="/packs"
            className="group inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-gray-500 transition hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:text-primary-400"
          >
            Browse the full marketplace
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
