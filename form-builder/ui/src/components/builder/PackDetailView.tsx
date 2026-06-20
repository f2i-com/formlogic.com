import { useState, useEffect, useCallback } from 'react';
import { parseServerDate } from '../../lib/utils';
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
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { api, type CatalogPack, type PackVersionInfo, type PackRatingEntry } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';
import { useAppStore } from '../../stores/appStore';

interface PackDetailViewProps {
  slug: string;
  onBack: () => void;
  onInstalled?: () => void;
  installedCatalogIds?: Set<string>;
}

export function PackDetailView({ slug, onBack, onInstalled, installedCatalogIds }: PackDetailViewProps) {
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
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const result = await api.getPackDetail(slug);
        if (!cancelled && result.data?.pack) {
          setPack(result.data.pack);
        }
      } catch {
        if (!cancelled) toast.error('Failed to load pack details');
      } finally {
        if (!cancelled) setLoading(false);
      }

      try {
        const result = await api.getPackRatings(slug);
        if (!cancelled && result.data) {
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
    }

    load();
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (pack && installedCatalogIds) {
      setInstalled(installedCatalogIds.has(pack.id));
    }
  }, [pack, installedCatalogIds]);

  const loadPackDetail = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getPackDetail(slug);
      if (result.data?.pack) {
        setPack(result.data.pack);
      }
    } catch {
      toast.error('Failed to load pack details');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const loadRatings = useCallback(async () => {
    try {
      const result = await api.getPackRatings(slug);
      if (result.data) {
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

  const handleInstall = useCallback(async () => {
    if (!pack || installing) return;
    setInstalling(true);
    try {
      const dlResult = await api.downloadPack(slug);
      if (!dlResult.data?.pack) {
        toast.error('Failed to download pack data');
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
        onInstalled?.();
      } else {
        toast.error('Install failed', importResult.error || 'Unknown error');
      }
    } catch (err) {
      toast.error('Install failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setInstalling(false);
    }
  }, [pack, slug, installing, refreshForms, fetchApps, onInstalled]);

  const handleSubmitRating = useCallback(async () => {
    if (!ratingInput || submittingRating) return;
    setSubmittingRating(true);
    try {
      const result = await api.ratePack(slug, ratingInput, reviewInput || undefined);
      if (result.error || !result.data?.success) {
        // api.request resolves (not throws) on non-2xx, so handle result.error here
        // or the user gets no feedback that the rating failed.
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-gray-500 dark:text-slate-400">Pack not found.</p>
        <Button variant="outline" size="sm" onClick={onBack} className="mt-4">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

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

  return (
    <div className="space-y-4">
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 cursor-pointer"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to marketplace
      </button>

      {/* Header */}
      <div className="flex items-start gap-4">
        <span className="text-4xl leading-none">{pack.icon || '📦'}</span>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">{pack.name}</h2>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <User className="h-3 w-3" />
              {pack.publisherName || 'Unknown'}
            </span>
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {parseServerDate(pack.createdAt).toLocaleDateString()}
            </span>
            {pack.latestVersion && (
              <Badge variant="default" size="sm">v{pack.latestVersion}</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          {renderStars(Math.round(pack.avgRating))}
          <span className="text-gray-600 dark:text-slate-400">
            {pack.avgRating.toFixed(1)} ({pack.ratingCount})
          </span>
        </div>
        <div className="flex items-center gap-1 text-gray-500 dark:text-slate-400">
          <Download className="h-3.5 w-3.5" />
          <span>{pack.downloadCount} downloads</span>
        </div>
        <div className="flex items-center gap-1 text-gray-500 dark:text-slate-400">
          <FileJson className="h-3.5 w-3.5" />
          <span>{pack.formCount} forms</span>
        </div>
        <div className="flex items-center gap-1 text-gray-500 dark:text-slate-400">
          <Globe className="h-3.5 w-3.5" />
          <span>{pack.appCount} apps</span>
        </div>
      </div>

      {/* Install button */}
      <div>
        {installed ? (
          <Button variant="outline" disabled>
            <CheckCircle className="h-4 w-4 mr-1.5 text-green-500" />
            Installed
          </Button>
        ) : (
          <Button variant="primary" onClick={handleInstall} isLoading={installing}>
            {!installing && <Package className="h-4 w-4 mr-1.5" />}
            {installing ? 'Installing...' : 'Install Pack'}
          </Button>
        )}
      </div>

      {/* Description */}
      {pack.description && (
        <p className="text-sm text-gray-600 dark:text-slate-400 leading-relaxed">
          {pack.description}
        </p>
      )}

      {/* Tags */}
      {pack.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pack.tags.map((tag) => (
            <Badge key={tag} variant="default" size="sm">{tag}</Badge>
          ))}
        </div>
      )}

      {/* Version History */}
      {pack.versions && pack.versions.length > 0 && (
        <div className="border-t border-gray-200 dark:border-slate-800 pt-3">
          <button
            type="button"
            onClick={() => setVersionsExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-slate-300 cursor-pointer"
          >
            {versionsExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Version History ({pack.versions.length})
          </button>
          {versionsExpanded && (
            <div className="mt-2 space-y-2 ml-5">
              {pack.versions.map((v) => (
                <div key={v.id} className="text-xs text-gray-600 dark:text-slate-400">
                  <div className="flex items-center gap-2">
                    <Badge variant="default" size="sm">v{v.version}</Badge>
                    <span>{new Date(v.created_at).toLocaleDateString()}</span>
                    <span className="text-gray-400 dark:text-slate-500">
                      {v.form_count} forms, {v.app_count} apps
                    </span>
                  </div>
                  {v.changelog && (
                    <p className="mt-0.5 ml-0.5 text-gray-500 dark:text-slate-500">{v.changelog}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Ratings & Reviews */}
      <div className="border-t border-gray-200 dark:border-slate-800 pt-3 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Ratings & Reviews</h3>

        {/* User rating form */}
        <div className="p-3 rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
          <p className="text-xs font-medium text-gray-700 dark:text-slate-300 mb-2">
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
                  className={`h-5 w-5 transition-colors ${
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
            rows={2}
            className="w-full text-xs rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white p-2 resize-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          />
          <div className="flex justify-end mt-2">
            <Button
              size="sm"
              variant="primary"
              onClick={handleSubmitRating}
              disabled={!ratingInput}
              isLoading={submittingRating}
            >
              {userRating ? 'Update' : 'Submit'}
            </Button>
          </div>
        </div>

        {/* Reviews list */}
        {ratings.length > 0 ? (
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {ratings.map((r) => (
              <div key={r.id} className="text-xs border-b border-gray-100 dark:border-slate-800 pb-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-700 dark:text-slate-300">{r.userName}</span>
                  {renderStars(r.rating, 'h-3 w-3')}
                  <span className="text-gray-400 dark:text-slate-500">
                    {parseServerDate(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
                {r.review && (
                  <p className="mt-0.5 text-gray-500 dark:text-slate-400">{r.review}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400 dark:text-slate-500">No reviews yet.</p>
        )}
      </div>
    </div>
  );
}
