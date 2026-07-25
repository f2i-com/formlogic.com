import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Package,
  Upload,
  FileJson,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  X,
  Trash2,
  AlertTriangle,
  Loader2,
  Calendar,
  Box,
  Globe,
  Search,
  Star,
  Download,
  User,
  Plus,
  Pencil,
  Archive,
  RefreshCw,
  Puzzle,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { PackIcon } from '../ui/PackIcon';
import { api, type PackData, type PackImportResult, type PackInstallation, type CatalogPack, type PackDescribeResult, type PackageInstallPlan } from '../../lib/api';
import { validateApplicationPackage } from '../../application-package/packageValidator';
import { packHasCodeScreen, packHasLogicScript, reviewableConnectorGrants } from '../../lib/packTrust';
import { CapabilityReview } from './TrustBadge';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';
import { useAppStore } from '../../stores/appStore';
import { useInstalledNodeStore } from '../../stores/installedNodeStore';
import { InstalledExtensionDetail } from './InstalledExtensionDetail';
import { PackDetailView } from './PackDetailView';
import { PublishPackDialog } from './PublishPackDialog';

type Tab = 'marketplace' | 'installed' | 'mypacks' | 'upload';

/** What the mandatory pre-install capability review is looking at (SAFE-001). */
type ReviewSource =
  | { kind: 'envelope'; envelope: Record<string, unknown> }
  | { kind: 'pack'; pack: PackData }
  | { kind: 'archive'; file: File };

interface PackImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Which tab to open on. Defaults to the marketplace; pass 'upload' to jump straight to file import. */
  initialTab?: Tab;
}

/** The reviewed v2 install plan the Import button will confirm. */
interface V2PlanState {
  planId: string;
  planDigest: string;
  action: 'install' | 'update';
  installedVersion: string | null;
  version: string;
  /** RUN-306: what an update would do to flows already using the package. */
  migration: PackageInstallPlan['migration'];
}

export function PackImportModal({ isOpen, onClose, initialTab }: PackImportModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'marketplace');

  // Marketplace state
  const [catalogPacks, setCatalogPacks] = useState<CatalogPack[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('popular');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // Upload state
  const [uploadedPack, setUploadedPack] = useState<PackData | null>(null);
  // A dropped .formlogic ARCHIVE (binary ZIP) can't be parsed client-side — held for direct import.
  const [pendingArchiveFile, setPendingArchiveFile] = useState<File | null>(null);
  // A parsed signed/application-package ENVELOPE (JSON) — the whole thing is sent so the server verifies it.
  const [signedEnvelope, setSignedEnvelope] = useState<Record<string, unknown> | null>(null);
  // Server-computed capability review + trust for a package (shown before Install).
  // SAFE-001: the review is MANDATORY for every source — import stays disabled until it loads,
  // a failure blocks with Retry, and its approve/deny checklist is what the import sends.
  const [packageReview, setPackageReview] = useState<PackDescribeResult | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [approvedGrants, setApprovedGrants] = useState<Set<string>>(new Set());
  // PKG-106: an Application Package v2 review IS a proposed install plan — Import confirms
  // exactly the server-stored bytes it reviewed (digest-bound, single-use, expiring).
  const [v2Plan, setV2Plan] = useState<V2PlanState | null>(null);
  // Ref mirror so cleanup paths can cancel the current plan without a stale closure.
  const v2PlanRef = useRef<V2PlanState | null>(null);
  // Guards a stale review response landing after a newer file was chosen + remembers what to Retry.
  const reviewSeqRef = useRef(0);
  const reviewSourceRef = useRef<ReviewSource | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PackImportResult | null>(null);
  // Non-fatal warnings from the server import response (application-package envelope metadata —
  // launch/native defaults, extra assets — that had no runtime target and was not applied).
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [expandedForms, setExpandedForms] = useState(true);
  const [expandedApps, setExpandedApps] = useState(true);

  // Installed packs state
  const [installations, setInstallations] = useState<PackInstallation[]>([]);
  const [loadingInstallations, setLoadingInstallations] = useState(false);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  // MKT-605: which installed v2 extension has its receipt/dependency detail open (fetch-on-expand).
  const [expandedInstallation, setExpandedInstallation] = useState<string | null>(null);

  // My packs state
  const [myPacks, setMyPacks] = useState<CatalogPack[]>([]);
  const [archiveConfirmSlug, setArchiveConfirmSlug] = useState<string | null>(null);
  const [archivingSlug, setArchivingSlug] = useState<string | null>(null);
  const [editingPack, setEditingPack] = useState<CatalogPack | null>(null);
  const [editPackName, setEditPackName] = useState('');
  const [editPackDesc, setEditPackDesc] = useState('');
  const [editPackVisibility, setEditPackVisibility] = useState('public');
  const [savingPackMeta, setSavingPackMeta] = useState(false);
  const [loadingMyPacks, setLoadingMyPacks] = useState(false);

  // Publish dialog
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishInitialPack, setPublishInitialPack] = useState<PackData | null>(null);
  const [versionTarget, setVersionTarget] = useState<{ slug: string; name: string; latestVersion?: string | null } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshForms = useFormStore((s) => s.refreshForms);
  const fetchApps = useAppStore((s) => s.fetchApps);
  const storageMode = useFormStore((s) => s.storageMode);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen && storageMode === 'api') {
      loadCatalog();
      loadInstallations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-effect: catalog+installations load only when modal opens or storage mode changes; loadCatalog identity tracks searchQuery/sortBy and is handled by the debounced effect below, so excluding it here prevents loadInstallations re-firing on every search keystroke
  }, [isOpen, storageMode]);

  // Debounced search (API-only, mirroring the load effect above)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (isOpen && storageMode === 'api') loadCatalog();
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounced search: loadCatalog only closes over searchQuery/sortBy which are already deps, so its identity is fully covered; listing the explicit values keeps the debounce reset tied to the actual search inputs
  }, [searchQuery, sortBy, isOpen, storageMode]);

  const [seeding, setSeeding] = useState(false);
  const seedAttemptedRef = useRef(false);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const result = await api.browsePacks({
        search: searchQuery || undefined,
        sort: sortBy,
        limit: 50,
      });
      if (result.data?.packs) {
        setCatalogPacks(result.data.packs);

        // MKT-602: an empty catalog TRIGGERS a server-side bootstrap (once per session). The
        // client no longer supplies the packs — it used to bundle every pack payload and POST
        // it, which let whoever opened this modal first decide what "official" meant on a new
        // deployment. The server seeds from its own copy; we just ask and re-read.
        if (result.data.packs.length === 0 && !searchQuery && !seedAttemptedRef.current) {
          seedAttemptedRef.current = true;
          setSeeding(true);
          try {
            const seedResult = await api.seedOfficialPacks();
            if (seedResult.data?.success) {
              const refreshed = await api.browsePacks({ sort: sortBy, limit: 50 });
              if (refreshed.data?.packs) {
                setCatalogPacks(refreshed.data.packs);
              }
            }
          } catch {
            // Seed failed — the user just sees an empty catalog, which is honest.
          } finally {
            setSeeding(false);
          }
        }
      }
    } catch {
      // silently fail
    } finally {
      setLoadingCatalog(false);
    }
  }, [searchQuery, sortBy]);

  const loadInstallations = useCallback(async () => {
    setLoadingInstallations(true);
    try {
      const result = await api.getInstalledPacks();
      setInstallations(result.data?.installations ?? []);
    } catch {
      // silently fail
    } finally {
      setLoadingInstallations(false);
    }
  }, []);

  const loadMyPacks = useCallback(async () => {
    setLoadingMyPacks(true);
    try {
      const result = await api.getMyPacks();
      setMyPacks(result.data?.packs ?? []);
    } catch {
      // silently fail
    } finally {
      setLoadingMyPacks(false);
    }
  }, []);

  const handleArchivePack = async (slug: string) => {
    setArchivingSlug(slug);
    const result = await api.archivePack(slug);
    setArchivingSlug(null);
    setArchiveConfirmSlug(null);
    if (result.error) {
      toast.error('Archive failed', typeof result.error === 'string' ? result.error : 'Please try again.');
    } else {
      toast.success('Pack archived', 'It is no longer listed in the marketplace.');
      loadMyPacks();
    }
  };

  const openEditPack = (pack: CatalogPack) => {
    setEditingPack(pack);
    setEditPackName(pack.name);
    setEditPackDesc(pack.description || '');
    setEditPackVisibility(pack.visibility || 'public');
  };

  const handleSavePackMeta = async () => {
    if (!editingPack) return;
    setSavingPackMeta(true);
    const result = await api.updatePackMeta(editingPack.slug, {
      name: editPackName.trim(),
      description: editPackDesc.trim(),
      visibility: editPackVisibility,
    });
    setSavingPackMeta(false);
    if (result.error) {
      toast.error('Update failed', typeof result.error === 'string' ? result.error : 'Please try again.');
    } else {
      toast.success('Pack updated', 'Your changes have been saved.');
      setEditingPack(null);
      loadMyPacks();
    }
  };

  const installedCatalogIds = new Set(
    installations.filter((i) => i.catalogId).map((i) => i.catalogId!)
  );

  const resetState = useCallback(() => {
    setUploadedPack(null);
    setPendingArchiveFile(null);
    setSignedEnvelope(null);
    reviewSeqRef.current++;
    reviewSourceRef.current = null;
    setPackageReview(null);
    setReviewError('');
    setReviewLoading(false);
    setApprovedGrants(new Set());
    setUploadFileName('');
    setUploadError('');
    setImporting(false);
    setImportResult(null);
    setImportWarnings([]);
    setExpandedForms(true);
    setExpandedApps(true);
    setIsDragging(false);
    setConfirmUninstall(null);
    setSelectedSlug(null);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    setActiveTab('marketplace');
    setSearchQuery('');
    onClose();
  }, [onClose, resetState]);

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    resetState();
    if (tab === 'mypacks') loadMyPacks();
  }, [resetState, loadMyPacks]);

  // Pull the inner Pack out of any recognized wrapper: a signed { package } envelope, an
  // ApplicationPackage { pack }, or a bare/flat pack. Returns null if none is present.
  const extractPack = useCallback((obj: unknown): PackData | null => {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    if (o.package && typeof o.package === 'object') return extractPack(o.package);
    if (o.pack && typeof o.pack === 'object') return o.pack as PackData;
    if (o.formatVersion && o.packMeta && Array.isArray(o.forms)) return o as unknown as PackData;
    return null;
  }, []);

  // Capability review + trust from the server (never trust a client-side claim). SAFE-001: this
  // runs for EVERY source (flat pack, legacy zip, signed envelope, binary archive) and is blocking —
  // the previous version was best-effort and only ran for signed envelopes, so a failed or skipped
  // review still allowed an import that activated every requested connector grant.
  const loadPackageReview = useCallback(async (source: ReviewSource) => {
    const seq = ++reviewSeqRef.current;
    reviewSourceRef.current = source;
    setPackageReview(null);
    v2PlanRef.current = null;
    setV2Plan(null);
    setReviewError('');
    setReviewLoading(true);
    let result: { data?: PackDescribeResult; error?: string };
    try {
      if (source.kind === 'archive') {
        result = await api.describePackArchive(source.file);
      } else if (source.kind === 'envelope') {
        const env = source.envelope;
        const inner = (env.package && typeof env.package === 'object') ? env.package as Record<string, unknown> : env;
        const isV2 = inner.formatVersion === 2 && !!inner.package && typeof inner.package === 'object';
        if (isV2) {
          // PKG-106: v2 aggregates ride the install-plan lane — propose stores the EXACT
          // reviewed bytes server-side; Import then confirms THAT plan (digest-bound,
          // single-use), so what you review is what installs.
          const proposal = await api.proposePackageInstallPlan(
            env.signature
              ? { package: inner, signature: env.signature, alg: env.alg }
              : { package: inner },
          );
          if (seq !== reviewSeqRef.current) return;
          setReviewLoading(false);
          if (proposal.data) {
            const pkgMeta = (inner.package && typeof inner.package === 'object') ? inner.package as Record<string, unknown> : {};
            v2PlanRef.current = {
              planId: proposal.data.planId,
              planDigest: proposal.data.planDigest,
              action: proposal.data.action === 'update' ? 'update' : 'install',
              installedVersion: typeof proposal.data.installedVersion === 'string' ? proposal.data.installedVersion : null,
              version: typeof pkgMeta.version === 'string' ? pkgMeta.version : '',
              migration: proposal.data.migration ?? null,
            };
            setV2Plan(v2PlanRef.current);
            setPackageReview({ trust: proposal.data.trust, formatVersion: 2, capabilities: proposal.data.capabilities });
            setApprovedGrants(new Set(reviewableConnectorGrants(proposal.data.capabilities)));
          } else {
            setReviewError(typeof proposal.error === 'string' && proposal.error !== '' ? proposal.error : 'The install-plan review failed.');
          }
          return;
        }
        const body = env.signature
          ? { package: (env.package ?? env), signature: env.signature as string, alg: env.alg as string | undefined }
          : { pack: extractPack(env) ?? undefined };
        result = await api.describePack(body);
      } else {
        result = await api.describePack({ pack: source.pack });
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : 'Network error' };
    }
    if (seq !== reviewSeqRef.current) return; // a newer file replaced this review
    setReviewLoading(false);
    if (result.data) {
      setPackageReview(result.data);
      // Default: every reviewable connector grant pre-approved; the user unticks to reduce
      // (same default as the marketplace install panel).
      setApprovedGrants(new Set(reviewableConnectorGrants(result.data.capabilities)));
    } else {
      setReviewError(typeof result.error === 'string' && result.error !== '' ? result.error : 'The capability review failed.');
    }
  }, [extractPack]);

  const retryReview = useCallback(() => {
    if (reviewSourceRef.current) void loadPackageReview(reviewSourceRef.current);
  }, [loadPackageReview]);

  const toggleGrant = useCallback((grant: string, next: boolean) => {
    setApprovedGrants((prev) => {
      const s = new Set(prev);
      if (next) s.add(grant); else s.delete(grant);
      return s;
    });
  }, []);

  // Reset every review artifact (a new/cleared file invalidates any in-flight review).
  const clearReview = useCallback(() => {
    reviewSeqRef.current++;
    reviewSourceRef.current = null;
    setPackageReview(null);
    setReviewError('');
    setReviewLoading(false);
    setApprovedGrants(new Set());
    // A discarded v2 review discards its proposed plan too (fire-and-forget; plans expire anyway).
    if (v2PlanRef.current) {
      void api.cancelPackageInstallPlan(v2PlanRef.current.planId).catch(() => undefined);
      v2PlanRef.current = null;
    }
    setV2Plan(null);
  }, []);

  // Route a parsed JSON blob: a v2 aggregate, a signed/application-package envelope, or a flat pack.
  const routeParsedJson = useCallback((parsed: unknown, fileName: string) => {
    const o = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : null;
    // ADR-010: Application Package v2 — a bare aggregate {formatVersion:2, package:{…}} or a
    // signed envelope wrapping one. Held as the envelope (the application-packages lane owns v2);
    // no client-side preview pack exists — the mandatory server review carries the detail.
    if (o) {
      const innerPkg = (o.package && typeof o.package === 'object') ? o.package as Record<string, unknown> : null;
      const bareV2 = o.formatVersion === 2 && innerPkg !== null && !('signature' in o);
      const signedV2 = innerPkg !== null && innerPkg.formatVersion === 2 && !!innerPkg.package && typeof innerPkg.package === 'object';
      if (bareV2 || signedV2) {
        const envelope = bareV2 ? { package: o } : o;
        setSignedEnvelope(envelope);
        setUploadFileName(fileName);
        void loadPackageReview({ kind: 'envelope', envelope });
        return;
      }
    }
    const isEnvelope = !!o && (('signature' in o && ('package' in o || 'pack' in o)) || ('manifest' in o && 'pack' in o));
    if (isEnvelope && o) {
      // Validate the envelope shape when it carries a manifest (the signed bare-pack shape has none).
      const inner = (o.package && typeof o.package === 'object') ? o.package as Record<string, unknown> : o;
      if ('manifest' in inner) {
        const v = validateApplicationPackage(inner);
        if (!v.valid) {
          setUploadError('Invalid application package: ' + (v.errors[0] ?? 'unknown error'));
          return;
        }
      }
      const pack = extractPack(o);
      if (!pack) {
        setUploadError('The application package does not contain a valid pack.');
        return;
      }
      setUploadedPack(pack);
      setSignedEnvelope(o);
      setUploadFileName(fileName);
      void loadPackageReview({ kind: 'envelope', envelope: o });
      return;
    }
    if (o && o.formatVersion && o.packMeta && Array.isArray(o.forms)) {
      const pack = o as unknown as PackData;
      setUploadedPack(pack);
      setUploadFileName(fileName);
      // SAFE-001: flat packs get the same mandatory review as envelopes.
      void loadPackageReview({ kind: 'pack', pack });
      return;
    }
    setUploadError('Invalid pack format. Expected formatVersion, packMeta, and forms fields.');
  }, [extractPack, loadPackageReview]);

  const parseFile = useCallback((file: File) => {
    setUploadError('');
    setUploadedPack(null);
    setPendingArchiveFile(null);
    setSignedEnvelope(null);
    clearReview();
    setUploadFileName('');

    const lower = file.name.toLowerCase();

    // Legacy marketplace .zip (manifest.json only) — parsed server-side for preview.
    if (lower.endsWith('.zip')) {
      (async () => {
        setUploading(true);
        try {
          const result = await api.uploadPackZip(file);
          if (result.data?.pack) {
            setUploadedPack(result.data.pack);
            setUploadFileName(file.name);
            void loadPackageReview({ kind: 'pack', pack: result.data.pack });
          } else {
            setUploadError(result.error || 'Failed to parse zip file');
          }
        } catch {
          setUploadError('Failed to upload file');
        } finally {
          setUploading(false);
        }
      })();
      return;
    }

    // A .formlogic (or legacy .formlogic-app) that is NOT a .json is the new ARCHIVE (binary ZIP) —
    // held for direct import (the server verifies + extracts it). If it turns out to be JSON text,
    // route it as an envelope. SAFE-001: the binary archive is reviewed server-side BEFORE import
    // (describePackArchive parses + signature-verifies without importing).
    if (lower.endsWith('.formlogic') || lower.endsWith('.formlogic-app')) {
      (async () => {
        try {
          const text = await file.text();
          if (text.trimStart().startsWith('{')) {
            routeParsedJson(JSON.parse(text), file.name);
          } else {
            setPendingArchiveFile(file);
            setUploadFileName(file.name);
            void loadPackageReview({ kind: 'archive', file });
          }
        } catch {
          // Not JSON text → treat as a binary archive to import directly.
          setPendingArchiveFile(file);
          setUploadFileName(file.name);
          void loadPackageReview({ kind: 'archive', file });
        }
      })();
      return;
    }

    if (!lower.endsWith('.json')) {
      setUploadError('Only .json, .zip and .formlogic files are accepted.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File is too large. Maximum size is 10 MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        routeParsedJson(JSON.parse(e.target?.result as string), file.name);
      } catch {
        setUploadError('Failed to parse JSON file.');
      }
    };
    reader.readAsText(file);
  }, [routeParsedJson, clearReview, loadPackageReview]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    if (!uploadedPack && !pendingArchiveFile && !signedEnvelope) return;
    // SAFE-001: no server review → no install (the button is disabled too; this is the backstop).
    if (!packageReview) return;
    const approved = [...approvedGrants];
    setImporting(true);
    try {
      // Import shapes, all landing at the same result overlay:
      //  1. a v2 install PLAN (PKG-106) → confirm the server-stored reviewed bytes
      //     (digest-bound, single-use — what you reviewed is what installs)
      //  2. a .formlogic ARCHIVE → server verifies + extracts the ZIP
      //  3. a signed/application-package ENVELOPE → server verifies the signature
      //  4. a flat pack → the classic import path (back-compat)
      // Every shape sends the reviewed grant array — the server fails closed without it.
      const response = v2Plan
        ? await api.confirmPackageInstallPlan(v2Plan.planId, { planDigest: v2Plan.planDigest, approvedConnectorGrants: approved })
        : pendingArchiveFile
          ? await api.importApplicationPackage(pendingArchiveFile, approved)
          : signedEnvelope
            ? await api.importSignedPackage(signedEnvelope, approved)
            : await api.importPack(uploadedPack as PackData, { approvedConnectorGrants: approved });
      if (v2Plan && response.data) {
        // The plan is spent — a re-import needs a fresh proposal.
        v2PlanRef.current = null;
      }
      if (response.data) {
        // Application-package imports return a warnings array (envelope launch/native/assets
        // metadata with no runtime target yet). The flat pack import returns none — read defensively.
        const rawWarnings = (response.data as unknown as { warnings?: unknown }).warnings;
        const warnings = Array.isArray(rawWarnings)
          ? rawWarnings.filter((w): w is string => typeof w === 'string')
          : [];
        setImportWarnings(warnings);
        setImportResult({
          success: true,
          message: '',
          installationId: response.data.installationId,
          forms: response.data.forms,
          apps: response.data.apps,
        });
        await Promise.all([refreshForms(), fetchApps(), loadInstallations()]);
        // A v2 extension may have contributed flow nodes — refresh the editor's registry source.
        void useInstalledNodeStore.getState().refresh();
        if (warnings.length > 0) {
          // Surface the count + first warning as a toast; the full list stays readable in the
          // modal's result view, so DON'T auto-close it (the user closes it when done).
          toast.warning(
            `Pack imported with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
            warnings[0]
          );
          setImporting(false);
        } else {
          toast.success(
            'Pack imported successfully',
            `Imported ${response.data.forms.length} form(s) and ${response.data.apps.length} app(s).`
          );
          closeTimerRef.current = setTimeout(handleClose, 1500);
        }
        return;
      } else {
        toast.error('Import failed', response.error || 'No data returned.');
      }
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : 'Unknown error');
    }
    setImporting(false);
  }, [uploadedPack, pendingArchiveFile, signedEnvelope, v2Plan, importing, packageReview, approvedGrants, refreshForms, fetchApps, loadInstallations, handleClose]);

  const handleUninstall = useCallback(async (installationId: string) => {
    setUninstallingId(installationId);
    try {
      const response = await api.uninstallPack(installationId);
      if (response.data?.success) {
        toast.success('Pack uninstalled', response.data.message);
        await Promise.all([refreshForms(), fetchApps(), loadInstallations()]);
        // A removed v2 extension takes its contributed flow nodes with it — refresh the registry
        // source (stored graph nodes fall back to the missing-definition placeholder).
        void useInstalledNodeStore.getState().refresh();
      } else {
        toast.error('Uninstall failed', response.error || 'Could not uninstall.');
      }
    } catch (err) {
      toast.error('Uninstall failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setUninstallingId(null);
      setConfirmUninstall(null);
    }
  }, [refreshForms, fetchApps, loadInstallations]);

  const handlePublishFromUpload = useCallback(() => {
    if (uploadedPack) {
      setPublishInitialPack(uploadedPack);
      setShowPublishDialog(true);
    }
  }, [uploadedPack]);

  const renderStars = (rating: number) => (
    <div className="flex items-center gap-0.5" role="img" aria-label={`Rated ${rating.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`h-3 w-3 ${s <= Math.round(rating) ? 'fill-amber-400 text-amber-400' : 'text-gray-300 dark:text-slate-600'}`}
        />
      ))}
    </div>
  );

  const tabButton = (tab: Tab, icon: React.ReactNode, label: string, badge?: number) => (
    <button
      type="button"
      onClick={() => handleTabChange(tab)}
      className={`px-2.5 sm:px-3 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
        activeTab === tab
          ? 'border-primary-600 text-primary-600 dark:text-primary-400 dark:border-primary-400'
          : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {icon}
        {label}
        {badge !== undefined && badge > 0 && (
          <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full text-xs font-semibold bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300">
            {badge}
          </span>
        )}
      </span>
    </button>
  );

  const formCount = uploadedPack?.forms?.length ?? 0;
  const appCount = uploadedPack?.apps?.length ?? 0;
  // Surface that a pack bundles server-side logic (runs on submit, can make
  // outbound requests) so the installer can review/consent before importing.
  // Surface a pack's code trust-surface (shared with the marketplace install flow via lib/packTrust):
  // backend onSubmit scripts, and sandboxed custom CODE screens (vs no-code widget dashboards).
  const hasLogicScript = uploadedPack ? packHasLogicScript(uploadedPack) : false;
  const hasCodeScreen = uploadedPack ? packHasCodeScreen(uploadedPack) : false;

  return (
    <>
      <Modal isOpen={isOpen} onClose={handleClose} title="Pack Marketplace" size="full">
        {/* Fixed-height flex column so the dialog stays one size across tabs:
            tabs pinned, content scrolls in the middle, footer pinned. Taller on
            mobile to use the available screen. */}
        <div className="p-4 sm:p-6 flex flex-col h-[80vh] sm:h-[70vh]">
          {/* Tabs — wrap onto multiple rows on mobile instead of scrolling */}
          <div className="flex flex-wrap border-b border-gray-200 dark:border-slate-800 flex-shrink-0">
            {tabButton('marketplace', <Package className="h-4 w-4" />, 'Marketplace')}
            {tabButton('installed', <Box className="h-4 w-4" />, 'Installed', installations.length)}
            {tabButton('mypacks', <User className="h-4 w-4" />, 'My Packs')}
            {tabButton('upload', <Upload className="h-4 w-4" />, 'Upload')}
          </div>

          {/* Scrollable content region */}
          <div className="flex-1 overflow-y-auto min-h-0 py-4 space-y-4">
          {/* Import result overlay */}
          {importResult && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <p className="text-lg font-semibold text-gray-900 dark:text-white">Import Complete</p>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {importResult.forms.length} form(s) and {importResult.apps.length} app(s) imported.
              </p>
              {/* Non-fatal server warnings (envelope launch/native/assets metadata that was not
                  applied). When present the modal does NOT auto-close, so give it a Close button. */}
              {importWarnings.length > 0 && (
                <div className="w-full max-w-lg space-y-2 text-left">
                  <div className="flex items-start gap-2.5 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 p-3 rounded-lg border border-amber-200 dark:border-amber-500/30">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-500" />
                    <div className="min-w-0 space-y-1.5">
                      <p className="font-medium">
                        Imported with {importWarnings.length} warning{importWarnings.length === 1 ? '' : 's'}
                      </p>
                      <ul className="list-disc pl-4 space-y-1">
                        {importWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    Launch and native runtime defaults are configured per custom domain after install — open the app's settings and connect a custom domain to set them.
                  </p>
                  <div className="flex justify-center pt-1">
                    <Button variant="outline" onClick={handleClose}>Close</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== MARKETPLACE TAB ==================== */}
          {!importResult && activeTab === 'marketplace' && !selectedSlug && (
            <div className="space-y-4">
              {/* Search & Sort bar */}
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search packs..."
                    aria-label="Search packs"
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-shadow"
                  />
                </div>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-white px-3 py-2.5 focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-shadow"
                >
                  <option value="popular">Popular</option>
                  <option value="top_rated">Top Rated</option>
                  <option value="newest">Newest</option>
                  <option value="name">Name</option>
                </select>
              </div>

              {/* Pack grid */}
              {loadingCatalog || seeding ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="h-7 w-7 animate-spin text-primary-500" />
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    {seeding ? 'Setting up marketplace...' : 'Loading packs...'}
                  </p>
                </div>
              ) : catalogPacks.length === 0 ? (
                <div className="text-center py-16 text-gray-400 dark:text-slate-500">
                  <Package className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  {storageMode !== 'api' ? (
                    <>
                      <p className="text-sm font-medium">Packs require cloud storage</p>
                      <p className="text-xs mt-1">Switch to Cloud from your account menu to browse and install packs.</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium">No packs found</p>
                      <p className="text-xs mt-1">Try a different search term.</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {catalogPacks.map((pack) => {
                    const isInstalled = installedCatalogIds.has(pack.id);
                    return (
                      <button
                        key={pack.id}
                        type="button"
                        onClick={() => setSelectedSlug(pack.slug)}
                        className="group relative flex flex-col overflow-hidden rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-300 dark:hover:border-primary-500/40 hover:shadow-lg hover:shadow-primary-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:hover:translate-y-0 motion-reduce:transition-none cursor-pointer"
                      >
                        {/* An accent edge on hover, mirroring the Desktop's status rail so the
                            two apps read as one product rather than two. */}
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-0 left-0 w-0.5 bg-primary-500 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                        />

                        <div className="flex items-start gap-3">
                          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-500/10" aria-hidden="true">
                            <PackIcon icon={pack.icon} className="h-4.5 w-4.5 text-primary-600 dark:text-primary-400" emojiClassName="text-2xl leading-none" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-gray-900 dark:text-white transition-colors group-hover:text-primary-700 dark:group-hover:text-primary-300">
                              {pack.name}
                            </p>
                            <p className="truncate text-xs text-gray-400 dark:text-slate-500">
                              {pack.publisherName || 'FormLogic'}
                            </p>
                          </div>
                          {isInstalled && (
                            <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-green-50 dark:bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                              <CheckCircle className="h-3 w-3" aria-hidden="true" />
                              Installed
                            </span>
                          )}
                        </div>

                        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
                          {pack.description}
                        </p>

                        {/* What you actually get. A pack is a working app, so its COMPOSITION is
                            the thing being chosen between — not its download count. Given the
                            weight that deserves, in the numeric face, and read as units. */}
                        <div className="mt-auto pt-3">
                          <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                            {([
                              ['forms', pack.formCount],
                              ['apps', pack.appCount],
                            ] as const)
                              .filter(([, n]) => n > 0)
                              .map(([label, n]) => (
                                <div key={label} className="flex items-baseline gap-1">
                                  <dd className="fl-mono text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{n}</dd>
                                  <dt className="text-[11px] text-gray-400 dark:text-slate-500">{n === 1 ? label.replace(/s$/, '') : label}</dt>
                                </div>
                              ))}
                          </dl>
                          {/* Social proof is context, not substance — quieter, and below. */}
                          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-400 dark:text-slate-500">
                            <span className="inline-flex items-center gap-1">
                              {renderStars(pack.avgRating)}
                              {pack.ratingCount > 0 && <span className="ml-0.5">({pack.ratingCount})</span>}
                            </span>
                            <span aria-hidden="true" className="text-gray-300 dark:text-slate-700">&middot;</span>
                            <span className="inline-flex items-center gap-0.5">
                              <Download className="h-3 w-3" aria-hidden="true" />
                              {pack.downloadCount}
                            </span>
                          </div>
                        </div>

                        {/* Tags */}
                        {pack.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2.5">
                            {pack.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400">
                                {tag}
                              </span>
                            ))}
                            {pack.tags.length > 3 && (
                              <span className="text-[10px] text-gray-400 dark:text-slate-500 self-center">+{pack.tags.length - 3}</span>
                            )}
                          </div>
                        )}

                        {/* Featured / Installed badges */}
                        {(pack.featured || isInstalled) && (
                          <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {pack.featured && <Badge variant="warning" size="sm">Featured</Badge>}
                            {isInstalled && <Badge variant="success" size="sm">Installed</Badge>}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Marketplace detail view */}
          {!importResult && activeTab === 'marketplace' && selectedSlug && (
            <PackDetailView
              slug={selectedSlug}
              onBack={() => setSelectedSlug(null)}
              onInstalled={() => loadInstallations()}
              installedCatalogIds={installedCatalogIds}
            />
          )}

          {/* ==================== INSTALLED TAB ==================== */}
          {!importResult && activeTab === 'installed' && (
            <div className="space-y-3">
              {loadingInstallations ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-slate-500" />
                </div>
              ) : installations.length === 0 ? (
                <div className="text-center py-8 text-gray-400 dark:text-slate-500">
                  <Box className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-medium">No packs installed</p>
                  <p className="text-xs mt-1">Browse the Marketplace tab to find packs to install.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {installations.map((inst) => (
                    <div
                      key={inst.id}
                      className="p-3 rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                              {inst.packName}
                            </p>
                            <Badge variant="default" size="sm">v{inst.packVersion}</Badge>
                            {inst.updateAvailable && (
                              <Badge variant="info" size="sm" title={inst.updateAvailable.changelog || undefined}>
                                Update available · v{inst.updateAvailable.version}
                              </Badge>
                            )}
                          </div>
                          {inst.packDescription && (
                            <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                              {inst.packDescription}
                            </p>
                          )}
                          {/* An extension contributes flow nodes, not forms/apps — showing it
                              "0/0 forms · 0/0 apps" was noise. Each kind states its own content. */}
                          <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 dark:text-slate-400">
                            {inst.formatVersion === 2 ? (
                              <>
                                <span className="inline-flex items-center gap-1">
                                  <Puzzle className="h-3 w-3" />
                                  {inst.nodesInstalled ?? 0} flow node{(inst.nodesInstalled ?? 0) === 1 ? '' : 's'}
                                </span>
                                {inst.publisherId && (
                                  <span className="truncate">by {inst.publisherId}</span>
                                )}
                              </>
                            ) : (
                              <>
                                <span className="inline-flex items-center gap-1">
                                  <FileJson className="h-3 w-3" />
                                  {inst.existingFormCount}/{inst.formCount} forms
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <Globe className="h-3 w-3" />
                                  {inst.existingAppCount}/{inst.appCount} apps
                                </span>
                              </>
                            )}
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {new Date(inst.installedAt).toLocaleDateString()}
                            </span>
                          </div>
                          {inst.formatVersion === 2 && (
                            <button
                              type="button"
                              onClick={() => setExpandedInstallation((cur) => (cur === inst.id ? null : inst.id))}
                              aria-expanded={expandedInstallation === inst.id}
                              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              {expandedInstallation === inst.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              {expandedInstallation === inst.id ? 'Hide details' : 'Details'}
                            </button>
                          )}
                        </div>

                        <div className="flex-shrink-0">
                          {confirmUninstall === inst.id ? (
                            <div className="flex items-center gap-1.5">
                              <Button variant="outline" size="sm" onClick={() => setConfirmUninstall(null)} disabled={uninstallingId === inst.id}>
                                Cancel
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => handleUninstall(inst.id)}
                                isLoading={uninstallingId === inst.id}
                                leftIcon={uninstallingId !== inst.id ? <Trash2 className="h-3.5 w-3.5" /> : undefined}
                              >
                                {uninstallingId === inst.id ? 'Removing...' : 'Delete'}
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setConfirmUninstall(inst.id)}
                              aria-label={`Uninstall ${inst.packName}`}
                              title={`Uninstall ${inst.packName}`}
                              className="text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {confirmUninstall === inst.id && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                          {/* §14.4: recoverability is itemized honestly — record-bearing forms are
                              pre-captured into the Recycle bin (not irreversibly destroyed), while
                              apps and empty forms are removed outright (reinstallable from the pack).
                              A v2 extension removes only its contributed node definitions. */}
                          <span>
                            {inst.formatVersion === 2
                              ? `Removes this extension${(inst.nodesInstalled ?? 0) > 0 ? ` and its ${inst.nodesInstalled} contributed flow node${inst.nodesInstalled === 1 ? '' : 's'}` : ''}. Flows already using its nodes keep them as read-only placeholders.`
                              : `Removes ${inst.existingFormCount} form${inst.existingFormCount === 1 ? '' : 's'}${inst.existingAppCount > 0 ? ` and ${inst.existingAppCount} app${inst.existingAppCount === 1 ? '' : 's'}` : ''} created by this pack. Forms with collected responses go to the Recycle bin (restorable for 30 days); apps and empty forms are removed outright and can be reinstalled from the pack.`}
                          </span>
                        </div>
                      )}

                      {expandedInstallation === inst.id && inst.formatVersion === 2 && (
                        <InstalledExtensionDetail installationId={inst.id} />
                      )}

                      {(inst.existingFormCount < inst.formCount || inst.existingAppCount < inst.appCount) && (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                          <span>
                            Some resources were manually deleted ({inst.formCount - inst.existingFormCount} form{inst.formCount - inst.existingFormCount !== 1 ? 's' : ''}, {inst.appCount - inst.existingAppCount} app{inst.appCount - inst.existingAppCount !== 1 ? 's' : ''})
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ==================== MY PACKS TAB ==================== */}
          {!importResult && activeTab === 'mypacks' && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => { setPublishInitialPack(null); setShowPublishDialog(true); }}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Publish New Pack
                </Button>
              </div>
              {loadingMyPacks ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              ) : myPacks.length === 0 ? (
                <div className="text-center py-8 text-gray-400 dark:text-slate-500">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-medium">No published packs</p>
                  <p className="text-xs mt-1">Publish a pack to share with others.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {myPacks.map((pack) => (
                    <div
                      key={pack.id}
                      className="p-3 rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-500/10" aria-hidden="true">
                          <PackIcon icon={pack.icon} className="h-4.5 w-4.5 text-primary-600 dark:text-primary-400" emojiClassName="text-2xl leading-none" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{pack.name}</p>
                            <Badge variant={pack.status === 'published' ? 'success' : 'default'} size="sm">
                              {pack.status}
                            </Badge>
                            <Badge variant="default" size="sm">{pack.visibility}</Badge>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-slate-400">
                            <span className="inline-flex items-center gap-0.5">
                              <Download className="h-3 w-3" /> {pack.downloadCount}
                            </span>
                            <span className="inline-flex items-center gap-0.5">
                              {renderStars(pack.avgRating)}
                              ({pack.ratingCount})
                            </span>
                            <span>{pack.formCount} forms, {pack.appCount} apps</span>
                          </div>
                        </div>
                        <div className="flex-shrink-0">
                          {archiveConfirmSlug === pack.slug ? (
                            <div className="flex items-center gap-1.5">
                              <Button variant="outline" size="sm" onClick={() => setArchiveConfirmSlug(null)} disabled={archivingSlug === pack.slug}>Cancel</Button>
                              <Button variant="danger" size="sm" onClick={() => handleArchivePack(pack.slug)} isLoading={archivingSlug === pack.slug}>Archive</Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <button onClick={() => openEditPack(pack)} aria-label={`Edit ${pack.name}`} title="Edit pack metadata"
                                className="p-1.5 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"><Pencil className="h-4 w-4" /></button>
                              {pack.status !== 'archived' && (
                                <button onClick={() => { setPublishInitialPack(null); setVersionTarget({ slug: pack.slug, name: pack.name, latestVersion: pack.latestVersion }); setShowPublishDialog(true); }} aria-label={`Publish update to ${pack.name}`} title="Publish a new version"
                                  className="p-1.5 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"><Upload className="h-4 w-4" /></button>
                              )}
                              {pack.status !== 'archived' && (
                                <button onClick={() => setArchiveConfirmSlug(pack.slug)} aria-label={`Archive ${pack.name}`} title="Archive pack"
                                  className="p-1.5 text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors cursor-pointer"><Archive className="h-4 w-4" /></button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ==================== UPLOAD TAB ==================== */}
          {!importResult && activeTab === 'upload' && (
            <div className="space-y-4">
              {/* Drop zone */}
              <div
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }}
                onClick={() => !uploadedPack && !pendingArchiveFile && !signedEnvelope && !uploading && fileInputRef.current?.click()}
                className={`relative rounded-xl transition-all ${
                  isDragging
                    ? 'border-2 border-dashed border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 dark:border-primary-400 shadow-lg shadow-primary-500/10'
                    : (uploadedPack || pendingArchiveFile || signedEnvelope)
                      ? 'border border-green-300 bg-green-50/50 dark:bg-green-500/5 dark:border-green-500/40'
                      : 'border-2 border-dashed border-gray-300 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500/50 bg-gray-50/50 dark:bg-slate-800/30 cursor-pointer group'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.zip,.formlogic,.formlogic-app"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); e.target.value = ''; }}
                  className="hidden"
                />
                {(uploadedPack || pendingArchiveFile || signedEnvelope) ? (
                  <div className="flex items-center gap-4 p-4">
                    <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-green-100 dark:bg-green-500/20 flex items-center justify-center">
                      <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{uploadFileName}</p>
                      <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                        {uploadedPack
                          ? `${uploadedPack.packMeta.name} · v${uploadedPack.packMeta.version}`
                          : pendingArchiveFile
                            ? 'Application package archive · verified on import'
                            : 'Application Package v2 · reviewed below'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); if (!uploading) fileInputRef.current?.click(); }}
                        className="text-xs text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium cursor-pointer"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUploadedPack(null); setPendingArchiveFile(null); setSignedEnvelope(null); clearReview(); setUploadFileName(''); setUploadError(''); }}
                        className="p-1 rounded-md text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : uploading ? (
                  <div className="flex flex-col items-center justify-center py-10 px-6">
                    <Loader2 className="h-7 w-7 text-primary-500 mb-3 animate-spin" />
                    <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Uploading…</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 px-6">
                    <div className="w-14 h-14 rounded-xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-3 group-hover:bg-primary-50 dark:group-hover:bg-primary-500/10 transition-colors">
                      <Upload className="h-7 w-7 text-gray-400 dark:text-slate-500 group-hover:text-primary-500 dark:group-hover:text-primary-400 transition-colors" />
                    </div>
                    <p className="text-sm font-medium text-gray-700 dark:text-slate-300">
                      Drop your pack file here
                    </p>
                    <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                      or <span className="text-primary-600 dark:text-primary-400 font-medium">click to browse</span>
                    </p>
                    <div className="flex items-center gap-2 mt-3">
                      <Badge variant="default" size="sm">.json</Badge>
                      <Badge variant="default" size="sm">.zip</Badge>
                      <Badge variant="default" size="sm">.formlogic</Badge>
                    </div>
                  </div>
                )}
              </div>

              {/* Upload error */}
              {uploadError && (
                <div className="flex items-start gap-2.5 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 p-3 rounded-lg border border-red-200 dark:border-red-500/20">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-red-500" />
                  <span>{uploadError}</span>
                </div>
              )}

              {/* Capability review + server-computed trust — MANDATORY before install (SAFE-001):
                  import stays disabled until the server review loads; a failure blocks with Retry. */}
              {reviewLoading && (
                <div className="flex items-center gap-2.5 text-sm text-gray-600 dark:text-slate-300 bg-gray-50 dark:bg-slate-800/50 p-3 rounded-lg border border-gray-200 dark:border-slate-800" role="status">
                  <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
                  <span>Reviewing capabilities…</span>
                </div>
              )}
              {reviewError && !reviewLoading && (
                <div className="flex items-start gap-2.5 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 p-3 rounded-lg border border-red-200 dark:border-red-500/20">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-red-500" />
                  <div className="flex-1 min-w-0">
                    <p>The capability review failed — the pack can’t be installed without it.</p>
                    <p className="mt-0.5 text-xs opacity-80 break-words">{reviewError}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={retryReview}>Retry</Button>
                </div>
              )}
              {packageReview && v2Plan?.action === 'update' && (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-foreground">
                    <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <p>
                      This package is already installed at v{v2Plan.installedVersion}. Importing updates it to v{v2Plan.version} —
                      existing flows keep the versions they were published with.
                    </p>
                  </div>
                  {/* RUN-306: a version that stops shipping a node type turns stored nodes into
                      read-only placeholders. Say so, and name the flows, before it happens. */}
                  {v2Plan.migration && v2Plan.migration.removedTypes.length > 0 && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium">
                          This version removes {v2Plan.migration.removedTypes.length} node type
                          {v2Plan.migration.removedTypes.length === 1 ? '' : 's'}.
                        </p>
                        <p className="mt-0.5 break-words">
                          {v2Plan.migration.breakingFlows.length > 0
                            ? `${v2Plan.migration.breakingFlows.length} flow${v2Plan.migration.breakingFlows.length === 1 ? '' : 's'} using ${v2Plan.migration.breakingFlows.length === 1 ? 'it' : 'them'} will stop compiling until updated: ` +
                              v2Plan.migration.affectedFlows
                                .filter((f) => v2Plan.migration!.breakingFlows.includes(f.flowId))
                                .map((f) => f.name)
                                .join(', ')
                            : 'No existing flow uses the removed types.'}
                        </p>
                        <p className="mt-0.5 text-xs opacity-80">
                          Stored nodes keep their configuration and become read-only placeholders — nothing is deleted.
                        </p>
                      </div>
                    </div>
                  )}
                  {v2Plan.migration && v2Plan.migration.removedTypes.length === 0 && v2Plan.migration.affectedFlows.length > 0 && (
                    <p className="px-1 text-xs text-gray-500 dark:text-slate-400">
                      {v2Plan.migration.affectedFlows.length} flow{v2Plan.migration.affectedFlows.length === 1 ? '' : 's'} use
                      {v2Plan.migration.affectedFlows.length === 1 ? 's' : ''} this package; no node types are being removed.
                    </p>
                  )}
                </div>
              )}
              {packageReview && (
                <CapabilityReview
                  caps={packageReview.capabilities}
                  trust={packageReview.trust}
                  vendorSigning={packageReview.vendorSigning}
                  selectedGrants={approvedGrants}
                  onToggleGrant={toggleGrant}
                />
              )}

              {/* Pack preview */}
              {uploadedPack && (
                <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                  {/* Preview header */}
                  <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/50 border-b border-gray-200 dark:border-slate-800">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Pack Contents</h3>
                  </div>

                  {/* Metadata grid */}
                  <div className="p-4 grid grid-cols-3 gap-3">
                    <div className="flex flex-col items-center p-3 rounded-lg bg-gray-50 dark:bg-slate-800/50">
                      <span className="text-lg font-bold text-gray-900 dark:text-white">{formCount}</span>
                      <span className="text-xs text-gray-500 dark:text-slate-400">Forms</span>
                    </div>
                    <div className="flex flex-col items-center p-3 rounded-lg bg-gray-50 dark:bg-slate-800/50">
                      <span className="text-lg font-bold text-gray-900 dark:text-white">{appCount}</span>
                      <span className="text-xs text-gray-500 dark:text-slate-400">Apps</span>
                    </div>
                    <div className="flex flex-col items-center p-3 rounded-lg bg-gray-50 dark:bg-slate-800/50">
                      <span className="text-lg font-bold text-gray-900 dark:text-white">v{uploadedPack.packMeta.version}</span>
                      <span className="text-xs text-gray-500 dark:text-slate-400">Version</span>
                    </div>
                  </div>

                  {uploadedPack.packMeta.description && (
                    <div className="px-4 pb-3">
                      <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed">{uploadedPack.packMeta.description}</p>
                    </div>
                  )}

                  {hasLogicScript && (
                    <div className="px-4 pb-3">
                      <div className="flex items-start gap-2.5 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 p-3 rounded-lg border border-amber-200 dark:border-amber-500/30">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-500" />
                        <span>This pack includes <strong>backend logic scripts</strong> that run on your server when a form is submitted and can make outbound network requests. Only import packs you trust, and review each form's Backend Logic Script before publishing.</span>
                      </div>
                    </div>
                  )}

                  {hasCodeScreen && (
                    <div className="px-4 pb-3">
                      <div className="flex items-start gap-2.5 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 p-3 rounded-lg border border-amber-200 dark:border-amber-500/30">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-500" />
                        <span>This pack includes <strong>custom code screens</strong> (sandboxed HTML/CSS/JS), not just no-code dashboards. They run in a locked-down sandbox and can only use the FormLogic SDK — but they can read data the viewer is allowed to see. Only import code screens from a source you trust.</span>
                      </div>
                    </div>
                  )}

                  {/* Forms list */}
                  {formCount > 0 && (
                    <div className="border-t border-gray-100 dark:border-slate-800">
                      <button
                        type="button"
                        onClick={() => setExpandedForms((v) => !v)}
                        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
                      >
                        {expandedForms ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <FileJson className="h-4 w-4 text-primary-500" />
                        Forms ({formCount})
                      </button>
                      {expandedForms && (
                        <ul className="px-4 pb-3 space-y-1.5">
                          {uploadedPack.forms.map((form, i) => {
                            const title = (form as Record<string, unknown>).title as string || `Form ${i + 1}`;
                            const fields = Array.isArray((form as Record<string, unknown>).fields)
                              ? ((form as Record<string, unknown>).fields as unknown[]).length
                              : 0;
                            return (
                              <li key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-md bg-gray-50 dark:bg-slate-800/50 text-xs">
                                <FileJson className="h-3.5 w-3.5 flex-shrink-0 text-primary-400 dark:text-primary-500" />
                                <span className="truncate text-gray-700 dark:text-slate-300 font-medium">{title}</span>
                                <span className="ml-auto flex-shrink-0 text-gray-400 dark:text-slate-500">{fields} fields</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Apps list */}
                  {appCount > 0 && (
                    <div className="border-t border-gray-100 dark:border-slate-800">
                      <button
                        type="button"
                        onClick={() => setExpandedApps((v) => !v)}
                        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
                      >
                        {expandedApps ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <Globe className="h-4 w-4 text-primary-500" />
                        Apps ({appCount})
                      </button>
                      {expandedApps && (
                        <ul className="px-4 pb-3 space-y-1.5">
                          {(uploadedPack.apps ?? []).map((app, i) => {
                            const aName = (app as Record<string, unknown>).name as string || `App ${i + 1}`;
                            return (
                              <li key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-md bg-gray-50 dark:bg-slate-800/50 text-xs">
                                <Globe className="h-3.5 w-3.5 flex-shrink-0 text-primary-400 dark:text-primary-500" />
                                <span className="truncate text-gray-700 dark:text-slate-300 font-medium">{aName}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          </div>
          {/* end scrollable content region */}

          {/* ==================== ACTION BUTTONS (pinned footer) ==================== */}
          {!importResult && activeTab === 'upload' && (
            <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 dark:border-slate-800 pt-4 mt-4">
              <div>
                {uploadedPack && (
                  <Button variant="outline" size="sm" onClick={handlePublishFromUpload}>
                    <Package className="h-4 w-4 mr-1.5" />
                    Publish to Marketplace
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={handleClose}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={handleImport}
                  disabled={(!uploadedPack && !pendingArchiveFile && !signedEnvelope) || !packageReview || reviewLoading}
                  isLoading={importing}
                  leftIcon={importing ? undefined : <Download className="h-4 w-4" />}
                >
                  {importing ? 'Importing...' : v2Plan?.action === 'update' ? 'Update extension' : 'Import to My Forms'}
                </Button>
              </div>
            </div>
          )}

          {!importResult && (activeTab === 'installed' || activeTab === 'mypacks') && (
            <div className="flex-shrink-0 flex items-center justify-end border-t border-gray-200 dark:border-slate-800 pt-4 mt-4">
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </div>
          )}

          {!importResult && activeTab === 'marketplace' && !selectedSlug && (
            <div className="flex-shrink-0 flex items-center justify-end border-t border-gray-200 dark:border-slate-800 pt-4 mt-4">
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </div>
          )}
        </div>
      </Modal>

      <PublishPackDialog
        isOpen={showPublishDialog}
        onClose={() => { setShowPublishDialog(false); setVersionTarget(null); }}
        onPublished={() => loadMyPacks()}
        initialPack={publishInitialPack}
        versionTarget={versionTarget}
      />

      <Modal isOpen={editingPack !== null} onClose={() => setEditingPack(null)} title="Edit Pack" size="sm">
        <div className="p-6 space-y-4">
          <div>
            <label htmlFor="edit-pack-name" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Name</label>
            <input id="edit-pack-name" type="text" value={editPackName} onChange={(e) => setEditPackName(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
          </div>
          <div>
            <label htmlFor="edit-pack-desc" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Description</label>
            <textarea id="edit-pack-desc" rows={3} value={editPackDesc} onChange={(e) => setEditPackDesc(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-gray-900 dark:text-white text-sm resize-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
          </div>
          <div>
            <label htmlFor="edit-pack-visibility" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Visibility</label>
            <select id="edit-pack-visibility" value={editPackVisibility} onChange={(e) => setEditPackVisibility(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent">
              <option value="public">Public — listed in the marketplace</option>
              <option value="unlisted">Unlisted — accessible by link</option>
              <option value="private">Private — only you</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setEditingPack(null)}>Cancel</Button>
            <Button onClick={handleSavePackMeta} disabled={!editPackName.trim() || savingPackMeta} isLoading={savingPackMeta}>Save</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
