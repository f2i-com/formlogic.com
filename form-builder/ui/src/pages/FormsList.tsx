import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { logger } from '../lib/logger';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
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
    <Card className="hover:shadow-md hover:shadow-gray-900/[0.04] transition-all duration-300">
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
                  {form.fieldCount ?? form.fields?.length ?? 0} fields
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
              aria-label={`Actions for ${form.title}`}
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
                  aria-label={`Actions for ${form.title}`}
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

        <div className="flex items-center justify-between text-xs sm:text-sm">
          <span className="text-slate-500 truncate">
            {formatRelativeTime(form.updatedAt)}
          </span>
          <Badge variant={form.status === 'published' ? 'success' : 'default'} size="sm">
            {responseCount} responses
          </Badge>
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
  const { forms, createForm, setActiveForm, deleteForm, duplicateForm, updateForm } = useFormStore();
  const formsLoading = useFormStore((s) => s.isLoading || !s.isInitialized);
  const { getResponsesByFormId } = useResponseStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'responses'>('modified');
  const [activeMenu, setActiveMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPackImport, setShowPackImport] = useState(false);
  const [packFilter, setPackFilter] = useState<string>('all');
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);

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

  // Unique pack names for filter options
  const packOptions = useMemo(() => {
    const packs = installedPacks.map((p) => ({ id: p.packId, name: p.packName }));
    // Deduplicate by packId
    const seen = new Set<string>();
    return packs.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [installedPacks]);

  // Fetch installed packs on mount
  useEffect(() => {
    api.getInstalledPacks().then((result) => {
      if (!result.error && result.data) {
        setInstalledPacks(result.data.installations);
      }
    });
  }, []);

  // Close dropdown menu on scroll or resize to prevent stale positioning
  useEffect(() => {
    if (!activeMenu) return;
    const close = () => setActiveMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [activeMenu]);

  const handleCreateForm = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const form = await createForm('Untitled Form');
      if (!form) return;
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
    } catch (error) {
      logger.error('Failed to create form:', error);
      toast.error('Failed to create form', 'Please try again');
    } finally {
      setIsCreating(false);
    }
  };

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
    forms
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
          case 'responses':
            return getResponsesByFormId(b.id).length - getResponsesByFormId(a.id).length;
          case 'modified':
          default:
            return parseServerDate(b.updatedAt).getTime() - parseServerDate(a.updatedAt).getTime();
        }
      }),
    [forms, searchQuery, sortBy, getResponsesByFormId, packFilter, formPackIdMap]
  );

  const draftForms = useMemo(() => filteredForms.filter((f) => f.status === 'draft'), [filteredForms]);
  const publishedForms = useMemo(() => filteredForms.filter((f) => f.status === 'published'), [filteredForms]);
  const archivedForms = useMemo(() => filteredForms.filter((f) => f.status === 'archived'), [filteredForms]);

  const renderFormCard = (form: Form) => (
    <FormCard
      key={form.id}
      form={form}
      responseCount={getResponsesByFormId(form.id).length}
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
            <Button variant="outline" size="sm" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />} title="Manage Packs">
              <span className="hidden sm:inline">Manage Packs</span>
            </Button>
            <Button onClick={handleCreateForm} size="sm" leftIcon={<Plus className="h-4 w-4" />} disabled={isCreating} isLoading={isCreating}>
              <span className="hidden sm:inline">New Form</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
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
          {packOptions.length > 0 && (
            <select
              value={packFilter}
              onChange={(e) => setPackFilter(e.target.value)}
              aria-label="Filter by pack"
              className="px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-all duration-200 cursor-pointer w-full sm:w-auto"
            >
              <option value="all">All Packs</option>
              <option value="none">No Pack</option>
              {packOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4" aria-busy={formsLoading && filteredForms.length === 0}>
              {formsLoading && filteredForms.length === 0 && !searchQuery && packFilter === 'all' ? (
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
                        <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
                          Create Form
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : (
                filteredForms.map(renderFormCard)
              )}
            </div>
          </TabsContent>

          <TabsContent value="published">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {publishedForms.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={Globe}
                    title="No published forms"
                    description="Publish a form to make it available to respondents"
                  />
                </div>
              ) : (
                publishedForms.map(renderFormCard)
              )}
            </div>
          </TabsContent>

          <TabsContent value="draft">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {draftForms.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={FileText}
                    title="No drafts"
                    description="Draft forms will appear here while you work on them"
                  />
                </div>
              ) : (
                draftForms.map(renderFormCard)
              )}
            </div>
          </TabsContent>

          <TabsContent value="archived">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {archivedForms.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    icon={Archive}
                    title="No archived forms"
                    description="Archived forms will appear here"
                  />
                </div>
              ) : (
                archivedForms.map(renderFormCard)
              )}
            </div>
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
    </div>
  );
}
