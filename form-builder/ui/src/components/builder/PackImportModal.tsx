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
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { api, type PackData, type PackImportResult, type PackInstallation, type CatalogPack } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';
import { useAppStore } from '../../stores/appStore';
import { PackDetailView } from './PackDetailView';
import { PublishPackDialog } from './PublishPackDialog';

type Tab = 'marketplace' | 'installed' | 'mypacks' | 'upload';

interface PackImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PackImportModal({ isOpen, onClose }: PackImportModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('marketplace');

  // Marketplace state
  const [catalogPacks, setCatalogPacks] = useState<CatalogPack[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('popular');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // Upload state
  const [uploadedPack, setUploadedPack] = useState<PackData | null>(null);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PackImportResult | null>(null);
  const [expandedForms, setExpandedForms] = useState(true);
  const [expandedApps, setExpandedApps] = useState(true);

  // Installed packs state
  const [installations, setInstallations] = useState<PackInstallation[]>([]);
  const [loadingInstallations, setLoadingInstallations] = useState(false);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

  // My packs state
  const [myPacks, setMyPacks] = useState<CatalogPack[]>([]);
  const [loadingMyPacks, setLoadingMyPacks] = useState(false);

  // Publish dialog
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishInitialPack, setPublishInitialPack] = useState<PackData | null>(null);

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
  }, [isOpen, storageMode]);

  // Debounced search (API-only, mirroring the load effect above)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (isOpen && storageMode === 'api') loadCatalog();
    }, 300);
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

        // Auto-seed official packs when catalog is empty (one-time)
        if (result.data.packs.length === 0 && !searchQuery && !seedAttemptedRef.current) {
          seedAttemptedRef.current = true;
          setSeeding(true);
          try {
            const { packCatalog } = await import('../../data/packs');
            const seedData = packCatalog.map((entry) => ({
              name: entry.name,
              description: entry.description,
              icon: entry.icon,
              tags: entry.tags,
              category: entry.tags[0] === 'finance' ? 'Finance & Compliance'
                : entry.tags[0] === 'safety' ? 'Safety & Quality'
                : entry.tags[0] === 'hr' ? 'Human Resources'
                : entry.tags[0] === 'events' ? 'Event Management'
                : entry.tags[0] === 'customer-service' ? 'Customer Service'
                : 'Operations',
              pack: entry.pack,
            }));
            const seedResult = await api.seedPacks(seedData);
            if (seedResult.data?.success) {
              // Reload the catalog with seeded packs
              const refreshed = await api.browsePacks({ sort: sortBy, limit: 50 });
              if (refreshed.data?.packs) {
                setCatalogPacks(refreshed.data.packs);
              }
            }
          } catch {
            // Seed failed — user just sees empty catalog
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

  const installedCatalogIds = new Set(
    installations.filter((i) => i.catalogId).map((i) => i.catalogId!)
  );

  const resetState = useCallback(() => {
    setUploadedPack(null);
    setUploadFileName('');
    setUploadError('');
    setImporting(false);
    setImportResult(null);
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

  const parseFile = useCallback((file: File) => {
    setUploadError('');
    setUploadedPack(null);
    setUploadFileName('');

    if (file.name.endsWith('.zip')) {
      (async () => {
        try {
          const result = await api.uploadPackZip(file);
          if (result.data?.pack) {
            setUploadedPack(result.data.pack);
            setUploadFileName(file.name);
          } else {
            setUploadError(result.error || 'Failed to parse zip file');
          }
        } catch {
          setUploadError('Failed to upload file');
        }
      })();
      return;
    }

    if (!file.name.endsWith('.json')) {
      setUploadError('Only .json and .zip files are accepted.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File is too large. Maximum size is 10 MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string) as PackData;
        if (!data.formatVersion || !data.packMeta || !Array.isArray(data.forms)) {
          setUploadError('Invalid pack format. Expected formatVersion, packMeta, and forms fields.');
          return;
        }
        setUploadedPack(data);
        setUploadFileName(file.name);
      } catch {
        setUploadError('Failed to parse JSON file.');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleImport = useCallback(async () => {
    if (!uploadedPack || importing) return;
    setImporting(true);
    try {
      const response = await api.importPack(uploadedPack);
      if (response.data) {
        setImportResult(response.data);
        await Promise.all([refreshForms(), fetchApps(), loadInstallations()]);
        toast.success(
          'Pack imported successfully',
          `Imported ${response.data.forms.length} form(s) and ${response.data.apps.length} app(s).`
        );
        closeTimerRef.current = setTimeout(handleClose, 1500);
        return;
      } else {
        toast.error('Import failed', response.error || 'No data returned.');
      }
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : 'Unknown error');
    }
    setImporting(false);
  }, [uploadedPack, importing, refreshForms, fetchApps, loadInstallations, handleClose]);

  const handleUninstall = useCallback(async (installationId: string) => {
    setUninstallingId(installationId);
    try {
      const response = await api.uninstallPack(installationId);
      if (response.data?.success) {
        toast.success('Pack uninstalled', response.data.message);
        await Promise.all([refreshForms(), fetchApps(), loadInstallations()]);
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
    <div className="flex items-center gap-0.5">
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
      className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
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

  return (
    <>
      <Modal isOpen={isOpen} onClose={handleClose} title="Pack Marketplace" size="full">
        <div className="p-4 sm:p-6 space-y-4">
          {/* Tabs */}
          <div className="flex border-b border-gray-200 dark:border-slate-800 overflow-x-auto">
            {tabButton('marketplace', <Package className="h-4 w-4" />, 'Marketplace')}
            {tabButton('installed', <Box className="h-4 w-4" />, 'Installed', installations.length)}
            {tabButton('mypacks', <User className="h-4 w-4" />, 'My Packs')}
            {tabButton('upload', <Upload className="h-4 w-4" />, 'Upload')}
          </div>

          {/* Import result overlay */}
          {importResult && (
            <div className="flex flex-col items-center justify-center py-8 space-y-3">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <p className="text-lg font-semibold text-gray-900 dark:text-white">Import Complete</p>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {importResult.forms.length} form(s) and {importResult.apps.length} app(s) imported.
              </p>
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
                  <p className="text-sm font-medium">No packs found</p>
                  <p className="text-xs mt-1">Try a different search term.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[calc(60vh-8rem)] overflow-y-auto pr-1 -mr-1">
                  {catalogPacks.map((pack) => {
                    const isInstalled = installedCatalogIds.has(pack.id);
                    return (
                      <button
                        key={pack.id}
                        type="button"
                        onClick={() => setSelectedSlug(pack.slug)}
                        className="text-left p-4 rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 hover:border-primary-300 dark:hover:border-primary-500/40 hover:shadow-md hover:shadow-primary-500/5 transition-all cursor-pointer group"
                      >
                        {/* Card header: icon + name row */}
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-2xl leading-none flex-shrink-0">{pack.icon || '📦'}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-gray-900 dark:text-white truncate group-hover:text-primary-700 dark:group-hover:text-primary-300 transition-colors">
                              {pack.name}
                            </p>
                            <p className="text-xs text-gray-400 dark:text-slate-500 truncate">
                              {pack.publisherName || 'FormLogic'}
                            </p>
                          </div>
                          {isInstalled && (
                            <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                          )}
                        </div>

                        {/* Description */}
                        <p className="text-xs text-gray-500 dark:text-slate-400 line-clamp-2 leading-relaxed mb-3">
                          {pack.description}
                        </p>

                        {/* Stats row */}
                        <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            {renderStars(pack.avgRating)}
                          </span>
                          <span className="text-gray-300 dark:text-slate-700">&middot;</span>
                          <span className="inline-flex items-center gap-0.5">
                            <Download className="h-3 w-3" />
                            {pack.downloadCount}
                          </span>
                          <span className="text-gray-300 dark:text-slate-700">&middot;</span>
                          <span>{pack.formCount} forms</span>
                          {pack.appCount > 0 && (
                            <>
                              <span className="text-gray-300 dark:text-slate-700">&middot;</span>
                              <span>{pack.appCount} apps</span>
                            </>
                          )}
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
                <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
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
                          </div>
                          {inst.packDescription && (
                            <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                              {inst.packDescription}
                            </p>
                          )}
                          <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 dark:text-slate-400">
                            <span className="inline-flex items-center gap-1">
                              <FileJson className="h-3 w-3" />
                              {inst.existingFormCount}/{inst.formCount} forms
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Globe className="h-3 w-3" />
                              {inst.existingAppCount}/{inst.appCount} apps
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {new Date(inst.installedAt).toLocaleDateString()}
                            </span>
                          </div>
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
                                {uninstallingId === inst.id ? 'Removing...' : 'Confirm'}
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
                <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                  {myPacks.map((pack) => (
                    <div
                      key={pack.id}
                      className="p-3 rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                    >
                      <div className="flex items-start gap-3">
                        <span className="text-2xl leading-none">{pack.icon || '📦'}</span>
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
                onClick={() => !uploadedPack && fileInputRef.current?.click()}
                className={`relative rounded-xl transition-all ${
                  isDragging
                    ? 'border-2 border-dashed border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 dark:border-primary-400 shadow-lg shadow-primary-500/10'
                    : uploadedPack
                      ? 'border border-green-300 bg-green-50/50 dark:bg-green-500/5 dark:border-green-500/40'
                      : 'border-2 border-dashed border-gray-300 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500/50 bg-gray-50/50 dark:bg-slate-800/30 cursor-pointer group'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.zip"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); e.target.value = ''; }}
                  className="hidden"
                />
                {uploadedPack ? (
                  <div className="flex items-center gap-4 p-4">
                    <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-green-100 dark:bg-green-500/20 flex items-center justify-center">
                      <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{uploadFileName}</p>
                      <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                        {uploadedPack.packMeta.name} &middot; v{uploadedPack.packMeta.version}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                        className="text-xs text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium cursor-pointer"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setUploadedPack(null); setUploadFileName(''); setUploadError(''); }}
                        className="p-1 rounded-md text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
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

          {/* ==================== ACTION BUTTONS ==================== */}
          {!importResult && activeTab === 'upload' && (
            <div className="flex items-center justify-between border-t border-gray-200 dark:border-slate-800 pt-4">
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
                  disabled={!uploadedPack}
                  isLoading={importing}
                  leftIcon={importing ? undefined : <Download className="h-4 w-4" />}
                >
                  {importing ? 'Importing...' : 'Import to My Forms'}
                </Button>
              </div>
            </div>
          )}

          {!importResult && (activeTab === 'installed' || activeTab === 'mypacks') && (
            <div className="flex items-center justify-end border-t border-gray-200 dark:border-slate-800 pt-4">
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </div>
          )}

          {!importResult && activeTab === 'marketplace' && !selectedSlug && (
            <div className="flex items-center justify-end border-t border-gray-200 dark:border-slate-800 pt-4">
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </div>
          )}
        </div>
      </Modal>

      <PublishPackDialog
        isOpen={showPublishDialog}
        onClose={() => setShowPublishDialog(false)}
        onPublished={() => loadMyPacks()}
        initialPack={publishInitialPack}
      />
    </>
  );
}
