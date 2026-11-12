import { useState, useEffect, useMemo, useRef, type ElementType, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Download, Users, Clock, CheckCircle, TrendingUp, Loader2, ChevronDown, Database, FileJson, Table, Share2, Star, BarChart3, Inbox, Eye, MousePointerClick, Lock } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from 'recharts';
import { useUIStore } from '../stores/uiStore';
import { ListRowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadFailure } from '../components/ui/LoadFailure';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
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
import { csvEscapeCell } from '../lib/csv';
import { deferEffect } from '../lib/deferredEffect';
import { useCurrentTime } from '../hooks/useCurrentTime';
import type { LocalFormResponse } from '../types/form';

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
  const allLocalResponses = useResponseStore((state) => state.responses);
  const now = useCurrentTime();
  const user = useAuthStore((state) => state.user);
  // True while the form store is still hydrating — so a deep-link/refresh shows a
  // loading state instead of flashing "Form not found" before the form arrives.
  const formsLoading = useFormStore((s) => !s.isInitialized || s.isLoading);

  const [analytics, setAnalytics] = useState<FormAnalyticsType | null>(null);
  // Real response rows for API/cloud mode (the local store is empty there).
  const [apiResponses, setApiResponses] = useState<LocalFormResponse[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const nextAnalyticsKey = `${formId ?? ''}/${storageMode}/${user?.id ?? ''}/${reloadToken}`;
  const [analyticsKey, setAnalyticsKey] = useState(nextAnalyticsKey);
  if (analyticsKey !== nextAnalyticsKey) {
    setAnalyticsKey(nextAnalyticsKey);
    setAnalytics(null);
    setApiResponses([]);
    setLoadError(null);
    setIsLoading(storageMode === 'api' && !!user && !!formId);
  }

  // Load full form data (with fields) from API
  useEffect(() => {
    if (formId) loadFullForm(formId);
  }, [formId, loadFullForm]);

  const form = formId ? getForm(formId) : undefined;
  const localResponses = useMemo(
    () => allLocalResponses.filter((response) => response.formId === formId),
    [allLocalResponses, formId],
  );
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
  useEffect(() => deferEffect(() => {
    let cancelled = false;

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
            setApiResponses(norm as LocalFormResponse[]);
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
  }), [formId, storageMode, user, reloadToken]);

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

  const formFields = useMemo(() => form?.fields ?? [], [form]);

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
  }, [analytics, responses, now]);

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
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      out.push({
        day: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        count: counts[localDayKey(d)] || 0,
      });
    }
    return out;
  }, [analytics, localResponses, rangeDays, now]);
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
          const blob = await api.exportResponses(form.id);
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

      // Formula-injection safe, numbers left as numbers (lib/csv.ts).
      const csv = [headers.map(csvEscapeCell).join(','), ...rows.map((r) => r.map(csvEscapeCell).join(','))].join('\n');
      // The BOM tells Excel the file is UTF-8, as the server's export does.
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
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
      <div className="@container/analytics flex-1 w-full px-4 pb-24 pt-4 sm:px-6">
        <PageHeader
          title={form.title}
          subtitle="Analytics"
          onBack={goBack}
          backLabel="Back"
        />

        {loadError && (
          <div className="mb-3">
            <LoadFailure
              title="We couldn't load this form's analytics"
              message={loadError}
              onRetry={() => { setLoadError(null); setReloadToken((n) => n + 1); }}
            />
          </div>
        )}

        {/* The form's numbers as one strip of facts, the strip that stands over the list of its
            responses (FormResponses): two to a line on a phone, three on a tablet, all six on a
            desktop, by this box's own width. What each number counts is its title; five numbers
            (a form with no "starts") leave no empty cell, the last takes two. */}
        <dl className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 dark:border-slate-800 dark:bg-slate-800 @xl/analytics:grid-cols-3 @4xl/analytics:grid-cols-6">
          {(([
            { icon: Eye, label: 'Views', value: hasServerAnalytics ? totalViews : '—', subtext: hasServerAnalytics ? undefined : 'Cloud only', help: 'Times the form was opened.' },
            ...(typeof totalStarts === 'number' ? [{ icon: MousePointerClick, label: 'Starts', value: totalStarts, help: 'Times someone began answering after opening it.' }] : []),
            { icon: Users, label: 'Responses', value: totalResponses, help: 'Completed submissions you received.' },
            { icon: CheckCircle, label: 'Completion', value: hasServerAnalytics ? `${Math.round(completionRate)}%` : '—', subtext: hasServerAnalytics ? undefined : 'Cloud only', help: 'Of the people who started, how many finished.' },
            { icon: Clock, label: 'Avg. time', value: avgCompletionTime > 60 ? `${Math.floor(avgCompletionTime / 60)}m` : `${avgCompletionTime}s`, help: 'How long a submission takes on average.' },
            { icon: TrendingUp, label: 'This week', value: weeklyTrend.thisWeek, change: weeklyTrend.pct, help: 'Responses in the last seven days, compared with the week before.' },
          ]) as Array<{ icon: ElementType; label: string; value: ReactNode; subtext?: string; help?: string; change?: number | null }>).map((m, index, all) => (
            <div key={m.label} className={cn('flex min-w-0 items-center gap-3 bg-white px-3 py-2.5 dark:bg-slate-900', all.length === 5 && index === 4 && 'col-span-2')} title={m.help}>
              <m.icon className="h-4 w-4 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
              <div className="min-w-0">
                <dt className="truncate text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-slate-400">{m.label}</dt>
                <dd className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold leading-6 tabular-nums text-gray-900 dark:text-white">
                  {m.value}
                  {/* Against the week before; "New" when there was no week before to compare with. */}
                  {m.change !== undefined && (
                    <span className={cn('text-[11px] font-semibold', m.change === null ? 'text-gray-500 dark:text-slate-400' : m.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
                      {m.change === null ? 'New' : `${m.change >= 0 ? '+' : ''}${m.change}%`} <span className="font-normal text-gray-400 dark:text-slate-500">vs last week</span>
                    </span>
                  )}
                  {m.subtext && <span className="text-[11px] font-normal text-gray-500 dark:text-slate-400">{m.subtext}</span>}
                </dd>
              </div>
            </div>
          ))}
        </dl>

        {!isPrivateForm && storageMode === 'api' && totalResponses > responses.length && Object.keys(fieldBreakdown).length > 0 && (
          <p className="mb-3 text-xs leading-5 tabular-nums text-gray-500 dark:text-slate-400">
            The breakdown of each field is based on the latest {responses.length} of {totalResponses} responses.
          </p>
        )}

        {/* The chart and one panel for each field's breakdown, in as many columns as this box
            has room for, each as tall as what it holds. */}
        <div className="columns-1 gap-4 [&>*]:mb-4 [&>*]:break-inside-avoid @4xl/analytics:columns-2 @7xl/analytics:columns-3">
        {/* Chart */}
        <Panel
          title="Responses over time"
          description={<span className="tabular-nums">{rangeTotal} {rangeTotal === 1 ? 'response' : 'responses'} in the last {rangeDays} days</span>}
          actions={
            /* Range switch — the server already ships up to 30 days of per-day counts */
            <div className="flex flex-none items-center gap-0.5 rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 p-0.5" role="group" aria-label="Chart range">
              {CHART_RANGES.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setRangeDays(d)}
                  aria-pressed={rangeDays === d}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 max-sm:px-3',
                    rangeDays === d
                      ? 'bg-white dark:bg-slate-800 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
          }
        >
            {rangeTotal === 0 ? (
              <div className="flex h-44 flex-col items-center justify-center text-center text-gray-500 dark:text-slate-400 sm:h-52">
                <BarChart3 className="mb-2 h-6 w-6 opacity-60" aria-hidden="true" />
                <p className="text-sm">No responses in the last {rangeDays} days</p>
              </div>
            ) : (
              /* One labelled figure for AT — recharts' inner SVG isn't self-describing. */
              <div
                className="h-44 sm:h-52"
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
        </Panel>

        {/* Field breakdown: a panel for each field — hidden for private forms (answers are
            ciphertext). An option's name is never cut short: it wraps beside its bar. */}
        {!isPrivateForm && Object.entries(fieldBreakdown).map(([fieldId, breakdown]) => (
          <Panel
            key={fieldId}
            title={<span className="[overflow-wrap:anywhere]">{breakdown.label}</span>}
            icon={breakdown.type === 'rating' ? <Star className="h-4 w-4 text-yellow-500" /> : <BarChart3 className="h-4 w-4" />}
            actions={
              <span className="text-xs tabular-nums text-gray-500 dark:text-slate-400">
                {breakdown.avg !== undefined && (
                  <span className="font-medium">{breakdown.avg} avg · </span>
                )}
                {breakdown.total} {breakdown.total === 1 ? 'answer' : 'answers'}
              </span>
            }
          >
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-3 gap-y-1.5">
              {breakdown.data.map((item, index) => (
                <div key={index} className="contents">
                  <div className="text-[13px] leading-5 text-gray-600 [overflow-wrap:anywhere] dark:text-slate-300">
                    {item.label}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-slate-800">
                    {/* Width is the TRUE share of answers (a 4% option renders at 4%),
                        not normalized to the largest option. A non-zero count keeps a
                        visible 2% sliver even when it rounds to 0%. */}
                    <div
                      className="h-full bg-primary-500 rounded-full transition-all"
                      style={{ width: `${Math.max(item.percentage, item.count > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                  <div className="text-right text-[13px] leading-5 tabular-nums">
                    <span className="font-medium text-gray-900 dark:text-white">{item.percentage}%</span>
                    <span className="ml-1 text-xs text-gray-500 dark:text-slate-400">({item.count})</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ))}

        {/* E2EE (§9.2): private-form placeholder for answer-derived analytics. */}
        {isPrivateForm && (
          <Panel title="Private form — open records to view" icon={<Lock className="h-4 w-4 text-green-600 dark:text-green-400" />}>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              Answers are end-to-end encrypted, so field breakdowns and answer previews aren't available here.
              Response counts and submission times above are unaffected.
            </p>
          </Panel>
        )}
        </div>

        {/* Recent responses: the latest ten as a dense table (the look of the responses list),
            and as cards where there is no room for columns. */}
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-3 py-2 dark:border-slate-700">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent responses</h2>
            <Button variant="outline" size="sm" onClick={() => navigate(`/responses/${form.id}`)}>
              View all
            </Button>
          </div>
            {isLoading ? (
              <div className="space-y-3 p-3" aria-busy="true" aria-label="Loading responses">
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
                  <ul className="divide-y divide-gray-100 dark:divide-slate-800">
                    {responses.slice(0, 10).map((response) => (
                      <li key={response.id}>
                        <button
                          type="button"
                          onClick={() => openResponse(response.id)}
                          title="Open this response"
                          className="w-full cursor-pointer p-3 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:hover:bg-white/[0.03]"
                        >
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{formatDate(response.submittedAt)}</p>
                          {/* Each answer's name over its value, two to a line, as on the responses list. */}
                          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                            {previewFields.map((field) => (
                              <div key={field.id} className="min-w-0">
                                <dt className="truncate text-[11px] text-gray-500 dark:text-slate-400">{field.label}</dt>
                                <dd className="truncate text-sm text-gray-700 dark:text-slate-200">
                                  {isPrivateForm
                                    ? '🔒'
                                    : field.type === 'linked_record'
                                      ? (resolvedLinkLabel(response, field.id) ?? formatPreviewValue(field, response.answers[field.id]))
                                      : formatPreviewValue(field, response.answers[field.id])}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                <table className="w-full table-fixed">
                  <thead className="border-b border-gray-200 bg-gray-50/50 dark:border-slate-800 dark:bg-slate-900/50">
                    <tr>
                      <th className="w-28 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">ID</th>
                      <th className="w-44 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Submitted</th>
                      <th className="w-16 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Time</th>
                      {visiblePreview.map((field) => (
                        <th key={field.id} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400" title={field.label}>
                          <span className="block truncate">{field.label}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {responses.slice(0, 10).map((response) => (
                      <tr
                        key={response.id}
                        onClick={() => openResponse(response.id)}
                        className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-white/[0.03]"
                      >
                        <td className="truncate px-3 py-1.5 text-[13px]">
                          {/* Real button inside the row so keyboard users can open it too. */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openResponse(response.id); }}
                            title="Open this response"
                            aria-label={`Open response ${response.id.slice(0, 8)}`}
                            className="font-mono text-xs text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-400 rounded cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                          >
                            #{response.id.slice(0, 8)}
                          </button>
                        </td>
                        <td className="truncate px-3 py-1.5 text-[13px] tabular-nums text-gray-600 dark:text-slate-300">
                          {formatDate(response.submittedAt)}
                        </td>
                        <td className="px-3 py-1.5 text-right text-[13px] tabular-nums text-gray-600 dark:text-slate-300">
                          {Math.round((response.completionTime || 0) / 1000)}s
                        </td>
                        {visiblePreview.map((field) => {
                          const text = isPrivateForm
                            ? '🔒'
                            : field.type === 'linked_record'
                              ? (resolvedLinkLabel(response, field.id) ?? formatPreviewValue(field, response.answers[field.id]))
                              : formatPreviewValue(field, response.answers[field.id]);
                          return (
                            <td key={field.id} className="truncate px-3 py-1.5 text-[13px] text-gray-600 dark:text-slate-300" title={text}>
                              {text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                )}
              </div>
            )}
        </section>
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
