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
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { PackIcon } from '../ui/PackIcon';
import { api, type CatalogPack, type PackVersionInfo, type PackRatingEntry, type PackData, type PackDescribeResult } from '../../lib/api';
import { packHasCodeScreen, packHasLogicScript } from '../../lib/packTrust';
import { PackScreenshots } from './PackScreenshots';
import { TrustBadge, CapabilityReview } from './TrustBadge';
import { reviewableConnectorGrants } from '../../lib/packTrust';
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
  // Pre-install capability review: the downloaded pack + its server-computed trust/capabilities,
  // held so the user can review what will be installed BEFORE committing.
  const [consent, setConsent] = useState<{ dl: PackData; catalogId: string; versionId: string; review: PackDescribeResult | null } | null>(null);
  // APP-502: the connector grants the user has ticked to approve in the review.
  const [approvedGrants, setApprovedGrants] = useState<Set<string>>(new Set());

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

  // Import the already-downloaded pack (shared by the direct + consent-confirmed paths).
  // SAFE-001: `approvedConnectorGrants` is ALWAYS explicit — the reviewed set from the consent
  // panel, or [] when the server review showed nothing to approve. The server fails closed without it.
  const doImport = useCallback(async (dl: PackData, catalogId: string, versionId: string, approvedConnectorGrants: string[]) => {
    setInstalling(true);
    try {
      const importResult = await api.importPack(dl, { catalogId, versionId, approvedConnectorGrants });
      if (importResult.data) {
        setInstalled(true);
        setConsent(null);
        const withheld = importResult.data.withheldGrants ?? [];
        toast.success(
          'Pack installed',
          `Imported ${importResult.data.forms.length} form(s) and ${importResult.data.apps.length} app(s).`
            + (withheld.length > 0 ? ` ${withheld.length} connector grant(s) were not approved.` : '')
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
  }, [refreshForms, fetchApps, onInstalled]);

  const handleInstall = useCallback(async () => {
    if (!pack || installing) return;
    setInstalling(true);
    try {
      const dlResult = await api.downloadPack(slug);
      if (!dlResult.data?.pack) {
        toast.error('Failed to download pack data');
        setInstalling(false);
        return;
      }
      const dl = dlResult.data.pack;
      // Capability review: ask the server what this pack can do + its trust level (spec §30.1).
      // SAFE-001: the review is MANDATORY — if it fails there is no reviewed grant set to send,
      // so the install is blocked (previously a failed describe fell through and installed with
      // every requested grant active).
      const reviewResult = await api.describePack({ pack: dl });
      const review = reviewResult.data ?? null;
      if (!review) {
        toast.error(
          'Install blocked',
          `The capability review failed${typeof reviewResult.error === 'string' && reviewResult.error ? ` (${reviewResult.error})` : ''} — try again.`
        );
        setInstalling(false);
        return;
      }
      const caps = review.capabilities;
      // Show the consent panel when the pack carries code OR declares connectors/permissions —
      // so the reviewer sees the full capability surface BEFORE committing. Plain no-code packs install directly.
      const needsReview = packHasCodeScreen(dl) || packHasLogicScript(dl)
        || caps.connectors.length > 0 || caps.permissions.length > 0 || caps.hasCustomLogic;
      if (needsReview) {
        // Default: every REVIEWABLE connector grant pre-approved (the user
        // unticks to reduce). The reviewable set is the server's connectorGrants
        // — exactly what import can strip — not flow-declared connector access.
        setApprovedGrants(new Set(reviewableConnectorGrants(caps)));
        setConsent({ dl, catalogId: dlResult.data.catalogId, versionId: dlResult.data.versionId, review });
        setInstalling(false); // wait for the user to confirm from the panel
        return;
      }
      // Nothing reviewable → an explicit empty approval (the server still requires the array).
      await doImport(dl, dlResult.data.catalogId, dlResult.data.versionId, []);
    } catch (err) {
      toast.error('Install failed', err instanceof Error ? err.message : 'Unknown error');
      setInstalling(false);
    }
  }, [pack, slug, installing, doImport]);

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
        <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-primary-50 dark:bg-primary-500/10" aria-hidden="true">
          <PackIcon icon={pack.icon} className="h-6 w-6 text-primary-600 dark:text-primary-400" emojiClassName="text-4xl leading-none" />
        </span>
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
            {/* Server-computed trust level (spec §30.1) — never derived on the client. */}
            <TrustBadge trust={pack.trustLevel || (pack.official ? 'official' : 'community')} />
          </div>
        </div>
      </div>

      {/* Dashboard preview(s) — one per app, click to enlarge */}
      <PackScreenshots
        shots={pack.screenshots?.length ? pack.screenshots : (pack.screenshot ? [{ label: pack.name, url: pack.screenshot }] : [])}
        maxHeight="max-h-72"
      />

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

      {/* Install button + pre-install capability review */}
      {consent ? (
        <div className="space-y-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5 p-3">
          <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
            <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>Review what this package can do before installing. {(packHasCodeScreen(consent.dl) || packHasLogicScript(consent.dl)) && 'It includes code (custom screens and/or backend scripts) that runs with access to data you are permitted to see.'}</span>
          </div>
          {consent.review && (() => {
            const connectorGrants = reviewableConnectorGrants(consent.review.capabilities);
            return (
              <CapabilityReview
                caps={consent.review.capabilities}
                trust={consent.review.trust}
                vendorSigning={consent.review.vendorSigning}
                selectedGrants={connectorGrants.length > 0 ? approvedGrants : undefined}
                onToggleGrant={connectorGrants.length > 0 ? (grant, next) => {
                  setApprovedGrants((prev) => {
                    const nextSet = new Set(prev);
                    if (next) nextSet.add(grant); else nextSet.delete(grant);
                    return nextSet;
                  });
                } : undefined}
              />
            );
          })()}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                // SAFE-001: always an explicit array — the ticked set when grants were reviewable,
                // [] otherwise. The server rejects an install without it.
                const connectorGrants = consent.review
                  ? reviewableConnectorGrants(consent.review.capabilities)
                  : [];
                doImport(
                  consent.dl,
                  consent.catalogId,
                  consent.versionId,
                  connectorGrants.length > 0 ? [...approvedGrants] : [],
                );
              }}
              isLoading={installing}
            >
              {!installing && <Package className="h-4 w-4 mr-1.5" />}
              {installing ? 'Installing...' : 'Install'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConsent(null)} disabled={installing}>Cancel</Button>
          </div>
        </div>
      ) : (
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
      )}

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
