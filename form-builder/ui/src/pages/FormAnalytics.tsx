import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Users, Clock, CheckCircle, TrendingUp, Loader2, ChevronDown, Database, FileJson, Table, Share2 } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { api, type FormAnalytics as FormAnalyticsType } from '../lib/api';
import { formatDate } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';

interface DailyResponse {
  day: string;
  count: number;
}

export default function FormAnalytics() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const { getForm, storageMode } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();
  const user = useAuthStore((state) => state.user);

  const [analytics, setAnalytics] = useState<FormAnalyticsType | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const form = formId ? getForm(formId) : undefined;
  const localResponses = formId ? getResponsesByFormId(formId) : [];

  // Calculate local analytics
  const localAnalytics = useMemo(() => {
    const avgCompletionTime = localResponses.length > 0
      ? Math.round(localResponses.reduce((sum, r) => sum + r.completionTime, 0) / localResponses.length / 1000)
      : 0;

    // Group responses by day for chart
    const responseCounts: Record<string, number> = {};
    localResponses.forEach(r => {
      const date = new Date(r.submittedAt);
      const dayKey = date.toLocaleDateString('en-US', { weekday: 'short' });
      responseCounts[dayKey] = (responseCounts[dayKey] || 0) + 1;
    });

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dailyResponses: DailyResponse[] = days.map(day => ({
      day,
      count: responseCounts[day] || 0,
    }));

    // Calculate week-over-week change
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const thisWeekResponses = localResponses.filter(r => new Date(r.submittedAt) >= oneWeekAgo).length;
    const lastWeekResponses = localResponses.filter(r => {
      const date = new Date(r.submittedAt);
      return date >= twoWeeksAgo && date < oneWeekAgo;
    }).length;

    const weeklyChange = lastWeekResponses > 0
      ? Math.round(((thisWeekResponses - lastWeekResponses) / lastWeekResponses) * 100)
      : thisWeekResponses > 0 ? 100 : 0;

    return {
      totalResponses: localResponses.length,
      completionRate: localResponses.length > 0 ? 100 : 0, // All submitted responses are complete
      averageCompletionTime: avgCompletionTime * 1000, // Convert back to ms for consistency
      dailyResponses,
      weeklyChange,
    };
  }, [localResponses]);

  // Fetch analytics from API
  useEffect(() => {
    async function fetchAnalytics() {
      if (storageMode === 'api' && user && formId) {
        setIsLoading(true);
        try {
          const result = await api.getFormAnalytics(formId);
          if (result.data?.analytics) {
            setAnalytics(result.data.analytics);
          }
        } catch (error) {
          console.error('Failed to fetch analytics:', error);
          toast.warning('Connection Issue', 'Using local analytics data.');
        } finally {
          setIsLoading(false);
        }
      }
    }

    fetchAnalytics();
  }, [formId, storageMode, user]);

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Form not found</p>
      </div>
    );
  }

  const totalResponses = analytics?.totalResponses ?? localAnalytics.totalResponses;
  const completionRate = analytics?.completionRate ?? localAnalytics.completionRate;
  const avgCompletionTime = Math.round((analytics?.averageCompletionTime ?? localAnalytics.averageCompletionTime) / 1000);

  // Process daily responses for chart
  const dailyResponses: DailyResponse[] = analytics?.responsesByDate
    ? analytics.responsesByDate.slice(-7).map(item => ({
        day: new Date(item.date).toLocaleDateString('en-US', { weekday: 'short' }),
        count: item.count,
      }))
    : localAnalytics.dailyResponses;

  const maxCount = Math.max(...dailyResponses.map((d) => d.count), 1);
  const weeklyChange = localAnalytics.weeklyChange;

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleExportCSV = async () => {
    setIsExporting(true);
    setExportMenuOpen(false);
    try {
      // Try to export from API first if in API mode
      if (storageMode === 'api' && user) {
        try {
          const csv = await api.exportResponses(form.id);
          const blob = new Blob([csv], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${form.title}-responses.csv`;
          a.click();
          URL.revokeObjectURL(url);
          return;
        } catch (error) {
          console.error('Failed to export from API, falling back to local:', error);
        }
      }

      // Fall back to local responses
      if (localResponses.length === 0) {
        toast.warning('No Data', 'No responses to export');
        return;
      }

      const headers = ['Response ID', 'Submitted At', 'Completion Time (s)', ...form.fields.map((f) => f.label)];
      const rows = localResponses.map((r) => [
        r.id,
        r.submittedAt,
        Math.round(r.completionTime / 1000),
        ...form.fields.map((f) => JSON.stringify(r.answers[f.id] || '')),
      ]);

      const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${form.title}-responses.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportSqlite = async () => {
    setIsExporting(true);
    setExportMenuOpen(false);
    try {
      await api.downloadSqlite(form.id, form.title);
    } catch (error) {
      console.error('Failed to export SQLite:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export SQLite database');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportJson = async () => {
    setIsExporting(true);
    setExportMenuOpen(false);
    try {
      await api.downloadJson(form.id, form.title);
    } catch (error) {
      console.error('Failed to export JSON:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export JSON');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title={`${form.title} - Analytics`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(`/builder/${form.id}`)}>
              <ArrowLeft className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Back to Builder</span>
            </Button>
            <Button variant="outline" onClick={() => navigate(`/responses/${form.id}`)}>
              <Table className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">View Data</span>
            </Button>
            <Button variant="outline" onClick={() => setShowEmbedModal(true)} title="Share & Embed">
              <Share2 className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Share</span>
            </Button>
            <div className="relative" ref={exportRef}>
              <Button
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
                disabled={isExporting}
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Download className="h-4 w-4 mr-2" />
                )}
                Export
                <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
              {exportMenuOpen && (
                <div className="absolute right-0 mt-1 w-48 bg-white rounded-md shadow-lg border border-gray-200 py-1 z-50">
                  <button
                    onClick={handleExportCSV}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
                  >
                    <Download className="h-4 w-4 text-purple-600" />
                    Export CSV
                  </button>
                  <button
                    onClick={handleExportJson}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
                  >
                    <FileJson className="h-4 w-4 text-green-600" />
                    Export JSON
                  </button>
                  <button
                    onClick={handleExportSqlite}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-100 flex items-center gap-2"
                  >
                    <Database className="h-4 w-4 text-blue-600" />
                    Download SQLite
                  </button>
                </div>
              )}
            </div>
          </div>
        }
      />

      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Users className="h-6 w-6 text-blue-600" />
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
                <p className="text-2xl font-bold text-gray-900">{completionRate}%</p>
                <p className="text-sm text-gray-500">Completion Rate</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-purple-100 rounded-lg">
                <Clock className="h-6 w-6 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">
                  {avgCompletionTime > 60
                    ? `${Math.floor(avgCompletionTime / 60)}m ${avgCompletionTime % 60}s`
                    : `${avgCompletionTime}s`}
                </p>
                <p className="text-sm text-gray-500">Avg. Time</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-orange-100 rounded-lg">
                <TrendingUp className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <p className={`text-2xl font-bold ${weeklyChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {weeklyChange >= 0 ? '+' : ''}{weeklyChange}%
                </p>
                <p className="text-sm text-gray-500">This Week</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Chart */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Responses Over Time</h2>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-end justify-between gap-2">
              {dailyResponses.map((day) => (
                <div key={day.day} className="flex-1 flex flex-col items-center gap-2">
                  <div
                    className="w-full bg-primary-500 rounded-t-lg transition-all hover:bg-primary-600"
                    style={{ height: `${(day.count / maxCount) * 100}%` }}
                  />
                  <span className="text-sm text-gray-500">{day.day}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Responses */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Recent Responses</h2>
            <Button variant="outline" size="sm">
              View All
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : localResponses.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No responses yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">ID</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">Submitted</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">Time</th>
                      {form.fields.slice(0, 3).map((field) => (
                        <th key={field.id} className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {localResponses.slice(0, 10).map((response) => (
                      <tr key={response.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-3 px-4 text-sm text-gray-900 font-mono">
                          #{response.id.slice(0, 8)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">
                          {formatDate(response.submittedAt)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">
                          {Math.round(response.completionTime / 1000)}s
                        </td>
                        {form.fields.slice(0, 3).map((field) => (
                          <td key={field.id} className="py-3 px-4 text-sm text-gray-600 truncate max-w-xs">
                            {String(response.answers[field.id] || '-')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Embed Modal */}
      <EmbedModal
        isOpen={showEmbedModal}
        onClose={() => setShowEmbedModal(false)}
        formId={form.id}
        formTitle={form.title}
      />
    </div>
  );
}
