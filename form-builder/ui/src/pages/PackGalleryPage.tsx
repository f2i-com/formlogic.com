import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package,
  Search,
  Star,
  Download,
  ChevronLeft,
  ArrowRight,
  Sparkles,
  Tag as TagIcon,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { PackIcon } from '../components/ui/PackIcon';
import { api, resolveFileUrl, type CatalogPack, type PackFacet } from '../lib/api';
import { useMarketplaceChrome, useReveal } from '../lib/marketplaceChrome';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Numbered mono eyebrow — the landing page's "engineered catalog" section marker. */
function SectionTag({ index, label }: { index: string; label: string }) {
  return (
    <div className="fl-mono inline-flex items-center gap-2.5 text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400 mb-5">
      <span className="opacity-60">{index}</span>
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
function PackCard({ pack, onOpen }: { pack: CatalogPack; onOpen: () => void }) {
  const shot = pack.screenshots?.[0]?.url || pack.screenshot;
  return (
    <button
      onClick={onOpen}
      className="group flex flex-col text-left rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/50 overflow-hidden hover:border-primary-300 dark:hover:border-primary-500/30 hover:shadow-xl hover:shadow-primary-500/[0.05] hover:-translate-y-0.5 transition-all duration-300 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
    >
      <div className="relative w-full aspect-[16/10] overflow-hidden border-b border-gray-200/80 dark:border-slate-800 bg-gray-50 dark:bg-slate-900">
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
          <span className="fl-mono absolute top-2.5 right-2.5 rounded-full bg-primary-600 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground shadow-md shadow-primary-600/30">
            Featured
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex min-w-0 items-center gap-2">
          {pack.icon && shot && (
            <PackIcon icon={pack.icon} className="h-4 w-4 shrink-0 text-primary-500" emojiClassName="shrink-0 text-lg leading-none" />
          )}
          <p className="truncate font-semibold text-gray-900 dark:text-white">{pack.name}</p>
        </div>
        {pack.description && (
          <p className="mt-1.5 text-sm text-gray-500 dark:text-slate-400 line-clamp-2">{pack.description}</p>
        )}
        <div className="fl-mono mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-3 text-[11px] text-gray-400 dark:text-slate-500">
          <span className="whitespace-nowrap">
            {plural(pack.formCount, 'form')} · {plural(pack.appCount, 'app')}
          </span>
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
              <span className="opacity-70">({pack.ratingCount})</span>
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
  const [packs, setPacks] = useState<CatalogPack[]>([]);
  const [featuredPacks, setFeaturedPacks] = useState<CatalogPack[]>([]);
  const [categories, setCategories] = useState<PackFacet[]>([]);
  const [tags, setTags] = useState<PackFacet[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('popular');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSeqRef = useRef(0);

  useMarketplaceChrome();
  useReveal();

  useEffect(() => {
    document.title = 'Marketplace — FormLogic';
  }, []);

  const filtering = Boolean(searchQuery || categoryFilter || tagFilter);

  // Declared before the effects below so the effects' dependency arrays can reference them
  // without hitting the const temporal dead zone (ReferenceError on mount).
  const loadFeatured = useCallback(async () => {
    try {
      const result = await api.browsePacks({ sort: 'popular', limit: 6 });
      if (result.data?.packs) {
        setFeaturedPacks(result.data.packs.filter((p) => p.featured));
      }
    } catch {
      // silently fail
    }
  }, []);

  // Facets (categories + tags in use) drive the browse chips. Derived from the live catalog, so
  // they adapt automatically as packs are published — there is no hardcoded taxonomy.
  const loadFacets = useCallback(async () => {
    try {
      const result = await api.getPackFacets();
      if (result.data) {
        setCategories(result.data.categories || []);
        setTags(result.data.tags || []);
      }
    } catch {
      // silently fail — chips just won't render
    }
  }, []);

  const loadPacks = useCallback(async () => {
    // Ignore out-of-order responses: only the latest request may apply results,
    // otherwise a slow earlier query/page can overwrite newer results.
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.browsePacks({
        search: searchQuery || undefined,
        sort: sortBy,
        category: categoryFilter || undefined,
        tag: tagFilter || undefined,
        page,
        limit: 12,
      });
      if (seq !== loadSeqRef.current) return;
      if (result.error) {
        setError(typeof result.error === 'string' ? result.error : 'Failed to load packs');
      } else if (result.data) {
        setPacks(result.data.packs);
        setTotalPages(result.data.totalPages);
      }
    } catch {
      if (seq === loadSeqRef.current) setError('Failed to load packs. Please check your connection and try again.');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [searchQuery, sortBy, categoryFilter, tagFilter, page]);

  useEffect(() => {
    loadFeatured();
    loadFacets();
  }, [loadFeatured, loadFacets]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadPacks();
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, sortBy, categoryFilter, tagFilter, page, loadPacks]);

  const chipClass = (active: boolean) =>
    `fl-mono px-3 py-1.5 rounded-full text-[11px] uppercase tracking-wider border transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
      active
        ? 'border-primary-500/50 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
        : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-700 hover:text-gray-700 dark:hover:text-slate-200'
    }`;

  return (
    <div className="min-h-screen overflow-x-clip bg-white dark:bg-slate-950 text-gray-900 dark:text-slate-50">
      {/* Slim top bar */}
      <header className="relative z-20 border-b border-gray-100 dark:border-slate-800/60 bg-white/85 dark:bg-slate-950/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <button
            onClick={() => navigate(-1)}
            className="fl-mono inline-flex cursor-pointer items-center gap-1.5 rounded text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 transition-colors hover:text-gray-900 dark:hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </button>
          <a
            href="/#demo"
            className="fl-mono inline-flex items-center gap-1.5 rounded text-xs uppercase tracking-wider text-primary-600 dark:text-primary-400 transition-colors hover:text-primary-700 dark:hover:text-primary-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            Try them live in the demo
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </header>

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
            Every pack is a complete app — forms, workflow, and a live dashboard — ready to install in one
            click. Browse by category, or search for your trade.
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

      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {/* Featured row */}
        {!filtering && featuredPacks.length > 0 && (
          <div className="mb-10">
            <div className="fl-mono mb-4 flex items-center gap-2.5 text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>Featured</span>
              <span className="h-px flex-1 bg-primary-500/20" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              onClick={() => { setCategoryFilter(''); setTagFilter(''); setPage(1); }}
              className={chipClass(!categoryFilter && !tagFilter)}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat.name}
                onClick={() => { setCategoryFilter(cat.name); setTagFilter(''); setPage(1); }}
                className={chipClass(categoryFilter === cat.name)}
              >
                {cat.name}
                <span className="ml-1.5 opacity-60">{cat.count}</span>
              </button>
            ))}
          </div>
          <select
            value={sortBy}
            onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
            aria-label="Sort packs"
            className="rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
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
            <span className="fl-mono inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-gray-400 dark:text-slate-500">
              <TagIcon className="h-3.5 w-3.5" aria-hidden="true" /> Tags
            </span>
            {tags.slice(0, 14).map((tag) => (
              <button
                key={tag.name}
                onClick={() => {
                  const next = tagFilter === tag.name ? '' : tag.name;
                  setTagFilter(next);
                  if (next) setCategoryFilter('');
                  setPage(1);
                }}
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
          <div className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
            <span>
              {categoryFilter && <>Category: <strong className="text-gray-700 dark:text-slate-200">{categoryFilter}</strong></>}
              {tagFilter && <>Tag: <strong className="text-gray-700 dark:text-slate-200">{tagFilter}</strong></>}
              {searchQuery && <>Search: <strong className="text-gray-700 dark:text-slate-200">“{searchQuery}”</strong></>}
            </span>
            <button
              onClick={() => { setSearchQuery(''); setCategoryFilter(''); setTagFilter(''); setPage(1); }}
              className="cursor-pointer rounded text-xs text-primary-600 dark:text-primary-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              Clear
            </button>
          </div>
        )}

        {/* Pack grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading apps">
            {Array.from({ length: 6 }).map((_, i) => (
              <PackCardSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <div role="alert" className="py-16 text-center text-gray-500 dark:text-slate-400">
            <Package className="mx-auto mb-3 h-12 w-12 opacity-50" />
            <p className="text-lg font-medium text-gray-700 dark:text-slate-300">Couldn’t load apps</p>
            <p className="mt-1 text-sm">{error}</p>
            <Button variant="outline" className="mt-4" onClick={() => loadPacks()}>Try again</Button>
          </div>
        ) : packs.length === 0 ? (
          <div className="py-16 text-center text-gray-400 dark:text-slate-500">
            <Package className="mx-auto mb-3 h-12 w-12 opacity-50" />
            <p className="text-lg font-medium">No apps found</p>
            <p className="mt-1 text-sm">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
    </div>
  );
}
