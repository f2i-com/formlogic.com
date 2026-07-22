import { useState, useEffect, useCallback } from 'react';
import { parseServerDate } from '../lib/utils';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  Star,
  Package,
  FileText,
  LayoutGrid,
  Calendar,
  User,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { PackIcon } from '../components/ui/PackIcon';
import { api, type CatalogPack, type PackVersionInfo, type PackRatingEntry, type PackData, type PackDescribeResult } from '../lib/api';
import { PackScreenshots } from '../components/builder/PackScreenshots';
import { TrustBadge, CapabilityReview } from '../components/builder/TrustBadge';
import { reviewableConnectorGrants } from '../lib/packTrust';
import { packHasCodeScreen, packHasLogicScript } from '../lib/packTrust';
import { toast } from '../stores/toastStore';
import { useFormStore } from '../stores/formStore';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import { useMarketplaceChrome } from '../lib/marketplaceChrome';

type PackDetail = CatalogPack & {
  versions: PackVersionInfo[];
  formTitles?: string[];
  appNames?: string[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function PackDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  useMarketplaceChrome();
  // Send anonymous visitors to sign in (preserving where they were) instead of
  // letting install/rate dead-end on an auth error.
  const goSignIn = useCallback(
    () => navigate(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`),
    [navigate]
  );

  const [pack, setPack] = useState<PackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [versionsExpanded, setVersionsExpanded] = useState(false);
  // Pre-install capability review (spec §30.1): the downloaded pack + server-computed trust/capabilities.
  const [consent, setConsent] = useState<{ dl: PackData; catalogId: string; versionId: string; review: PackDescribeResult | null } | null>(null);
  // APP-502: the connector grants the user has ticked to approve in the review.
  const [approvedGrants, setApprovedGrants] = useState<Set<string>>(new Set());

  // The shared Demo account has every pack pre-installed — treat it as "view the demo", never
  // "Installed"/"Install" (installs are blocked on the demo anyway).
  const isDemo = !!user?.isDemo;
  // Demo app(s) for this pack (by catalog slug) so any visitor can view it live.
  const [demoApps, setDemoApps] = useState<Array<{ slug: string; name: string }>>([]);
  const [launchingDemo, setLaunchingDemo] = useState(false);

  // Ratings
  const [ratings, setRatings] = useState<PackRatingEntry[]>([]);
  const [userRating, setUserRating] = useState<{ rating: number; review: string | null } | null>(null);
  const [hoverRating, setHoverRating] = useState(0);
  const [ratingInput, setRatingInput] = useState(0);
  const [reviewInput, setReviewInput] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);
  // With no reviews the ratings block collapses to one quiet line; this expands
  // the rating form for whoever wants to be first.
  const [showRatingForm, setShowRatingForm] = useState(false);

  const refreshForms = useFormStore((s) => s.refreshForms);
  const fetchApps = useAppStore((s) => s.fetchApps);

  useEffect(() => {
    document.title = pack ? `${pack.name} — FormLogic marketplace` : 'Marketplace — FormLogic';
  }, [pack]);

  useEffect(() => {
    if (!slug) return;
    // Guard against stale responses: if the user navigates slug A -> B while A's
    // requests are in flight, A must not clobber B's pack/ratings on resolve.
    let cancelled = false;
    const shouldApply = () => !cancelled;
    loadPackDetail(shouldApply);
    loadRatings(shouldApply);
    checkInstalled();
    // Find the demo app(s) installed from this pack on the shared Demo account (matched by catalog
    // slug) so signed-out + demo visitors can view it live.
    api.getDemoApps().then((r) => {
      if (cancelled) return;
      setDemoApps((r.data?.apps ?? [])
        .filter((a) => a.catalogSlug === slug && a.slug)
        .map((a) => ({ slug: a.slug, name: a.name })));
    }).catch(() => { /* demo may be disabled */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const launchDemo = useCallback(async (appSlug: string) => {
    if (launchingDemo) return;
    setLaunchingDemo(true);
    try {
      const res = await api.startDemo();
      if (res.error) { toast.error('Could not start the demo'); return; }
      window.open(`/app/${appSlug}`, '_blank', 'noopener'); // shares the demo cookie; keeps this tab
    } finally {
      setLaunchingDemo(false);
    }
  }, [launchingDemo]);

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

  // Import an already-downloaded pack (shared by the direct + consent-confirmed paths).
  // `approvedConnectorGrants` is set ONLY from the review panel (undefined = no review = all grants).
  const doImport = useCallback(async (dl: PackData, catalogId: string, versionId: string, approvedConnectorGrants?: string[]) => {
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
      } else {
        toast.error('Install failed', importResult.error || 'Unknown error');
      }
    } catch (err) {
      toast.error('Install failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setInstalling(false);
    }
  }, [refreshForms, fetchApps]);

  const handleInstall = useCallback(async (versionId?: string) => {
    if (!user) { goSignIn(); return; }
    if (!slug || installing) return;
    setInstalling(true);
    try {
      const dlResult = await api.downloadPack(slug, versionId);
      if (!dlResult.data?.pack) {
        toast.error('Failed to download pack');
        setInstalling(false);
        return;
      }
      const dl = dlResult.data.pack;
      // Capability review before installing: ask the server what this pack can do + its trust level.
      const review = (await api.describePack({ pack: dl })).data ?? null;
      const caps = review?.capabilities;
      const needsReview = packHasCodeScreen(dl) || packHasLogicScript(dl)
        || (!!caps && (caps.connectors.length > 0 || caps.permissions.length > 0 || caps.hasCustomLogic));
      if (needsReview) {
        // Default: every REVIEWABLE connector grant pre-approved (the user
        // unticks to reduce) — the same set import can actually strip.
        setApprovedGrants(new Set(caps ? reviewableConnectorGrants(caps) : []));
        setConsent({ dl, catalogId: dlResult.data.catalogId, versionId: dlResult.data.versionId, review });
        setInstalling(false);
        return;
      }
      await doImport(dl, dlResult.data.catalogId, dlResult.data.versionId);
    } catch (err) {
      toast.error('Install failed', err instanceof Error ? err.message : 'Unknown error');
      setInstalling(false);
    }
  }, [slug, installing, user, goSignIn, doImport]);

  const handleSubmitRating = useCallback(async () => {
    if (!user) { goSignIn(); return; }
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
  }, [slug, ratingInput, reviewInput, submittingRating, loadPackDetail, loadRatings, user, goSignIn]);

  const handleRemoveRating = useCallback(async () => {
    if (!slug || submittingRating || !userRating) return;
    setSubmittingRating(true);
    try {
      const result = await api.deletePackRating(slug);
      if (result.error) {
        toast.error('Failed to remove rating', typeof result.error === 'string' ? result.error : undefined);
        return;
      }
      toast.success('Rating removed');
      setUserRating(null);
      setRatingInput(0);
      setReviewInput('');
      await Promise.all([loadPackDetail(), loadRatings()]);
    } catch {
      toast.error('Failed to remove rating');
    } finally {
      setSubmittingRating(false);
    }
  }, [slug, submittingRating, userRating, loadPackDetail, loadRatings]);

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
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-slate-950">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-slate-950">
        <div className="text-center">
          <Package className="mx-auto mb-3 h-12 w-12 text-gray-400 opacity-50" />
          <p className="text-lg font-medium text-gray-600 dark:text-slate-400">Pack not found</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/packs')}>
            Back to marketplace
          </Button>
        </div>
      </div>
    );
  }

  const formTitles = pack.formTitles ?? [];
  const appNames = pack.appNames ?? [];

  return (
    <div className="min-h-screen overflow-x-clip bg-white dark:bg-slate-950 text-gray-900 dark:text-slate-50">
      {/* Breadcrumb */}
      <div className="border-b border-gray-100 dark:border-slate-800/60 bg-white/85 dark:bg-slate-950/75 backdrop-blur-xl">
        <div className="fl-mono mx-auto flex h-12 max-w-4xl items-center gap-2 px-4 text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 sm:px-6">
          <Link
            to="/packs"
            className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-gray-900 dark:hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Marketplace
          </Link>
          <span className="text-gray-300 dark:text-slate-700">/</span>
          <span className="truncate normal-case tracking-normal font-medium text-gray-900 dark:text-white">{pack.name}</span>
        </div>
      </div>

      {/* Header, on the landing page's blueprint-grid backdrop */}
      <div className="relative overflow-hidden">
        <div
          className="fl-grid pointer-events-none absolute inset-0"
          style={{
            maskImage: 'radial-gradient(ellipse 70% 95% at 50% 0%, #000 0%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse 70% 95% at 50% 0%, #000 0%, transparent 75%)',
          }}
        />
        <div className="pointer-events-none absolute -top-24 left-1/2 h-[320px] w-[700px] -translate-x-1/2 rounded-full bg-primary-600/10 opacity-70 blur-[110px]" />

        <div className="relative mx-auto max-w-4xl px-4 pt-10 pb-6 sm:px-6">
          <div className="flex items-start gap-5">
            <span
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/70 text-4xl leading-none shadow-sm"
              aria-hidden="true"
            >
              <PackIcon icon={pack.icon} className="h-8 w-8 text-primary-500" emojiClassName="text-4xl leading-none" />
            </span>
            <div className="min-w-0 flex-1">
              {pack.category && (
                <p className="fl-mono mb-1.5 text-[11px] uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400">
                  {pack.category}
                </p>
              )}
              <h1 className="fl-display text-3xl text-gray-900 dark:text-white sm:text-4xl">{pack.name}</h1>
              <div className="fl-mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500 dark:text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" aria-hidden="true" />
                  {pack.publisherName || 'Unknown'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                  Published {parseServerDate(pack.createdAt).toLocaleDateString()}
                </span>
                {pack.latestVersion && (
                  <span className="rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5">
                    v{pack.latestVersion}
                  </span>
                )}
                {/* Server-computed trust level (spec §30.1) — never derived on the client. */}
                <TrustBadge trust={pack.trustLevel || (pack.official ? 'official' : 'community')} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-6 px-4 pb-12 sm:px-6">
        {/* Dashboard preview(s) — one per app, aspect-true, click to enlarge */}
        <PackScreenshots
          shots={pack.screenshots?.length ? pack.screenshots : (pack.screenshot ? [{ label: pack.name, url: pack.screenshot }] : [])}
          maxHeight="max-h-[420px]"
        />

        {/* Stats + install. Zero-value social proof stays hidden: no star row or
            download count until the pack has actually been rated/installed. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
          {pack.ratingCount > 0 && (
            <div className="flex items-center gap-2">
              {renderStars(Math.round(pack.avgRating))}
              <span className="fl-mono text-sm font-medium text-gray-700 dark:text-slate-300">
                {pack.avgRating.toFixed(1)}
              </span>
              <span className="fl-mono text-xs text-gray-400 dark:text-slate-500">
                ({plural(pack.ratingCount, 'rating')})
              </span>
            </div>
          )}
          {pack.downloadCount > 0 && (
            <div className="fl-mono flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>{plural(pack.downloadCount, 'install')}</span>
            </div>
          )}
          <div className="fl-mono flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
            <FileText className="h-4 w-4" aria-hidden="true" />
            <span>{plural(pack.formCount, 'form')}</span>
          </div>
          <div className="fl-mono flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
            <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            <span>{plural(pack.appCount, 'app')}</span>
          </div>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Only offer the live demo to signed-out / demo visitors — starting the demo swaps the
                auth cookie, which would sign a real logged-in user out of their own account. */}
            {(!user || isDemo) && demoApps.map((d) => (
              <Button key={d.slug} variant="outline" onClick={() => launchDemo(d.slug)} isLoading={launchingDemo}>
                {!launchingDemo && <ExternalLink className="mr-1.5 h-4 w-4" />}
                {demoApps.length > 1 ? `View ${d.name} demo` : 'View demo'}
              </Button>
            ))}
            {/* The demo account has everything pre-installed — offer only the live view, not install. */}
            {!isDemo && (installed ? (
              <Button variant="outline" disabled>
                <CheckCircle className="mr-1.5 h-4 w-4 text-green-500" />
                Installed
              </Button>
            ) : (
              <Button variant="primary" onClick={() => handleInstall()} isLoading={installing && !consent}>
                {!installing && <Package className="mr-1.5 h-4 w-4" />}
                {installing && !consent ? 'Installing…' : (user ? 'Install pack' : 'Sign in to install')}
              </Button>
            ))}
          </div>
        </div>

        {/* Pre-install capability review + server-computed trust (spec §30.1) */}
        {consent && (
          <div className="space-y-3 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5 p-4 sm:p-5">
            <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
              <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>Review what this package can do before installing.{(packHasCodeScreen(consent.dl) || packHasLogicScript(consent.dl)) && ' It includes code (custom screens and/or backend scripts) that runs with access to data you are permitted to see.'}</span>
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
                  const connectorGrants = consent.review
                    ? reviewableConnectorGrants(consent.review.capabilities)
                    : [];
                  doImport(
                    consent.dl,
                    consent.catalogId,
                    consent.versionId,
                    connectorGrants.length > 0 ? [...approvedGrants] : undefined,
                  );
                }}
                isLoading={installing}
              >
                {!installing && <Package className="mr-1.5 h-4 w-4" />}
                {installing ? 'Installing…' : 'Install'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConsent(null)} disabled={installing}>Cancel</Button>
            </div>
          </div>
        )}

        {/* Description */}
        {pack.description && (
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">About</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-gray-600 dark:text-slate-400">
              {pack.description}
            </p>
            {pack.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {pack.tags.map((tag) => (
                  <span
                    key={tag}
                    className="fl-mono rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5 text-[11px] text-gray-500 dark:text-slate-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* What's inside — the actual forms and apps this pack installs */}
        {(appNames.length > 0 || formTitles.length > 0) && (
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">What’s inside</h2>
            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              {appNames.length > 0 && (
                <div>
                  <p className="fl-mono mb-2.5 text-[11px] uppercase tracking-[0.2em] text-gray-400 dark:text-slate-500">
                    {plural(appNames.length, 'app')}
                  </p>
                  <ul className="space-y-2">
                    {appNames.map((name, i) => (
                      <li key={`${name}-${i}`} className="flex items-start gap-2.5 text-sm text-gray-700 dark:text-slate-300">
                        <LayoutGrid className="mt-0.5 h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                        <span className="min-w-0 break-words">{name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {formTitles.length > 0 && (
                <div>
                  <p className="fl-mono mb-2.5 text-[11px] uppercase tracking-[0.2em] text-gray-400 dark:text-slate-500">
                    {plural(formTitles.length, 'form')}
                  </p>
                  <ul className="space-y-2">
                    {formTitles.map((title, i) => (
                      <li key={`${title}-${i}`} className="flex items-start gap-2.5 text-sm text-gray-700 dark:text-slate-300">
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                        <span className="min-w-0 break-words">{title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Version history */}
        {pack.versions && pack.versions.length > 0 && (
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            <button
              type="button"
              onClick={() => setVersionsExpanded((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-2 rounded text-left font-semibold text-gray-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {versionsExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Version history ({pack.versions.length})
            </button>
            {versionsExpanded && (
              <div className="mt-3 space-y-3">
                {pack.versions.map((v, i) => (
                  <div key={v.id} className="flex items-start gap-3 border-l-2 border-gray-200 dark:border-slate-700 pl-3 text-sm">
                    <Badge variant={i === 0 ? 'success' : 'default'} size="sm">v{v.version}</Badge>
                    <div className="flex-1">
                      <span className="fl-mono text-xs text-gray-500 dark:text-slate-400">
                        {new Date(v.created_at).toLocaleDateString()} &middot; {v.form_count} forms, {v.app_count} apps{i === 0 ? ' · latest' : ''}
                      </span>
                      {v.changelog && (
                        <p className="mt-0.5 text-xs text-gray-600 dark:text-slate-400">{v.changelog}</p>
                      )}
                    </div>
                    {!installed && (
                      <button
                        onClick={() => handleInstall(v.id)}
                        disabled={installing}
                        className="flex-shrink-0 cursor-pointer rounded text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
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

        {/* Ratings & reviews. With no reviews this collapses to a single quiet
            line so an empty pack page isn't dominated by an empty ratings block. */}
        {ratings.length > 0 || userRating || showRatingForm ? (
          <div className="space-y-4 rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">Ratings and reviews</h2>

            {/* Rating form */}
            <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-3">
              <p className="mb-2 text-sm font-medium text-gray-700 dark:text-slate-300">
                {userRating ? 'Update your rating' : 'Rate this pack'}
              </p>
              <div className="mb-2 flex items-center gap-1">
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
                placeholder="Write a review (optional)…"
                rows={3}
                className="w-full resize-none rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-sm text-gray-900 dark:text-white focus:ring-1 focus:ring-primary-500"
              />
              <div className="mt-2 flex justify-end gap-2">
                {userRating && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleRemoveRating}
                    disabled={submittingRating}
                  >
                    Remove
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handleSubmitRating}
                  disabled={!ratingInput}
                  isLoading={submittingRating}
                >
                  {userRating ? 'Update rating' : 'Submit rating'}
                </Button>
              </div>
            </div>

            {/* Reviews */}
            {ratings.length > 0 ? (
              <div className="space-y-3">
                {ratings.map((r) => (
                  <div key={r.id} className="border-b border-gray-100 dark:border-slate-800 pb-3 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-slate-300">{r.userName}</span>
                      {renderStars(r.rating)}
                      <span className="fl-mono text-xs text-gray-400 dark:text-slate-500">
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
              <p className="text-sm text-gray-400 dark:text-slate-500">No reviews yet.</p>
            )}
          </div>
        ) : (
          <p className="px-1 text-sm text-gray-400 dark:text-slate-500">
            No reviews yet.{' '}
            <button
              type="button"
              onClick={() => (user ? setShowRatingForm(true) : goSignIn())}
              className="cursor-pointer rounded text-primary-600 dark:text-primary-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              Be the first to review this pack
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
