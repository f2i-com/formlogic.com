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
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { api, type CatalogPack } from '../lib/api';

const CATEGORIES = [
  'Finance & Compliance',
  'Human Resources',
  'Safety & Quality',
  'Customer Service',
  'Event Management',
  'Operations',
  'Sales & Marketing',
  'IT & Development',
  'Education',
  'Healthcare',
];

export default function PackGalleryPage() {
  const navigate = useNavigate();
  const [packs, setPacks] = useState<CatalogPack[]>([]);
  const [featuredPacks, setFeaturedPacks] = useState<CatalogPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('popular');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSeqRef = useRef(0);

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
  }, [searchQuery, sortBy, categoryFilter, page]);

  useEffect(() => {
    loadFeatured();
  }, [loadFeatured]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadPacks();
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, sortBy, categoryFilter, page, loadPacks]);

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
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Pack Marketplace</h1>
          <p className="text-gray-600 dark:text-slate-400 mt-2 max-w-lg mx-auto">
            Browse and install pre-built form packs to get started quickly. Share your own packs with the community.
          </p>
          <div className="max-w-md mx-auto mt-6 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              placeholder="Search packs..."
              aria-label="Search packs"
              className="w-full pl-10 pr-4 py-3 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white shadow-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Featured row */}
        {!searchQuery && !categoryFilter && featuredPacks.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-amber-500" />
              Featured Packs
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {featuredPacks.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => navigate(`/packs/${pack.slug}`)}
                  className="text-left p-4 rounded-xl border-2 border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5 hover:shadow-md transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-3xl" aria-hidden="true">{pack.icon || '📦'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 dark:text-white">{pack.name}</p>
                      <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 line-clamp-2">{pack.description}</p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 dark:text-slate-400">
                        {renderStars(pack.avgRating)}
                        <span className="inline-flex items-center gap-0.5 ml-1">
                          <Download className="h-3 w-3" /> {pack.downloadCount}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="flex-1 flex flex-wrap gap-2">
            <button
              onClick={() => { setCategoryFilter(''); setPage(1); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                !categoryFilter
                  ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300'
                  : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700'
              }`}
            >
              All
            </button>
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => { setCategoryFilter(cat); setPage(1); }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                  categoryFilter === cat
                    ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300'
                    : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700'
                }`}
              >
                {cat}
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

        {/* Pack grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div role="alert" className="text-center py-16 text-gray-500 dark:text-slate-400">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium text-gray-700 dark:text-slate-300">Couldn’t load packs</p>
            <p className="text-sm mt-1">{error}</p>
            <Button variant="outline" className="mt-4" onClick={() => loadPacks()}>Try again</Button>
          </div>
        ) : packs.length === 0 ? (
          <div className="text-center py-16 text-gray-400 dark:text-slate-500">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No packs found</p>
            <p className="text-sm mt-1">Try adjusting your search or filters.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {packs.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => navigate(`/packs/${pack.slug}`)}
                  className="text-left p-4 rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-gray-300 dark:hover:border-slate-700 hover:shadow-md transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-3xl" aria-hidden="true">{pack.icon || '📦'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-gray-900 dark:text-white truncate">{pack.name}</p>
                        {pack.featured && <Badge variant="warning" size="sm">Featured</Badge>}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 line-clamp-2">{pack.description}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 dark:text-slate-400">
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
                            <span>by {pack.publisherName}</span>
                          </>
                        )}
                      </div>
                      {pack.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {pack.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="default" size="sm">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
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
