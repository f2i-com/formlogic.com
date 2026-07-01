import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package,
  Search,
  Star,
  Download,
  ChevronLeft,
  Loader2,
  Sparkles,
  Tag as TagIcon,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { api, resolveFileUrl, type CatalogPack, type PackFacet } from '../lib/api';

/**
 * A pack's marketplace thumbnail: the captured dashboard screenshot when we have one, otherwise a
 * branded gradient tile with the pack's emoji. Same aspect ratio either way so the grid stays even.
 */
function PackThumb({ pack, className = '' }: { pack: CatalogPack; className?: string }) {
  const [broken, setBroken] = useState(false);
  const showImage = pack.screenshot && !broken;
  return (
    <div
      className={`relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-gradient-to-br from-primary-100 to-primary-50 dark:from-primary-500/15 dark:to-slate-800 ${className}`}
    >
      {showImage ? (
        <img
          src={resolveFileUrl(pack.screenshot)}
          alt={`${pack.name} dashboard preview`}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-5xl opacity-90" aria-hidden="true">{pack.icon || '📦'}</span>
        </div>
      )}
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

  const renderStars = (rating: number) => (
    <div className="flex items-center gap-0.5" role="img" aria-label={`Rated ${rating.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          aria-hidden="true"
          className={`h-3.5 w-3.5 ${s <= Math.round(rating) ? 'fill-amber-400 text-amber-400' : 'text-gray-300 dark:text-slate-600'}`}
        />
      ))}
    </div>
  );

  const chipClass = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
      active
        ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300'
        : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700'
    }`;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>
        </div>
      </div>

      {/* Hero */}
      <div className="bg-gradient-to-b from-primary-50 to-white dark:from-primary-950/30 dark:to-slate-950 border-b border-gray-200 dark:border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-12 text-center">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">App Marketplace</h1>
          <p className="text-gray-600 dark:text-slate-400 mt-2 max-w-lg mx-auto">
            Install a ready-made business app — forms, workflow, and a live dashboard — in one click. Browse by
            category, or search for your trade.
          </p>
          <div className="max-w-md mx-auto mt-6 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              placeholder="Search apps…"
              aria-label="Search packs"
              className="w-full pl-10 pr-4 py-3 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white shadow-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Featured row */}
        {!filtering && featuredPacks.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-amber-500" />
              Featured
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {featuredPacks.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => navigate(`/packs/${pack.slug}`)}
                  className="group text-left rounded-xl border border-amber-200 dark:border-amber-500/30 bg-white dark:bg-slate-900 overflow-hidden hover:shadow-lg transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
                >
                  <PackThumb pack={pack} className="rounded-none" />
                  <div className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xl" aria-hidden="true">{pack.icon || '📦'}</span>
                      <p className="font-semibold text-gray-900 dark:text-white truncate">{pack.name}</p>
                      <Badge variant="warning" size="sm" className="ml-auto shrink-0">Featured</Badge>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1.5 line-clamp-2">{pack.description}</p>
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 dark:text-slate-400">
                      {renderStars(pack.avgRating)}
                      <span className="inline-flex items-center gap-0.5 ml-1">
                        <Download className="h-3 w-3" /> {pack.downloadCount}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Category chips (dynamic) */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex-1 flex flex-wrap gap-2">
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
            className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-white px-3 py-1.5"
          >
            <option value="popular">Popular</option>
            <option value="top_rated">Top Rated</option>
            <option value="newest">Newest</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Tag cloud (dynamic) */}
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400 dark:text-slate-500">
              <TagIcon className="h-3.5 w-3.5" /> Tags
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
                className={`px-2.5 py-1 rounded-md text-xs transition-colors cursor-pointer border ${
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
          <div className="flex items-center gap-2 mb-4 text-sm text-gray-500 dark:text-slate-400">
            <span>
              {categoryFilter && <>Category: <strong className="text-gray-700 dark:text-slate-200">{categoryFilter}</strong></>}
              {tagFilter && <>Tag: <strong className="text-gray-700 dark:text-slate-200">{tagFilter}</strong></>}
              {searchQuery && <>Search: <strong className="text-gray-700 dark:text-slate-200">“{searchQuery}”</strong></>}
            </span>
            <button
              onClick={() => { setSearchQuery(''); setCategoryFilter(''); setTagFilter(''); setPage(1); }}
              className="text-xs text-primary-600 dark:text-primary-400 hover:underline cursor-pointer"
            >
              Clear
            </button>
          </div>
        )}

        {/* Pack grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div role="alert" className="text-center py-16 text-gray-500 dark:text-slate-400">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium text-gray-700 dark:text-slate-300">Couldn’t load apps</p>
            <p className="text-sm mt-1">{error}</p>
            <Button variant="outline" className="mt-4" onClick={() => loadPacks()}>Try again</Button>
          </div>
        ) : packs.length === 0 ? (
          <div className="text-center py-16 text-gray-400 dark:text-slate-500">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No apps found</p>
            <p className="text-sm mt-1">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {packs.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => navigate(`/packs/${pack.slug}`)}
                  className="group text-left rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden hover:border-gray-300 dark:hover:border-slate-700 hover:shadow-lg transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
                >
                  <PackThumb pack={pack} className="rounded-none" />
                  <div className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xl shrink-0" aria-hidden="true">{pack.icon || '📦'}</span>
                      <p className="font-semibold text-gray-900 dark:text-white truncate">{pack.name}</p>
                      {pack.featured && <Badge variant="warning" size="sm" className="ml-auto shrink-0">Featured</Badge>}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1.5 line-clamp-2">{pack.description}</p>
                    <div className="flex items-center gap-3 mt-2.5 text-xs text-gray-500 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        {renderStars(pack.avgRating)}
                        <span className="ml-0.5">({pack.ratingCount})</span>
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <Download className="h-3 w-3" /> {pack.downloadCount}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 dark:text-slate-400">
                      <span>{pack.formCount} forms</span>
                      <span className="text-gray-300 dark:text-slate-600">&middot;</span>
                      <span>{pack.appCount} apps</span>
                      {pack.publisherName && (
                        <>
                          <span className="text-gray-300 dark:text-slate-600">&middot;</span>
                          <span className="truncate">by {pack.publisherName}</span>
                        </>
                      )}
                    </div>
                    {pack.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2.5">
                        {pack.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="default" size="sm">{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-8">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-gray-600 dark:text-slate-400">
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
