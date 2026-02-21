import { useState, useEffect, useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
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
  Package,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { EmptyState } from '../components/ui/EmptyState';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { toast } from '../stores/toastStore';
import { formatRelativeTime } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { PackImportModal } from '../components/builder/PackImportModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import type { Form } from '../types/form';

// Extracted outside FormsList so React maintains a stable component identity across renders
const FormCard = memo(function FormCard({
  form,
  responseCount,
  activeMenuId,
  activeMenuRect,
  onMenuToggle,
  onMenuClose,
  onNavigate,
  onDuplicate,
  onEmbed,
  onDelete,
}: {
  form: Form;
  responseCount: number;
  activeMenuId: string | null;
  activeMenuRect: DOMRect | null;
  onMenuToggle: (id: string, rect: DOMRect) => void;
  onMenuClose: () => void;
  onNavigate: (path: string) => void;
  onDuplicate: (id: string) => void;
  onEmbed: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const isMenuOpen = activeMenuId === form.id;

  return (
    <Card className="hover:shadow-md hover:shadow-gray-900/[0.04] transition-all duration-300">
      <CardContent>
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="p-2 bg-indigo-50 dark:bg-primary-500/10 rounded-lg flex-shrink-0">
              <FileText className="h-4 w-4 sm:h-5 sm:w-5 text-indigo-600 dark:text-primary-500" />
            </div>
            <div className="min-w-0">
              <h3 className="font-medium text-gray-900 dark:text-white truncate">{form.title}</h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-500">
                {form.fields.length} fields
              </p>
            </div>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Actions for ${form.title}`}
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
                  className="absolute w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 ring-1 ring-black/5 dark:ring-white/[0.06] overflow-hidden"
                  style={{
                    top: activeMenuRect.bottom + 4,
                    left: Math.max(8, activeMenuRect.right - 192),
                  }}
                >
                  <button
                    onClick={() => { onNavigate(`/builder/${form.id}`); onMenuClose(); }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Pencil className="h-4 w-4" /> Edit
                  </button>
                  <button
                    onClick={() => { onNavigate(`/preview/${form.id}`); onMenuClose(); }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Eye className="h-4 w-4" /> Preview
                  </button>
                  <button
                    onClick={() => { onNavigate(`/analytics/${form.id}`); onMenuClose(); }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <BarChart3 className="h-4 w-4" /> Analytics
                  </button>
                  <button
                    onClick={() => { onNavigate(`/responses/${form.id}`); onMenuClose(); }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Table className="h-4 w-4" /> View Data
                  </button>
                  <button
                    onClick={() => onDuplicate(form.id)}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Copy className="h-4 w-4" /> Duplicate
                  </button>
                  <button
                    onClick={() => { onEmbed(form.id, form.title); onMenuClose(); }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Share2 className="h-4 w-4" /> Share & Embed
                  </button>
                  <hr className="my-1 border-gray-100 dark:border-slate-800" />
                  <button
                    onClick={() => { onDelete(form.id, form.title); onMenuClose(); }}
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
  const navigate = useNavigate();
  const { forms, createForm, setActiveForm, deleteForm, duplicateForm } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'responses'>('modified');
  const [activeMenu, setActiveMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPackImport, setShowPackImport] = useState(false);

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
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
    } catch (error) {
      console.error('Failed to create form:', error);
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
      console.error('Failed to duplicate form:', error);
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

  const filteredForms = forms
    .filter((form) => form.title.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.title.localeCompare(b.title);
        case 'responses':
          return getResponsesByFormId(b.id).length - getResponsesByFormId(a.id).length;
        case 'modified':
        default:
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
    });

  const draftForms = filteredForms.filter((f) => f.status === 'draft');
  const publishedForms = filteredForms.filter((f) => f.status === 'published');
  const archivedForms = filteredForms.filter((f) => f.status === 'archived');

  const renderFormCard = (form: Form) => (
    <FormCard
      key={form.id}
      form={form}
      responseCount={getResponsesByFormId(form.id).length}
      activeMenuId={activeMenu?.id ?? null}
      activeMenuRect={activeMenu?.id === form.id ? activeMenu.rect : null}
      onMenuToggle={handleMenuToggle}
      onMenuClose={handleMenuClose}
      onNavigate={handleNavigate}
      onDuplicate={handleDuplicate}
      onEmbed={handleEmbed}
      onDelete={handleDelete}
    />
  );

  return (
    <div className="min-h-screen">
      <Header
        title="My Forms"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />} title="Import Pack">
              <span className="hidden sm:inline">Import Pack</span>
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
            className="px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-all duration-200 cursor-pointer"
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {filteredForms.length === 0 ? (
                <div className="col-span-full">
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
