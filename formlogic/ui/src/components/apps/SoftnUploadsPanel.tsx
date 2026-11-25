import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  Image as ImageIcon,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  api,
  type NativeAppUploadAccess,
  type NativeAppUploadCategory,
  type NativeAppUploadPolicy,
  type NativeAppUploadRecord,
  type NativeAppUploadStats,
} from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Panel } from '../ui/Panel';
import { toast } from '../../stores/toastStore';
import { API_BASE_URL } from '../../lib/apiBase';
import { cn, copyToClipboard } from '../../lib/utils';

const ACCESS_OPTIONS: readonly { value: NativeAppUploadAccess; label: string; hint: string }[] = [
  { value: 'disabled', label: 'Disabled', hint: 'No uploads accepted through the app runtime.' },
  { value: 'owner', label: 'Owner only', hint: 'Only you can upload files (via this panel or while signed in).' },
  { value: 'members', label: 'Signed-in members', hint: 'Invited app members and the owner can upload files.' },
  { value: 'anyone', label: 'Anyone (public visitors)', hint: 'Public visitors can upload files under your sandbox policy & quotas.' },
];

const CATEGORY_OPTIONS: readonly { value: NativeAppUploadCategory; label: string; exts: string }[] = [
  { value: 'images', label: 'Images', exts: 'PNG, JPG, GIF, WebP (no SVG)' },
  { value: 'documents', label: 'Documents', exts: 'PDF, TXT, CSV, MD, JSON, Office' },
  { value: 'audio', label: 'Audio', exts: 'MP3, WAV, OGG, M4A, FLAC' },
  { value: 'video', label: 'Video', exts: 'MP4, WebM, MOV' },
  { value: 'archives', label: 'Archives', exts: 'ZIP, GZ' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function categoryIcon(category: string) {
  switch (category) {
    case 'images': return ImageIcon;
    case 'audio': return FileAudio;
    case 'video': return FileVideo;
    case 'archives': return Archive;
    default: return FileText;
  }
}

export function SoftnUploadsPanel({
  appId,
  appSlug,
  readOnly = false,
}: {
  appId: string;
  appSlug: string;
  readOnly?: boolean;
}) {
  const [uploads, setUploads] = useState<NativeAppUploadRecord[]>([]);
  const [stats, setStats] = useState<NativeAppUploadStats | null>(null);
  const [policy, setPolicy] = useState<NativeAppUploadPolicy | null>(null);
  const [draftPolicy, setDraftPolicy] = useState<NativeAppUploadPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadFolder, setUploadFolder] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'quarantined'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxFileMbInput, setMaxFileMbInput] = useState('');
  const [quotaMbInput, setQuotaMbInput] = useState('');
  const [activeAppId, setActiveAppId] = useState(appId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadSeqRef = useRef(0);
  const loadedAppIdRef = useRef(appId);
  const policyDirtyRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);

  if (activeAppId !== appId) {
    setActiveAppId(appId);
    setUploads([]);
    setStats(null);
    setPolicy(null);
    setDraftPolicy(null);
    setMaxFileMbInput('');
    setQuotaMbInput('');
    setSelected(new Set());
    setStatusFilter('all');
    setCategoryFilter('all');
    setSearch('');
    setError(null);
    setLoading(true);
    setSavingPolicy(false);
    setUploading(false);
    setDragActive(false);
    setUploadFolder('');
    setBusyIds(new Set());
    setBulkDeleting(false);
    setCopiedId(null);
  }

  const policyDirty = Boolean(policy && draftPolicy && JSON.stringify(policy) !== JSON.stringify(draftPolicy));
  useEffect(() => {
    policyDirtyRef.current = policyDirty;
  }, [policyDirty]);

  useEffect(() => {
    loadedAppIdRef.current = appId;
    policyDirtyRef.current = false;
    loadSeqRef.current += 1;
  }, [appId]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const requestedAppId = appId;
    setLoading(true);
    setError(null);
    const res = await api.listNativeAppUploads(requestedAppId, {
      status: statusFilter,
      category: categoryFilter,
      search: search.trim() || undefined,
      limit: 100,
    });
    if (seq !== loadSeqRef.current || loadedAppIdRef.current !== requestedAppId) return;
    if (res.error || !res.data) {
      setError(res.error || 'Could not load sandboxed uploads.');
    } else {
      const nextPolicy = res.data.policy;
      setUploads(res.data.uploads);
      setStats(res.data.stats);
      setPolicy(nextPolicy);
      if (!policyDirtyRef.current) {
        setDraftPolicy(nextPolicy);
        setMaxFileMbInput(String(nextPolicy.maxFileSizeMb));
        setQuotaMbInput(String(nextPolicy.maxTotalStorageMb));
      }
      setSelected(new Set());
    }
    setLoading(false);
  }, [appId, statusFilter, categoryFilter, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, search ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const clampMaxFileMb = (raw: string, fallback: number): number => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(25, parsed)) : fallback;
  };

  const clampQuotaMb = (raw: string, fallback: number): number => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(10, Math.min(2048, parsed)) : fallback;
  };

  const savePolicy = async () => {
    if (!draftPolicy || readOnly || savingPolicy) return;
    const requestedAppId = appId;
    const clampedPolicy: NativeAppUploadPolicy = {
      ...draftPolicy,
      maxFileSizeMb: clampMaxFileMb(maxFileMbInput, draftPolicy.maxFileSizeMb),
      maxTotalStorageMb: clampQuotaMb(quotaMbInput, draftPolicy.maxTotalStorageMb),
    };
    setDraftPolicy(clampedPolicy);
    setMaxFileMbInput(String(clampedPolicy.maxFileSizeMb));
    setQuotaMbInput(String(clampedPolicy.maxTotalStorageMb));
    setSavingPolicy(true);
    try {
      const res = await api.updateNativeAppUploadPolicy(requestedAppId, clampedPolicy);
      if (loadedAppIdRef.current !== requestedAppId) return;
      if (res.error || !res.data) {
        toast.error('Could not save upload policy', res.error || 'Please check your settings.');
        return;
      }
      policyDirtyRef.current = false;
      setPolicy(res.data.policy);
      setDraftPolicy(res.data.policy);
      setMaxFileMbInput(String(res.data.policy.maxFileSizeMb));
      setQuotaMbInput(String(res.data.policy.maxTotalStorageMb));
      toast.success('Upload sandbox policy saved');
      void load();
    } finally {
      if (loadedAppIdRef.current === requestedAppId) setSavingPolicy(false);
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || readOnly || uploading) return;
    const requestedAppId = appId;
    setUploading(true);
    let okCount = 0;
    try {
      for (const file of Array.from(fileList)) {
        if (loadedAppIdRef.current !== requestedAppId) return;
        const res = await api.uploadNativeAppFile(requestedAppId, file, uploadFolder);
        if (loadedAppIdRef.current !== requestedAppId) return;
        if (res.error) {
          toast.error(`Blocked: ${file.name}`, res.error);
        } else {
          okCount++;
        }
      }
      if (okCount > 0 && loadedAppIdRef.current === requestedAppId) {
        toast.success(okCount === 1 ? 'File uploaded to sandbox' : `${okCount} files uploaded to sandbox`);
        void load();
      }
    } finally {
      if (loadedAppIdRef.current === requestedAppId) setUploading(false);
    }
  };

  const toggleStatus = async (item: NativeAppUploadRecord) => {
    if (readOnly) return;
    const requestedAppId = appId;
    const nextStatus = item.status === 'approved' ? 'quarantined' : 'approved';
    setBusyIds(prev => new Set(prev).add(item.id));
    try {
      const res = await api.updateNativeAppUpload(requestedAppId, item.id, { status: nextStatus });
      if (loadedAppIdRef.current !== requestedAppId) return;
      if (res.error) {
        toast.error('Could not update file status', res.error);
        return;
      }
      toast.success(nextStatus === 'approved' ? 'File approved for app access' : 'File moved to quarantine');
      void load();
    } finally {
      if (loadedAppIdRef.current === requestedAppId) {
        setBusyIds(prev => { const next = new Set(prev); next.delete(item.id); return next; });
      }
    }
  };

  const removeOne = async (item: NativeAppUploadRecord) => {
    if (readOnly) return;
    if (!window.confirm(`Permanently delete "${item.originalFilename}"? This cannot be undone.`)) return;
    const requestedAppId = appId;
    setBusyIds(prev => new Set(prev).add(item.id));
    try {
      const res = await api.deleteNativeAppUpload(requestedAppId, item.id);
      if (loadedAppIdRef.current !== requestedAppId) return;
      if (res.error) {
        toast.error('Could not delete file', res.error);
        return;
      }
      toast.success('File permanently deleted');
      void load();
    } finally {
      if (loadedAppIdRef.current === requestedAppId) {
        setBusyIds(prev => { const next = new Set(prev); next.delete(item.id); return next; });
      }
    }
  };

  const removeSelected = async () => {
    if (readOnly || bulkDeleting || selected.size === 0) return;
    const ids = [...selected];
    if (!window.confirm(`Permanently delete ${ids.length} selected file(s)? This cannot be undone.`)) return;
    const requestedAppId = appId;
    setBulkDeleting(true);
    try {
      const res = await api.bulkDeleteNativeAppUploads(requestedAppId, ids);
      if (loadedAppIdRef.current !== requestedAppId) return;
      if (res.error) {
        toast.error('Bulk delete failed', res.error);
        return;
      }
      toast.success(`Deleted ${res.data?.deleted ?? ids.length} file(s)`);
      void load();
    } finally {
      if (loadedAppIdRef.current === requestedAppId) setBulkDeleting(false);
    }
  };

  const copyUrl = async (item: NativeAppUploadRecord) => {
    const apiOrigin = new URL(API_BASE_URL, window.location.origin).origin;
    const full = new URL(item.url, apiOrigin).toString();
    await copyToClipboard(full);
    setCopiedId(item.id);
    toast.success('Sandboxed file URL copied');
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null;
      setCopiedId(curr => curr === item.id ? null : curr);
    }, 1800);
  };

  const usagePct = stats && stats.quotaBytes > 0
    ? Math.min(100, Math.round((stats.totalBytes / stats.quotaBytes) * 100))
    : 0;

  return (
    <div className="mt-4 space-y-5" data-testid="softn-uploads-panel">
      {/* Top storage & status metrics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Sandboxed Files</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">{stats?.totalFiles ?? 0}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Approved &amp; Active</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{stats?.approvedFiles ?? 0}</p>
        </div>
        <div className={cn(
          'rounded-xl border p-4',
          (stats?.quarantinedFiles ?? 0) > 0
            ? 'border-amber-300 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-500/10'
            : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
        )}>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">In Quarantine</p>
          <p className={cn(
            'mt-1 text-2xl font-semibold',
            (stats?.quarantinedFiles ?? 0) > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-900 dark:text-white',
          )}>
            {stats?.quarantinedFiles ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-500 dark:text-slate-400">App Storage Quota</span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">{usagePct}%</span>
          </div>
          <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
            {formatBytes(stats?.totalBytes ?? 0)} <span className="font-normal text-slate-500 dark:text-slate-400">/ {formatBytes(stats?.quotaBytes ?? 0)}</span>
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className={cn('h-full rounded-full transition-all', usagePct > 85 ? 'bg-amber-500' : 'bg-primary-600')}
              style={{ width: `${usagePct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Main files management table + upload dropzone */}
        <div className="min-w-0 space-y-4">
          {!readOnly && (
            <div
              onDragOver={e => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
              }}
              onDrop={e => { e.preventDefault(); setDragActive(false); void handleFiles(e.dataTransfer.files); }}
              className={cn(
                'rounded-2xl border-2 border-dashed p-5 transition-colors',
                dragActive
                  ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10'
                  : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900',
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                aria-label="Upload files to app sandbox"
                onChange={e => { void handleFiles(e.target.files); e.target.value = ''; }}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-primary-500/15 dark:text-primary-300">
                    <Upload className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">Upload into this app&rsquo;s sandbox</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Drag &amp; drop files here or browse. Every file is inspected via magic bytes, assigned a UUID filename, and isolated outside the webroot.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={uploadFolder}
                    onChange={e => setUploadFolder(e.target.value)}
                    placeholder="Optional folder (e.g. avatars)"
                    className="h-9 w-48 text-xs"
                    aria-label="Target folder"
                  />
                  <Button
                    size="sm"
                    isLoading={uploading}
                    leftIcon={<Upload className="h-4 w-4" />}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Choose files
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Filter & bulk-action toolbar */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search files or folders"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search files or folders…"
                    className="h-8 rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 text-xs text-slate-900 focus:border-primary-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                </div>
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as 'all' | 'approved' | 'quarantined')}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <option value="all">All statuses</option>
                  <option value="approved">Approved</option>
                  <option value="quarantined">Quarantined</option>
                </select>
                <select
                  aria-label="Filter by category"
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                >
                  <option value="all">All categories</option>
                  {CATEGORY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                {selected.size > 0 && !readOnly && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={bulkDeleting}
                    isLoading={bulkDeleting}
                    leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={() => void removeSelected()}
                  >
                    Delete {selected.size}
                  </Button>
                )}
                <Button size="sm" variant="secondary" leftIcon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />} onClick={() => void load()}>
                  Refresh
                </Button>
              </div>
            </div>

            {error && (
              <p role="alert" className="p-4 text-sm text-rose-600 dark:text-rose-400">{error}</p>
            )}

            {!error && loading && uploads.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">Loading sandboxed files…</div>
            ) : !error && uploads.length === 0 ? (
              <div className="p-10 text-center">
                <FolderOpen className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-600" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-200">No uploaded files yet</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Files uploaded by you, your members, or app visitors appear here for inspection, quarantine review, and management.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {uploads.map(item => {
                  const Icon = categoryIcon(item.category);
                  const isBusy = busyIds.has(item.id);
                  const isImage = item.category === 'images';
                  const downloadUrl = api.getNativeAppUploadDownloadUrl(appId, item.id, true);
                  const previewUrl = api.getNativeAppUploadDownloadUrl(appId, item.id, false);
                  return (
                    <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        {!readOnly && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${item.originalFilename}`}
                            checked={selected.has(item.id)}
                            onChange={e => {
                              setSelected(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(item.id); else next.delete(item.id);
                                return next;
                              });
                            }}
                            className="h-4 w-4 rounded border-slate-300 text-primary-600"
                          />
                        )}
                        {isImage && item.status === 'approved' ? (
                          <img
                            src={previewUrl}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 object-cover dark:border-slate-700"
                          />
                        ) : (
                          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                            <Icon className="h-5 w-5" aria-hidden="true" />
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-900 dark:text-white">{item.originalFilename}</span>
                            {item.folder && (
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                {item.folder}/
                              </span>
                            )}
                            {item.status === 'quarantined' ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                                <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                                Quarantined
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                Approved
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                            {formatBytes(item.sizeBytes)} · {item.mimeType.split(';')[0]} · SHA {item.sha256.slice(0, 10)}
                            {item.uploaderLabel ? ` · by ${item.uploaderLabel}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!readOnly && (
                          <Button
                            size="sm"
                            variant={item.status === 'quarantined' ? 'primary' : 'secondary'}
                            disabled={isBusy}
                            onClick={() => void toggleStatus(item)}
                          >
                            {item.status === 'quarantined' ? 'Approve' : 'Quarantine'}
                          </Button>
                        )}
                        <button
                          type="button"
                          title="Copy sandboxed URL"
                          onClick={() => void copyUrl(item)}
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          {copiedId === item.id ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                          URL
                        </button>
                        <a
                          href={downloadUrl}
                          download={item.originalFilename}
                          title="Download file"
                          aria-label={`Download ${item.originalFilename}`}
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                        {item.status === 'approved' && (
                          <a
                            href={previewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open in sandboxed tab"
                            aria-label={`Open ${item.originalFilename} in sandboxed tab`}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        )}
                        {!readOnly && (
                          <button
                            type="button"
                            disabled={isBusy}
                            title="Delete permanently"
                            aria-label={`Delete ${item.originalFilename} permanently`}
                            onClick={() => void removeOne(item)}
                            className="inline-flex h-8 items-center rounded-lg border border-rose-200 px-2 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Developer upload snippet */}
          <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setShowSnippet(v => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              <span className="inline-flex items-center gap-2">
                <Code2 className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                How your app uploads files safely
              </span>
              <span className="text-slate-400">{showSnippet ? 'Hide' : 'Show code'}</span>
            </button>
            {showSnippet && (
              <div className="space-y-3 border-t border-slate-200 p-4 text-xs dark:border-slate-700">
                <p className="text-slate-600 dark:text-slate-300">
                  Inside a hosted JS site or SoftN app, upload via <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">formlogic.upload(file)</code> or standard <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">fetch(&apos;/api/_uploads&apos;)</code>. FormLogic inspects magic bytes, strips filenames, enforces quotas, and serves approved files under <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">/api/app/{appSlug}/native/uploads/&lt;id&gt;</code> with <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">CSP: default-src &apos;none&apos;; sandbox</code>.
                </p>
                <pre className="overflow-x-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100">{`// Option 1 — FormLogic JS helper (in built sites)
const { upload, url, quarantined } = await formlogic.upload(fileInput.files[0], {
  folder: 'attachments',
});

// Option 2 — Standard FormData POST
const fd = new FormData();
fd.append('file', fileInput.files[0]);
fd.append('folder', 'attachments');
const res = await fetch('/api/_uploads', { method: 'POST', body: fd });
const data = await res.json();`}</pre>
              </div>
            )}
          </div>
        </div>

        {/* Right column: Sandbox Policy */}
        <aside className="space-y-4">
          <Panel title="Upload Sandbox Policy" icon={<ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}>
            {draftPolicy ? (
              <div className="space-y-4">
                <fieldset disabled={readOnly || savingPolicy} className="space-y-2">
                  <legend className="text-xs font-semibold text-slate-700 dark:text-slate-200">Who can upload files</legend>
                  {ACCESS_OPTIONS.map(opt => (
                    <label
                      key={opt.value}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5',
                        draftPolicy.access === opt.value
                          ? 'border-primary-400 bg-primary-50/60 dark:border-primary-500/60 dark:bg-primary-500/10'
                          : 'border-slate-200 dark:border-slate-700',
                      )}
                    >
                      <input
                        type="radio"
                        name="native-upload-access"
                        className="mt-0.5"
                        checked={draftPolicy.access === opt.value}
                        onChange={() => setDraftPolicy({ ...draftPolicy, access: opt.value })}
                      />
                      <span>
                        <span className="block text-xs font-semibold text-slate-900 dark:text-white">{opt.label}</span>
                        <span className="block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{opt.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <Switch
                  label="Quarantine new uploads for review"
                  description="Non-owner uploads stay hidden (403) until you click Approve here."
                  checked={draftPolicy.requireQuarantineReview}
                  disabled={readOnly || savingPolicy}
                  onChange={checked => setDraftPolicy({ ...draftPolicy, requireQuarantineReview: checked })}
                />

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="upload-max-mb" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      Max file (MB)
                    </label>
                    <Input
                      id="upload-max-mb"
                      type="number"
                      min={1}
                      max={25}
                      value={maxFileMbInput}
                      disabled={readOnly || savingPolicy}
                      onChange={e => {
                        const raw = e.target.value;
                        setMaxFileMbInput(raw);
                        const parsed = Number.parseInt(raw, 10);
                        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 25) {
                          setDraftPolicy({ ...draftPolicy, maxFileSizeMb: parsed });
                        }
                      }}
                      onBlur={() => {
                        const clamped = clampMaxFileMb(maxFileMbInput, draftPolicy.maxFileSizeMb);
                        setMaxFileMbInput(String(clamped));
                        setDraftPolicy({ ...draftPolicy, maxFileSizeMb: clamped });
                      }}
                      className="mt-1 h-9 text-xs"
                    />
                  </div>
                  <div>
                    <label htmlFor="upload-quota-mb" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      App quota (MB)
                    </label>
                    <Input
                      id="upload-quota-mb"
                      type="number"
                      min={10}
                      max={2048}
                      value={quotaMbInput}
                      disabled={readOnly || savingPolicy}
                      onChange={e => {
                        const raw = e.target.value;
                        setQuotaMbInput(raw);
                        const parsed = Number.parseInt(raw, 10);
                        if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 2048) {
                          setDraftPolicy({ ...draftPolicy, maxTotalStorageMb: parsed });
                        }
                      }}
                      onBlur={() => {
                        const clamped = clampQuotaMb(quotaMbInput, draftPolicy.maxTotalStorageMb);
                        setQuotaMbInput(String(clamped));
                        setDraftPolicy({ ...draftPolicy, maxTotalStorageMb: clamped });
                      }}
                      className="mt-1 h-9 text-xs"
                    />
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Allowed file categories</p>
                  <div className="mt-2 space-y-1.5">
                    {CATEGORY_OPTIONS.map(cat => {
                      const active = draftPolicy.allowedCategories.includes(cat.value);
                      return (
                        <label key={cat.value} className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-xs dark:border-slate-700">
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={active}
                              disabled={readOnly || savingPolicy}
                              onChange={e => {
                                const next = e.target.checked
                                  ? [...draftPolicy.allowedCategories, cat.value]
                                  : draftPolicy.allowedCategories.filter(c => c !== cat.value);
                                if (next.length === 0) return;
                                setDraftPolicy({ ...draftPolicy, allowedCategories: next });
                              }}
                            />
                            <span className="font-medium text-slate-800 dark:text-slate-200">{cat.label}</span>
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">{cat.exts}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {!readOnly && (
                  <Button
                    className="w-full"
                    size="sm"
                    disabled={!policyDirty || savingPolicy}
                    isLoading={savingPolicy}
                    onClick={() => void savePolicy()}
                  >
                    Save sandbox policy
                  </Button>
                )}

                <div className="rounded-xl bg-emerald-50/70 p-3 text-[11px] leading-4 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
                  <p className="font-semibold">Hardened by default</p>
                  <p className="mt-1">
                    Active web/server files (<code className="font-mono">.php</code>, <code className="font-mono">.js</code>, <code className="font-mono">.html</code>, <code className="font-mono">.svg</code>), double extensions, spoofed MIME headers, and script polyglots are always rejected. Files are stored outside webroot under UUID names and served with <code className="font-mono">nosniff</code> + <code className="font-mono">CSP sandbox</code>.
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">Loading policy…</p>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
