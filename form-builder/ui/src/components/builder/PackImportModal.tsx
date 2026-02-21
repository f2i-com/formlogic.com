import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Package,
  Upload,
  FileJson,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  X,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { api, type PackData, type PackImportResult } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';
import { packCatalog, type PackCatalogEntry } from '../../data/packs';

type Tab = 'catalog' | 'upload';

interface PackImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PackImportModal({ isOpen, onClose }: PackImportModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('catalog');
  const [selectedEntry, setSelectedEntry] = useState<PackCatalogEntry | null>(null);
  const [uploadedPack, setUploadedPack] = useState<PackData | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string>('');
  const [uploadError, setUploadError] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PackImportResult | null>(null);
  const [expandedForms, setExpandedForms] = useState(true);
  const [expandedApps, setExpandedApps] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshForms = useFormStore((s) => s.refreshForms);

  // Clean up auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const currentPack: PackData | null = activeTab === 'catalog'
    ? selectedEntry?.pack ?? null
    : uploadedPack;

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
      if (file) {
        parseFile(file);
      }
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
      if (file) {
        parseFile(file);
      }
      // Reset input so the same file can be selected again
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
        await refreshForms();
        toast.success(
          'Pack imported successfully',
          `Imported ${response.data.forms.length} form(s) and ${response.data.apps.length} app(s).`
        );
        // Close after a brief delay so the user can see the result
        // Keep importing=true to prevent double-click during delay
        closeTimerRef.current = setTimeout(() => {
          handleClose();
        }, 1500);
        return; // Skip finally's setImporting(false)
      } else {
        toast.error('Import failed', response.error || 'No data returned from the server.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred.';
      toast.error('Import failed', message);
    }
    setImporting(false);
  }, [currentPack, importing, refreshForms, handleClose]);

  const formCount = currentPack?.forms?.length ?? 0;
  const appCount = currentPack?.apps?.length ?? 0;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import Pack" size="lg">
      <div className="p-4 sm:p-6 space-y-4">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-slate-800">
          <button
            type="button"
            onClick={() => handleTabChange('catalog')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'catalog'
                ? 'border-primary-600 text-primary-600 dark:text-primary-400 dark:border-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300 dark:hover:border-slate-600'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <Package className="h-4 w-4" />
              Pre-built Packs
            </span>
          </button>
          <button
            type="button"
            onClick={() => handleTabChange('upload')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'upload'
                ? 'border-primary-600 text-primary-600 dark:text-primary-400 dark:border-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300 dark:hover:border-slate-600'
            }`}
          >
            <span className="inline-flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Upload JSON
            </span>
          </button>
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

        {/* Tab content */}
        {!importResult && activeTab === 'catalog' && (
          <div className="space-y-4">
            {/* Catalog grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-1">
              {packCatalog.map((entry) => {
                const isSelected = selectedEntry?.id === entry.id;
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
                        <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                          {entry.name}
                        </p>
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

        {!importResult && activeTab === 'upload' && (
          <div className="space-y-4">
            {/* File drop zone */}
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

        {/* Preview section */}
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
                  {expandedForms ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  Forms ({formCount})
                </button>
                {expandedForms && (
                  <ul className="mt-1.5 ml-5 space-y-1">
                    {currentPack.forms.map((form, i) => {
                      const title = (form as Record<string, unknown>).title as string || `Form ${i + 1}`;
                      const fields = Array.isArray((form as Record<string, unknown>).fields)
                        ? ((form as Record<string, unknown>).fields as unknown[]).length
                        : 0;
                      return (
                        <li key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                          <FileJson className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-slate-500" />
                          <span className="truncate">{title}</span>
                          <Badge variant="default" size="sm">{fields} field{fields !== 1 ? 's' : ''}</Badge>
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
                  {expandedApps ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  Apps ({appCount})
                </button>
                {expandedApps && (
                  <ul className="mt-1.5 ml-5 space-y-1">
                    {(currentPack.apps ?? []).map((app, i) => {
                      const name = (app as Record<string, unknown>).name as string || `App ${i + 1}`;
                      const roles = Array.isArray((app as Record<string, unknown>).roles)
                        ? ((app as Record<string, unknown>).roles as Array<{ name?: string }>)
                        : [];
                      return (
                        <li key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                          <Package className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-slate-500" />
                          <span className="truncate">{name}</span>
                          {roles.length > 0 && (
                            <span className="text-gray-400 dark:text-slate-500">
                              ({roles.map((r) => r.name || 'Unnamed').join(', ')})
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

        {/* Action buttons */}
        {!importResult && (
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
      </div>
    </Modal>
  );
}
