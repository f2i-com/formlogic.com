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
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { api, type PackData, type PackImportResult, type PackInstallation } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';
import { useAppStore } from '../../stores/appStore';
import { packCatalog, type PackCatalogEntry } from '../../data/packs';

type Tab = 'catalog' | 'installed' | 'upload';

interface PackImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PackImportModal({ isOpen, onClose }: PackImportModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('catalog');
  const [selectedEntry, setSelectedEntry] = useState<PackCatalogEntry | null>(null);
  const [uploadedPack, setUploadedPack] = useState<PackData | null>(null);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PackImportResult | null>(null);
  const [expandedForms, setExpandedForms] = useState(true);
  const [expandedApps, setExpandedApps] = useState(true);
  const [isDragging, setIsDragging] = useState(false);

  // Installed packs state
  const [installations, setInstallations] = useState<PackInstallation[]>([]);
  const [loadingInstallations, setLoadingInstallations] = useState(false);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshForms = useFormStore((s) => s.refreshForms);
  const fetchApps = useAppStore((s) => s.fetchApps);
  const storageMode = useFormStore((s) => s.storageMode);

  // Clean up auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Load installed packs when modal opens or tab changes to installed
  useEffect(() => {
    if (isOpen && storageMode === 'api') {
      loadInstallations();
    }
  }, [isOpen, storageMode]);

  const loadInstallations = useCallback(async () => {
    setLoadingInstallations(true);
    try {
      const result = await api.getInstalledPacks();
      if (result.data?.installations) {
        setInstallations(result.data.installations);
      }
    } catch {
      // Silently fail — installed tab will show empty
    } finally {
      setLoadingInstallations(false);
    }
  }, []);

  const currentPack: PackData | null = activeTab === 'catalog'
    ? selectedEntry?.pack ?? null
    : activeTab === 'upload'
      ? uploadedPack
      : null;

  const isPackInstalled = useCallback((packId: string) => {
    return installations.some((inst) => inst.packId === packId);
  }, [installations]);

  const resetState = useCallback(() => {
    setSelectedEntry(null);
    setUploadedPack(null);
    setUploadFileName('');
    setUploadError('');
    setImporting(false);
    setImportResult(null);
    setExpandedForms(true);
    setExpandedApps(true);
    setIsDragging(false);
    setConfirmUninstall(null);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    setActiveTab('catalog');
    onClose();
  }, [onClose, resetState]);

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setSelectedEntry(null);
    setUploadedPack(null);
    setUploadFileName('');
    setUploadError('');
    setImportResult(null);
    setConfirmUninstall(null);
  }, []);

  const parseFile = useCallback((file: File) => {
    setUploadError('');
    setUploadedPack(null);
    setUploadFileName('');

    if (!file.name.endsWith('.json')) {
      setUploadError('Only .json files are accepted.');
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
        setUploadError('Failed to parse JSON file. Please check the file format.');
      }
    };
    reader.onerror = () => {
      setUploadError('Failed to read file.');
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) parseFile(file);
    },
    [parseFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) parseFile(file);
      e.target.value = '';
    },
    [parseFile]
  );

  const handleImport = useCallback(async () => {
    if (!currentPack || importing) return;

    setImporting(true);
    try {
      const response = await api.importPack(currentPack);
      if (response.data) {
        setImportResult(response.data);
        await Promise.all([refreshForms(), fetchApps(), loadInstallations()]);
        toast.success(
          'Pack imported successfully',
          `Imported ${response.data.forms.length} form(s) and ${response.data.apps.length} app(s).`
        );
        closeTimerRef.current = setTimeout(() => {
          handleClose();
        }, 1500);
        return;
      } else {
        toast.error('Import failed', response.error || 'No data returned from the server.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred.';
      toast.error('Import failed', message);
    }
    setImporting(false);
  }, [currentPack, importing, refreshForms, fetchApps, loadInstallations, handleClose]);

  const handleUninstall = useCallback(async (installationId: string) => {
    setUninstallingId(installationId);
    try {
      const response = await api.uninstallPack(installationId);
      if (response.data?.success) {
        toast.success(
          'Pack uninstalled',
          response.data.message
        );
        await Promise.all([refreshForms(), fetchApps(), loadInstallations()]);
      } else {
        toast.error('Uninstall failed', response.error || 'Could not uninstall the pack.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred.';
      toast.error('Uninstall failed', message);
    } finally {
      setUninstallingId(null);
      setConfirmUninstall(null);
    }
  }, [refreshForms, fetchApps, loadInstallations]);

  const formCount = currentPack?.forms?.length ?? 0;
  const appCount = currentPack?.apps?.length ?? 0;

  const tabButton = (tab: Tab, icon: React.ReactNode, label: string, badge?: number) => (
    <button
      type="button"
      onClick={() => handleTabChange(tab)}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
        activeTab === tab
          ? 'border-primary-600 text-primary-600 dark:text-primary-400 dark:border-primary-400'
          : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300 dark:hover:border-slate-600'
      }`}
    >
      <span className="inline-flex items-center gap-2">
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

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Pack Manager" size="lg">
      <div className="p-4 sm:p-6 space-y-4">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-slate-800">
          {tabButton('catalog', <Package className="h-4 w-4" />, 'Catalog')}
          {tabButton('installed', <Box className="h-4 w-4" />, 'Installed', installations.length)}
          {tabButton('upload', <Upload className="h-4 w-4" />, 'Upload')}
        </div>

        {/* Import result overlay */}
        {importResult && (
          <div className="flex flex-col items-center justify-center py-8 space-y-3">
            <CheckCircle className="h-12 w-12 text-green-500" />
            <p className="text-lg font-semibold text-gray-900 dark:text-white">
              Import Complete
            </p>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              {importResult.forms.length} form(s) and {importResult.apps.length} app(s) imported.
            </p>
          </div>
        )}

        {/* ==================== CATALOG TAB ==================== */}
        {!importResult && activeTab === 'catalog' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-1">
              {packCatalog.map((entry) => {
                const isSelected = selectedEntry?.id === entry.id;
                const installed = isPackInstalled(entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelectedEntry(isSelected ? null : entry)}
                    className={`text-left p-3 rounded-lg border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-primary-500 dark:border-primary-400 bg-primary-50 dark:bg-primary-500/10 ring-1 ring-primary-500 dark:ring-primary-400'
                        : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-gray-300 dark:hover:border-slate-700 hover:shadow-sm'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl leading-none flex-shrink-0">{entry.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                            {entry.name}
                          </p>
                          {installed && (
                            <Badge variant="success" size="sm">Installed</Badge>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                          {entry.description}
                        </p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 dark:text-slate-400">
                          <span>{entry.formCount} form{entry.formCount !== 1 ? 's' : ''}</span>
                          <span className="text-gray-300 dark:text-slate-600">&middot;</span>
                          <span>{entry.appCount} app{entry.appCount !== 1 ? 's' : ''}</span>
                        </div>
                        {entry.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {entry.tags.map((tag) => (
                              <Badge key={tag} variant="default" size="sm">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
              {packCatalog.length === 0 && (
                <div className="col-span-2 text-center py-8 text-gray-400 dark:text-slate-500">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No pre-built packs available.</p>
                </div>
              )}
            </div>
          </div>
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
                <p className="text-xs mt-1">
                  Browse the Catalog tab to find packs to install.
                </p>
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
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setConfirmUninstall(null)}
                              disabled={uninstallingId === inst.id}
                            >
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
                            className="text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/30 hover:bg-red-50 dark:hover:bg-red-500/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Warning if some resources were manually deleted */}
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

        {/* ==================== UPLOAD TAB ==================== */}
        {!importResult && activeTab === 'upload' && (
          <div className="space-y-4">
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                isDragging
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10 dark:border-primary-400'
                  : uploadedPack
                    ? 'border-green-400 bg-green-50 dark:bg-green-500/10 dark:border-green-500'
                    : 'border-gray-300 dark:border-slate-700 hover:border-gray-400 dark:hover:border-slate-600 bg-gray-50 dark:bg-slate-800/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                className="hidden"
              />
              {uploadedPack ? (
                <>
                  <FileJson className="h-8 w-8 text-green-500 mb-2" />
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {uploadFileName}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                    {uploadedPack.packMeta.name} &mdash; v{uploadedPack.packMeta.version}
                  </p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setUploadedPack(null);
                      setUploadFileName('');
                      setUploadError('');
                    }}
                    className="mt-2 text-xs text-gray-500 dark:text-slate-400 hover:text-red-500 dark:hover:text-red-400 underline cursor-pointer"
                  >
                    Remove file
                  </button>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-gray-400 dark:text-slate-500 mb-2" />
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300">
                    Drop a .json pack file here
                  </p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                    or click to browse
                  </p>
                </>
              )}
            </div>

            {uploadError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 p-3 rounded-lg border border-red-200 dark:border-red-500/30">
                <X className="h-4 w-4 flex-shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}

        {/* ==================== PREVIEW SECTION ==================== */}
        {!importResult && currentPack && (
          <div className="space-y-3 border-t border-gray-200 dark:border-slate-800 pt-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Pack Preview
            </h3>
            <div className="text-xs text-gray-500 dark:text-slate-400 space-y-0.5">
              <p><span className="font-medium text-gray-700 dark:text-slate-300">Name:</span> {currentPack.packMeta.name}</p>
              <p><span className="font-medium text-gray-700 dark:text-slate-300">Description:</span> {currentPack.packMeta.description}</p>
              <p><span className="font-medium text-gray-700 dark:text-slate-300">Version:</span> {currentPack.packMeta.version}</p>
              {currentPack.packMeta.author && (
                <p><span className="font-medium text-gray-700 dark:text-slate-300">Author:</span> {currentPack.packMeta.author}</p>
              )}
            </div>

            {/* Collapsible forms tree */}
            {formCount > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandedForms((v) => !v)}
                  className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
                >
                  {expandedForms ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Forms ({formCount})
                </button>
                {expandedForms && (
                  <ul className="mt-1.5 ml-5 space-y-1">
                    {currentPack.forms.map((form, i) => {
                      const title = (form as Record<string, unknown>).title as string || `Form ${i + 1}`;
                      const fields = Array.isArray((form as Record<string, unknown>).fields)
                        ? ((form as Record<string, unknown>).fields as unknown[]).length
                        : 0;
                      const hasScript = !!(form as Record<string, unknown>).logicScript;
                      return (
                        <li key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                          <FileJson className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-slate-500" />
                          <span className="truncate">{title}</span>
                          <Badge variant="default" size="sm">{fields} field{fields !== 1 ? 's' : ''}</Badge>
                          {hasScript && (
                            <Badge variant="warning" size="sm">script</Badge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {/* Collapsible apps tree */}
            {appCount > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setExpandedApps((v) => !v)}
                  className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
                >
                  {expandedApps ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Apps ({appCount})
                </button>
                {expandedApps && (
                  <ul className="mt-1.5 ml-5 space-y-1">
                    {(currentPack.apps ?? []).map((app, i) => {
                      const name = (app as Record<string, unknown>).name as string || `App ${i + 1}`;
                      const roles = Array.isArray((app as Record<string, unknown>).roles)
                        ? ((app as Record<string, unknown>).roles as Array<{ name?: string }>)
                        : [];
                      const appForms = Array.isArray((app as Record<string, unknown>).forms)
                        ? ((app as Record<string, unknown>).forms as unknown[]).length
                        : 0;
                      return (
                        <li key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                          <Globe className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-slate-500" />
                          <span className="truncate">{name}</span>
                          <Badge variant="default" size="sm">{appForms} form{appForms !== 1 ? 's' : ''}</Badge>
                          {roles.length > 0 && (
                            <span className="text-gray-400 dark:text-slate-500 truncate">
                              {roles.length} role{roles.length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================== ACTION BUTTONS ==================== */}
        {!importResult && activeTab !== 'installed' && (
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-slate-800 pt-4">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleImport}
              disabled={!currentPack}
              isLoading={importing}
              leftIcon={importing ? undefined : <Package className="h-4 w-4" />}
            >
              {importing ? 'Importing...' : 'Import Pack'}
            </Button>
          </div>
        )}

        {/* Close button for installed tab */}
        {!importResult && activeTab === 'installed' && (
          <div className="flex items-center justify-end border-t border-gray-200 dark:border-slate-800 pt-4">
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
