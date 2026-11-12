import { downloadPackProjects } from '../lib/packProjectDownload';
import { starterCatalog } from '../lib/starterCatalog';
import '../styles/landing-v2.css';
import '../styles/landing-refresh.css';
import { MarketplaceLayout } from '../components/layout/MarketplaceLayout';
import { PageBody } from '../components/layout/PageBody';
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { parseServerDate, cn } from '../lib/utils';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
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
import { LoadFailure } from '../components/ui/LoadFailure';
import { Badge } from '../components/ui/Badge';
import { PackIcon } from '../components/ui/PackIcon';
import { Panel } from '../components/ui/Panel';
import { api, type CatalogPack, type PackVersionInfo, type PackRatingEntry, type PackData, type PackDescribeResult } from '../lib/api';
import { PackScreenshots } from '../components/builder/PackScreenshots';
import { TrustBadge, CapabilityReview } from '../components/builder/TrustBadge';
import { reviewableConnectorGrants } from '../lib/packTrust';
import { packHasCodeScreen, packHasLogicScript } from '../lib/packTrust';
import { toast } from '../stores/toastStore';
import { useFormStore } from '../stores/formStore';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import { useInstalledNodeStore } from '../stores/installedNodeStore';
import { useMarketplaceChrome } from '../lib/marketplaceChrome';
import { deferEffect } from '../lib/deferredEffect';

type PackDetail = CatalogPack & {
  versions: PackVersionInfo[];
  formTitles?: string[];
  appNames?: string[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function PackDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  return <PackDetailContent key={slug} />;
}

function PackDetailContent() {
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
  const [bundledPreview, setBundledPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [downloadingSources, setDownloadingSources] = useState(false);
  const [versionsExpanded, setVersionsExpanded] = useState(false);
  // Pre-install capability review (spec §30.1): the downloaded pack + server-computed trust/capabilities.
  const [consent, setConsent] = useState<{ dl: PackData; catalogId: string | null; versionId: string | null; review: PackDescribeResult | null; planId?: string; planDigest?: string } | null>(null);
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
    setLoading(true); setPack(null); setBundledPreview(false);
    try {
      const result = await api.getPackDetail(slug);
      if (shouldApply()) {
        if (result.data?.pack) {
          setPack(result.data.pack);
          setLoadError(null);
        } else if (starterCatalog.some(pack => pack.slug === slug)) {
          setPack(starterCatalog.find(pack => pack.slug === slug)!); setBundledPreview(true); setLoadError(null);
        } else if (result.status === 404) {
          // A genuine 404 is the only case that means "this template doesn't exist".
          setLoadError(null);
        } else {
          setLoadError(typeof result.error === 'string' ? result.error : 'Please try again.');
        }
      }
    } catch (e) {
      // Silently failing rendered "Pack not found" — asserting the template does not
      // exist when in fact we could not reach the server.
      if (shouldApply()) setLoadError(e instanceof Error ? e.message : 'Please try again.');
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

  const ratingsSlug = pack && !pack.folderSource ? pack.slug : null;
  useEffect(() => deferEffect(() => {
    if (!ratingsSlug) return;
    let cancelled = false;
    void loadRatings(() => !cancelled);
    return () => { cancelled = true; };
  }), [ratingsSlug, loadRatings]);

  const checkInstalled = useCallback(async () => {
    try {
      const result = await api.getInstalledPacks();
      const installs = result.data?.installations ?? [];
      if (pack) {
        setInstalled(installs.some((i) => i.catalogId === pack.id || (pack.folderSource === true && i.packId === pack.slug)));
      }
    } catch {
      // silently fail
    }
  }, [pack]);

  useEffect(() => deferEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const shouldApply = () => !cancelled;
    void loadPackDetail(shouldApply);
    api.getDemoApps().then((r) => {
      if (cancelled) return;
      setDemoApps((r.data?.apps ?? [])
        .filter((a) => a.catalogSlug === slug && a.slug)
        .map((a) => ({ slug: a.slug, name: a.name })));
    }).catch(() => { /* demo may be disabled */ });
    return () => { cancelled = true; };
  }), [slug, loadPackDetail, loadRatings]);

  useEffect(() => {
    if (pack) return deferEffect(() => { void checkInstalled(); });
  }, [pack, checkInstalled]);

  // Import an already-downloaded pack (shared by the direct + consent-confirmed paths).
  // SAFE-001: `approvedConnectorGrants` is ALWAYS explicit — the reviewed set from the consent
  // panel, or [] when the server review showed nothing to approve. The server fails closed without it.
  const doImport = useCallback(async (dl: PackData, catalogId: string | null, versionId: string | null, approvedConnectorGrants: string[], planId?: string, planDigest?: string) => {
    setInstalling(true);
    try {
      // MKT-601: an Application Package v2 aggregate installs through the install-plan lane,
      // exactly as it does in the Packs modal. This page used to call importPack for
      // everything, which a v2 aggregate refuses outright — the two surfaces had drifted, and
      // whichever one you happened to use decided whether a package could be installed.
      const importResult = planId && planDigest
        ? await api.confirmPackageInstallPlan(planId, { planDigest, approvedConnectorGrants })
        : await api.importPack(dl, { catalogId, versionId, approvedConnectorGrants });
      if (importResult.data) {
        setInstalled(true);
        setConsent(null);
        const withheld = importResult.data.withheldGrants ?? [];
        const withheldNote = withheld.length > 0 ? ` ${withheld.length} connector grant(s) were not approved.` : '';
        if (planId) {
          toast.success('Extension installed', `Its nodes are available in the flow editor.${withheldNote}`);
          // The flow editor loads the store once a session, so a new node would stay out of
          // the palette until a reload.
          void useInstalledNodeStore.getState().refresh();
        } else {
          toast.success('Pack installed', `Imported ${importResult.data.forms.length} form(s) and ${importResult.data.apps.length} app(s).${withheldNote}`);
        }
        await Promise.all([refreshForms(), fetchApps()]);
      } else {
        toast.error('Install failed', importResult.error || 'Unknown error');
        // A plan is single-use, so Install on this panel could only fail from here on.
        if (planId) setConsent(null);
      }
    } catch (err) {
      toast.error('Install failed', err instanceof Error ? err.message : 'Unknown error');
      if (planId) setConsent(null);
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

      // MKT-601: a v2 aggregate's review IS a proposed install plan (the server stores the
      // exact reviewed bytes and the confirm is digest-bound), so the review and the install
      // cannot diverge. Same lane the Packs modal uses.
      if ((dl as unknown as { formatVersion?: number }).formatVersion === 2) {
        const proposal = await api.proposePackageInstallPlan({ package: dl as unknown as Record<string, unknown> });
        if (!proposal.data) {
          toast.error(
            'Install blocked',
            typeof proposal.error === 'string' && proposal.error ? proposal.error : 'The install review failed — try again.'
          );
          setInstalling(false);
          return;
        }
        setApprovedGrants(new Set(reviewableConnectorGrants(proposal.data.capabilities)));
        setConsent({
          dl,
          catalogId: dlResult.data.catalogId,
          versionId: dlResult.data.versionId,
          review: { trust: proposal.data.trust, capabilities: proposal.data.capabilities } as PackDescribeResult,
          planId: proposal.data.planId,
          planDigest: proposal.data.planDigest,
        });
        setInstalling(false);
        return;
      }

      // Capability review before installing: ask the server what this pack can do + its trust level.
      // SAFE-001: the review is MANDATORY — a failed describe blocks the install (previously it fell
      // through and installed with every requested grant active).
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
      const needsReview = packHasCodeScreen(dl) || packHasLogicScript(dl)
        || caps.connectors.length > 0 || caps.permissions.length > 0 || caps.hasCustomLogic;
      if (needsReview) {
        // Default: every REVIEWABLE connector grant pre-approved (the user
        // unticks to reduce) — the same set import can actually strip.
        setApprovedGrants(new Set(reviewableConnectorGrants(caps)));
        setConsent({ dl, catalogId: dlResult.data.catalogId, versionId: dlResult.data.versionId, review });
        setInstalling(false);
        return;
      }
      // Nothing reviewable → an explicit empty approval (the server still requires the array).
      await doImport(dl, dlResult.data.catalogId, dlResult.data.versionId, []);
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

  // Signed in (the demo account too) the page stands inside the workspace shell and follows the
  // workspace's rules (docs/WORKSPACE_PAGES.md); nobody signed in sees the public marketplace
  // page. The two differ in layout alone: every control below is the same one in both.
  const workspace = !!user;
  // The workspace Header's way back to the catalogue (the public page has its own breadcrumb).
  const backToTemplates = { onClick: () => navigate('/packs'), label: 'Back to templates' };

  if (loading) {
    return (
      <MarketplaceLayout back={backToTemplates}><div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" role="status" aria-label="Loading template" />
      </div></MarketplaceLayout>
    );
  }

  if (!pack) {
    return (
      <MarketplaceLayout back={backToTemplates}><div className="flex min-h-[50vh] items-center justify-center px-4">
        {loadError ? (
          <div className="w-full max-w-md">
            <LoadFailure
              title="We couldn't load this template"
              message={loadError}
              onRetry={() => { setLoadError(null); void loadPackDetail(); }}
            />
            <div className="mt-4 text-center">
              <Button variant="outline" onClick={() => navigate('/packs')}>Back to templates</Button>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <Package className="mx-auto mb-3 h-12 w-12 text-gray-400 opacity-50" />
            <p className="text-lg font-medium text-gray-600 dark:text-slate-400">Template not found</p>
            <Button variant="outline" className="mt-4" onClick={() => navigate('/packs')}>
              Back to templates
            </Button>
          </div>
        )}
      </div></MarketplaceLayout>
    );
  }

  const publishedDate = parseServerDate(pack.createdAt);
  const hasPublishedDate = Number.isFinite(publishedDate.getTime());
  const formTitles = pack.formTitles ?? [];
  const appNames = pack.appNames ?? [];
  const shots = pack.screenshots?.length ? pack.screenshots : (pack.screenshot ? [{ label: pack.name, url: pack.screenshot }] : []);
  // Server-computed trust level (spec §30.1) — never derived on the client.
  const trust = pack.trustLevel || (pack.official ? 'official' : 'community');
  // The public page sets its small print in the marketing mono face; the workspace keeps its own.
  const mono = workspace ? 'tabular-nums' : 'fl-mono';
  // A finger's height for the workspace's buttons on a phone.
  const touch = workspace ? 'max-sm:min-h-11' : undefined;

  // ── The page's controls, the same in both layouts ──────────────────────────────────────────

  // Only offer the live demo to signed-out / demo visitors — starting the demo swaps the
  // auth cookie, which would sign a real logged-in user out of their own account.
  const demoButtons = (!user || isDemo) && demoApps.map((d) => (
    <Button key={d.slug} variant="outline" className={touch} onClick={() => launchDemo(d.slug)} isLoading={launchingDemo}>
      {!launchingDemo && <ExternalLink className="mr-1.5 h-4 w-4" />}
      {demoApps.length > 1 ? `View ${d.name} demo` : 'View demo'}
    </Button>
  ));
  const sourcesButton = pack.folderSource && (
    <Button variant="outline" className={touch} isLoading={downloadingSources} onClick={async () => {
      if (downloadingSources) return;
      setDownloadingSources(true);
      try { await downloadPackProjects(pack.slug); }
      catch (error) { toast.error('Download failed', error instanceof Error ? error.message : 'Please try again.'); }
      finally { setDownloadingSources(false); }
    }}>Download app sources</Button>
  );
  // The demo account has everything pre-installed — offer only the live view, not install.
  const installButton = !isDemo && (installed ? (
    <Button variant="outline" className={touch} disabled>
      <CheckCircle className="mr-1.5 h-4 w-4 text-green-500" />
      Installed
    </Button>
  ) : (
    <Button variant="primary" className={touch} onClick={() => handleInstall()} isLoading={installing && !consent}>
      {!installing && <Package className="mr-1.5 h-4 w-4" />}
      {installing && !consent ? 'Installing…' : (user ? 'Install pack' : 'Sign in to install')}
    </Button>
  ));

  // Pre-install capability review + server-computed trust (spec §30.1)
  const consentPanel = consent && (
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
              consent.planId,
              consent.planDigest,
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
  );

  // What's inside — the actual forms and apps this pack installs
  const insideHeading = workspace
    ? 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400'
    : 'fl-mono mb-2.5 text-[11px] uppercase tracking-[0.2em] text-gray-400 dark:text-slate-500';
  const insideLists = (
    <>
      {appNames.length > 0 && (
        <div>
          <p className={insideHeading}>
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
          <p className={insideHeading}>
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
    </>
  );

  // Version history
  const hasVersions = !!pack.versions && pack.versions.length > 0;
  const versionsToggle = hasVersions && (
    <button
      type="button"
      onClick={() => setVersionsExpanded((v) => !v)}
      aria-expanded={versionsExpanded}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded text-left font-semibold text-gray-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        workspace && 'text-sm',
      )}
    >
      {versionsExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      Version history ({pack.versions.length})
    </button>
  );
  const versionRows = hasVersions && versionsExpanded && (
    <div className={cn('space-y-3', !workspace && 'mt-3')}>
      {pack.versions.map((v, i) => (
        <div key={v.id} className="flex items-start gap-3 border-l-2 border-gray-200 dark:border-slate-700 pl-3 text-sm">
          <Badge variant={i === 0 ? 'success' : 'default'} size="sm">v{v.version}</Badge>
          <div className="flex-1">
            <span className={cn(mono, 'text-xs text-gray-500 dark:text-slate-400')}>
              {parseServerDate(v.created_at).toLocaleDateString()} &middot; {v.form_count} forms, {v.app_count} apps{i === 0 ? ' · latest' : ''}
            </span>
            {v.changelog && (
              <p className="mt-0.5 text-xs text-gray-600 dark:text-slate-400">{v.changelog}</p>
            )}
          </div>
          {!installed && (
            <button
              onClick={() => handleInstall(v.id)}
              disabled={installing}
              className={cn(
                'flex-shrink-0 cursor-pointer rounded text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                workspace && 'max-sm:-my-3 max-sm:min-h-11 max-sm:px-1',
              )}
            >
              Install this version
            </button>
          )}
        </div>
      ))}
    </div>
  );

  // Ratings & reviews. With no reviews this collapses to a single quiet
  // line so an empty pack page isn't dominated by an empty ratings block.
  const quiet = workspace ? 'text-gray-500 dark:text-slate-400' : 'text-gray-400 dark:text-slate-500';
  const showRatings = !pack.folderSource;
  const ratingsOpen = ratings.length > 0 || !!userRating || showRatingForm;
  const ratingForm = (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-3">
      <p className="mb-2 text-sm font-medium text-gray-700 dark:text-slate-300">
        {userRating ? 'Update your rating' : 'Rate this pack'}
      </p>
      <div className={cn('mb-2 flex items-center', workspace ? 'gap-1 max-sm:gap-0' : 'gap-1')}>
        {[1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setRatingInput(s)}
            onMouseEnter={() => setHoverRating(s)}
            onMouseLeave={() => setHoverRating(0)}
            aria-label={`Rate ${s} star${s === 1 ? '' : 's'}`}
            aria-pressed={s === ratingInput}
            className={cn('cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500', workspace && 'max-sm:p-2.5')}
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
  );
  const reviewList = ratings.length > 0 ? (
    <div className="space-y-3">
      {ratings.map((r) => (
        <div key={r.id} className="border-b border-gray-100 dark:border-slate-800 pb-3 last:border-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-slate-300">{r.userName}</span>
            {renderStars(r.rating)}
            <span className={cn(mono, 'text-xs', quiet)}>
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
    <p className={cn('text-sm', quiet)}>No reviews yet.</p>
  );
  const firstReviewLine = (
    <p className={cn('px-1 text-sm', quiet)}>
      No reviews yet.{' '}
      <button
        type="button"
        onClick={() => (user ? setShowRatingForm(true) : goSignIn())}
        className={cn('cursor-pointer rounded text-primary-600 dark:text-primary-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500', touch)}
      >
        Be the first to review this pack
      </button>
    </p>
  );

  // ── Inside the workspace ───────────────────────────────────────────────────────────────────
  // The Header names the template and leads back to the catalogue. Under it the template's
  // facts and its Install button come first, in view without scrolling; the picture, what the
  // template holds and its reviews stand beside them where there is room and under them where
  // there is not.
  if (workspace) {
    const facts: Array<[label: string, value: ReactNode]> = [];
    if (pack.category) facts.push(['Category', pack.category]);
    facts.push(['Publisher', pack.publisherName || 'Unknown']);
    if (pack.latestVersion) facts.push(['Version', `v${pack.latestVersion}`]);
    if (hasPublishedDate) facts.push(['Published', publishedDate.toLocaleDateString()]);
    // An extension holds flow nodes, not forms or apps: "0 forms · 0 apps" says nothing of it.
    if (pack.formCount > 0 || pack.appCount > 0) facts.push(['Contains', `${plural(pack.formCount, 'form')} · ${plural(pack.appCount, 'app')}`]);
    // Zero-value social proof stays hidden: no installs or stars until there are some.
    if (pack.downloadCount > 0) facts.push(['Installs', pack.downloadCount.toLocaleString()]);
    if (pack.ratingCount > 0) {
      facts.push(['Rating', (
        <span className="flex flex-wrap items-center gap-x-2">
          {renderStars(Math.round(pack.avgRating))}
          <span>{pack.avgRating.toFixed(1)} <span className="text-gray-500 dark:text-slate-400">({plural(pack.ratingCount, 'rating')})</span></span>
        </span>
      )]);
    }
    return (
      <MarketplaceLayout
        title={pack.name}
        back={backToTemplates}
        actions={
          // The way to what an install made. The bottom navigation has "Apps" on a phone, where
          // the header keeps its room for the template's name.
          <Button variant="outline" size="sm" className="hidden @xl/header:inline-flex" onClick={() => navigate('/apps')} rightIcon={<ArrowRight className="h-4 w-4" />}>
            My apps
          </Button>
        }
      >
        <PageBody>
          {bundledPreview && <p role="status" className="mb-3 text-sm text-gray-600 dark:text-slate-300">Bundled starter preview. Connect to the live marketplace to install this app.</p>}
          <div className="grid gap-4 @3xl/packs:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] @3xl/packs:items-start @5xl/packs:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            {/* What it is and the button that installs it. */}
            <div className="grid min-w-0 gap-4">
              <Panel
                title="About"
                icon={<PackIcon icon={pack.icon} className="h-4 w-4" emojiClassName="text-base leading-none" />}
                actions={<TrustBadge trust={trust} />}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {installButton}
                  {sourcesButton}
                  {demoButtons}
                </div>
                {pack.description && (
                  <p className="mt-3 whitespace-pre-line text-sm leading-6 text-gray-700 dark:text-slate-300">{pack.description}</p>
                )}
                {pack.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {pack.tags.map((tag) => (
                      <span key={tag} className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-slate-800 dark:text-slate-300">{tag}</span>
                    ))}
                  </div>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-gray-100 pt-3 dark:border-slate-800">
                  {facts.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">{label}</dt>
                      <dd className="break-words text-sm tabular-nums text-gray-900 dark:text-white">{value}</dd>
                    </div>
                  ))}
                </dl>
                {pack.folderSource && (
                  <p className="mt-3 text-xs leading-5 text-gray-500 dark:text-slate-400">
                    Includes an editable app workspace, linked forms and record storage. Install to create your own copy, then customise its screens, backend actions, forms and automations in App Studio. The source download includes each app as a .softn project and the complete installation package.
                  </p>
                )}
              </Panel>
              {consentPanel}
            </div>
            {/* What it looks like, what it holds and what others made of it. */}
            <div className="grid min-w-0 gap-4">
              {/* Dashboard preview(s) — one per app, aspect-true, click to enlarge */}
              <PackScreenshots shots={shots} maxHeight="max-h-[36rem]" />
              {(appNames.length > 0 || formTitles.length > 0) && (
                <Panel title="What’s inside">
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-4">{insideLists}</div>
                </Panel>
              )}
              {hasVersions && (
                // Folded, the panel gives back the space it keeps under a title for its contents.
                <Panel className={cn(!versionsExpanded && 'pb-1')} title={versionsToggle}>
                  {versionRows}
                </Panel>
              )}
              {showRatings && (ratingsOpen ? (
                <Panel title="Ratings and reviews">
                  <div className="space-y-3">
                    {ratingForm}
                    {reviewList}
                  </div>
                </Panel>
              ) : firstReviewLine)}
            </div>
          </div>
        </PageBody>
      </MarketplaceLayout>
    );
  }

  // ── The public marketplace page ────────────────────────────────────────────────────────────
  return (
    <MarketplaceLayout>
      {bundledPreview && <p role="status" className="mx-auto max-w-4xl px-6 pt-5 text-sm text-slate-600 dark:text-slate-300">Bundled starter preview. Connect to the live marketplace to install this app.</p>}
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
                {hasPublishedDate && <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                  Published {publishedDate.toLocaleDateString()}
                </span>}
                {pack.latestVersion && (
                  <span className="rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5">
                    v{pack.latestVersion}
                  </span>
                )}
                <TrustBadge trust={trust} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-6 px-4 pb-12 sm:px-6">
        {/* Dashboard preview(s) — one per app, aspect-true, click to enlarge */}
        <PackScreenshots
          shots={shots}
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
            {demoButtons}
            {sourcesButton}
            {installButton}
          </div>
        </div>

        {pack.folderSource && <p className="rounded-xl border border-primary-200 bg-primary-50 p-4 text-sm leading-6 text-primary-950 dark:border-primary-800 dark:bg-primary-950/40 dark:text-primary-100">Includes an editable app workspace, linked forms and record storage. Install to create your own copy, then customise its screens, backend actions, forms and automations in App Studio. The source download includes each app as a .softn project and the complete installation package.</p>}
        {consentPanel}

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

        {(appNames.length > 0 || formTitles.length > 0) && (
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">What’s inside</h2>
            <div className="mt-4 grid gap-6 sm:grid-cols-2">{insideLists}</div>
          </div>
        )}

        {hasVersions && (
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            {versionsToggle}
            {versionRows}
          </div>
        )}

        {showRatings && (ratingsOpen ? (
          <div className="space-y-4 rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 sm:p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">Ratings and reviews</h2>
            {ratingForm}
            {reviewList}
          </div>
        ) : firstReviewLine)}
      </div>
    </MarketplaceLayout>
  );
}
