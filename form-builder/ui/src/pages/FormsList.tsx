import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { logger } from '../lib/logger';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useCreateFormFlow } from '../hooks/useCreateFormFlow';
import {
  Plus,
  Search,
  MoreVertical,
  Pencil,
  Eye,
  BarChart3,
  Copy,
  Trash2,
  Table,
  Share2,
  Inbox,
  Globe,
  Archive,
  ArchiveRestore,
  EyeOff,
  Package,
  FileText,
  Boxes,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { EmptyState } from '../components/ui/EmptyState';
import { FormCardSkeleton } from '../components/ui/Skeleton';
import { ShowMore } from '../components/ui/ShowMore';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { toast } from '../stores/toastStore';
import { formatRelativeTime, parseServerDate } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { PackImportModal } from '../components/builder/PackImportModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { api } from '../lib/api';
import type { PackInstallation } from '../lib/api';
import type { Form } from '../types/form';

// Incremental pagination page sizes for the card grids.
const FORMS_PAGE = 12;
const APPS_PAGE = 8;

// Extracted outside FormsList so React maintains a stable component identity across renders
const FormCard = memo(function FormCard({
  form,
  responseCount,
  packName,
  activeMenuId,
  activeMenuRect,
  onMenuToggle,
  onMenuClose,
  onNavigate,
  onDuplicate,
  onEmbed,
  onDelete,
  onStatusChange,
}: {
  form: Form;
  responseCount: number;
  packName: string | null;
  activeMenuId: string | null;
  activeMenuRect: DOMRect | null;
  onMenuToggle: (id: string, rect: DOMRect) => void;
  onMenuClose: () => void;
  onNavigate: (path: string) => void;
  onDuplicate: (id: string) => void;
  onEmbed: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
  onStatusChange: (id: string, status: 'draft' | 'published' | 'archived') => void;
}) {
  const isMenuOpen = activeMenuId === form.id;

  return (
    <Card className="hover:shadow-md hover:shadow-gray-900/[0.04] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-300">
      <CardContent>
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="p-2 bg-indigo-50 dark:bg-primary-500/10 rounded-lg flex-shrink-0">
              <DynamicIcon name={form.icon} className="h-4 w-4 sm:h-5 sm:w-5 text-indigo-600 dark:text-primary-500" />
            </div>
            <div className="min-w-0">
              <h3 className="font-medium text-gray-900 dark:text-white truncate">{form.title || 'Untitled Form'}</h3>
              <div className="flex items-center gap-2">
                <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-500">
                  {(() => { const n = form.fieldCount ?? form.fields?.length ?? 0; return `${n} field${n === 1 ? '' : 's'}`; })()}
                </p>
                {packName && (
                  <Badge variant="info" size="sm">
                    <Package className="h-3 w-3 mr-1 inline" />
                    {packName}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Actions for ${form.title || 'Untitled Form'}`}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={(e) => {
                e.stopPropagation();
                if (isMenuOpen) {
                  onMenuClose();
                } else {
                  onMenuToggle(form.id, e.currentTarget.getBoundingClientRect());
                }
              }}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>

            {isMenuOpen && activeMenuRect && createPortal(
              <div
                className="fixed inset-0 z-[60]"
                style={{ zIndex: 60 }}
              >
                <div
                  className="absolute inset-0 bg-transparent"
                  onClick={onMenuClose}
                />
                <div
                  role="menu"
                  aria-label={`Actions for ${form.title || 'Untitled Form'}`}
                  className="absolute w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 ring-1 ring-black/5 dark:ring-white/[0.06] overflow-hidden max-h-[80vh] overflow-y-auto"
                  style={{
                    ...(activeMenuRect.bottom + 280 > window.innerHeight
                      ? { bottom: window.innerHeight - activeMenuRect.top + 4 }
                      : { top: activeMenuRect.bottom + 4 }),
                    left: Math.max(8, activeMenuRect.right - 192),
                  }}
                >
                  <button
                    onClick={() => { onNavigate(`/builder/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Pencil className="h-4 w-4" /> Edit
                  </button>
                  <button
                    onClick={() => { onNavigate(`/preview/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Eye className="h-4 w-4" /> Preview
                  </button>
                  <button
                    onClick={() => { onNavigate(`/analytics/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <BarChart3 className="h-4 w-4" /> Analytics
                  </button>
                  <button
                    onClick={() => { onNavigate(`/responses/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Table className="h-4 w-4" /> View Data
                  </button>
                  <button
                    onClick={() => onDuplicate(form.id)}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Copy className="h-4 w-4" /> Duplicate
                  </button>
                  <button
                    onClick={() => { onEmbed(form.id, form.title); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Share2 className="h-4 w-4" /> Share & Embed
                  </button>
                  <hr className="my-1 border-gray-100 dark:border-slate-800" />
                  {form.status !== 'published' && form.status !== 'archived' && (
                    <button
                      onClick={() => { onStatusChange(form.id, 'published'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Globe className="h-4 w-4" /> Publish
                    </button>
                  )}
                  {form.status === 'published' && (
                    <button
                      onClick={() => { onStatusChange(form.id, 'draft'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <EyeOff className="h-4 w-4" /> Unpublish
                    </button>
                  )}
                  {form.status === 'archived' ? (
                    <button
                      onClick={() => { onStatusChange(form.id, 'draft'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <ArchiveRestore className="h-4 w-4" /> Restore to draft
                    </button>
                  ) : (
                    <button
                      onClick={() => { onStatusChange(form.id, 'archived'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Archive className="h-4 w-4" /> Archive
                    </button>
                  )}
                  <hr className="my-1 border-gray-100 dark:border-slate-800" />
                  <button
                    onClick={() => { onDelete(form.id, form.title); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </div>
              </div>,
              document.body
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
          <span className="text-slate-500 truncate">
            {formatRelativeTime(form.updatedAt)}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Status as its own badge; the count is neutral text so color no longer
                stands in for lifecycle status. */}
            <Badge variant={form.status === 'published' ? 'success' : 'default'} size="sm" className="capitalize">
              {form.status}
            </Badge>
            <span className="text-slate-500">{`${responseCount} response${responseCount === 1 ? '' : 's'}`}</span>
          </div>
        </div>

        <div className="flex gap-2 mt-3 sm:mt-4">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onNavigate(`/builder/${form.id}`)}
          >
            Edit
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            onClick={() => onNavigate(`/preview/${form.id}`)}
          >
            Preview
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});

export function FormsList() {
  useDocumentTitle('My Forms');
  const navigate = useNavigate();
  const { forms, setActiveForm, deleteForm, duplicateForm, updateForm } = useFormStore();
  // "New Form" / "Create Form" open the New Form picker (template or blank).
  const { openNewForm, newFormPicker } = useCreateFormFlow();
  const formsLoading = useFormStore((s) => s.isLoading || !s.isInitialized);
  const storageMode = useFormStore((s) => s.storageMode);
  const { getResponsesByFormId } = useResponseStore();
  // Cloud mode keeps responses on the server, so the local store is empty — use the
  // server-provided per-form count there (falls back to the local store offline/local).
  const responseCountOf = (form: Form) =>
    storageMode === 'api' ? (form.responseCount ?? 0) : getResponsesByFormId(form.id).length;
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'responses'>('modified');
  const [activeMenu, setActiveMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showPackImport, setShowPackImport] = useState(false);
  const [packFilter, setPackFilter] = useState<string>('all');
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);
  // App grouping: which forms belong to which app, and the current drill-in.
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appGroups, setAppGroups] = useState<Array<{ id: string; name: string; formIds: string[] }>>([]);
  // Apps load async — track it so the section reserves space (skeleton) instead of popping in.
  const [appsLoading, setAppsLoading] = useState(() => useFormStore.getState().storageMode === 'api');
  // Incremental pagination limits.
  const [appLimit, setAppLimit] = useState(APPS_PAGE);
  const [formLimit, setFormLimit] = useState(FORMS_PAGE);

  // Build formId → packName map from installed packs
  const formPackMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const formId of pack.formIds ?? []) {
        map[formId] = pack.packName;
      }
    }
    return map;
  }, [installedPacks]);

  // Build formId → packId map for filtering
  const formPackIdMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const formId of pack.formIds ?? []) {
        map[formId] = pack.packId;
      }
    }
    return map;
  }, [installedPacks]);

  // Fetch installed packs on mount
  useEffect(() => {
    api.getInstalledPacks().then((result) => {
      if (!result.error && result.data) {
        setInstalledPacks(result.data.installations);
      }
    });
  }, []);

  // Load apps + their form memberships so My Forms can group forms by app (cloud mode only).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (storageMode !== 'api') { if (!cancelled) { setAppGroups([]); setAppsLoading(false); } return; }
      if (!cancelled) setAppsLoading(true);
      try {
        const res = await api.getApps();
        const apps = (res.data?.apps || []) as Array<{ id: string; name: string }>;
        const groups = await Promise.all(apps.map(async (a) => {
          const fr = await api.getAppForms(a.id);
          const formIds = ((fr.data?.forms || []) as Array<{ formId: string }>).map((f) => f.formId);
          return { id: a.id, name: a.name, formIds };
        }));
        if (!cancelled) setAppGroups(groups);
      } finally {
        if (!cancelled) setAppsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [storageMode]);

  // formId → its app (for grouping standalone vs in-app forms).
  const formToApp = useMemo(() => {
    const map: Record<string, { id: string; name: string }> = {};
    for (const g of appGroups) for (const fid of g.formIds) map[fid] = { id: g.id, name: g.name };
    return map;
  }, [appGroups]);

  // The forms to show in the current view: a drilled-in app's forms, or top-level standalone forms.
  // While apps are still loading at the top level, hold the list empty so we show skeletons instead of
  // briefly listing in-app forms and then filtering them out (which caused a visible jump).
  const viewForms = useMemo(() => {
    if (selectedAppId) {
      const ids = new Set(appGroups.find((g) => g.id === selectedAppId)?.formIds ?? []);
      return forms.filter((f) => ids.has(f.id));
    }
    if (storageMode === 'api' && appsLoading) return [];
    return forms.filter((f) => !formToApp[f.id]);
  }, [forms, selectedAppId, appGroups, formToApp, storageMode, appsLoading]);

  const selectedApp = selectedAppId ? appGroups.find((g) => g.id === selectedAppId) : null;
  // The grid is "loading" while forms load, or while apps load at the top level (grouping not ready yet).
  const gridLoading = formsLoading || (storageMode === 'api' && appsLoading && !selectedAppId);

  // Close dropdown menu on scroll, resize, or Escape to prevent stale positioning
  useEffect(() => {
    if (!activeMenu) return;
    const close = () => setActiveMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveMenu(null); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [activeMenu]);

  const handleNavigate = useCallback((path: string) => {
    navigate(path);
  }, [navigate]);

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const newForm = await duplicateForm(id);
      if (newForm) {
        setActiveForm(newForm.id);
        navigate(`/builder/${newForm.id}`);
      }
    } catch (error) {
      logger.error('Failed to duplicate form:', error);
      toast.error('Failed to duplicate form', 'Please try again');
    }
    setActiveMenu(null);
  }, [duplicateForm, setActiveForm, navigate]);

  const handleMenuToggle = useCallback((id: string, rect: DOMRect) => {
    setActiveMenu({ id, rect });
  }, []);

  const handleMenuClose = useCallback(() => {
    setActiveMenu(null);
  }, []);

  const handleEmbed = useCallback((id: string, title: string) => {
    setEmbedModalForm({ id, title });
  }, []);

  const handleDelete = useCallback((id: string, title: string) => {
    setDeleteTarget({ id, title });
  }, []);

  const handleStatusChange = useCallback(async (id: string, status: 'draft' | 'published' | 'archived') => {
    try {
      await updateForm(id, { status });
      const label = status === 'published' ? 'published' : status === 'archived' ? 'archived' : 'moved to draft';
      toast.success('Form updated', `Form ${label}.`);
    } catch (error) {
      logger.error('Failed to update form status:', error);
      toast.error('Update failed', 'Could not change the form status.');
    }
  }, [updateForm]);

  const filteredForms = useMemo(() =>
    viewForms
      .filter((form) => {
        if (!form.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        if (packFilter === 'all') return true;
        if (packFilter === 'none') return !formPackIdMap[form.id];
        return formPackIdMap[form.id] === packFilter;
      })
      .sort((a, b) => {
        switch (sortBy) {
          case 'name':
            return a.title.localeCompare(b.title);
          case 'responses': {
            const ca = storageMode === 'api' ? (a.responseCount ?? 0) : getResponsesByFormId(a.id).length;
            const cb = storageMode === 'api' ? (b.responseCount ?? 0) : getResponsesByFormId(b.id).length;
            return cb - ca;
          }
          case 'modified':
          default:
            return parseServerDate(b.updatedAt).getTime() - parseServerDate(a.updatedAt).getTime();
        }
      }),
    [viewForms, searchQuery, sortBy, getResponsesByFormId, packFilter, formPackIdMap, storageMode]
  );

  const draftForms = useMemo(() => filteredForms.filter((f) => f.status === 'draft'), [filteredForms]);
  const publishedForms = useMemo(() => filteredForms.filter((f) => f.status === 'published'), [filteredForms]);
  const archivedForms = useMemo(() => filteredForms.filter((f) => f.status === 'archived'), [filteredForms]);

  const renderFormCard = (form: Form) => (
    <FormCard
      key={form.id}
      form={form}
      responseCount={responseCountOf(form)}
      packName={formPackMap[form.id] ?? null}
      activeMenuId={activeMenu?.id ?? null}
      activeMenuRect={activeMenu?.id === form.id ? activeMenu.rect : null}
      onMenuToggle={handleMenuToggle}
      onMenuClose={handleMenuClose}
      onNavigate={handleNavigate}
      onDuplicate={handleDuplicate}
      onEmbed={handleEmbed}
      onDelete={handleDelete}
      onStatusChange={handleStatusChange}
    />
  );

  return (
    <div className="min-h-screen">
      <Header
        title="My Forms"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />} aria-label="Manage Packs" title="Manage Packs">
              <span className="hidden sm:inline">Manage Packs</span>
            </Button>
            <Button onClick={openNewForm} size="sm" leftIcon={<Plus className="h-4 w-4" />}>
              <span className="hidden sm:inline">New Form</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Breadcrumb when drilled into an app */}
        {selectedAppId && (
          <nav className="mb-4 flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
            <button onClick={() => setSelectedAppId(null)} className="text-gray-500 dark:text-slate-400 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer">My Forms</button>
            <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600" />
            <span className="font-medium text-gray-900 dark:text-white inline-flex items-center gap-1.5"><Boxes className="h-4 w-4 text-primary-600 dark:text-primary-400" />{selectedApp?.name ?? 'App'}</span>
          </nav>
        )}

        {/* Apps grouping (top level only). Rendered as a skeleton while apps load so it reserves space
            instead of popping in and shifting the forms below. */}
        {!selectedAppId && storageMode === 'api' && (appsLoading || appGroups.length > 0) && (
          <div className="mb-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-2.5 flex items-center gap-2">
              Apps {appsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400 dark:text-slate-500" />}
            </h2>
            {appsLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" aria-busy="true">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 animate-pulse">
                    <div className="h-9 w-9 rounded-lg bg-gray-200 dark:bg-slate-700 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-2/3 rounded bg-gray-200 dark:bg-slate-700" />
                      <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-slate-700" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {appGroups.slice(0, appLimit).map((g) => (
                    <button
                      key={g.id}
                      onClick={() => { setSelectedAppId(g.id); setSearchQuery(''); }}
                      className="flex items-center gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer"
                    >
                      <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-500/10 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 transition-colors shrink-0">
                        <Boxes className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{g.name}</span>
                        <span className="block text-xs text-gray-500 dark:text-slate-400">{g.formIds.length} form{g.formIds.length === 1 ? '' : 's'}</span>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 shrink-0" />
                    </button>
                  ))}
                </div>
                <ShowMore shown={Math.min(appLimit, appGroups.length)} total={appGroups.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" className="mt-3" />
              </>
            )}
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mt-6 mb-1">Standalone forms</h2>
          </div>
        )}

        {/* Search and Sort */}
        <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row gap-3">
          <Input
            placeholder="Search forms..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" />}
            className="w-full sm:max-w-md"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'modified' | 'name' | 'responses')}
            aria-label="Sort forms by"
            className="px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-all duration-200 cursor-pointer w-full sm:w-auto"
          >
            <option value="modified">Last Modified</option>
            <option value="name">Name A-Z</option>
            <option value="responses">Most Responses</option>
          </select>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="all">
          <TabsList className="mb-4 sm:mb-6 overflow-x-auto flex-nowrap">
            <TabsTrigger value="all">All ({filteredForms.length})</TabsTrigger>
            <TabsTrigger value="published">Published ({publishedForms.length})</TabsTrigger>
            <TabsTrigger value="draft">Drafts ({draftForms.length})</TabsTrigger>
            <TabsTrigger value="archived">Archived ({archivedForms.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4" aria-busy={gridLoading && filteredForms.length === 0}>
              {gridLoading && filteredForms.length === 0 && !searchQuery && packFilter === 'all' ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : filteredForms.length === 0 ? (
                <div className="col-span-full">
                  {(searchQuery || packFilter !== 'all') ? (
                    <EmptyState
                      icon={Search}
                      title="No forms match your filters"
                      description="Try a different search term, or clear the filters to see all your forms."
                      action={
                        <Button variant="outline" onClick={() => { setSearchQuery(''); setPackFilter('all'); }}>
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={Inbox}
                      title="No forms yet"
                      description="Create your first form to get started"
                      action={
                        <Button onClick={openNewForm} leftIcon={<Plus className="h-4 w-4" />}>
                          Create Form
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : (
                filteredForms.slice(0, formLimit).map(renderFormCard)
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, filteredForms.length)} total={filteredForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>

          <TabsContent value="published">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
              {gridLoading && publishedForms.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : publishedForms.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={Globe}
                    title="No published forms"
                    description="Publish a form to make it available to respondents"
                  />
                </div>
              ) : (
                publishedForms.slice(0, formLimit).map(renderFormCard)
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, publishedForms.length)} total={publishedForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>

          <TabsContent value="draft">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
              {gridLoading && draftForms.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : draftForms.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={FileText}
                    title="No drafts"
                    description="Draft forms will appear here while you work on them"
                  />
                </div>
              ) : (
                draftForms.slice(0, formLimit).map(renderFormCard)
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, draftForms.length)} total={draftForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>

          <TabsContent value="archived">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
              {gridLoading && archivedForms.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : archivedForms.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={Archive}
                    title="No archived forms"
                    description="Archived forms will appear here"
                  />
                </div>
              ) : (
                archivedForms.slice(0, formLimit).map(renderFormCard)
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, archivedForms.length)} total={archivedForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>
        </Tabs>
      </div>

      {/* Embed Modal */}
      {embedModalForm && (
        <EmbedModal
          isOpen={true}
          onClose={() => setEmbedModalForm(null)}
          formId={embedModalForm.id}
          formTitle={embedModalForm.title}
        />
      )}

      {/* Pack Import Modal */}
      <PackImportModal
        isOpen={showPackImport}
        onClose={() => setShowPackImport(false)}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteForm(deleteTarget.id);
            setDeleteTarget(null);
          }
        }}
        title="Delete Form"
        message={`Are you sure you want to delete "${deleteTarget?.title || 'this form'}"? This action cannot be undone and all responses will be lost.`}
        confirmLabel="Delete"
        variant="danger"
      />

      {newFormPicker}
    </div>
  );
}
