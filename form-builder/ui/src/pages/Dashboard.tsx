import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  FileText,
  Eye,
  Plus,
  Pencil,
  BarChart3,
  Trash2,
  Download,
  MoreVertical,
  Database,
  FileJson,
  Table,
  Share2,
  Globe,
  Settings,
  LayoutTemplate,
  Clock,
  ArrowRight,
  Inbox,
  Sparkles,
  BookOpen,
  Zap,
  TrendingUp,
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

// Stat Card Component with enhanced styling
function StatCard({
  icon: Icon,
  iconBg,
  iconColor,
  value,
  label,
  subtext,
}: {
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  value: string | number;
  label: string;
  subtext?: string;
}) {
  return (
    <Card className="hover:shadow-md transition-all duration-200 hover:-translate-y-0.5">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-3xl font-bold text-gray-900 dark:text-white">{value}</p>
            <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mt-1">{label}</p>
            {subtext && (
              <p className="text-xs text-slate-500 mt-0.5">{subtext}</p>
            )}
          </div>
          <div className={`p-3 rounded-xl ${iconBg}`}>
            <Icon className={`h-6 w-6 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Quick Action Button Component
function QuickActionButton({
  icon: Icon,
  label,
  onClick,
  primary = false,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-2 p-4 rounded-xl border transition-all duration-200 hover:-translate-y-0.5 ${primary
        ? 'bg-primary-600 border-primary-500 text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20'
        : 'bg-white dark:bg-slate-900/50 backdrop-blur-sm border-gray-200 dark:border-white/10 text-gray-600 dark:text-slate-300 hover:border-gray-300 dark:hover:border-white/20 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-slate-800/50'
        }`}
    >
      <Icon className={`h-5 w-5 ${primary ? 'text-white' : 'text-gray-500'}`} />
      <span className={`text-sm font-medium ${primary ? 'text-white' : 'text-gray-700'}`}>
        {label}
      </span>
    </button>
  );
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
  onShare,
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
        aria-label={`Actions for ${formTitle}`}
      >
        {isExporting ? (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
        ) : (
          <MoreVertical className="h-4 w-4" />
        )}
      </Button>
      {isOpen && (
        <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-gray-100 dark:border-slate-800 py-1 z-50 ring-1 ring-black/5 dark:ring-white/5">
          {/* Mobile-only quick actions */}
          <div className="sm:hidden">
            <button
              onClick={() => { onEdit(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
            >
              <Pencil className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Edit
            </button>
            <button
              onClick={() => { onPreview(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
            >
              <Eye className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Preview
            </button>
            <button
              onClick={() => { onAnalytics(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
            >
              <BarChart3 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Analytics
            </button>
            <button
              onClick={() => { onViewData(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
            >
              <Table className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              View Data
            </button>
            <button
              onClick={() => { onShare(); setIsOpen(false); }}
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
            >
              <Share2 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              Share & Embed
            </button>
            <div className="border-t border-gray-100 dark:border-slate-800 my-1" />
          </div>
          <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
            Export
          </div>
          <button
            onClick={handleExportSqlite}
            className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
          >
            <Database className="h-4 w-4 text-blue-500" />
            Download SQLite
          </button>
          <button
            onClick={handleExportJson}
            className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
          >
            <FileJson className="h-4 w-4 text-green-500" />
            Export JSON
          </button>
          <button
            onClick={handleExportCsv}
            className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2"
          >
            <Download className="h-4 w-4 text-purple-500" />
            Export CSV
          </button>
          <div className="border-t border-gray-100 dark:border-slate-800 my-1" />
          <button
            onClick={() => { onDelete(); setIsOpen(false); }}
            className="w-full px-3 py-2 text-sm text-left hover:bg-red-500/10 text-red-500 flex items-center gap-2"
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
  const { forms, createForm, setActiveForm, deleteForm, addField, storageMode } = useFormStore();
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
      const form = await createForm(template.name);
      template.fields.forEach((field) => {
        addField(form.id, field);
      });
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
      toast.success('Form Created', `Started with "${template.name}" template`);
    } else {
      const form = await createForm('Untitled Form');
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
    }
  };

  // Calculate various stats
  const totalForms = forms.length;
  const publishedForms = forms.filter(f => f.status === 'published').length;

  // Calculate stats from local responses
  const localStats = useMemo(() => {
    const totalResponses = forms.reduce(
      (sum, form) => sum + getResponsesByFormId(form.id).length,
      0
    );
    const formsWithResponses = forms.filter(form => getResponsesByFormId(form.id).length > 0);
    const avgCompletionRate = forms.length > 0
      ? Math.round((formsWithResponses.length / forms.length) * 100)
      : 0;
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

          const analyticsResults = await Promise.all(
            forms.map((form) => api.getFormAnalytics(form.id))
          );
          for (const result of analyticsResults) {
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

  // Get recent forms
  const recentForms = [...forms]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  // Get recent responses across all forms
  const recentResponses = useMemo(() => {
    const allResponses = forms.flatMap(form => {
      const formResponses = getResponsesByFormId(form.id);
      return formResponses.map(r => ({
        ...r,
        formId: form.id,
        formTitle: form.title,
      }));
    });
    return allResponses
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
      .slice(0, 5);
  }, [forms, responses, getResponsesByFormId]);

  // Format date for welcome message
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  // Show getting started for new users
  const showGettingStarted = forms.length === 0;

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            Welcome back{user?.name ? `, ${user.name}` : ''}!
          </h1>
          <p className="text-gray-500 dark:text-slate-400 mt-1">{today}</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={FileText}
            iconBg="bg-indigo-50 dark:bg-indigo-500/10"
            iconColor="text-indigo-600 dark:text-indigo-400"
            value={totalForms}
            label="Total Forms"
            subtext={totalForms === 1 ? '1 form created' : `${totalForms} forms created`}
          />
          <StatCard
            icon={Globe}
            iconBg="bg-green-50 dark:bg-green-500/10"
            iconColor="text-green-600 dark:text-green-400"
            value={publishedForms}
            label="Published"
            subtext={totalForms > 0 ? `${Math.round((publishedForms / totalForms) * 100)}% of forms` : 'No forms yet'}
          />
          <StatCard
            icon={Inbox}
            iconBg="bg-blue-50 dark:bg-blue-500/10"
            iconColor="text-blue-600 dark:text-blue-400"
            value={totalResponses}
            label="Total Responses"
            subtext="Across all forms"
          />
          <StatCard
            icon={TrendingUp}
            iconBg="bg-amber-50 dark:bg-amber-500/10"
            iconColor="text-amber-600 dark:text-amber-400"
            value={`${avgCompletionRate}%`}
            label="Completion Rate"
            subtext="Average across forms"
          />
        </div>

        {/* Quick Actions */}
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-3">
            Quick Actions
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <QuickActionButton
              icon={Plus}
              label="New Form"
              onClick={handleCreateForm}
              primary
            />
            <QuickActionButton
              icon={FileText}
              label="All Forms"
              onClick={() => navigate('/forms')}
            />
            <QuickActionButton
              icon={LayoutTemplate}
              label="Templates"
              onClick={() => setShowTemplateSelector(true)}
            />
            <QuickActionButton
              icon={Settings}
              label="Settings"
              onClick={() => navigate('/settings')}
            />
          </div>
        </div>

        {/* Getting Started Section for New Users */}
        {showGettingStarted && (
          <div className="mb-8">
            <Card className="bg-gradient-to-br from-indigo-900/50 to-purple-900/50 border-indigo-500/30">
              <CardContent className="p-6 sm:p-8">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                  <div className="p-4 bg-white/20 rounded-2xl">
                    <Sparkles className="h-8 w-8 text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-xl font-bold text-white mb-2">
                      Get started with FormLogic
                    </h3>
                    <p className="text-indigo-100 mb-4">
                      Create your first form in seconds. Choose from templates or start from scratch.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        onClick={handleCreateForm}
                        className="bg-white text-indigo-600 hover:bg-indigo-50"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Create Your First Form
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-white hover:bg-white/10"
                        onClick={() => setShowTemplateSelector(true)}
                      >
                        <BookOpen className="h-4 w-4 mr-2" />
                        Browse Templates
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Main Content - Two Column Layout on Desktop */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent Forms - Takes 2/3 on desktop */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Forms</h2>
              {forms.length > 5 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/forms')}
                  className="text-primary-400 hover:text-primary-300"
                >
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              )}
            </div>

            {recentForms.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <div className="w-16 h-16 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4">
                    <FileText className="h-8 w-8 text-gray-400 dark:text-slate-500" />
                  </div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                    No forms yet
                  </h3>
                  <p className="text-gray-500 dark:text-slate-400 mb-6 max-w-sm mx-auto">
                    Create your first form to start collecting responses and insights.
                  </p>
                  <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
                    Create Form
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {recentForms.map((form) => {
                  const formResponses = getResponsesByFormId(form.id);
                  const fieldCount = form.fields?.length || 0;
                  return (
                    <Card key={form.id} className="hover:shadow-md transition-all duration-200">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-4 min-w-0 flex-1">
                            <div className="p-2.5 bg-indigo-50 dark:bg-slate-800 rounded-xl flex-shrink-0 hidden sm:flex">
                              <FileText className="h-5 w-5 text-indigo-500 dark:text-slate-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h4 className="font-semibold text-gray-900 dark:text-white truncate">
                                  {form.title}
                                </h4>
                                <Badge
                                  variant={form.status === 'published' ? 'success' : 'default'}
                                  size="sm"
                                >
                                  {form.status}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-500">
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3.5 w-3.5" />
                                  {formatRelativeTime(form.updatedAt)}
                                </span>
                                <span className="hidden sm:inline">•</span>
                                <span className="hidden sm:inline">{fieldCount} fields</span>
                                <span>•</span>
                                <span>{formResponses.length} responses</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 flex-shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/builder/${form.id}`)}
                              title="Edit form"
                              className="hidden md:flex text-slate-400 hover:text-white"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/preview/${form.id}`)}
                              title="Preview form"
                              className="hidden md:flex text-slate-400 hover:text-white"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/analytics/${form.id}`)}
                              title="View analytics"
                              className="hidden lg:flex text-slate-400 hover:text-white"
                            >
                              <BarChart3 className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/responses/${form.id}`)}
                              title="View data"
                              className="hidden lg:flex text-slate-400 hover:text-white"
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
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Activity - Takes 1/3 on desktop */}
          <div className="lg:col-span-1">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
            </div>

            <Card>
              <CardContent className="p-0">
                {recentResponses.length === 0 ? (
                  <div className="py-12 text-center px-4">
                    <div className="w-12 h-12 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Inbox className="h-6 w-6 text-gray-400 dark:text-slate-500" />
                    </div>
                    <p className="text-sm text-gray-500 dark:text-slate-500">No submissions yet</p>
                    <p className="text-xs text-gray-400 dark:text-slate-600 mt-1">
                      Responses will appear here
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100 dark:divide-slate-800">
                    {recentResponses.map((response, index) => (
                      <button
                        key={`${response.formId}-${index}`}
                        onClick={() => navigate(`/responses/${response.formId}`)}
                        className="w-full p-4 text-left hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-2 bg-green-500/10 rounded-lg flex-shrink-0">
                            <Zap className="h-4 w-4 text-green-600 dark:text-green-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {response.formTitle}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-slate-500 mt-0.5">
                              New submission • {formatRelativeTime(response.submittedAt)}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Tips Card */}
            {forms.length > 0 && forms.length <= 3 && (
              <Card className="mt-4 bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-amber-100 dark:bg-amber-500/20 rounded-lg flex-shrink-0">
                      <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Pro tip</p>
                      <p className="text-xs text-amber-600 dark:text-amber-300/70 mt-1">
                        Use backend scripts to score leads, validate data, and automate workflows on every submission.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
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
