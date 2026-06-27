import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Users, Clock, CheckCircle, TrendingUp, Loader2, ChevronDown, Database, FileJson, Table, Share2, Star, BarChart3, Inbox } from 'lucide-react';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { logger } from '../lib/logger';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { api, type FormAnalytics as FormAnalyticsType } from '../lib/api';
import { formatDate, sanitizeFilename, parseServerDate } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';

interface DailyResponse {
  day: string;
  count: number;
}

export default function FormAnalytics() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const { getForm, loadFullForm, storageMode } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();
  const user = useAuthStore((state) => state.user);

  const [analytics, setAnalytics] = useState<FormAnalyticsType | null>(null);
  // Real response rows for API/cloud mode (the local store is empty there).
  const [apiResponses, setApiResponses] = useState<ReturnType<typeof getResponsesByFormId>>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load full form data (with fields) from API
  useEffect(() => {
    if (formId) loadFullForm(formId);
  }, [formId, loadFullForm]);

  const form = formId ? getForm(formId) : undefined;
  const localResponses = formId ? getResponsesByFormId(formId) : [];
  // Use server-fetched responses in API mode (local store is empty in cloud mode),
  // so the field breakdown and Recent Responses table reflect real data.
  const responses = storageMode === 'api' ? apiResponses : localResponses;

  // Calculate local analytics
  const localAnalytics = useMemo(() => {
    const avgCompletionTime = localResponses.length > 0
      ? Math.round(localResponses.reduce((sum, r) => sum + r.completionTime, 0) / localResponses.length / 1000)
      : 0;

    // Group responses by day for chart (last 7 days). Bucket by LOCAL calendar day
    // so each response lands under the bar labeled with the same local day
    // (toISOString would bucket by UTC day, mis-attributing near-midnight responses).
    const localDayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const responseCounts: Record<string, number> = {};
    localResponses.forEach(r => {
      const dayKey = localDayKey(parseServerDate(r.submittedAt));
      responseCounts[dayKey] = (responseCounts[dayKey] || 0) + 1;
    });

    const last7Days: DailyResponse[] = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dayKey = localDayKey(date);
      last7Days.push({
        day: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        count: responseCounts[dayKey] || 0,
      });
    }
    const dailyResponses: DailyResponse[] = last7Days;

    // Calculate week-over-week change
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const thisWeekResponses = localResponses.filter(r => parseServerDate(r.submittedAt) >= oneWeekAgo).length;
    const lastWeekResponses = localResponses.filter(r => {
      const date = parseServerDate(r.submittedAt);
      return date >= twoWeeksAgo && date < oneWeekAgo;
    }).length;

    const weeklyChange = lastWeekResponses > 0
      ? Math.round(((thisWeekResponses - lastWeekResponses) / lastWeekResponses) * 100)
      : null; // null = no prior data to compare against

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
    let cancelled = false;
    // Clear the previous form's API analytics so it doesn't briefly show for the
    // new form (or persist if the new fetch fails / isn't applicable).
    setAnalytics(null);

    async function fetchAnalytics() {
      if (storageMode === 'api' && user && formId) {
        setIsLoading(true);
        try {
          const result = await api.getFormAnalytics(formId);
          if (cancelled) return;
          if (result.data?.analytics) {
            setAnalytics(result.data.analytics);
          }
          // Also pull real response rows so the field breakdown + Recent Responses
          // table aren't empty in cloud mode.
          const respResult = await api.getResponses(formId, { limit: 200 });
          if (cancelled) return;
          if (respResult.data?.responses) {
            // Normalize completionTime: the server nests it under
            // metadata.completionTime, but the UI reads it at the top level
            // (otherwise the Recent Responses table renders "NaNs").
            const norm = (respResult.data.responses as Array<{ completionTime?: number; metadata?: { completionTime?: number } }>).map((r) => ({
              ...r,
              completionTime: r.completionTime ?? r.metadata?.completionTime ?? 0,
            }));
            setApiResponses(norm as unknown as ReturnType<typeof getResponsesByFormId>);
          }
        } catch (error) {
          if (cancelled) return;
          logger.error('Failed to fetch analytics:', error);
          toast.warning('Connection Issue', 'Using local analytics data.');
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      }
    }

    fetchAnalytics();
    return () => { cancelled = true; };
  }, [formId, storageMode, user]);

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [exportMenuOpen]);

  const formFields = form?.fields ?? [];

  // Calculate field breakdown statistics
  const fieldBreakdown = useMemo(() => {
    const breakdown: Record<string, { type: string; label: string; data: { label: string; count: number; percentage: number }[] }> = {};

    formFields.forEach((field) => {
      // Only analyze rating, scale, dropdown, multiple_choice, and checkboxes fields
      if (!['rating', 'scale', 'dropdown', 'multiple_choice', 'checkboxes'].includes(field.type)) {
        return;
      }

      const counts: Record<string, number> = {};
      let totalAnswers = 0;

      responses.forEach((response) => {
        const answer = response.answers[field.id];
        if (answer === undefined || answer === null || answer === '') return;
        // Skip empty checkbox arrays (no selections made)
        if (Array.isArray(answer) && answer.length === 0) return;

        totalAnswers++;

        if (field.type === 'rating') {
          const rating = String(answer);
          counts[rating] = (counts[rating] || 0) + 1;
        } else if (field.type === 'scale') {
          const value = String(answer);
          counts[value] = (counts[value] || 0) + 1;
        } else if (field.type === 'checkboxes' && Array.isArray(answer)) {
          answer.forEach((val) => {
            counts[String(val)] = (counts[String(val)] || 0) + 1;
          });
        } else {
          counts[String(answer)] = (counts[String(answer)] || 0) + 1;
        }
      });

      if (totalAnswers === 0) return;

      let data: { label: string; count: number; percentage: number }[] = [];

      if (field.type === 'rating') {
        const maxStars = field.properties.maxStars || 5;
        for (let i = 1; i <= maxStars; i++) {
          const count = counts[String(i)] || 0;
          data.push({
            label: `${'★'.repeat(i)}${'☆'.repeat(maxStars - i)}`,
            count,
            percentage: Math.round((count / totalAnswers) * 100),
          });
        }
      } else if (field.type === 'scale') {
        const start = field.properties.scaleStart ?? 1;
        const end = field.properties.scaleEnd ?? 10;
        for (let i = start; i <= end; i++) {
          const count = counts[String(i)] || 0;
          data.push({
            label: String(i),
            count,
            percentage: Math.round((count / totalAnswers) * 100),
          });
        }
      } else if (field.properties.options) {
        // For choice fields, use the options
        data = field.properties.options.map((option) => {
          const count = counts[option.value] || counts[option.label] || 0;
          return {
            label: option.label,
            count,
            percentage: Math.round((count / totalAnswers) * 100),
          };
        });
      }

      if (data.length > 0) {
        breakdown[field.id] = {
          type: field.type,
          label: field.label,
          data,
        };
      }
    });

    return breakdown;
  }, [formFields, responses]);

  // Week-over-week change. In cloud mode localResponses is empty, so prefer the
  // server's per-day series (covers ALL responses, not just the fetched page);
  // fall back to the in-memory responses for local mode.
  const weeklyChange = useMemo(() => {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
    let thisWeek = 0;
    let lastWeek = 0;
    if (analytics?.responsesByDate?.length) {
      for (const { date, count } of analytics.responsesByDate) {
        const t = new Date(date).getTime();
        if (t >= oneWeekAgo) thisWeek += count;
        else if (t >= twoWeeksAgo && t < oneWeekAgo) lastWeek += count;
      }
    } else {
      for (const r of responses) {
        const t = parseServerDate(r.submittedAt).getTime();
        if (t >= oneWeekAgo) thisWeek++;
        else if (t >= twoWeeksAgo && t < oneWeekAgo) lastWeek++;
      }
    }
    return lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
  }, [analytics, responses]);

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center transition-colors">
        <EmptyState
          icon={Inbox}
          title="Form not found"
          description="The form you're looking for doesn't exist or has been deleted."
          action={<Button onClick={() => navigate('/')}>Go to Dashboard</Button>}
        />
      </div>
    );
  }

  const totalResponses = analytics?.totalResponses ?? localAnalytics.totalResponses;
  const completionRate = analytics?.completionRate ?? localAnalytics.completionRate;
  const avgCompletionTime = Math.round((analytics?.averageCompletionTime ?? localAnalytics.averageCompletionTime) / 1000);

  // Process daily responses for chart. Fill the last 7 CONTIGUOUS calendar days
  // (so empty days render as gaps, not collapsed into adjacent bars) and derive each
  // label from a local Date (so labels aren't off-by-one in negative-UTC zones the
  // way `new Date('YYYY-MM-DD')` — parsed as UTC midnight — would be). Mirrors the
  // local-mode fill above.
  const dailyResponses: DailyResponse[] = analytics?.responsesByDate
    ? (() => {
        const counts: Record<string, number> = {};
        for (const { date, count } of analytics.responsesByDate) counts[date] = count;
        const out: DailyResponse[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          out.push({ day: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), count: counts[key] || 0 });
        }
        return out;
      })()
    : localAnalytics.dailyResponses;

  // Preview only INPUT fields (skip welcome/statement/thank-you layout fields,
  // which have no answer and otherwise show as empty "-" columns).
  const previewFields = form.fields
    .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
    .slice(0, 3);

  const maxCount = Math.max(...dailyResponses.map((d) => d.count), 1);

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
          a.download = `${sanitizeFilename(form.title)}-responses.csv`;
          a.click();
          URL.revokeObjectURL(url);
          return;
        } catch (error) {
          logger.error('Failed to export from API, falling back to local:', error);
        }
      }

      // Fall back to local responses
      if (localResponses.length === 0) {
        toast.warning('No Data', 'No responses to export');
        return;
      }

      const escapeCell = (val: unknown) => {
        let str = String(val ?? '').replace(/"/g, '""');
        if (/^[=+\-@]/.test(str)) str = "'" + str;
        return `"${str}"`;
      };
      const inputFields = form.fields.filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type));
      const headers = ['Response ID', 'Submitted At', 'Completion Time (s)', ...inputFields.map((f) => f.label)];
      const rows = localResponses.map((r) => [
        r.id,
        parseServerDate(r.submittedAt).toLocaleString(),
        Math.round(r.completionTime / 1000),
        ...inputFields.map((f) => {
          const v = r.answers[f.id];
          return Array.isArray(v) ? v.map(item => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)).join(', ') : (v ?? '');
        }),
      ]);

      const csv = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename(form.title)}-responses.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Failed to export CSV:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export CSV');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportSqlite = async () => {
    if (!form) return;
    setIsExporting(true);
    setExportMenuOpen(false);
    try {
      await api.downloadSqlite(form.id, form.title);
    } catch (error) {
      logger.error('Failed to export SQLite:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export SQLite database');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportJson = async () => {
    if (!form) return;
    setIsExporting(true);
    setExportMenuOpen(false);
    try {
      await api.downloadJson(form.id, form.title);
    } catch (error) {
      logger.error('Failed to export JSON:', error);
      toast.error('Export Failed', error instanceof Error ? error.message : 'Failed to export JSON');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen transition-colors">
      <Header
        title={`${form.title} - Analytics`}
        actions={
          <div className="flex gap-1 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate(`/builder/${form.id}`)} title="Back to Builder">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Builder</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate(`/responses/${form.id}`)} title="View Data">
              <Table className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Data</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowEmbedModal(true)} title="Share & Embed" className="hidden sm:flex">
              <Share2 className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Share</span>
            </Button>
            <div className="relative" ref={exportRef}>
              <Button
                size="sm"
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
                disabled={isExporting}
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span className="hidden sm:inline ml-2">Export</span>
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
              {exportMenuOpen && (
                <div role="menu" className="absolute right-0 mt-1.5 w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 z-50">
                  <button
                    onClick={handleExportCSV}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                  >
                    <Download className="h-4 w-4 text-purple-500 dark:text-purple-400" />
                    Export CSV
                  </button>
                  <button
                    onClick={handleExportJson}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                  >
                    <FileJson className="h-4 w-4 text-green-500 dark:text-green-400" />
                    Export JSON
                  </button>
                  <button
                    onClick={handleExportSqlite}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                  >
                    <Database className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                    Download SQLite
                  </button>
                </div>
              )}
            </div>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card>
            <CardContent className="flex items-center gap-3">
              <div className="p-2 sm:p-3 bg-blue-500/10 rounded-lg flex-shrink-0">
                <Users className="h-5 w-5 sm:h-6 sm:w-6 text-blue-500" />
              </div>
              <div className="min-w-0">
                <p className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white transition-colors tabular-nums">{totalResponses}</p>
                <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-400 truncate transition-colors">Responses</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3">
              <div className="p-2 sm:p-3 bg-green-500/10 rounded-lg flex-shrink-0">
                <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-green-500" />
              </div>
              <div className="min-w-0">
                <p className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white transition-colors tabular-nums">{completionRate}%</p>
                <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-400 truncate transition-colors">Completion</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3">
              <div className="p-2 sm:p-3 bg-purple-500/10 rounded-lg flex-shrink-0">
                <Clock className="h-5 w-5 sm:h-6 sm:w-6 text-purple-500" />
              </div>
              <div className="min-w-0">
                <p className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white transition-colors tabular-nums">
                  {avgCompletionTime > 60
                    ? `${Math.floor(avgCompletionTime / 60)}m`
                    : `${avgCompletionTime}s`}
                </p>
                <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-400 truncate transition-colors">Avg. Time</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3">
              <div className="p-2 sm:p-3 bg-orange-500/10 rounded-lg flex-shrink-0">
                <TrendingUp className="h-5 w-5 sm:h-6 sm:w-6 text-orange-500" />
              </div>
              <div className="min-w-0">
                <p className={`text-xl sm:text-2xl font-bold tabular-nums ${weeklyChange === null ? 'text-gray-500 dark:text-slate-400' : weeklyChange >= 0 ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500'} transition-colors`}>
                  {weeklyChange === null ? 'New' : `${weeklyChange >= 0 ? '+' : ''}${weeklyChange}%`}
                </p>
                <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-400 truncate transition-colors">This Week</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Chart */}
        <Card>
          <CardHeader>
            <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white tracking-tight transition-colors">Responses Over Time</h2>
          </CardHeader>
          <CardContent>
            <div className="h-48 sm:h-64 flex items-end justify-between gap-1 sm:gap-2">
              {dailyResponses.map((day) => (
                <div key={day.day} className="flex-1 flex flex-col items-center gap-1 sm:gap-2">
                  <span className="text-xs text-gray-500 dark:text-slate-500 font-medium tabular-nums">
                    {day.count > 0 ? day.count : ''}
                  </span>
                  <div
                    className="w-full bg-primary-600 rounded-t-lg transition-all hover:bg-primary-500 min-h-[4px]"
                    style={{ height: `${Math.max((day.count / maxCount) * 100, 2)}%` }}
                    title={`${day.day}: ${day.count} response${day.count !== 1 ? 's' : ''}`}
                    aria-label={`${day.day}: ${day.count} response${day.count !== 1 ? 's' : ''}`}
                  />
                  <span className="text-xs sm:text-sm text-gray-500 dark:text-slate-500 transition-colors">
                    <span className="sm:hidden">{day.day.slice(0, 2)}</span>
                    <span className="hidden sm:inline">{day.day}</span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Field Breakdown */}
        {Object.keys(fieldBreakdown).length > 0 && (
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <BarChart3 className="h-4 w-4 sm:h-5 sm:w-5 text-primary-500" />
              <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white tracking-tight transition-colors">Field Breakdown</h2>
              {storageMode === 'api' && totalResponses > responses.length && (
                <span className="ml-auto text-xs text-gray-400 dark:text-slate-500">
                  Based on the latest {responses.length} of {totalResponses}
                </span>
              )}
            </CardHeader>
            <CardContent>
              <div className="space-y-6 sm:space-y-8">
                {Object.entries(fieldBreakdown).map(([fieldId, breakdown]) => (
                  <div key={fieldId}>
                    <div className="flex items-center gap-2 mb-2 sm:mb-3">
                      {breakdown.type === 'rating' && <Star className="h-4 w-4 text-yellow-500" />}
                      <h3 className="font-medium text-gray-900 dark:text-white text-sm sm:text-base transition-colors">{breakdown.label}</h3>
                    </div>
                    <div className="space-y-2">
                      {breakdown.data.map((item, index) => {
                        const maxPercentage = Math.max(...breakdown.data.map((d) => d.percentage), 1);
                        return (
                          <div key={index} className="flex items-center gap-2 sm:gap-3">
                            <div className="w-20 sm:w-32 md:w-40 text-xs sm:text-sm text-gray-500 dark:text-slate-400 truncate flex-shrink-0 transition-colors" title={item.label}>
                              {item.label}
                            </div>
                            <div className="flex-1 h-5 sm:h-6 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden transition-colors">
                              <div
                                className="h-full bg-primary-600 rounded-full transition-all"
                                style={{ width: `${(item.percentage / maxPercentage) * 100}%` }}
                              />
                            </div>
                            <div className="w-16 sm:w-20 text-right flex-shrink-0">
                              <span className="text-xs sm:text-sm font-medium text-gray-900 dark:text-white transition-colors">{item.percentage}%</span>
                              <span className="text-xs text-gray-500 dark:text-slate-500 ml-1 hidden sm:inline transition-colors">({item.count})</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent Responses */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white tracking-tight transition-colors">Recent Responses</h2>
            <Button variant="outline" size="sm" onClick={() => navigate(`/responses/${form.id}`)}>
              View All
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner />
              </div>
            ) : responses.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No responses yet"
                description="Share your form to start collecting responses"
                className="py-8"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-800">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500">ID</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500">Submitted</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500">Time</th>
                      {previewFields.map((field) => (
                        <th key={field.id} className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500">
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {responses.slice(0, 10).map((response) => (
                      <tr key={response.id} className="border-b border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="py-3 px-4 text-sm text-gray-900 dark:text-white font-mono">
                          #{response.id.slice(0, 8)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-500 dark:text-slate-400">
                          {formatDate(response.submittedAt)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-500 dark:text-slate-400">
                          {Math.round((response.completionTime || 0) / 1000)}s
                        </td>
                        {previewFields.map((field) => {
                          const val = response.answers[field.id];
                          let display = '-';
                          if (val !== null && val !== undefined && val !== '') {
                            if (field.type === 'location' && typeof val === 'object' && 'latitude' in (val as Record<string, unknown>)) {
                              const loc = val as Record<string, number>;
                              display = `${loc.latitude?.toFixed(4)}, ${loc.longitude?.toFixed(4)}`;
                            } else if (field.type === 'file_upload' && Array.isArray(val)) {
                              display = val.map((f: unknown) => (f && typeof f === 'object' && 'originalFilename' in f) ? (f as Record<string, unknown>).originalFilename : 'File').join(', ');
                            } else if (Array.isArray(val)) {
                              display = val.join(', ');
                            } else if (typeof val === 'object') {
                              display = JSON.stringify(val);
                            } else {
                              display = String(val);
                            }
                          }
                          return (
                            <td key={field.id} className="py-3 px-4 text-sm text-gray-500 dark:text-slate-400 truncate max-w-xs">
                              {display}
                            </td>
                          );
                        })}
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
