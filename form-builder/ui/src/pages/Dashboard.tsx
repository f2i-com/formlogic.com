import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import {
  FileText,
  Eye,
  CheckCircle,
  Plus,
  Pencil,
  BarChart3,
  Trash2,
  Download,
  MoreVertical,
  Database,
  FileJson,
  Table,
  Share2
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { formatRelativeTime } from '../lib/utils';
import { EmbedModal, TemplateSelector } from '../components/builder';
import type { FormTemplate } from '../data/formTemplates';

interface DashboardStats {
  totalResponses: number;
  avgCompletionRate: number;
}

// Dropdown Menu component for form actions
function FormActionsDropdown({
  formId,
  formTitle,
  onDelete,
  onEdit,
  onPreview,
  onAnalytics,
  onViewData,
  onShare
}: {
  formId: string;
  formTitle: string;
  onDelete: () => void;
  onEdit: () => void;
  onPreview: () => void;
  onAnalytics: () => void;
  onViewData: () => void;
  onShare: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleExportSqlite = async () => {
    setIsExporting(true);
    try {
      await api.downloadSqlite(formId, formTitle);
    } catch (error) {
      console.error('Failed to export SQLite:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export SQLite database');
    } finally {
      setIsExporting(false);
      setIsOpen(false);
    }
  };

  const handleExportJson = async () => {
    setIsExporting(true);
    try {
      await api.downloadJson(formId, formTitle);
    } catch (error) {
      console.error('Failed to export JSON:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export JSON');
    } finally {
      setIsExporting(false);
      setIsOpen(false);
    }
  };

  const handleExportCsv = async () => {
    setIsExporting(true);
    try {
      const csv = await api.exportResponses(formId);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${formTitle}-responses.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export CSV:', error);
      toast.error('Export Failed', 'Failed to export CSV');
    } finally {
      setIsExporting(false);
      setIsOpen(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        disabled={isExporting}
      >
        {isExporting ? (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
        ) : (
          <MoreVertical className="h-4 w-4" />
        )}
      </Button>
      {isOpen && (
        <div className="absolute right-0 mt-1 w-48 bg-white rounded-md shadow-lg border border-gray-200 py-1 z-50">
          {/* Mobile-only quick actions */}
          <div className="sm:hidden">
            <button
              onClick={() => { onEdit(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
            >
              <Pencil className="h-4 w-4 text-gray-600" />
              Edit
            </button>
            <button
              onClick={() => { onPreview(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
            >
              <Eye className="h-4 w-4 text-gray-600" />
              Preview
            </button>
            <button
              onClick={() => { onAnalytics(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
            >
              <BarChart3 className="h-4 w-4 text-gray-600" />
              Analytics
            </button>
            <button
              onClick={() => { onViewData(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
            >
              <Table className="h-4 w-4 text-gray-600" />
              View Data
            </button>
            <button
              onClick={() => { onShare(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
            >
              <Share2 className="h-4 w-4 text-gray-600" />
              Share & Embed
            </button>
            <div className="border-t border-gray-200 my-1" />
          </div>
          <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Export
          </div>
          <button
            onClick={handleExportSqlite}
            className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
          >
            <Database className="h-4 w-4 text-blue-600" />
            Download SQLite
          </button>
          <button
            onClick={handleExportJson}
            className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
          >
            <FileJson className="h-4 w-4 text-green-600" />
            Export JSON
          </button>
          <button
            onClick={handleExportCsv}
            className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
          >
            <Download className="h-4 w-4 text-purple-600" />
            Export CSV
          </button>
          <div className="border-t border-gray-200 my-1" />
          <button
            onClick={() => { onDelete(); setIsOpen(false); }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-red-50 flex items-center gap-2 text-red-600"
          >
            <Trash2 className="h-4 w-4" />
            Delete Form
          </button>
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { forms, createForm, setActiveForm, deleteForm, storageMode } = useFormStore();
  const { getResponsesByFormId, responses } = useResponseStore();
  const user = useAuthStore((state) => state.user);
  const [stats, setStats] = useState<DashboardStats>({ totalResponses: 0, avgCompletionRate: 0 });
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);

  const handleCreateForm = () => {
    setShowTemplateSelector(true);
  };

  const handleSelectTemplate = async (template: FormTemplate | null) => {
    setShowTemplateSelector(false);

    if (template) {
      // Create form with template
      const form = await createForm(template.name);

      // Add template fields to the form
      const fieldsWithIds = template.fields.map((field, index) => ({
        ...field,
        id: uuidv4(),
        order: index,
      }));

      // Update the form with template fields
      const formStore = useFormStore.getState();
      formStore.updateForm(form.id, { fields: fieldsWithIds });

      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
      toast.success('Form Created', `Started with "${template.name}" template`);
    } else {
      // Create blank form
      const form = await createForm('Untitled Form');
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
    }
  };

  const totalForms = forms.length;

  // Calculate stats from local responses
  const localStats = useMemo(() => {
    const totalResponses = forms.reduce(
      (sum, form) => sum + getResponsesByFormId(form.id).length,
      0
    );
    // Calculate average completion rate based on forms that have responses
    const formsWithResponses = forms.filter(form => getResponsesByFormId(form.id).length > 0);
    const avgCompletionRate = formsWithResponses.length > 0 ? 100 : 0; // All local responses are completed
    return { totalResponses, avgCompletionRate };
  }, [forms, responses, getResponsesByFormId]);

  // Fetch stats from API when in API mode
  useEffect(() => {
    async function fetchStats() {
      if (storageMode === 'api' && user && forms.length > 0) {
        try {
          let totalResponses = 0;
          let totalCompletionRate = 0;
          let formsWithAnalytics = 0;

          // Fetch analytics for each form
          for (const form of forms) {
            const result = await api.getFormAnalytics(form.id);
            if (result.data?.analytics) {
              totalResponses += result.data.analytics.totalResponses;
              if (result.data.analytics.completionRate > 0) {
                totalCompletionRate += result.data.analytics.completionRate;
                formsWithAnalytics++;
              }
            }
          }

          setStats({
            totalResponses,
            avgCompletionRate: formsWithAnalytics > 0 ? Math.round(totalCompletionRate / formsWithAnalytics) : 0,
          });
        } catch (error) {
          console.error('Failed to fetch dashboard stats:', error);
          toast.warning('Connection Issue', 'Using local data. Some stats may not be up to date.');
          setStats(localStats);
        }
      } else {
        setStats(localStats);
      }
    }

    fetchStats();
  }, [forms, storageMode, user, localStats]);

  const totalResponses = stats.totalResponses;
  const avgCompletionRate = stats.avgCompletionRate;

  const recentForms = [...forms]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" />

      <div className="p-6 max-w-7xl mx-auto">
        {/* Welcome Section */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Welcome back!
          </h2>
          <p className="text-gray-600">
            Here's an overview of your forms and responses.
          </p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-primary-100 rounded-lg">
                <FileText className="h-6 w-6 text-primary-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{totalForms}</p>
                <p className="text-sm text-gray-500">Total Forms</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Eye className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{totalResponses}</p>
                <p className="text-sm text-gray-500">Total Responses</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-green-100 rounded-lg">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{avgCompletionRate}%</p>
                <p className="text-sm text-gray-500">Avg. Completion Rate</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Recent Forms */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Recent Forms</h3>
          <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
            New Form
          </Button>
        </div>

        {recentForms.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No forms yet
              </h3>
              <p className="text-gray-500 mb-4">
                Create your first form to get started
              </p>
              <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
                Create Form
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {recentForms.map((form) => {
              const responses = getResponsesByFormId(form.id);
              return (
                <Card key={form.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="p-2 bg-gray-100 rounded-lg">
                        <FileText className="h-5 w-5 text-gray-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-gray-900">
                            {form.title}
                          </h4>
                          <Badge
                            variant={form.status === 'published' ? 'success' : 'default'}
                          >
                            {form.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-500">
                          Updated {formatRelativeTime(form.updatedAt)} • {responses.length} responses
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 sm:gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/builder/${form.id}`)}
                        title="Edit form"
                        className="hidden sm:flex"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/preview/${form.id}`)}
                        title="Preview form"
                        className="hidden sm:flex"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/analytics/${form.id}`)}
                        title="View analytics"
                        className="hidden sm:flex"
                      >
                        <BarChart3 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/responses/${form.id}`)}
                        title="View data"
                        className="hidden sm:flex"
                      >
                        <Table className="h-4 w-4" />
                      </Button>
                      <FormActionsDropdown
                        formId={form.id}
                        formTitle={form.title}
                        onDelete={() => deleteForm(form.id)}
                        onEdit={() => navigate(`/builder/${form.id}`)}
                        onPreview={() => navigate(`/preview/${form.id}`)}
                        onAnalytics={() => navigate(`/analytics/${form.id}`)}
                        onViewData={() => navigate(`/responses/${form.id}`)}
                        onShare={() => setEmbedModalForm({ id: form.id, title: form.title })}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
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

      {/* Template Selector */}
      <TemplateSelector
        isOpen={showTemplateSelector}
        onClose={() => setShowTemplateSelector(false)}
        onSelectTemplate={handleSelectTemplate}
      />
    </div>
  );
}
