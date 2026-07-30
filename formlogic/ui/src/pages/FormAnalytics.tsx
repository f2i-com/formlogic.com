import { useState, useEffect, useMemo, useRef, type ElementType, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Download, Users, Clock, CheckCircle, TrendingUp, TrendingDown, Loader2, ChevronDown, Database, FileJson, Table, Share2, Star, BarChart3, Inbox, Eye, MousePointerClick, Lock } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from 'recharts';
import { useUIStore } from '../stores/uiStore';
import { ListRowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadFailure } from '../components/ui/LoadFailure';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { logger } from '../lib/logger';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { api, type FormAnalytics as FormAnalyticsType } from '../lib/api';
import { cn, formatDate, sanitizeFilename, parseServerDate } from '../lib/utils';
import { isEncryptedEnvelope } from '../lib/crypto/envelope';
import { useFittedColumns } from '../hooks/useFittedColumns';
import { EmbedModal } from '../components/builder/EmbedModal';
import { publicUnfillableFieldLabels } from '../lib/publicForm';

interface DailyResponse {
  day: string;
  count: number;
}

// Bucket a Date by LOCAL calendar day (toISOString would bucket by UTC day,
// mis-attributing near-midnight responses).
const localDayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Range options for the Responses Over Time chart — the server ships up to 30
// days of per-day counts, so all three ranges render from already-fetched data.
const CHART_RANGES = [7, 14, 30] as const;
type ChartRange = (typeof CHART_RANGES)[number];

export default function FormAnalytics() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { getForm, loadFullForm, storageMode } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();
  const user = useAuthStore((state) => state.user);
  // True while the form store is still hydrating — so a deep-link/refresh shows a
  // loading state instead of flashing "Form not found" before the form arrives.
  const formsLoading = useFormStore((s) => !s.isInitialized || s.isLoading);

  const [analytics, setAnalytics] = useState<FormAnalyticsType | null>(null);
  // Real response rows for API/cloud mode (the local store is empty there).
  const [apiResponses, setApiResponses] = useState<ReturnType<typeof getResponsesByFormId>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Load full form data (with fields) from API
  useEffect(() => {
    if (formId) loadFullForm(formId);
  }, [formId, loadFullForm]);

  const form = formId ? getForm(formId) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- getResponsesByFormId returns a fresh .filter() array each call and its action ref is stable; recomputing per render is required so localAnalytics reflects live store data — memoizing here would freeze stale responses
  const localResponses = formId ? getResponsesByFormId(formId) : [];
  // Use server-fetched responses in API mode (local store is empty in cloud mode),
  // so the field breakdown and Recent Responses table reflect real data.
  const responses = storageMode === 'api' ? apiResponses : localResponses;

  // E2EE (§9.2): a private form's answers are ciphertext — answer-derived surfaces
  // (field breakdown, answer previews) render the private placeholder instead of
  // silently empty charts. Count-based surfaces (over-time chart) stay: they are
  // computed from non-content columns and remain meaningful.
  const isPrivateForm = useMemo(
    () => responses.some((r) => isEncryptedEnvelope((r as { answers?: unknown }).answers)),
    [responses],
  );

  // Calculate local analytics
  const localAnalytics = useMemo(() => {
    const avgCompletionTime = localResponses.length > 0
      ? Math.round(localResponses.reduce((sum, r) => sum + r.completionTime, 0) / localResponses.length / 1000)
      : 0;

    return {
      totalResponses: localResponses.length,
      completionRate: localResponses.length > 0 ? 100 : 0, // All submitted responses are complete
      averageCompletionTime: avgCompletionTime * 1000, // Convert back to ms for consistency
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
          // getTimezoneOffset() returns minutes BEHIND UTC (JS convention); the API wants
          // minutes AHEAD of UTC, so negate it — this makes the server bucket
          // "Responses over time" by this viewer's local calendar day, matching the
          // local-day keys the chart below is already built from.
          const tzOffsetMinutes = -new Date().getTimezoneOffset();
          const result = await api.getFormAnalytics(formId, tzOffsetMinutes);
          if (cancelled) return;
          if (result.data?.analytics) {
            setAnalytics(result.data.analytics);
            setLoadError(null);
          } else {
            // api.request never throws, so without this a 500 left every metric at 0 and
            // the page reported a busy form as having no responses at all.
            setLoadError(typeof result.error === 'string' ? result.error : 'Please try again.');
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
          setLoadError(error instanceof Error ? error.message : 'Please try again.');
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      }
    }

    fetchAnalytics();
    return () => { cancelled = true; };
  }, [formId, storageMode, user, reloadToken]);

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

  // eslint-disable-next-line react-hooks/exhaustive-deps -- derived inline from the live `form` store object so fieldBreakdown recomputes whenever the form's fields change; the array is only newly allocated in the undefined-form branch
  const formFields = form?.fields ?? [];

  // Calculate field breakdown statistics
  const fieldBreakdown = useMemo(() => {
    const breakdown: Record<string, { type: string; label: string; total: number; avg?: number; data: { label: string; count: number; percentage: number }[] }> = {};

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
        // Mean for numeric distributions (rating/scale) — shown beside the field label.
        let avg: number | undefined;
        if (field.type === 'rating' || field.type === 'scale') {
          let weighted = 0;
          let n = 0;
          for (const [k, c] of Object.entries(counts)) {
            const v = Number(k);
            if (Number.isFinite(v)) { weighted += v * c; n += c; }
          }
          if (n > 0) avg = Math.round((weighted / n) * 10) / 10;
        }
        breakdown[field.id] = {
          type: field.type,
          label: field.label,
          total: totalAnswers,
          avg,
          data,
        };
      }
    });

    return breakdown;
  }, [formFields, responses]);

  // Week-over-week trend. In cloud mode localResponses is empty, so prefer the
  // server's per-day series (covers ALL responses, not just the fetched page);
  // fall back to the in-memory responses for local mode.
  const weeklyTrend = useMemo(() => {
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
    return {
      thisWeek,
      // null = no prior week to compare against
      pct: lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null,
    };
  }, [analytics, responses]);

  // Responses Over Time — selectable window over the (up to 30-day) per-day counts.
  const [rangeDays, setRangeDays] = useState<ChartRange>(7);
  // Fill the last N CONTIGUOUS calendar days (empty days render as gaps, not
  // collapsed into adjacent bars) and derive each label from a local Date (so
  // labels aren't off-by-one in negative-UTC zones the way `new Date('YYYY-MM-DD')`
  // — parsed as UTC midnight — would be).
  const dailySeries: DailyResponse[] = useMemo(() => {
    const counts: Record<string, number> = {};
    if (analytics?.responsesByDate) {
      for (const { date, count } of analytics.responsesByDate) counts[date] = count;
    } else {
      for (const r of localResponses) {
        const key = localDayKey(parseServerDate(r.submittedAt));
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const out: DailyResponse[] = [];
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push({
        day: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        count: counts[localDayKey(d)] || 0,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- localResponses is a fresh array each render by design (see above); keying on its length + analytics keeps the memo honest without thrashing
  }, [analytics, localResponses.length, rangeDays]);
  const rangeTotal = useMemo(() => dailySeries.reduce((a, d) => a + d.count, 0), [dailySeries]);

  // Chart inks follow the mode (subscribed, so a theme toggle re-renders the chart);
  // the accent reads the live --primary-* CSS variables, so it tracks the curated
  // per-mode palette (indigo by day, lime by night) AND user theme-color overrides.
  const isDark = useUIStore((s) => s.theme === 'dark');
  const chartInk = useMemo(() => ({
    accent: 'rgb(var(--primary-500))',
    axis: isDark ? '#94a3b8' : '#64748b',
    grid: isDark ? '#1e293b' : '#e2e8f0',
    cursor: isDark ? 'rgba(148,163,184,0.08)' : 'rgba(0,0,0,0.04)',
    tooltip: {
      background: isDark ? '#0f172a' : '#ffffff',
      border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
      borderRadius: 10,
      fontSize: 12,
      color: isDark ? '#e2e8f0' : '#0f172a',
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      padding: '8px 12px',
    } as const,
    tooltipLabel: { color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600, fontSize: 11 } as const,
  }), [isDark]);

  // Preview only INPUT fields (skip welcome/statement/thank-you layout fields, which have no
  // answer). Computed defensively and the column-fit hook is called BEFORE the early return below,
  // so the hook order stays stable when `form` transitions loading → loaded (else React throws
  // "rendered more hooks than during the previous render").
  const previewFields = (form?.fields ?? [])
    .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
    .slice(0, 8);
  const { ref: previewRef, count: previewCount, cards: previewCards } = useFittedColumns<HTMLDivElement>({
    itemCount: previewFields.length,
    itemMinPx: 150,
    reservedPx: 340,
    cardBelowPx: 560,
  });
  const visiblePreview = previewFields.slice(0, previewCount);

  if (!form) {
    // Still hydrating the store (e.g. a direct link / refresh) — don't flash not-found.
    if (formsLoading) {
      return (
        <div className="min-h-screen flex items-center justify-center transition-colors">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading" />
        </div>
      );
    }
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
  const totalViews = analytics?.totalViews ?? 0;
  const completionRate = analytics?.completionRate ?? localAnalytics.completionRate;
  const avgCompletionTime = Math.round((analytics?.averageCompletionTime ?? localAnalytics.averageCompletionTime) / 1000);
  // Views/starts/completion only exist server-side — without server analytics they'd
  // read as a misleading 0 / 100%, so render an em dash + hint instead.
  const hasServerAnalytics = analytics !== null;
  const totalStarts = analytics?.totalStarts;

  // History-aware back: return to wherever the user came from; fall back to the
  // form builder on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/builder/${form.id}`);
  };

  // Recent Responses rows open the full record on the Responses page (which reads
  // ?open= once and auto-opens that record's view modal).
  const openResponse = (responseId: string) =>
    navigate(`/responses/${form.id}?open=${encodeURIComponent(responseId)}`);

  // Shared value formatter for the recent-responses preview (table + card modes).
  // Server-resolved label(s) for a linked_record field on a response, or null if unresolved.
  const resolvedLinkLabel = (response: unknown, fieldId: string): string | null => {
    const v = (response as { _resolved?: Record<string, unknown> })._resolved?.[fieldId] as { display?: string } | Array<{ display?: string }> | undefined;
    if (!v) return null;
    const list = Array.isArray(v) ? v : [v];
    const s = list.map((x) => x?.display).filter(Boolean).join(', ');
    return s || null;
  };

  const formatPreviewValue = (field: { id: string; type: string; properties?: { options?: Array<{ value: string; label?: string }> } }, val: unknown): string => {
    if (val === null || val === undefined || val === '') return '-';
    if (field.type === 'location' && typeof val === 'object' && 'latitude' in (val as Record<string, unknown>)) {
      const loc = val as Record<string, number>;
      return `${loc.latitude?.toFixed(4)}, ${loc.longitude?.toFixed(4)}`;
    }
    if (field.type === 'file_upload' && Array.isArray(val)) {
      return val.map((f: unknown) => (f && typeof f === 'object' && 'originalFilename' in f) ? String((f as Record<string, unknown>).originalFilename) : 'File').join(', ');
    }
    // Linked record: never show raw UUIDs (call sites prefer the resolved label; this is the fallback).
    if (field.type === 'linked_record') {
      const n = Array.isArray(val) ? val.length : (val ? 1 : 0);
      return n === 0 ? '-' : n === 1 ? '[linked record]' : `[${n} linked records]`;
    }
    if (['dropdown', 'multiple_choice', 'checkboxes'].includes(field.type)) {
      const opts = (field.properties?.options ?? []) as Array<{ value: string; label?: string }>;
      const labelFor = (v: unknown) => opts.find((o) => o.value === v)?.label ?? String(v);
      return Array.isArray(val) ? val.map(labelFor).join(', ') : labelFor(val);
    }
    if (Array.isArray(val)) return val.join(', ');
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  };

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
          toast.success('Export ready', 'Your CSV download has started.');
          return;
        } catch (error) {
          // In cloud mode there's no local data to fall back to, so surface the real
          // failure instead of letting it fall through to a misleading "No Data".
          logger.error('Failed to export from API:', error);
          toast.error('Export Failed', error instanceof Error ? error.message : 'Could not export responses.');
          return;
        }
      }

      // Fall back to local responses
      if (localResponses.length === 0) {
        toast.warning('No Data', 'No responses to export');
        return;
      }

      const escapeCell = (val: unknown) => {
        let str = String(val ?? '').replace(/"/g, '""');
        // Match the hardened guard used elsewhere: also catch leading whitespace
        // and TAB/CR before a formula trigger (spreadsheets still evaluate those).
        if (/^\s*[=+\-@\t\r]/.test(str)) str = "'" + str;
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
          if (f.type === 'file_upload' && Array.isArray(v)) {
            return v.map((x: unknown) => (x && typeof x === 'object' && 'originalFilename' in x) ? (x as Record<string, unknown>).originalFilename : 'File').join(', ');
          }
          if (f.type === 'location' && v && typeof v === 'object' && 'latitude' in (v as object)) {
            const loc = v as Record<string, number>;
            return loc.latitude != null && loc.longitude != null ? `${loc.latitude}, ${loc.longitude}` : '';
          }
          if (['dropdown', 'multiple_choice', 'checkboxes'].includes(f.type)) {
            const opts = (f.properties?.options ?? []) as Array<{ value: string; label?: string }>;
            const labelFor = (x: unknown) => opts.find((o) => o.value === x)?.label ?? String(x);
            return Array.isArray(v) ? v.map(labelFor).join(', ') : (v != null ? labelFor(v) : '');
          }
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
      toast.success('Export ready', 'Your CSV download has started.');
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
      toast.success('Export ready', 'Your SQLite download has started.');
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
      toast.success('Export ready', 'Your JSON download has started.');
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
        title="Analytics"
        actions={
          // Gated on the header's own width — see the note in FormResponses.
          <div className="flex gap-1 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate(`/responses/${form.id}`)} title="View responses">
              <Table className="h-4 w-4" />
              <span className="ml-2 hidden @4xl/header:inline">Responses</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowEmbedModal(true)} title="Share & Embed" className="hidden @lg/header:flex">
              <Share2 className="h-4 w-4" />
              <span className="ml-2 hidden @4xl/header:inline">Share</span>
            </Button>
            <div className="relative" ref={exportRef}>
              <Button
                size="sm"
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
                disabled={isExporting || totalResponses === 0}
                title={totalResponses === 0 ? 'No responses to export' : undefined}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span className="ml-2 hidden @2xl/header:inline">Export</span>
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
              {exportMenuOpen && (
                <div role="menu" aria-label="Export options" className="absolute right-0 mt-1.5 w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 z-50">
                  {isPrivateForm ? (
                    <p className="px-3 py-2 text-xs text-gray-500 dark:text-slate-400">
                      This form is private, so answers can only be exported where they can be decrypted —
                      open <span className="font-medium">Responses</span> and use the decrypted spreadsheet
                      export there.
                    </p>
                  ) : (
                    <>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportCSV}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <Download className="h-4 w-4 text-purple-500 dark:text-purple-400" />
                        Spreadsheet (.csv)
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportJson}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <FileJson className="h-4 w-4 text-green-500 dark:text-green-400" />
                        Data file (.json) — for developers
                      </button>
                    </>
                  )}
                  <button
                    role="menuitem"
                    type="button"
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

      {/* @container/analytics: the six-number strip used `lg:grid-cols-6` on the viewport,
          so at 1280px with the sidebar out and the chat docked it packed six numbers into
          a ~576px box and they wrapped mid-digit. */}
      <div className="@container/analytics flex-1 w-full p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <PageHeader
          title={form.title}
          subtitle="Analytics"
          onBack={goBack}
          backLabel="Back"
        />

        {loadError && (
          <LoadFailure
            title="We couldn't load this form's analytics"
            message={loadError}
            onRetry={() => { setLoadError(null); setReloadToken((n) => n + 1); }}
          />
        )}

        {/* Metrics — one divided card (gap-px hairlines) instead of separate tiles, so up to
            six numbers stay readable at every width: 2-up on phones, 3-up on tablets, 6-up on
            desktop. The icon is a small inline label, not a chip that steals the number's room. */}
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-gray-100 @xl/analytics:grid-cols-3 @4xl/analytics:grid-cols-6 dark:bg-slate-800/80">
            {([
              { icon: Eye, iconColor: 'text-sky-500', label: 'Views', value: hasServerAnalytics ? totalViews : '—', subtext: hasServerAnalytics ? undefined : 'Cloud only', help: 'Times the form was opened.' },
              ...(typeof totalStarts === 'number' ? [{ icon: MousePointerClick, iconColor: 'text-teal-500', label: 'Starts', value: totalStarts, help: 'Times someone began answering after opening it.' }] : []),
              { icon: Users, iconColor: 'text-blue-500', label: 'Responses', value: totalResponses, help: 'Completed submissions you received.' },
              { icon: CheckCircle, iconColor: 'text-green-500', label: 'Completion', value: hasServerAnalytics ? `${Math.round(completionRate)}%` : '—', subtext: hasServerAnalytics ? undefined : 'Cloud only', help: 'Of the people who started, how many finished.' },
              { icon: Clock, iconColor: 'text-purple-500', label: 'Avg. time', value: avgCompletionTime > 60 ? `${Math.floor(avgCompletionTime / 60)}m` : `${avgCompletionTime}s`, help: 'How long a submission takes on average.' },
              { icon: TrendingUp, iconColor: 'text-orange-500', label: 'This week', value: weeklyTrend.thisWeek, trend: { pct: weeklyTrend.pct, label: 'vs last' }, help: 'Responses in the last seven days, compared with the week before.' },
            ] as Array<{ icon: ElementType; iconColor: string; label: string; value: ReactNode; subtext?: string; help?: string; trend?: { pct: number | null; label?: string } }>).map((m) => (
              <div key={m.label} className="bg-white dark:bg-slate-900/50 p-3.5 sm:p-4 min-w-0" title={m.help}>
                <div className="flex items-center gap-1.5 text-gray-400 dark:text-slate-500">
                  <m.icon className={cn('h-3.5 w-3.5 flex-none', m.iconColor)} aria-hidden="true" />
                  <span className="text-[11px] font-medium uppercase tracking-wide truncate">{m.label}</span>
                </div>
                <p className="mt-1 text-xl sm:text-2xl font-bold text-gray-900 dark:text-white tracking-tight tabular-nums leading-tight break-words">{m.value}</p>
                {m.trend && (
                  <span className={cn('mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                    m.trend.pct === null ? 'bg-gray-500/10 text-gray-500 dark:text-slate-400'
                      : m.trend.pct >= 0 ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                        : 'bg-red-500/10 text-red-600 dark:text-red-400')}>
                    {m.trend.pct !== null && (m.trend.pct >= 0
                      ? <TrendingUp className="h-3 w-3" aria-hidden="true" />
                      : <TrendingDown className="h-3 w-3" aria-hidden="true" />)}
                    {m.trend.pct === null ? 'New' : `${m.trend.pct >= 0 ? '+' : ''}${m.trend.pct}%`}
                  </span>
                )}
                {m.subtext && <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5 truncate">{m.subtext}</p>}
                {m.help && (
                  <p className="mt-1 hidden text-[11px] leading-snug text-gray-400 @4xl/analytics:block dark:text-slate-500">{m.help}</p>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* Chart */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white tracking-tight transition-colors">Responses Over Time</h2>
              <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5 tabular-nums">
                {rangeTotal} {rangeTotal === 1 ? 'response' : 'responses'} in the last {rangeDays} days
              </p>
            </div>
            {/* Range switch — the server already ships up to 30 days of per-day counts */}
            <div className="flex flex-none items-center gap-0.5 rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 p-0.5" role="group" aria-label="Chart range">
              {CHART_RANGES.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setRangeDays(d)}
                  aria-pressed={rangeDays === d}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    rangeDays === d
                      ? 'bg-white dark:bg-slate-800 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {rangeTotal === 0 ? (
              <div className="h-52 sm:h-64 flex flex-col items-center justify-center text-center text-gray-400 dark:text-slate-500">
                <BarChart3 className="mb-2 h-6 w-6 opacity-60" aria-hidden="true" />
                <p className="text-sm">No responses in the last {rangeDays} days</p>
              </div>
            ) : (
              /* One labelled figure for AT — recharts' inner SVG isn't self-describing. */
              <div
                className="h-52 sm:h-64"
                role="img"
                aria-label={`Responses over the last ${dailySeries.length} days. ${dailySeries.map((d) => `${d.day} ${d.count}`).join(', ')}.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailySeries} margin={{ top: rangeDays === 7 ? 20 : 8, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartInk.grid} vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11, fill: chartInk.axis }}
                      tickLine={false}
                      axisLine={{ stroke: chartInk.grid }}
                      interval="preserveStartEnd"
                      minTickGap={rangeDays === 7 ? 8 : 24}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: chartInk.axis }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={32}
                    />
                    <Tooltip
                      contentStyle={chartInk.tooltip}
                      labelStyle={chartInk.tooltipLabel}
                      formatter={(v) => [`${v} ${v === 1 ? 'response' : 'responses'}`, null]}
                      cursor={{ fill: chartInk.cursor }}
                    />
                    <Bar dataKey="count" name="Responses" fill={chartInk.accent} radius={[6, 6, 0, 0]} maxBarSize={42}>
                      {/* Direct labels only on the roomy 7-day view; longer ranges rely on the tooltip. */}
                      {rangeDays === 7 && (
                        <LabelList
                          dataKey="count"
                          position="top"
                          formatter={(v: unknown) => (Number(v) > 0 ? String(v) : '')}
                          style={{ fontSize: 11, fill: chartInk.axis }}
                        />
                      )}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Field Breakdown — hidden for private forms (answers are ciphertext). */}
        {!isPrivateForm && Object.keys(fieldBreakdown).length > 0 && (
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
                    <div className="flex items-baseline gap-2 mb-2 sm:mb-3">
                      {breakdown.type === 'rating' && <Star className="h-4 w-4 text-yellow-500 self-center flex-shrink-0" />}
                      <h3 className="font-medium text-gray-900 dark:text-white text-sm sm:text-base transition-colors truncate" title={breakdown.label}>{breakdown.label}</h3>
                      <span className="ml-auto flex-shrink-0 text-xs text-gray-400 dark:text-slate-500 tabular-nums">
                        {breakdown.avg !== undefined && (
                          <span className="font-medium text-gray-500 dark:text-slate-400">{breakdown.avg} avg · </span>
                        )}
                        {breakdown.total} {breakdown.total === 1 ? 'answer' : 'answers'}
                      </span>
                    </div>
                    <div className="space-y-2.5">
                      {breakdown.data.map((item, index) => (
                        <div key={index} className="flex items-center gap-2 sm:gap-3">
                          <div className="w-20 sm:w-32 md:w-40 text-xs sm:text-sm text-gray-500 dark:text-slate-400 truncate flex-shrink-0 transition-colors" title={item.label}>
                            {item.label}
                          </div>
                          <div className="flex-1 h-2.5 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden transition-colors">
                            {/* Width is the TRUE share of answers (a 4% option renders at 4%),
                                not normalized to the largest option. A non-zero count keeps a
                                visible 2% sliver even when it rounds to 0%. */}
                            <div
                              className="h-full bg-primary-500 rounded-full transition-all"
                              style={{ width: `${Math.max(item.percentage, item.count > 0 ? 2 : 0)}%` }}
                            />
                          </div>
                          <div className="w-16 sm:w-24 text-right flex-shrink-0 tabular-nums">
                            <span className="text-xs sm:text-sm font-medium text-gray-900 dark:text-white transition-colors">{item.percentage}%</span>
                            <span className="text-xs text-gray-500 dark:text-slate-500 ml-1 hidden sm:inline transition-colors">({item.count})</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* E2EE (§9.2): private-form placeholder for answer-derived analytics. */}
        {isPrivateForm && (
          <Card>
            <CardContent className="p-6 flex items-start gap-3">
              <Lock className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">Private form — open records to view</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                  Answers are end-to-end encrypted, so field breakdowns and answer previews aren't available here.
                  Response counts and submission times above are unaffected.
                </p>
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
              <div className="space-y-3" aria-busy="true" aria-label="Loading responses">
                {Array.from({ length: 4 }).map((_, i) => <ListRowSkeleton key={i} />)}
              </div>
            ) : responses.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No responses yet"
                description="Share your form to start collecting responses"
                className="py-8"
              />
            ) : (
              <div ref={previewRef}>
                {previewCards ? (
                  <ul className="space-y-2">
                    {responses.slice(0, 10).map((response) => (
                      <li key={response.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60">
                        <button
                          type="button"
                          onClick={() => openResponse(response.id)}
                          title="Open this response"
                          className="w-full p-4 text-left rounded-xl cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        >
                          <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">{formatDate(response.submittedAt)}</p>
                          {previewFields.map((field) => (
                            <p key={field.id} className="text-sm text-gray-600 dark:text-slate-300 truncate">
                              <span className="text-gray-400 dark:text-slate-500">{field.label}: </span>
                              {isPrivateForm
                                ? '🔒'
                                : field.type === 'linked_record'
                                  ? (resolvedLinkLabel(response, field.id) ?? formatPreviewValue(field, response.answers[field.id]))
                                  : formatPreviewValue(field, response.answers[field.id])}
                            </p>
                          ))}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                <table className="w-full table-fixed">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-800">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500 w-28">ID</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500 w-44">Submitted</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500 w-20">Time</th>
                      {visiblePreview.map((field) => (
                        <th key={field.id} className="text-left py-3 px-4 text-sm font-medium text-gray-500 dark:text-slate-500 truncate">
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {responses.slice(0, 10).map((response) => (
                      <tr
                        key={response.id}
                        onClick={() => openResponse(response.id)}
                        className="border-b border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-4 text-sm truncate">
                          {/* Real button inside the row so keyboard users can open it too. */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openResponse(response.id); }}
                            title="Open this response"
                            aria-label={`Open response ${response.id.slice(0, 8)}`}
                            className="font-mono text-sm text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-400 rounded cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                          >
                            #{response.id.slice(0, 8)}
                          </button>
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-500 dark:text-slate-400 truncate">
                          {formatDate(response.submittedAt)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-500 dark:text-slate-400">
                          {Math.round((response.completionTime || 0) / 1000)}s
                        </td>
                        {visiblePreview.map((field) => (
                          <td key={field.id} className="py-3 px-4 text-sm text-gray-500 dark:text-slate-400 truncate">
                            {isPrivateForm
                              ? '🔒'
                              : field.type === 'linked_record'
                                ? (resolvedLinkLabel(response, field.id) ?? formatPreviewValue(field, response.answers[field.id]))
                                : formatPreviewValue(field, response.answers[field.id])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                )}
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
        formStatus={form.status}
        publicUnfillableFields={publicUnfillableFieldLabels(form.fields)}
      />
    </div>
  );
}
