import { useState } from 'react';
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
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { EmptyState } from '../components/ui/EmptyState';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { formatRelativeTime } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import type { Form } from '../types/form';

export function FormsList() {
  const navigate = useNavigate();
  const { forms, createForm, setActiveForm, deleteForm, duplicateForm } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);

  const handleCreateForm = async () => {
    const form = await createForm('Untitled Form');
    setActiveForm(form.id);
    navigate(`/builder/${form.id}`);
  };

  const handleDuplicate = async (id: string) => {
    const newForm = await duplicateForm(id);
    if (newForm) {
      setActiveForm(newForm.id);
      navigate(`/builder/${newForm.id}`);
    }
    setActiveMenu(null);
  };

  const filteredForms = forms.filter((form) =>
    form.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const draftForms = filteredForms.filter((f) => f.status === 'draft');
  const publishedForms = filteredForms.filter((f) => f.status === 'published');
  const archivedForms = filteredForms.filter((f) => f.status === 'archived');

  const FormCard = ({ form }: { form: Form }) => {
    const responses = getResponsesByFormId(form.id);
    const isMenuOpen = activeMenu === form.id;

    return (
      <Card className="hover:shadow-md transition-shadow">
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
                onClick={() => setActiveMenu(isMenuOpen ? null : form.id)}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>

              {isMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setActiveMenu(null)}
                  />
                  <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-gray-100 dark:border-slate-800 z-20 py-1 ring-1 ring-black/5 dark:ring-white/5">
                    <button
                      onClick={() => {
                        navigate(`/builder/${form.id}`);
                        setActiveMenu(null);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <Pencil className="h-4 w-4" /> Edit
                    </button>
                    <button
                      onClick={() => {
                        navigate(`/preview/${form.id}`);
                        setActiveMenu(null);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <Eye className="h-4 w-4" /> Preview
                    </button>
                    <button
                      onClick={() => {
                        navigate(`/analytics/${form.id}`);
                        setActiveMenu(null);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <BarChart3 className="h-4 w-4" /> Analytics
                    </button>
                    <button
                      onClick={() => {
                        navigate(`/responses/${form.id}`);
                        setActiveMenu(null);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <Table className="h-4 w-4" /> View Data
                    </button>
                    <button
                      onClick={() => handleDuplicate(form.id)}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <Copy className="h-4 w-4" /> Duplicate
                    </button>
                    <button
                      onClick={() => {
                        setEmbedModalForm({ id: form.id, title: form.title });
                        setActiveMenu(null);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800"
                    >
                      <Share2 className="h-4 w-4" /> Share & Embed
                    </button>
                    <hr className="my-1 border-gray-100 dark:border-slate-800" />
                    <button
                      onClick={() => {
                        deleteForm(form.id);
                        setActiveMenu(null);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4" /> Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between text-xs sm:text-sm">
            <span className="text-slate-500 truncate">
              {formatRelativeTime(form.updatedAt)}
            </span>
            <Badge variant={form.status === 'published' ? 'success' : 'default'} size="sm">
              {responses.length} responses
            </Badge>
          </div>

          <div className="flex gap-2 mt-3 sm:mt-4">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => navigate(`/builder/${form.id}`)}
            >
              Edit
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              onClick={() => navigate(`/preview/${form.id}`)}
            >
              Preview
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="min-h-screen">
      <Header
        title="My Forms"
        actions={
          <Button onClick={handleCreateForm} size="sm" leftIcon={<Plus className="h-4 w-4" />}>
            <span className="hidden sm:inline">New Form</span>
            <span className="sm:hidden">New</span>
          </Button>
        }
      />

      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        {/* Search */}
        <div className="mb-4 sm:mb-6">
          <Input
            placeholder="Search forms..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" />}
            className="w-full sm:max-w-md"
          />
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
                filteredForms.map((form) => <FormCard key={form.id} form={form} />)
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
                publishedForms.map((form) => <FormCard key={form.id} form={form} />)
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
                draftForms.map((form) => <FormCard key={form.id} form={form} />)
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
                archivedForms.map((form) => <FormCard key={form.id} form={form} />)
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
    </div>
  );
}
