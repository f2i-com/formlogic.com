import { browseStarters, starterCatalog } from '../lib/starterCatalog';
import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import '../styles/landing-v2.css';
import '../styles/landing-refresh.css';
import { MarketplaceLayout } from '../components/layout/MarketplaceLayout';
import { PageBody } from '../components/layout/PageBody';
import { useAuthStore } from '../stores/authStore';
import {
  Package,
  Search,
  Star,
  Download,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Tag as TagIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { PackIcon } from '../components/ui/PackIcon';
import { usePackBrowse } from '../hooks/usePackBrowse';
import { api, resolveFileUrl, type CatalogPack, type PackFacet } from '../lib/api';
import { useMarketplaceChrome, useReveal } from '../lib/marketplaceChrome';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Numbered mono eyebrow — the landing page's "engineered catalog" section marker. */
function SectionTag({ index, label }: { index: string; label: string }) {
  return (
    <div className="fl-mono inline-flex items-center gap-2.5 text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400 mb-5">
      <span>{index}</span>
      <span className="h-px w-8 bg-primary-500/40" />
      <span>{label}</span>
    </div>
  );
}

/**
 * One pack card, used for both the featured row and the main grid. Leads with the
 * captured dashboard screenshot (16:10) — the fastest way to judge a pack — and
 * hides zero-value social proof: no star row until someone has rated, no download
 * count until someone has installed.
 */
function PackCard({ pack, onOpen, workspace = false }: { pack: CatalogPack; onOpen: () => void; /** Inside the workspace: a plain card, its name whole. */ workspace?: boolean }) {
  const shot = pack.screenshots?.[0]?.url || pack.screenshot;
  return (
    <button
      onClick={onOpen}
      className={cn(
        'group flex flex-col text-left rounded-2xl border overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950',
        workspace
          ? 'border-gray-200 bg-white shadow-sm transition-colors hover:border-primary-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-primary-500/40'
          : 'border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/50 hover:border-primary-300 dark:hover:border-primary-500/30 hover:shadow-xl hover:shadow-primary-500/[0.05] hover:-translate-y-0.5 transition-all duration-300',
      )}
    >
      {/* In the workspace's single column (a phone) a template with no picture keeps a short band
          for its icon, not a picture-sized blank. */}
      <div className={cn(
        'relative w-full aspect-[16/10] overflow-hidden border-b border-gray-200/80 dark:border-slate-800 bg-gray-50 dark:bg-slate-900',
        workspace && !shot && '@max-[30rem]/packs:aspect-auto @max-[30rem]/packs:h-20',
      )}>
        {shot ? (
          <img
            src={resolveFileUrl(shot)}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <div className="fl-grid absolute inset-0 flex items-center justify-center">
            <PackIcon icon={pack.icon} className="h-10 w-10 text-primary-500/60" emojiClassName="text-4xl" />
          </div>
        )}
        {pack.featured && (
          <span className={cn('absolute top-2.5 right-2.5 rounded-full bg-primary-600 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground', workspace ? 'shadow-sm' : 'fl-mono shadow-md shadow-primary-600/30')}>
            Featured
          </span>
        )}
      </div>

      <div className={cn('flex flex-1 flex-col', workspace ? 'p-3' : 'p-4')}>
        <div className={cn('flex min-w-0 gap-2', workspace ? 'items-start' : 'items-center')}>
          {pack.icon && shot && (
            <PackIcon icon={pack.icon} className={cn('h-4 w-4 shrink-0 text-primary-500', workspace && 'mt-0.5')} emojiClassName="shrink-0 text-lg leading-none" />
          )}
          {/* In the workspace a name wraps: cut short, two templates of one family read the same. */}
          <p className={cn('font-semibold text-gray-900 dark:text-white', workspace ? 'min-w-0 break-words text-sm leading-5' : 'truncate')}>{pack.name}</p>
        </div>
        {pack.description && (
          <p className={cn('text-gray-500 dark:text-slate-400 line-clamp-2', workspace ? 'mt-1 text-[13px] leading-5' : 'mt-1.5 text-sm')}>{pack.description}</p>
        )}
        {/* Contrast: gray-400 fails WCAG AA at 11px — and this row carries the composition,
            which is the thing someone is choosing between. */}
        <div className={cn('mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-3 text-[11px] text-gray-500 dark:text-slate-400', workspace ? 'tabular-nums' : 'fl-mono')}>
          {/* An extension holds flow nodes: in the workspace its card does not say "0 forms · 0 apps". */}
          {(!workspace || pack.formCount > 0 || pack.appCount > 0) && (
            <span className="whitespace-nowrap">
              {plural(pack.formCount, 'form')} · {plural(pack.appCount, 'app')}
            </span>
          )}
          {pack.category && (
            <span className="rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-500 dark:text-slate-400">
              {pack.category}
            </span>
          )}
          {pack.ratingCount > 0 && (
            <span
              className="inline-flex items-center gap-1 text-gray-500 dark:text-slate-400"
              aria-label={`Rated ${pack.avgRating.toFixed(1)} out of 5 by ${pack.ratingCount}`}
            >
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
              {pack.avgRating.toFixed(1)}
              <span>({pack.ratingCount})</span>
            </span>
          )}
          {pack.downloadCount > 0 && (
            <span className="inline-flex items-center gap-1" aria-label={`${pack.downloadCount} installs`}>
              <Download className="h-3 w-3" aria-hidden="true" />
              {pack.downloadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/** Card-shaped placeholder so the grid doesn't jump when the catalog arrives. */
function PackCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/50">
      <Skeleton className="aspect-[16/10] w-full rounded-none" />
      <div className="space-y-2.5 border-t border-gray-200/80 dark:border-slate-800 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export default function PackGalleryPage() {
  const navigate = useNavigate();
  const signedIn = useAuthStore(state => !!state.user);
  const [featuredPacks, setFeaturedPacks] = useState<CatalogPack[]>(starterCatalog.filter(pack => pack.featured));
  const [categories, setCategories] = useState<PackFacet[]>([]);
  const [tags, setTags] = useState<PackFacet[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('popular');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);

  useMarketplaceChrome();
  useReveal();

  useEffect(() => {
    document.title = signedIn ? 'Templates — FormLogic' : 'Marketplace — FormLogic';
  }, [signedIn]);

  const filtering = Boolean(searchQuery || categoryFilter || tagFilter);

  // Declared before the effects below so the effects' dependency arrays can reference them
  // without hitting the const temporal dead zone (ReferenceError on mount).




  // MKT-601: browsing (debounce, stale-response cancellation, error state, retry) lives in the
  // shared hook, so this route and the Packs popup cannot drift into different behaviour for
  // the same screen again.
  const browse = usePackBrowse({
    search: searchQuery,
    sort: sortBy,
    category: categoryFilter,
    tag: tagFilter,
    page,
    limit: 12,
  });
  const bundled = browseStarters(searchQuery, categoryFilter, tagFilter, sortBy, page);
  const packs = browse.error ? bundled.packs : browse.packs;
  const totalPages = browse.error ? bundled.totalPages : browse.totalPages;
  const loading = browse.loading;
  const error = browse.error;
  const loadPacks = browse.retry;

  // Mount-only chrome: the featured strip and the facet chips. Fetched INLINE (react-hooks
  // forbids calling a setState-ing helper from an effect body), and failures leave those
  // sections simply absent — they are decoration around the catalog, not the catalog.
  useEffect(() => {
    let cancelled = false;
    void api.browsePacks({ sort: 'popular', limit: 6 }).then((result) => {
      if (!cancelled && result.data?.packs) {
        setFeaturedPacks([...result.data.packs.filter((p) => p.featured && p.slug !== 'aokie-receptionist').slice(0, 2), result.data.packs.find(p => p.slug === 'aokie-receptionist') || starterCatalog.find(p => p.slug === 'aokie-receptionist')!]);
      }
    }).catch(() => {});
    // Facets (categories + tags in use) drive the browse chips. Derived from the live catalog,
    // so they adapt as packs are published — there is no hardcoded taxonomy.
    void api.getPackFacets().then((result) => {
      if (!cancelled && result.data) {
        setCategories(result.data.categories || []);
        setTags(result.data.tags || []);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const chipClass = (active: boolean) =>
    `fl-mono min-h-11 px-3 py-1.5 rounded-full text-[11px] uppercase tracking-wider border transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
      active
        ? 'border-primary-500/50 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
        : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-700 hover:text-gray-700 dark:hover:text-slate-200'
    }`;

  const selectCategory = (name: string) => { setCategoryFilter(name); setTagFilter(''); setPage(1); };
  const toggleTag = (name: string) => {
    const next = tagFilter === name ? '' : name;
    setTagFilter(next);
    if (next) setCategoryFilter('');
    setPage(1);
  };
  const clearFilters = () => { setSearchQuery(''); setCategoryFilter(''); setTagFilter(''); setPage(1); };

  // Signed in, the catalogue is a workspace page (docs/WORKSPACE_PAGES.md): the Header names it,
  // the body starts at the left under it and the cards fill the width. There is no title block
  // and no "Featured" band: those cards lead the list already, each wearing its mark. Only the
  // layout differs from the public page below; what is searched, filtered and opened is the same.
  if (signedIn) {
    const pill = (active: boolean) => cn(
      'inline-flex flex-none items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer max-sm:min-h-11',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
      active
        ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/15 dark:text-primary-300'
        : 'border-gray-300 bg-white text-gray-600 hover:text-gray-900 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:text-white',
    );
    // As many columns as fit, none narrower than a card can be read at.
    const grid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3 sm:gap-4';
    return (
      <MarketplaceLayout
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate('/apps')} rightIcon={<ArrowRight className="h-4 w-4" />}>
            My apps
          </Button>
        }
      >
        <PageBody>
          {error && (
            <p role="status" className="mb-3 text-sm text-gray-600 dark:text-slate-300">
              Browsing the bundled starter catalogue. Live marketplace details and installation need a connection.{' '}
              <button type="button" className="cursor-pointer underline max-sm:min-h-11" onClick={() => loadPacks()}>Retry live catalogue</button>
            </p>
          )}

          {/* Search, the order and the categories: one line where there is room; on a phone the
              search and the order share the first line and the categories take the second. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-slate-500" aria-hidden="true" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Search templates…"
                aria-label="Search packs"
                className="block w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:placeholder:text-slate-500"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
              aria-label="Sort packs"
              className="flex-none cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 sm:order-last sm:ml-auto dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="popular">Popular</option>
              <option value="top_rated">Top rated</option>
              <option value="newest">Newest</option>
              <option value="name">Name</option>
            </select>
            <div role="group" aria-label="Category" className="flex basis-full flex-wrap gap-1.5 sm:min-w-0 sm:flex-1 sm:basis-auto">
              <button type="button" onClick={() => selectCategory('')} aria-pressed={!categoryFilter && !tagFilter} className={pill(!categoryFilter && !tagFilter)}>
                All
              </button>
              {categories.map((cat) => (
                <button key={cat.name} type="button" onClick={() => selectCategory(cat.name)} aria-pressed={categoryFilter === cat.name} className={pill(categoryFilter === cat.name)}>
                  {cat.name}{' '}
                  <span className="tabular-nums opacity-70">{cat.count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* The tags in use. On a phone they are one row that scrolls sideways, so the first
              templates stay on the first screen. */}
          {tags.length > 0 && (
            <div className="mb-3 flex items-center gap-2">
              <span className="inline-flex flex-none items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                <TagIcon className="h-3.5 w-3.5" aria-hidden="true" /> Tags
              </span>
              <div role="group" aria-label="Tag" className="scrollbar-hide flex min-w-0 gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-visible">
                {tags.slice(0, 14).map((tag) => (
                  <button
                    key={tag.name}
                    type="button"
                    onClick={() => toggleTag(tag.name)}
                    aria-pressed={tagFilter === tag.name}
                    className={cn(
                      'flex-none cursor-pointer whitespace-nowrap rounded-md border px-2 py-1 text-xs transition-colors max-sm:min-h-11 max-sm:px-3',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500',
                      tagFilter === tag.name
                        ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/15 dark:text-primary-300'
                        : 'border-transparent bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:bg-slate-700',
                    )}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {filtering && (
            <div className="mb-3 flex flex-wrap items-center gap-2 break-words text-sm text-gray-500 dark:text-slate-400">
              <span>
                {categoryFilter && <>Category: <strong className="text-gray-700 dark:text-slate-200">{categoryFilter}</strong></>}
                {tagFilter && <>Tag: <strong className="text-gray-700 dark:text-slate-200">{tagFilter}</strong></>}
                {searchQuery && <>{(categoryFilter || tagFilter) && ' · '}Search: <strong className="text-gray-700 dark:text-slate-200">“{searchQuery}”</strong></>}
              </span>
              <button
                type="button"
                onClick={clearFilters}
                className="cursor-pointer rounded px-1 text-xs font-medium text-primary-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 max-sm:px-2 dark:text-primary-400"
              >
                Clear
              </button>
            </div>
          )}

          {loading ? (
            <div className={grid} role="status" aria-busy="true" aria-label="Loading apps">
              {Array.from({ length: 8 }).map((_, i) => (
                <PackCardSkeleton key={i} />
              ))}
            </div>
          ) : packs.length === 0 ? (
            <div className="py-16 text-center text-gray-500 dark:text-slate-400">
              <Package className="mx-auto mb-3 h-10 w-10 opacity-50" aria-hidden="true" />
              <p className="text-sm font-semibold text-gray-700 dark:text-slate-200">No apps found</p>
              <p className="mt-1 text-sm">Try adjusting your search or filters.</p>
            </div>
          ) : (
            <>
              <div className={grid}>
                {packs.map((pack) => (
                  <PackCard key={pack.id} pack={pack} workspace onOpen={() => navigate(`/packs/${pack.slug}`)} />
                ))}
              </div>
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between gap-3">
                  <p className="text-sm tabular-nums text-gray-500 dark:text-slate-400">Page {page} of {totalPages}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} leftIcon={<ChevronLeft className="h-4 w-4" />}>
                      Previous
                    </Button>
                    <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)} rightIcon={<ChevronRight className="h-4 w-4" />}>
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </PageBody>
      </MarketplaceLayout>
    );
  }

  return (
    <MarketplaceLayout>
      {error && <div role="status" className="mx-auto max-w-6xl px-6 pt-5 text-sm text-slate-600 dark:text-slate-300">Browsing the bundled starter catalogue. Live marketplace details and installation need a connection. <button className="min-h-11 underline" onClick={() => loadPacks()}>Retry live catalogue</button></div>}

      {/* Hero — same blueprint-grid + glow grammar as the landing page */}
      <section className="relative overflow-hidden border-b border-gray-100 dark:border-slate-800/60 px-4 pt-14 pb-12 sm:px-6 sm:pt-20 sm:pb-16 lg:px-8">
        <div
          className="fl-grid pointer-events-none absolute inset-0"
          style={{
            maskImage: 'radial-gradient(ellipse 75% 80% at 50% 20%, #000 0%, transparent 78%)',
            WebkitMaskImage: 'radial-gradient(ellipse 75% 80% at 50% 20%, #000 0%, transparent 78%)',
          }}
        />
        <div className="pointer-events-none absolute -top-24 left-1/2 h-[420px] w-[900px] -translate-x-1/2 rounded-full bg-primary-600/10 opacity-70 blur-[120px]" />

        <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
          <div data-reveal className="fl-reveal">
            <SectionTag index="01" label="Marketplace" />
          </div>
          <h1
            data-reveal
            className="fl-display fl-reveal text-4xl text-gray-900 dark:text-white sm:text-6xl"
            style={{ transitionDelay: '80ms' }}
          >
            Install a working
            <br />
            <span className="fl-grad">business app</span>
          </h1>
          <p
            data-reveal
            className="fl-reveal mt-5 max-w-xl text-base leading-relaxed text-gray-500 dark:text-slate-400 sm:text-lg"
            style={{ transitionDelay: '160ms' }}
          >
            Start with a working app, then make it yours. Forms, dashboards and automations
            stay connected to your FormLogic records. Add Aokie to bring calls and appointment requests into your workspace.
          </p>
          <div data-reveal className="fl-reveal relative mt-8 w-full max-w-md" style={{ transitionDelay: '240ms' }}>
            <Search className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 dark:text-slate-500" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              placeholder="Search apps…"
              aria-label="Search packs"
              className="w-full rounded-xl border border-gray-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/70 py-3 pl-11 pr-4 text-gray-900 dark:text-white shadow-sm backdrop-blur-sm placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {!filtering && <section aria-label="Build with connected apps" className="mb-10 grid gap-4 rounded-2xl border border-sky-200 bg-sky-50 p-6 sm:grid-cols-3 sm:p-8 dark:border-sky-900 dark:bg-sky-950/30">
          <div><span className="fl-mono text-xs text-sky-600 dark:text-sky-300">01 / START</span><h2 className="mt-2 font-semibold">Choose your starting point</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Browse a complete workspace for your business. Review its forms and capabilities before installing.</p></div>
          <div><span className="fl-mono text-xs text-sky-600 dark:text-sky-300">02 / CONNECT</span><h2 className="mt-2 font-semibold">Bring your tools together</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Share forms with another app or move Aokie’s automations into an existing workspace.</p><Link to="/aokie" className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-sky-700 dark:text-sky-300">Explore Aokie <ArrowRight size={15}/></Link></div>
          <div><span className="fl-mono text-xs text-sky-600 dark:text-sky-300">03 / MAKE IT YOURS</span><h2 className="mt-2 font-semibold">Keep building your app</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Customize your workspace and build an editable app with Softn, hosted on FormLogic.</p><a href="/#live-demo" className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-sky-700 dark:text-sky-300">Try the live workspace <ArrowRight size={15}/></a></div>
        </section>}
        {/* Featured row */}
        {!filtering && featuredPacks.length > 0 && (
          <div className="mb-10">
            <div className="fl-mono mb-4 flex items-center gap-2.5 text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>Featured</span>
              <span className="h-px flex-1 bg-primary-500/20" />
            </div>
            <div className="grid grid-cols-1 gap-4 @2xl/packs:grid-cols-2 @4xl/packs:grid-cols-3">
              {featuredPacks.map((pack) => (
                <PackCard key={pack.id} pack={pack} onOpen={() => navigate(`/packs/${pack.slug}`)} />
              ))}
            </div>
          </div>
        )}

        {/* Category chips (dynamic) */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex flex-1 flex-wrap gap-2">
            <button
              onClick={() => selectCategory('')}
              className={chipClass(!categoryFilter && !tagFilter)}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat.name}
                onClick={() => selectCategory(cat.name)}
                className={chipClass(categoryFilter === cat.name)}
              >
                {cat.name}{' '}
                <span className="ml-1.5">{cat.count}</span>
              </button>
            ))}
          </div>
          <select
            value={sortBy}
            onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
            aria-label="Sort packs"
            className="min-h-11 rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <option value="popular">Popular</option>
            <option value="top_rated">Top rated</option>
            <option value="newest">Newest</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Tag cloud (dynamic) */}
        {tags.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="fl-mono inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-gray-500 dark:text-slate-400">
              <TagIcon className="h-3.5 w-3.5" aria-hidden="true" /> Tags
            </span>
            {tags.slice(0, 14).map((tag) => (
              <button
                key={tag.name}
                onClick={() => toggleTag(tag.name)}
                className={`fl-mono cursor-pointer rounded-md border px-2.5 py-1 text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  tagFilter === tag.name
                    ? 'border-primary-300 dark:border-primary-500/40 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                    : 'border-transparent bg-gray-100 dark:bg-slate-800/60 text-gray-500 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700'
                }`}
              >
                {tag.name}
              </button>
            ))}
          </div>
        )}

        {/* Active filter summary */}
        {filtering && (
          <div className="mb-4 flex flex-wrap items-center gap-2 break-words text-sm text-gray-500 dark:text-slate-400">
            <span>
              {categoryFilter && <>Category: <strong className="text-gray-700 dark:text-slate-200">{categoryFilter}</strong></>}
              {tagFilter && <>Tag: <strong className="text-gray-700 dark:text-slate-200">{tagFilter}</strong></>}
              {searchQuery && <>Search: <strong className="text-gray-700 dark:text-slate-200">“{searchQuery}”</strong></>}
            </span>
            <button
              onClick={clearFilters}
              className="cursor-pointer rounded text-xs text-primary-600 dark:text-primary-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              Clear
            </button>
          </div>
        )}

        {/* Pack grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 @2xl/packs:grid-cols-2 @4xl/packs:grid-cols-3" role="status" aria-busy="true" aria-label="Loading apps">
            {Array.from({ length: 6 }).map((_, i) => (
              <PackCardSkeleton key={i} />
            ))}
          </div>
        ) : packs.length === 0 ? (
          <div className="py-16 text-center text-gray-500 dark:text-slate-400">
            <Package className="mx-auto mb-3 h-12 w-12 opacity-50" />
            <p className="text-lg font-medium">No apps found</p>
            <p className="mt-1 text-sm">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 @2xl/packs:grid-cols-2 @4xl/packs:grid-cols-3">
              {packs.map((pack) => (
                <PackCard key={pack.id} pack={pack} onOpen={() => navigate(`/packs/${pack.slug}`)} />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-8 flex items-center justify-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span className="fl-mono text-xs text-gray-500 dark:text-slate-400">
                  Page {page} of {totalPages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </MarketplaceLayout>
  );
}
