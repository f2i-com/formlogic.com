import { useState, useEffect, useCallback } from 'react';
import { parseServerDate } from '../lib/utils';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  Star,
  Package,
  FileJson,
  Globe,
  Calendar,
  User,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { api, type CatalogPack, type PackVersionInfo, type PackRatingEntry } from '../lib/api';
import { toast } from '../stores/toastStore';
import { useFormStore } from '../stores/formStore';
import { useAppStore } from '../stores/appStore';

export default function PackDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [pack, setPack] = useState<(CatalogPack & { versions: PackVersionInfo[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [versionsExpanded, setVersionsExpanded] = useState(false);

  // Ratings
  const [ratings, setRatings] = useState<PackRatingEntry[]>([]);
  const [userRating, setUserRating] = useState<{ rating: number; review: string | null } | null>(null);
  const [hoverRating, setHoverRating] = useState(0);
  const [ratingInput, setRatingInput] = useState(0);
  const [reviewInput, setReviewInput] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);

  const refreshForms = useFormStore((s) => s.refreshForms);
  const fetchApps = useAppStore((s) => s.fetchApps);

  useEffect(() => {
    if (!slug) return;
    // Guard against stale responses: if the user navigates slug A -> B while A's
    // requests are in flight, A must not clobber B's pack/ratings on resolve.
    let cancelled = false;
    const shouldApply = () => !cancelled;
    loadPackDetail(shouldApply);
    loadRatings(shouldApply);
    checkInstalled();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const loadPackDetail = useCallback(async (shouldApply: () => boolean = () => true) => {
    if (!slug) return;
    setLoading(true);
    try {
      const result = await api.getPackDetail(slug);
      if (shouldApply() && result.data?.pack) {
        setPack(result.data.pack);
      }
    } catch {
      // silently fail
    } finally {
      if (shouldApply()) setLoading(false);
    }
  }, [slug]);

  const loadRatings = useCallback(async (shouldApply: () => boolean = () => true) => {
    if (!slug) return;
    try {
      const result = await api.getPackRatings(slug);
      if (shouldApply() && result.data) {
        setRatings(result.data.ratings);
        if (result.data.userRating) {
          setUserRating(result.data.userRating);
          setRatingInput(result.data.userRating.rating);
          setReviewInput(result.data.userRating.review || '');
        }
      }
    } catch {
      // silently fail
    }
  }, [slug]);

  const checkInstalled = useCallback(async () => {
    try {
      const result = await api.getInstalledPacks();
      const installs = result.data?.installations ?? [];
      if (pack) {
        setInstalled(installs.some((i) => i.catalogId === pack.id));
      }
    } catch {
      // silently fail
    }
  }, [pack]);

  useEffect(() => {
    if (pack) checkInstalled();
  }, [pack, checkInstalled]);

  const handleInstall = useCallback(async (versionId?: string) => {
    if (!slug || installing) return;
    setInstalling(true);
    try {
      const dlResult = await api.downloadPack(slug, versionId);
      if (!dlResult.data?.pack) {
        toast.error('Failed to download pack');
        return;
      }
      const importResult = await api.importPack(dlResult.data.pack, {
        catalogId: dlResult.data.catalogId,
        versionId: dlResult.data.versionId,
      });
      if (importResult.data) {
        setInstalled(true);
        toast.success(
          'Pack installed',
          `Imported ${importResult.data.forms.length} form(s) and ${importResult.data.apps.length} app(s).`
        );
        await Promise.all([refreshForms(), fetchApps()]);
      } else {
        toast.error('Install failed', importResult.error || 'Unknown error');
      }
    } catch (err) {
      toast.error('Install failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setInstalling(false);
    }
  }, [slug, installing, refreshForms, fetchApps]);

  const handleSubmitRating = useCallback(async () => {
    if (!slug || !ratingInput || submittingRating) return;
    setSubmittingRating(true);
    try {
      const result = await api.ratePack(slug, ratingInput, reviewInput || undefined);
      if (result.error || !result.data?.success) {
        // api.request resolves (not throws) on non-2xx, so handle result.error here
        // or the user gets zero feedback that the rating failed to persist.
        toast.error('Failed to submit rating', typeof result.error === 'string' ? result.error : undefined);
        return;
      }
      toast.success('Rating submitted');
      setUserRating({ rating: ratingInput, review: reviewInput || null });
      await Promise.all([loadPackDetail(), loadRatings()]);
    } catch {
      toast.error('Failed to submit rating');
    } finally {
      setSubmittingRating(false);
    }
  }, [slug, ratingInput, reviewInput, submittingRating, loadPackDetail, loadRatings]);

  const renderStars = (rating: number, size = 'h-4 w-4') => (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`${size} ${s <= rating ? 'fill-amber-400 text-amber-400' : 'text-gray-300 dark:text-slate-600'}`}
        />
      ))}
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <Package className="h-12 w-12 mx-auto mb-3 text-gray-400 opacity-50" />
          <p className="text-lg font-medium text-gray-600 dark:text-slate-400">Pack not found</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/packs')}>
            Browse Packs
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      {/* Breadcrumb */}
      <div className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <Link to="/packs" className="hover:text-gray-700 dark:hover:text-slate-300 inline-flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            Packs
          </Link>
          <span>/</span>
          <span className="text-gray-900 dark:text-white font-medium">{pack.name}</span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-start gap-5">
          <span className="text-5xl leading-none">{pack.icon || '📦'}</span>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{pack.name}</h1>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-gray-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <User className="h-4 w-4" />
                {pack.publisherName || 'Unknown'}
              </span>
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                Published {parseServerDate(pack.createdAt).toLocaleDateString()}
              </span>
              {pack.latestVersion && (
                <Badge variant="default" size="sm">v{pack.latestVersion}</Badge>
              )}
            </div>
          </div>
        </div>

        {/* Stats + Install */}
        <div className="flex flex-wrap items-center gap-6 p-4 rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            {renderStars(Math.round(pack.avgRating), 'h-5 w-5')}
            <span className="text-gray-700 dark:text-slate-300 font-medium">
              {pack.avgRating.toFixed(1)}
            </span>
            <span className="text-gray-500 dark:text-slate-400">({pack.ratingCount} ratings)</span>
          </div>
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-slate-400">
            <Download className="h-4 w-4" />
            <span>{pack.downloadCount} downloads</span>
          </div>
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-slate-400">
            <FileJson className="h-4 w-4" />
            <span>{pack.formCount} forms</span>
          </div>
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-slate-400">
            <Globe className="h-4 w-4" />
            <span>{pack.appCount} apps</span>
          </div>
          <div className="flex-1" />
          {installed ? (
            <Button variant="outline" disabled>
              <CheckCircle className="h-4 w-4 mr-1.5 text-green-500" />
              Installed
            </Button>
          ) : (
            <Button variant="primary" onClick={() => handleInstall()} isLoading={installing}>
              {!installing && <Package className="h-4 w-4 mr-1.5" />}
              {installing ? 'Installing...' : 'Install Pack'}
            </Button>
          )}
        </div>

        {/* Description */}
        {pack.description && (
          <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-2">About</h2>
            <p className="text-sm text-gray-600 dark:text-slate-400 leading-relaxed whitespace-pre-line">
              {pack.description}
            </p>
            {pack.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {pack.tags.map((tag) => (
                  <Badge key={tag} variant="default" size="sm">{tag}</Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Version History */}
        {pack.versions && pack.versions.length > 0 && (
          <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setVersionsExpanded((v) => !v)}
              className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white cursor-pointer w-full text-left"
            >
              {versionsExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Version History ({pack.versions.length})
            </button>
            {versionsExpanded && (
              <div className="mt-3 space-y-3">
                {pack.versions.map((v, i) => (
                  <div key={v.id} className="flex items-start gap-3 text-sm border-l-2 border-gray-200 dark:border-slate-700 pl-3">
                    <Badge variant={i === 0 ? 'success' : 'default'} size="sm">v{v.version}</Badge>
                    <div className="flex-1">
                      <span className="text-gray-500 dark:text-slate-400 text-xs">
                        {new Date(v.created_at).toLocaleDateString()} &middot; {v.form_count} forms, {v.app_count} apps{i === 0 ? ' · latest' : ''}
                      </span>
                      {v.changelog && (
                        <p className="text-gray-600 dark:text-slate-400 text-xs mt-0.5">{v.changelog}</p>
                      )}
                    </div>
                    {!installed && (
                      <button
                        onClick={() => handleInstall(v.id)}
                        disabled={installing}
                        className="flex-shrink-0 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50 cursor-pointer"
                      >
                        Install this version
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Ratings & Reviews */}
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 space-y-4">
          <h2 className="font-semibold text-gray-900 dark:text-white">Ratings & Reviews</h2>

          {/* Rating form */}
          <div className="p-3 rounded-lg bg-gray-50 dark:bg-slate-800/50 border border-gray-200 dark:border-slate-700">
            <p className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
              {userRating ? 'Update your rating' : 'Rate this pack'}
            </p>
            <div className="flex items-center gap-1 mb-2">
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRatingInput(s)}
                  onMouseEnter={() => setHoverRating(s)}
                  onMouseLeave={() => setHoverRating(0)}
                  aria-label={`Rate ${s} star${s === 1 ? '' : 's'}`}
                  aria-pressed={s === ratingInput}
                  className="cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <Star
                    aria-hidden="true"
                    className={`h-6 w-6 transition-colors ${
                      s <= (hoverRating || ratingInput)
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-gray-300 dark:text-slate-600'
                    }`}
                  />
                </button>
              ))}
            </div>
            <textarea
              value={reviewInput}
              onChange={(e) => setReviewInput(e.target.value)}
              placeholder="Write a review (optional)..."
              rows={3}
              className="w-full text-sm rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white p-2 resize-none focus:ring-1 focus:ring-primary-500"
            />
            <div className="flex justify-end mt-2">
              <Button
                size="sm"
                variant="primary"
                onClick={handleSubmitRating}
                disabled={!ratingInput}
                isLoading={submittingRating}
              >
                {userRating ? 'Update Rating' : 'Submit Rating'}
              </Button>
            </div>
          </div>

          {/* Reviews */}
          {ratings.length > 0 ? (
            <div className="space-y-3">
              {ratings.map((r) => (
                <div key={r.id} className="border-b border-gray-100 dark:border-slate-800 pb-3 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-gray-700 dark:text-slate-300">{r.userName}</span>
                    {renderStars(r.rating)}
                    <span className="text-xs text-gray-400 dark:text-slate-500">
                      {parseServerDate(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {r.review && (
                    <p className="mt-1 text-sm text-gray-600 dark:text-slate-400">{r.review}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-slate-500">No reviews yet. Be the first to rate this pack!</p>
          )}
        </div>
      </div>
    </div>
  );
}
