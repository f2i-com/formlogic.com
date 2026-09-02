import { useState, useEffect, useMemo, useRef, useCallback, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';

import { logger } from '../lib/logger';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
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
  Clock,
  ArrowRight,
  Inbox,
  Sparkles,
  BookOpen,
  Package,
  Boxes,
  ChevronRight,
  Search,
  ShieldCheck,
  AlertTriangle,
  X,
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { ListRowSkeleton, Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { ShowMore } from '../components/ui/ShowMore';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { api } from '../lib/api';
import { loadUiCache, saveUiCache } from '../lib/uiCache';
import { loadAppGroupsCache, fetchAppGroups, type AppGroup } from '../lib/appGroups';
import { appClickLabel, appClickPath } from '../lib/appNavigation';
import { isDemoLocalId } from '../lib/demoLocal';
import { cn, formatRelativeTime, sanitizeFilename, parseServerDate } from '../lib/utils';
import { EmbedModal, TemplateSelector, PackImportModal, useFormPreview } from '../components/builder';
import { WelcomeModal } from '../components/onboarding/WelcomeModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { CreateBand } from '../components/chat/CreateBand';
import { PrivateLockBadge } from '../components/forms/PrivateLockBadge';
import type { FormTemplate } from '../data/formTemplates';
import type { App } from '../types/app';
import type { Form } from '../types/form';

interface DashboardStats {
  totalResponses: number;
}

// The last visit's computed aggregates, persisted per user (see uiCache) so the
// dashboard paints instantly instead of re-blocking on the per-form analytics
// fan-out. Always revalidated in the background after hydration.
interface DashboardStatsCache {
  totalResponses: number;
  responseCounts: Record<string, number>;
  pulses: Record<string, PulseDay[]>;
  recent: Array<{ id: string; formId: string; formTitle: string; submittedAt: string }>;
  /** formId → epoch-ms of the most recent submission (drives the Last-activity sort). */
  lastActivity?: Record<string, number>;
}

interface BrowserResponseStats {
  totalResponses: number;
  responseCounts: Record<string, number>;
  pulses: Record<string, PulseDay[]>;
  recent: Array<{ id: string; formId: string; formTitle: string; submittedAt: string }>;
  lastActivity: Record<string, number>;
}

/** Dashboard "My forms" sort modes — Last activity is the default (last USED, not last added). */
type DashFormsSort = 'activity' | 'edited' | 'created' | 'responses';
const DASH_FORMS_SORT_KEY = 'dashboard.formsSort';
const DASH_FORMS_PAGE = 10;
const DASH_FORMS_INITIAL = 5;

// Within this window a remount reuses the cache without refetching at all —
// rapid Dashboard ↔ Forms navigation shouldn't hammer N analytics endpoints.
const STATS_FRESH_MS = 60_000;

// App accents are user/pack-authored hex values; validate strictly before injecting into an
// inline CSS custom property (same rule as AppsDashboard / FormsList).
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

// App identity tile: logo image → curated icon tinted with the app's accent → monogram initial.
function AppIdentityTile({ app }: { app: App }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showLogo = Boolean(app.logoUrl) && !imgFailed;
  const icon = app.settings?.icon;
  const accent = app.theme?.primaryColor;
  const accented = !showLogo && isHexColor(accent);
  const monogram = (app.name?.trim().charAt(0) || '?').toUpperCase();
  return (
    <div
      style={accented ? ({ '--fl-a': accent } as CSSProperties) : undefined}
      className={cn(
        'flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded-lg',
        showLogo
          ? 'bg-gray-50 dark:bg-slate-800/60'
          : accented
            ? 'bg-[color-mix(in_srgb,var(--fl-a)_11%,transparent)] text-[color:var(--fl-a)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--fl-a)_25%,transparent)] dark:bg-[color-mix(in_srgb,var(--fl-a)_16%,transparent)] dark:text-[color:color-mix(in_srgb,var(--fl-a)_62%,white)]'
            : 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400'
      )}
    >
      {showLogo ? (
        <img src={app.logoUrl} alt="" loading="lazy" onError={() => setImgFailed(true)} className="h-full w-full object-cover" />
      ) : icon ? (
        <DynamicIcon name={icon} className="h-5 w-5" fallback={<span className="text-sm font-semibold" aria-hidden="true">{monogram}</span>} />
      ) : (
        <span className="text-sm font-semibold" aria-hidden="true">{monogram}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The 14-day pulse strip — the dashboard's signature element. One row per form:
// a bar per local calendar day (oldest → today), fill opacity graded by that
// day's response count so the shape registers even on a quiet form, with
// today's bar always at full opacity to mark the live edge of the ledger.
// ---------------------------------------------------------------------------

const PULSE_DAYS = 14;

interface PulseDay {
  /** Local calendar date, 'YYYY-MM-DD'. */
  key: string;
  count: number;
  isToday: boolean;
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The last `n` local calendar dates, oldest first, ending with today.
function lastNDayKeys(n: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

function weekdayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
}

// API mode: the backend already buckets into local-calendar-day counts (when we pass
// tzOffsetMinutes), but only returns days that had ≥1 response, over a 30-day window.
// Zero-fill onto the last PULSE_DAYS days so quiet days still render a bar.
function buildPulseFromSparse(sparse: Array<{ date: string; count: number }> | undefined): PulseDay[] {
  const keys = lastNDayKeys(PULSE_DAYS);
  const todayKey = keys[keys.length - 1];
  const counts = new Map((sparse ?? []).map((d) => [d.date, d.count] as const));
  return keys.map((key) => ({ key, count: counts.get(key) ?? 0, isToday: key === todayKey }));
}

// Local storage mode: bucket raw response timestamps into local calendar days ourselves.
function buildPulseFromTimestamps(timestamps: string[]): PulseDay[] {
  const keys = lastNDayKeys(PULSE_DAYS);
  const todayKey = keys[keys.length - 1];
  const counts = new Map<string, number>();
  for (const ts of timestamps) {
    const key = localDateKey(parseServerDate(ts));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return keys.map((key) => ({ key, count: counts.get(key) ?? 0, isToday: key === todayKey }));
}

const EMPTY_PULSE_BAR_H = 2; // px — the sliver a zero-response day still shows

function PulseStrip({ days, className, loading = false }: { days: PulseDay[]; className?: string; loading?: boolean }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // `realMax` is the true busiest-day count (0 for a quiet form); `scaleMax` floors that
  // to 1 purely so the height/opacity math below never divides by zero. Keep these
  // separate — the floor is a rendering detail, not a fact to report in the aria-label.
  const realMax = Math.max(...days.map((d) => d.count));
  const scaleMax = Math.max(1, realMax);
  const barCount = days.length || PULSE_DAYS;
  const viewWidth = 168;
  const height = 42;
  const barWidth = 7;
  const gap = barCount > 1 ? (viewWidth - barCount * barWidth) / (barCount - 1) : 0;
  const chartBottom = height - 3;
  const chartHeight = 32;

  if (loading) {
    return (
      <div className={cn('flex h-[42px] w-full min-w-[7rem] items-end gap-1', className)} aria-hidden="true">
        {Array.from({ length: barCount }).map((_, i) => (
          <span
            key={i}
            className="min-w-0 flex-1 animate-pulse rounded-t-[3px] bg-primary-200/70 dark:bg-primary-500/20"
            style={{ height: `${8 + ((i * 7) % 28)}px`, opacity: i === barCount - 1 ? 0.7 : 0.4 }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('relative h-[42px] w-full min-w-[7rem]', className)}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${viewWidth} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Responses over the last ${days.length} days: ${days.reduce((s, d) => s + d.count, 0)} total, busiest day ${realMax}`}
      >
        {[chartBottom - chartHeight, chartBottom - chartHeight / 2, chartBottom].map((y) => (
          <line
            key={y}
            x1={0}
            x2={viewWidth}
            y1={y}
            y2={y}
            stroke="currentColor"
            className="text-gray-200/80 dark:text-white/[0.07]"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {days.map((d, i) => {
          const barHeight = Math.max(EMPTY_PULSE_BAR_H + 1, Math.round((d.count / scaleMax) * chartHeight));
          const x = i * (barWidth + gap);
          const y = chartBottom - barHeight;
          // Quiet days remain visible against the guides; today is slightly stronger so
          // the live edge is obvious without pretending a zero-response day has activity.
          const opacity = d.count === 0 ? (d.isToday ? 0.32 : 0.12) : 0.45 + (d.count / scaleMax) * 0.55;
          return (
            <g key={d.key}>
              {/* Full-height, gap-inclusive hit area — the visible bar can be as
                  short as 2px, too small a target to hover reliably on its own. */}
              <rect
                x={Math.max(0, x - gap / 2)}
                y={0}
                width={barWidth + gap}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
              >
                <title>{`${weekdayLabel(d.key)} · ${d.count} response${d.count === 1 ? '' : 's'}`}</title>
              </rect>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={2}
                fill="rgb(var(--primary-600))"
                style={{ opacity }}
                pointerEvents="none"
              />
            </g>
          );
        })}
      </svg>
      {hoverIndex !== null && (
        <div
          className={cn(
            'pointer-events-none absolute -top-7 z-10 whitespace-nowrap rounded-md border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-700 shadow-md motion-safe:transition-opacity dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
            hoverIndex > 0 && hoverIndex < days.length - 1 && '-translate-x-1/2'
          )}
          style={
            hoverIndex === 0
              ? { left: 0 }
              : hoverIndex === days.length - 1
                ? { right: 0 }
                : { left: `${((hoverIndex + 0.5) / days.length) * 100}%` }
          }
        >
          {weekdayLabel(days[hoverIndex].key)} · {days[hoverIndex].count} response{days[hoverIndex].count === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

// Per-form accent dots in the activity rail — real categorical identity (same color =
// same form) replacing the old uniform green "Zap" chip, which carried no information.
// Assigned by a stable hash of the form id (not by position in a recency-sorted list),
// so a form's dot color survives reordering as `updatedAt` changes across renders.
const ACTIVITY_ACCENT_DOTS = ['bg-blue-500', 'bg-violet-500', 'bg-teal-500', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-500'];

function hashToIndex(id: string, mod: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % mod;
}

function accentDotForForm(formId: string): string {
  return ACTIVITY_ACCENT_DOTS[hashToIndex(formId, ACTIVITY_ACCENT_DOTS.length)];
}

// Dropdown Menu component for form actions — uses createPortal to escape stacking context
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
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on scroll/resize to prevent stale positioning
  useEffect(() => {
    if (!isOpen) return;
    const close = () => setIsOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setIsOpen(false); buttonRef.current?.focus(); } };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const toggleMenu = useCallback(() => {
    if (isOpen) {
      setIsOpen(false);
    } else {
      setMenuRect(buttonRef.current?.getBoundingClientRect() ?? null);
      setIsOpen(true);
    }
  }, [isOpen]);

  const handleExportSqlite = async () => {
    setIsExporting(true);
    try {
      await api.downloadSqlite(formId, formTitle);
    } catch (error) {
      logger.error('Failed to export SQLite:', error);
      toast.error('Export failed', error instanceof Error ? error.message : 'Failed to export SQLite database');
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
      logger.error('Failed to export JSON:', error);
      toast.error('Export failed', error instanceof Error ? error.message : 'Failed to export JSON');
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
      link.download = `${sanitizeFilename(formTitle)}-responses.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Failed to export CSV:', error);
      toast.error('Export failed', 'Failed to export CSV');
    } finally {
      setIsExporting(false);
      setIsOpen(false);
    }
  };

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        onClick={toggleMenu}
        disabled={isExporting}
        title="More actions"
        aria-label={`Actions for ${formTitle}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        {isExporting ? (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 dark:border-slate-600 border-t-gray-600 dark:border-t-slate-300" />
        ) : (
          <MoreVertical className="h-4 w-4" />
        )}
      </Button>
      {isOpen && menuRect && createPortal(
        <div className="fixed inset-0" style={{ zIndex: 60 }}>
          <div className="absolute inset-0 bg-transparent" onClick={() => setIsOpen(false)} />
          <div
            role="menu"
            aria-label={`Actions for ${formTitle}`}
            className="absolute w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 ring-1 ring-black/5 dark:ring-white/[0.06] overflow-hidden max-h-[80vh] overflow-y-auto"
            style={{
              ...(menuRect.bottom + 320 > window.innerHeight
                ? { bottom: window.innerHeight - menuRect.top + 4 }
                : { top: menuRect.bottom + 4 }),
              left: Math.max(8, menuRect.right - 192),
            }}
          >
            {/* Mobile-only quick actions */}
            <div className="sm:hidden">
              <button
                onClick={() => { onEdit(); setIsOpen(false); }}
                role="menuitem"
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
              >
                <Pencil className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                Edit
              </button>
              <button
                onClick={() => { onPreview(); setIsOpen(false); }}
                role="menuitem"
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
              >
                <Eye className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                Preview
              </button>
              <button
                onClick={() => { onAnalytics(); setIsOpen(false); }}
                role="menuitem"
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
              >
                <BarChart3 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                Analytics
              </button>
              <button
                onClick={() => { onViewData(); setIsOpen(false); }}
                role="menuitem"
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
              >
                <Table className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                View data
              </button>
              <button
                onClick={() => { onShare(); setIsOpen(false); }}
                role="menuitem"
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
              >
                <Share2 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                Share & embed
              </button>
              <div className="border-t border-gray-100 dark:border-slate-800 my-1" />
            </div>
            <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
              Export
            </div>
            <button
              onClick={handleExportSqlite}
              role="menuitem"
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
            >
              <Database className="h-4 w-4 text-blue-500" />
              Download SQLite
            </button>
            <button
              onClick={handleExportJson}
              role="menuitem"
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
            >
              <FileJson className="h-4 w-4 text-green-500" />
              Export JSON
            </button>
            <button
              onClick={handleExportCsv}
              role="menuitem"
              className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300 flex items-center gap-2 cursor-pointer"
            >
              <Download className="h-4 w-4 text-purple-500" />
              Export CSV
            </button>
            <div className="border-t border-gray-100 dark:border-slate-800 my-1" />
            <button
              onClick={() => { onDelete(); setIsOpen(false); }}
              role="menuitem"
              className="w-full px-3 py-2 text-sm text-left hover:bg-red-500/10 text-red-500 flex items-center gap-2 cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
              Delete form
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Quick find: type-ahead over every form — jump straight to a form's records,
// builder, or analytics without scrolling the lists. "/" focuses it from
// anywhere on the page; ↑/↓ + Enter opens the highlighted form's records.
function QuickFind({
  forms,
  countOf,
  appOfForm,
}: {
  forms: Form[];
  countOf: (form: Form) => number;
  appOfForm: Record<string, string>;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'archived'>('all');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // "/" focuses the quick find unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '/' && t && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Clicking outside closes the results panel.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    return forms
      .filter((f) => statusFilter === 'all' || f.status === statusFilter)
      .filter((f) => !t || f.title.toLowerCase().includes(t) || (appOfForm[f.id] ?? '').toLowerCase().includes(t))
      .sort((a, b) => parseServerDate(b.updatedAt).getTime() - parseServerDate(a.updatedAt).getTime())
      .slice(0, 8);
  }, [forms, q, statusFilter, appOfForm]);
  // Clamp the keyboard highlight instead of resetting it in an effect.
  const hi = Math.min(highlight, Math.max(0, results.length - 1));

  const openRecords = (form: Form) => { setOpen(false); navigate(`/responses/${form.id}`); };

  return (
    <div ref={wrapRef} className="relative mb-8 max-w-2xl">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-label="Quick find a form"
          placeholder="Search your forms"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHighlight(Math.min(hi + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(Math.max(hi - 1, 0)); }
            else if (e.key === 'Enter' && open && results[hi]) { e.preventDefault(); openRecords(results[hi]); }
            else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
          }}
          className="w-full pl-10 pr-16 py-3 rounded-xl border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-colors shadow-sm"
        />
        <kbd className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-gray-400 dark:text-slate-500">/</kbd>
      </div>

      {open && (
        <div className="absolute z-40 mt-2 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl shadow-gray-900/10 dark:shadow-black/40 overflow-hidden">
          {/* Status filter chips */}
          <div className="flex items-center gap-1.5 px-3 pt-3 pb-2 border-b border-gray-100 dark:border-slate-800">
            {(['all', 'published', 'draft', 'archived'] as const).map((sf) => (
              <button
                key={sf}
                type="button"
                onClick={() => { setStatusFilter(sf); inputRef.current?.focus(); }}
                className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors cursor-pointer ${statusFilter === sf
                  ? 'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
                  : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800'}`}
              >
                {sf === 'all' ? 'All' : sf}
              </button>
            ))}
          </div>
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400 dark:text-slate-500">No forms match.</p>
          ) : (
            <ul role="listbox" aria-label="Matching forms" className="max-h-80 overflow-y-auto divide-y divide-gray-50 dark:divide-slate-800/60">
              {results.map((form, i) => {
                const count = countOf(form);
                const appName = appOfForm[form.id];
                return (
                  <li key={form.id} role="option" aria-selected={i === hi}>
                    <div
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => openRecords(form)}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer ${i === hi ? 'bg-gray-50 dark:bg-slate-800/60' : ''}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{form.title}</span>
                          {appName && (
                            <span className="hidden sm:inline-flex flex-none items-center rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:text-slate-400">
                              {appName}
                            </span>
                          )}
                        </div>
                        <span className="block text-xs text-gray-400 dark:text-slate-500 capitalize">
                          {form.status} · {count} record{count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 flex-none" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => openRecords(form)}
                          title="View records"
                          aria-label={`View records for ${form.title}`}
                          className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
                        >
                          <Table className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setOpen(false); navigate(`/builder/${form.id}`); }}
                          title="Edit form"
                          aria-label={`Edit ${form.title}`}
                          className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setOpen(false); navigate(`/analytics/${form.id}`); }}
                          title="Analytics"
                          aria-label={`Analytics for ${form.title}`}
                          className="hidden sm:block p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
                        >
                          <BarChart3 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="px-4 py-2 border-t border-gray-100 dark:border-slate-800 text-[11px] text-gray-400 dark:text-slate-500">
            Enter opens the records · click a result to browse its data
          </p>
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  useDocumentTitle('Dashboard');
  const navigate = useNavigate();
  const { forms, createForm, setActiveForm, deleteForm, addField, storageMode } = useFormStore();
  const formsLoading = useFormStore((s) => s.isLoading || !s.isInitialized);
  const { getResponsesByFormId, responses } = useResponseStore();
  const user = useAuthStore((state) => state.user);
  const [stats, setStats] = useState<DashboardStats>({ totalResponses: 0 });
  // Whether `stats` reflects a completed fetch (api mode) rather than the zeroed initial
  // value — so the headline can hold its '—' dash instead of flashing "0 responses" while
  // the analytics fetch is still in flight.
  const [statsReady, setStatsReady] = useState(false);
  // api.request never throws — a 500 from every /analytics call returns {error} and used
  // to leave totalResponses at 0, which the headline reported as "No responses yet" and
  // the cache then persisted. Track the failure so the page can say so instead of lying.
  const [statsFailed, setStatsFailed] = useState(false);
  const [statsReloadToken, setStatsReloadToken] = useState(0);
  // Cloud (API) mode keeps responses on the server, not in the local store, so
  // per-form counts + Recent Activity must come from the API (else the cards show
  // 0 / "No submissions yet" while the Total Responses stat shows the real number).
  const [responseCounts, setResponseCounts] = useState<Record<string, number>>({});
  // formId → most recent submission (epoch ms). API mode: derived from the analytics fetch
  // below; local mode: computed from the stored responses. Powers the Last-activity sort.
  const [apiLastActivity, setApiLastActivity] = useState<Record<string, number>>({});
  const [formsSort, setFormsSort] = useState<DashFormsSort>(() => {
    try {
      const v = localStorage.getItem(DASH_FORMS_SORT_KEY);
      return v === 'edited' || v === 'created' || v === 'responses' ? v : 'activity';
    } catch {
      return 'activity';
    }
  });
  const changeFormsSort = (v: DashFormsSort) => {
    setFormsSort(v);
    try { localStorage.setItem(DASH_FORMS_SORT_KEY, v); } catch { /* persistence is optional */ }
  };
  const [formsShown, setFormsShown] = useState(DASH_FORMS_INITIAL);
  // Per-form 14-day activity, for the pulse strip (api mode; local mode derives its own below).
  const [apiPulses, setApiPulses] = useState<Record<string, PulseDay[]>>({});
  const [apiRecent, setApiRecent] = useState<Array<{ id: string; formId: string; formTitle: string; submittedAt: string }>>([]);
  const [browserStats, setBrowserStats] = useState<BrowserResponseStats>({
    totalResponses: 0,
    responseCounts: {},
    pulses: {},
    recent: [],
    lastActivity: {},
  });
  const [browserStatsReady, setBrowserStatsReady] = useState(true);
  // formId -> the app it belongs to (cloud mode), so Recent Forms can tag which app a form is
  // part of (badge only — preview routing does its own fresh per-click context lookup).
  const [appOfForm, setAppOfForm] = useState<Record<string, string>>({});
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string; status: Form['status'] } | null>(null);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showPackImport, setShowPackImport] = useState(false);

  // Apps panel (cloud mode only — apps live on the server). Reuses the app store, which
  // persists across visits, so the section renders instantly on revisit.
  const { apps, fetchApps } = useAppStore();
  useEffect(() => {
    if (storageMode === 'api') fetchApps();
  }, [storageMode, fetchApps]);
  const recentApps = useMemo(
    () => storageMode === 'api'
      ? [...apps]
        .sort((a, b) => parseServerDate(b.updatedAt).getTime() - parseServerDate(a.updatedAt).getTime())
        .slice(0, 4)
      : [],
    [apps, storageMode]
  );

  const handleCreateForm = () => {
    setShowTemplateSelector(true);
  };

  const handleSelectTemplate = async (template: FormTemplate | null) => {
    setShowTemplateSelector(false);

    if (template) {
      const form = await createForm(template.name);
      if (!form) return;
      template.fields.forEach((field) => {
        addField(form.id, field);
      });
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
      toast.success('Form created', `Started with "${template.name}" template`);
    } else {
      const form = await createForm('Untitled Form');
      if (!form) return;
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
    }
  };

  // First-run onboarding: a welcome that routes a brand-new user into creating their first form.
  // Dismissal persists PER USER (namespaced by id) so a fresh account on a shared browser still sees
  // it and returning users aren't nagged. Derived during render (no effect) so it reacts once `user`
  // hydrates; a bump forces the re-render after dismissal — avoids a setState-in-effect.
  const onboardingKey = user?.id ? `formlogic_onboarding_dismissed:${user.id}` : null;
  const [, bumpOnboarding] = useState(0);
  const welcomeDismissed = !onboardingKey || (() => {
    try { return localStorage.getItem(onboardingKey) === '1'; } catch { return false; }
  })();
  const dismissWelcome = useCallback(() => {
    if (onboardingKey) { try { localStorage.setItem(onboardingKey, '1'); } catch { /* ignore */ } }
    bumpOnboarding((n) => n + 1);
  }, [onboardingKey]);
  const onWelcomeBlank = () => { dismissWelcome(); handleSelectTemplate(null); };
  const onWelcomeTemplate = () => { dismissWelcome(); setShowTemplateSelector(true); };

  // Gentle post-signup security nudge: suggest two-factor auth to NEW accounts
  // (first 14 days) that haven't enabled it. Optional by design — dismissal
  // persists per user, and the banner disappears for good once MFA is on.
  const mfaNudgeKey = user?.id ? `formlogic_mfa_nudge_dismissed:${user.id}` : null;
  const [, bumpMfaNudge] = useState(0);
  const mfaNudgeDismissed = !mfaNudgeKey || (() => {
    try { return localStorage.getItem(mfaNudgeKey) === '1'; } catch { return false; }
  })();
  const accountAgeDays = user?.createdAt
    ? (Date.now() - parseServerDate(user.createdAt).getTime()) / 86400000
    : Infinity;
  const showMfaNudge = !!user && !user.isDemo && !user.mfaEnabled && !mfaNudgeDismissed && accountAgeDays < 14;
  const dismissMfaNudge = useCallback(() => {
    if (mfaNudgeKey) { try { localStorage.setItem(mfaNudgeKey, '1'); } catch { /* ignore */ } }
    bumpMfaNudge((n) => n + 1);
  }, [mfaNudgeKey]);
  const onWelcomeAI = async () => {
    dismissWelcome();
    const form = await createForm('Untitled Form');
    if (!form) return;
    setActiveForm(form.id);
    navigate(`/builder/${form.id}?ai=1`);
  };

  // Calculate various stats
  const totalForms = forms.length;

  // Calculate stats from local responses
  const localStats = useMemo(() => {
    const totalResponses = forms.reduce(
      (sum, form) => sum + getResponsesByFormId(form.id).length,
      0
    );
    return { totalResponses };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getResponsesByFormId is a stable store method reading get().responses; 'responses' must stay so the memo recomputes when stored responses change
  }, [forms, responses, getResponsesByFormId]);

  // Per-form 14-day pulse (local storage mode) — bucketed client-side from raw timestamps.
  const localPulses = useMemo(() => {
    const map: Record<string, PulseDay[]> = {};
    for (const form of forms) {
      map[form.id] = buildPulseFromTimestamps(getResponsesByFormId(form.id).map((r) => r.submittedAt));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getResponsesByFormId is a stable store method reading get().responses; 'responses' must stay so the memo recomputes when stored responses change
  }, [forms, responses, getResponsesByFormId]);

  const pulseByForm = useMemo(
    () => storageMode === 'api' ? { ...apiPulses, ...browserStats.pulses } : localPulses,
    [apiPulses, browserStats.pulses, localPulses, storageMode],
  );

  // Browser-created demo forms keep their records in IndexedDB, even while the
  // shared demo workspace otherwise uses cloud/API mode. Read that small local
  // overlay separately so the workspace dashboard agrees with the published app.
  useEffect(() => {
    let cancelled = false;
    const browserForms = storageMode === 'api'
      ? forms.filter((form) => isDemoLocalId(form.id))
      : [];
    if (browserForms.length === 0) {
      setBrowserStats({
        totalResponses: 0,
        responseCounts: {},
        pulses: {},
        recent: [],
        lastActivity: {},
      });
      setBrowserStatsReady(true);
      return () => { cancelled = true; };
    }

    setBrowserStatsReady(false);
    void Promise.all(
      browserForms.map(async (form) => {
        const result = await api.getResponses(form.id, { limit: 1000 });
        return { form, responses: result.data?.responses ?? [] };
      }),
    ).then((results) => {
      if (cancelled) return;
      const responseCounts: Record<string, number> = {};
      const pulses: Record<string, PulseDay[]> = {};
      const lastActivity: Record<string, number> = {};
      const recent: BrowserResponseStats['recent'] = [];
      let totalResponses = 0;

      for (const { form, responses: formResponses } of results) {
        responseCounts[form.id] = formResponses.length;
        totalResponses += formResponses.length;
        pulses[form.id] = buildPulseFromTimestamps(formResponses.map((response) => response.submittedAt));
        for (const response of formResponses) {
          const submitted = parseServerDate(response.submittedAt).getTime();
          if (Number.isFinite(submitted) && submitted > (lastActivity[form.id] ?? 0)) {
            lastActivity[form.id] = submitted;
          }
          recent.push({
            id: response.id,
            formId: form.id,
            formTitle: form.title,
            submittedAt: response.submittedAt,
          });
        }
      }

      recent.sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime());
      setBrowserStats({
        totalResponses,
        responseCounts,
        pulses,
        recent: recent.slice(0, 5),
        lastActivity,
      });
      setBrowserStatsReady(true);
    }).catch((error) => {
      if (cancelled) return;
      logger.warn('Failed to read browser-local dashboard responses:', error);
      setBrowserStatsReady(true);
    });

    return () => { cancelled = true; };
  }, [forms, storageMode]);

  // Which user's data is currently on screen (cache hydration or a landed fetch).
  // Lets the fetch effect refresh silently instead of dropping back to skeletons.
  const statsShownFor = useRef<string | null>(null);

  // Hydrate the last visit's aggregates instantly (stale-while-revalidate).
  useEffect(() => {
    if (storageMode !== 'api' || !user?.id) return;
    if (statsShownFor.current === user.id) return;
    const cached = loadUiCache<DashboardStatsCache>('dashboard-stats', user.id);
    if (!cached) return;
    statsShownFor.current = user.id;
    setStats({ totalResponses: cached.data.totalResponses });
    setResponseCounts(cached.data.responseCounts);
    setApiLastActivity(cached.data.lastActivity ?? {});
    setApiPulses(cached.data.pulses);
    setApiRecent(cached.data.recent);
    setStatsReady(true);
  }, [storageMode, user?.id]);

  // Fetch stats from API when in API mode
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      // Only drop to the loading state when nothing is on screen yet — a cache
      // hydration (or an earlier fetch) keeps rendering while we revalidate.
      if (storageMode === 'api' && statsShownFor.current !== user?.id) setStatsReady(false);
      if (storageMode === 'api' && user && forms.length > 0) {
        // Fresh-enough cache + data already shown → skip the fan-out entirely.
        const cached = loadUiCache<DashboardStatsCache>('dashboard-stats', user.id);
        if (cached && cached.ageMs < STATS_FRESH_MS && statsShownFor.current === user.id) {
          setStatsReady(true);
          return;
        }
        try {
          let totalResponses = 0;
          const serverForms = forms.filter((form) => !isDemoLocalId(form.id));
          // getTimezoneOffset() returns minutes BEHIND UTC (JS convention); the API wants
          // minutes AHEAD — negate it (see api.getFormAnalytics doc) so responsesByDate (and
          // therefore the pulse strip) buckets by the viewer's local calendar day.
          const tzOffsetMinutes = -new Date().getTimezoneOffset();
          const analyticsResults = await Promise.all(
            serverForms.map((form) => api.getFormAnalytics(form.id, tzOffsetMinutes))
          );
          if (cancelled) return;
          let analyticsFailures = 0;
          for (const result of analyticsResults) {
            if (result.data?.analytics) {
              totalResponses += result.data.analytics.totalResponses;
            } else {
              analyticsFailures += 1;
            }
          }
          // Every call failed: there are no figures, as opposed to figures of zero.
          const allAnalyticsFailed = serverForms.length > 0 && analyticsFailures === serverForms.length;
          setStatsFailed(allAnalyticsFailed);

          setStats({ totalResponses });

          // Per-form counts + 14-day pulse for the ledger rows (reuse the analytics we just fetched).
          const counts: Record<string, number> = {};
          const pulses: Record<string, PulseDay[]> = {};
          // Last submission time per form, derived from the analytics we already have,
          // so Recent Activity ranks by submission recency. Submissions no longer bump
          // forms.updatedAt, so updatedAt alone would miss the newest activity.
          const lastActivity: Record<string, number> = {};
          analyticsResults.forEach((result, i) => {
            if (result.data?.analytics) {
              counts[serverForms[i].id] = result.data.analytics.totalResponses;
              pulses[serverForms[i].id] = buildPulseFromSparse(result.data.analytics.responsesByDate);
              // Prefer the exact last-submission timestamp: responsesByDate is DAY-granular
              // (a 22:28 call ranked as midnight and lost to any same-day form EDIT, which
              // carries full precision). Fall back to the by-date max on older payloads.
              const lastAt = result.data.analytics.lastResponseAt;
              if (lastAt) {
                const t = parseServerDate(lastAt).getTime();
                if (Number.isFinite(t)) lastActivity[serverForms[i].id] = t;
              } else {
                const dated = (result.data.analytics.responsesByDate || []).filter((d) => d.count > 0);
                if (dated.length) {
                  lastActivity[serverForms[i].id] = Math.max(...dated.map((d) => parseServerDate(d.date).getTime()));
                }
              }
            }
          });
          if (cancelled) return;
          setResponseCounts(counts);
          setApiLastActivity(lastActivity);
          setApiPulses(pulses);

          // Recent Activity: pull a few recent rows from the forms that have responses.
          const formsWithResponses = serverForms
            .filter((f) => (counts[f.id] ?? 0) > 0)
            .sort((a, b) => {
              // Rank by most-recent submission; fall back to updatedAt when a form has
              // no dated activity in the analytics window.
              const la = lastActivity[a.id] ?? parseServerDate(a.updatedAt).getTime();
              const lb = lastActivity[b.id] ?? parseServerDate(b.updatedAt).getTime();
              return lb - la;
            })
            .slice(0, 5);
          const recentResults = await Promise.all(
            formsWithResponses.map((f) =>
              api.getResponses(f.id, { limit: 5 }).then((res) => ({ f, res })).catch(() => null)
            )
          );
          if (cancelled) return;
          const merged = recentResults.flatMap((r) =>
            r && r.res.data?.responses
              ? r.res.data.responses.map((resp) => ({ id: resp.id, formId: r.f.id, formTitle: r.f.title, submittedAt: resp.submittedAt }))
              : []
          );
          merged.sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime());
          const recent = merged.slice(0, 5);
          setApiRecent(recent);
          setStatsReady(true);
          if (!allAnalyticsFailed) {
            statsShownFor.current = user.id;
            saveUiCache<DashboardStatsCache>('dashboard-stats', user.id, {
              totalResponses,
              responseCounts: counts,
              pulses,
              recent,
              lastActivity,
            });
          }
        } catch (error) {
          if (cancelled) return;
          logger.error('Failed to fetch dashboard stats:', error);
          // With cached data on screen a failed revalidate degrades silently to
          // the stale numbers; only an empty dashboard warns and falls back.
          if (statsShownFor.current !== user?.id) {
            setStatsFailed(true);
            setStats(localStats);
          }
          setStatsReady(true);
        }
      } else if (storageMode !== 'api') {
        setStats(localStats);
        setStatsReady(true);
      } else if (formsLoading === false) {
        // Cloud mode with a genuinely empty account (the forms list finished
        // loading and none exist). While forms are still loading this branch
        // must NOT run: marking stats "ready" with zero counts here made a hard
        // refresh flash "No responses yet" the moment the forms list landed,
        // before the analytics fan-out had produced the real totals.
        setStats({ totalResponses: 0 });
        setStatsReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [forms, storageMode, user, localStats, formsLoading, statsReloadToken]);

  const totalResponses = stats.totalResponses + (storageMode === 'api' ? browserStats.totalResponses : 0);
  const displayedResponseCounts = useMemo(
    () => storageMode === 'api' ? { ...responseCounts, ...browserStats.responseCounts } : responseCounts,
    [browserStats.responseCounts, responseCounts, storageMode],
  );

  // "This week" = the most recent 7 of the 14 days each form's pulse already covers —
  // no extra fetch, and it keeps the headline and the pulse strips reading the same window.
  const weekly = useMemo(() => {
    let weeklyResponses = 0;
    let activeForms = 0;
    for (const form of forms) {
      const days = pulseByForm[form.id];
      if (!days) continue;
      const sum = days.slice(-7).reduce((s, d) => s + d.count, 0);
      weeklyResponses += sum;
      if (sum > 0) activeForms++;
    }
    return { responses: weeklyResponses, activeForms };
  }, [forms, pulseByForm]);

  // Load which app each form belongs to (cloud mode) so Recent Forms can tag it (badge only).
  // Shared cached fetch (see lib/appGroups): the last visit's mapping applies instantly,
  // the per-app fan-out refreshes it in the background.
  useEffect(() => {
    let cancelled = false;
    if (storageMode !== 'api') { setAppOfForm({}); return; }
    const toMap = (groups: AppGroup[]) => {
      const map: Record<string, string> = {};
      for (const g of groups) for (const fid of g.formIds) map[fid] = g.name;
      return map;
    };
    const cached = loadAppGroupsCache(user?.id);
    if (cached) setAppOfForm(toMap(cached));
    fetchAppGroups(user?.id)
      .then((groups) => { if (!cancelled) setAppOfForm(toMap(groups)); })
      .catch(() => { /* badge-only data — keep whatever is shown */ });
    return () => { cancelled = true; };
  }, [storageMode, user?.id]);

  // Preview a form in a NEW TAB and IN CONTEXT: fresh app-context lookup on click (shared
  // mechanism) — one published app opens the app runtime at that form, several ask which,
  // otherwise (or on fetch failure) the standalone fillable form (?form=1 shows the form even
  // with a custom screen).
  const { openPreview: previewForm, previewChooser } = useFormPreview();

  // Local mode: most recent submission per form, straight from the stored responses.
  const localLastActivity = useMemo(() => {
    if (storageMode === 'api') return {} as Record<string, number>;
    const map: Record<string, number> = {};
    for (const form of forms) {
      for (const r of getResponsesByFormId(form.id)) {
        const t = parseServerDate(r.submittedAt).getTime();
        if (Number.isFinite(t) && t > (map[form.id] ?? 0)) map[form.id] = t;
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getResponsesByFormId is a stable store method reading get().responses; 'responses' must stay so the memo recomputes when stored responses change
  }, [forms, responses, getResponsesByFormId, storageMode]);
  const activityOf = useMemo(
    () => storageMode === 'api' ? { ...apiLastActivity, ...browserStats.lastActivity } : localLastActivity,
    [apiLastActivity, browserStats.lastActivity, localLastActivity, storageMode],
  );

  // "My forms", sorted by the chosen mode. Default = Last activity (most recent submission,
  // falling back to the edit time for forms with no responses yet) so the list surfaces the
  // forms actually being USED — not just the last ones added.
  const sortedForms = useMemo(() => {
    const editedMs = (f: Form) => parseServerDate(f.updatedAt).getTime();
    const activityMs = (f: Form) => activityOf[f.id] ?? editedMs(f);
    const countOf = (f: Form) =>
      storageMode === 'api' ? (displayedResponseCounts[f.id] ?? f.responseCount ?? 0) : getResponsesByFormId(f.id).length;
    return [...forms].sort((a, b) => {
      switch (formsSort) {
        case 'edited':
          return editedMs(b) - editedMs(a);
        case 'created':
          return parseServerDate(b.createdAt).getTime() - parseServerDate(a.createdAt).getTime();
        case 'responses':
          return countOf(b) - countOf(a) || activityMs(b) - activityMs(a);
        case 'activity':
        default:
          return activityMs(b) - activityMs(a);
      }
    });
  }, [forms, formsSort, activityOf, displayedResponseCounts, storageMode, getResponsesByFormId]);
  const recentForms = sortedForms.slice(0, formsShown);

  // Get recent responses across all forms (local store — cloud mode uses apiRecent)
  const localRecentResponses = useMemo(() => {
    const allResponses = forms.flatMap(form => {
      const formResponses = getResponsesByFormId(form.id);
      return formResponses.map(r => ({
        ...r,
        formId: form.id,
        formTitle: form.title,
      }));
    });
    return allResponses
      .sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime())
      .slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getResponsesByFormId is a stable store method reading get().responses; 'responses' must stay so the memo recomputes when stored responses change
  }, [forms, responses, getResponsesByFormId]);
  const recentResponses = useMemo(
    () => storageMode === 'api'
      ? [...apiRecent, ...browserStats.recent]
        .sort((a, b) => parseServerDate(b.submittedAt).getTime() - parseServerDate(a.submittedAt).getTime())
        .slice(0, 5)
      : localRecentResponses,
    [apiRecent, browserStats.recent, localRecentResponses, storageMode],
  );
  const statsLoading = storageMode === 'api' && (!statsReady || !browserStatsReady);

  // Show getting started only for genuinely-new users — not during the initial
  // cloud-data load (which would briefly flash the onboarding hero + zeroed stats),
  // and NOT when the forms read failed: in cloud mode a failed read also leaves
  // forms: [], so without this an owner whose data failed to load was shown the
  // brand-new-account hero and told to create their first form.
  const formsFailed = useFormStore((s) => !!s.error) && storageMode === 'api';
  const showGettingStarted = forms.length === 0 && !formsLoading && !formsFailed;
  const showWelcome = showGettingStarted && !welcomeDismissed;

  // The headline band — one prose sentence, data figures set in primary color.
  // While data is loading, say what is happening instead of rendering em-dash
  // placeholders as if they were real metrics. Once ready, the sentence reports
  // either the empty-account state or the real weekly figures.
  // The old "completion rate" stat (which meant two different things in local vs api
  // mode) is retired here rather than carried forward under a new name.
  const headlineReady = !formsLoading && statsReady && browserStatsReady;
  let headline: React.ReactNode;
  const num = (n: number | string) => (
    <span className="tabular-nums text-primary-600 dark:text-primary-400">{n}</span>
  );
  if (formsFailed) {
    headline = <span className="text-gray-500 dark:text-slate-400">We couldn&apos;t load your forms.</span>;
  } else if (!headlineReady) {
    headline = (
      <span className="text-gray-500 dark:text-slate-400">
        Getting your workspace ready…
      </span>
    );
  } else if (statsFailed) {
    headline = <span className="text-gray-500 dark:text-slate-400">We couldn&apos;t load your response figures.</span>;
  } else if (totalForms === 0) {
    headline = <>Create your first form to start collecting responses.</>;
  } else if (totalResponses === 0) {
    headline = <>No responses yet — share a form link and watch them arrive here.</>;
  } else if (weekly.responses === 0) {
    headline = <>No new responses this week — {num(totalResponses)} total so far.</>;
  } else {
    headline = (
      <>
        {num(weekly.responses)} response{weekly.responses === 1 ? '' : 's'} arrived across{' '}
        {num(weekly.activeForms)} form{weekly.activeForms === 1 ? '' : 's'} this week.
      </>
    );
  }

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" />

      {/* @container/dash: Home sits inside AppShell's sidebar inset (64/256px) and can
          lose another 384px to a docked chat, so viewport breakpoints fired the 3-column
          layout exactly when the content box was 704px — 219px tracks, with app names and
          "12 forms · published" both truncated to nothing. Size against the real box. */}
      <div className="@container/dash flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Post-signup security nudge: suggest (optional) two-factor auth to new accounts. */}
        {showMfaNudge && (
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-primary-200/70 dark:border-primary-500/25 bg-primary-50/70 dark:bg-primary-500/10 p-4">
            <ShieldCheck className="h-5 w-5 text-primary-600 dark:text-primary-400 flex-none" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Secure your account with two-factor authentication</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                Optional, takes a minute: one-time codes from Google Authenticator on unknown browsers.
              </p>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { dismissMfaNudge(); navigate('/settings#security'); }}>
                Set up
              </Button>
              <button
                type="button"
                onClick={dismissMfaNudge}
                aria-label="Dismiss two-factor suggestion"
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 hover:bg-primary-100/60 dark:hover:bg-primary-500/20 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {(formsFailed || statsFailed) && (
          <div
            role="status"
            className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/80 p-4 dark:border-amber-500/30 dark:bg-amber-500/10 @2xl/dash:flex-row @2xl/dash:items-center"
          >
            <AlertTriangle className="h-5 w-5 flex-none text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {formsFailed ? "We couldn't load your forms" : "We couldn't load your response figures"}
              </p>
              <p className="mt-0.5 text-xs text-gray-600 dark:text-slate-300">
                Nothing has been lost — this is a problem reading them, not a problem with your data.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="flex-none"
              onClick={() => {
                if (formsFailed) void useFormStore.getState().refreshForms();
                setStatsFailed(false);
                setStatsReloadToken((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        )}

        {/* §11B O1: the availability-routed creation band — chat-first when an AI can
            answer, "Build your way" when none is connected. A brand-new owner used to get
            this PLUS the headline's two buttons PLUS the "Get started" hero PLUS the
            welcome modal — four competing invitations, two of which contradicted the
            app-first spine by leading with a single form. On first run the hero owns the
            invitation and this band stands down. */}
        {storageMode === 'api' && !showGettingStarted && <CreateBand />}

        {/* Headline band — the intake ledger reads as one live sentence, not four stat cards. */}
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900 dark:text-white">
            {headline}
          </h1>
          {/* Deliberately minimal (owner direction): the sidebar's Create app owns the
              whole app journey (studio covers diagrams, AI and the rest) — the dashboard
              keeps just the form quick-start and pack import. */}
          {!showGettingStarted && (
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
                Start with a form
              </Button>
              <Button variant="outline" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />}>
                Start from a template
              </Button>
            </div>
          )}
        </div>

        {/* Quick find — jump straight to any form's records/builder/analytics. */}
        {forms.length > 0 && (
          <QuickFind
            forms={forms}
            countOf={(f) => (storageMode === 'api' ? (displayedResponseCounts[f.id] ?? f.responseCount ?? 0) : getResponsesByFormId(f.id).length)}
            appOfForm={appOfForm}
          />
        )}

        {/* Getting Started Section for New Users */}
        {showGettingStarted && (
          <div className="mb-8">
            <Card className="bg-gradient-to-br from-primary-600/90 to-primary-800/90 dark:from-primary-900/50 dark:to-primary-950/50 border-primary-500/20">
              <CardContent className="p-6 sm:p-8">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                  <div className="p-4 bg-white/20 rounded-2xl">
                    <Sparkles className="h-8 w-8 text-primary-foreground" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-xl font-bold text-primary-foreground mb-2">
                      Get started with FormLogic
                    </h3>
                    <p className="text-primary-foreground/80 mb-4">
                      Create your first form in seconds. Choose from templates or start from scratch.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        onClick={handleCreateForm}
                        className="bg-white text-primary-600 hover:bg-white/90"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Create your first form
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-primary-foreground hover:bg-white/10"
                        onClick={() => setShowTemplateSelector(true)}
                      >
                        <BookOpen className="h-4 w-4 mr-2" />
                        Browse templates
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Main Content - Two Column Layout on Desktop */}
        <div className="grid gap-6 @4xl/dash:grid-cols-3">
          {/* Recent Forms - Takes 2/3 on desktop. min-w-0: grid items default to
              min-width:auto, so one long nowrap form title would otherwise blow the
              track past the viewport and shove the pulse strips over/under the text. */}
          <div className="min-w-0 @4xl/dash:col-span-2">
            <div className="mb-4 flex flex-col gap-3 @3xl/dash:flex-row @3xl/dash:items-end @3xl/dash:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white">My forms</h2>
                  {forms.length > 0 && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-gray-500 dark:bg-white/[0.06] dark:text-slate-400">
                      {forms.length} total
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
                  Open a form or review its latest response activity.
                </p>
              </div>
              {forms.length > 0 && (
                <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @3xl/dash:flex @3xl/dash:w-auto">
                  <select
                    value={formsSort}
                    onChange={(e) => changeFormsSort(e.target.value as DashFormsSort)}
                    aria-label="Sort my forms by"
                    className="h-10 w-full cursor-pointer rounded-xl border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 shadow-sm shadow-gray-900/[0.02] transition-colors hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-600 sm:h-9 sm:w-auto"
                  >
                    <option value="activity">Last activity</option>
                    <option value="edited">Last edited</option>
                    <option value="created">Created</option>
                    <option value="responses">Most responses</option>
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('/forms')}
                    className="text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300"
                  >
                    View all <span className="hidden sm:inline">forms</span>
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </div>

            {formsLoading && recentForms.length === 0 ? (
              <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading recent forms">
                {Array.from({ length: 4 }).map((_, i) => <ListRowSkeleton key={i} />)}
              </div>
            ) : recentForms.length === 0 ? (
              <Card>
                <CardContent className="p-0">
                  <EmptyState
                    icon={FileText}
                    title="No forms yet"
                    description="Create your first form to start collecting responses and insights."
                    action={
                      <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
                        Create form
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {recentForms.map((form) => {
                  const formResponses = getResponsesByFormId(form.id);
                  const fieldCount = form.fieldCount ?? form.fields?.length ?? 0;
                  const n = storageMode === 'api' ? (displayedResponseCounts[form.id] ?? 0) : formResponses.length;
                  const days = pulseByForm[form.id] ?? buildPulseFromTimestamps([]);
                  const periodResponses = days.reduce((sum, day) => sum + day.count, 0);
                  return (
                    <Card
                      key={form.id}
                      // The whole card stays clickable for the mouse, but it is NOT a
                      // control: a role="button" wrapper around the card's own buttons
                      // (menu, actions) is a nested-interactive violation, and a screen
                      // reader announced one giant button whose inner controls were
                      // unreachable. The title link below is the accessible action.
                      onClick={() => navigate(`/builder/${form.id}`)}
                      className="group cursor-pointer overflow-hidden transition-all duration-300 hover:border-primary-300/80 hover:shadow-md hover:shadow-gray-900/[0.05] focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 dark:hover:border-primary-500/30 dark:hover:shadow-black/20 dark:focus-within:ring-offset-slate-950"
                    >
                      <CardContent className="p-0">
                        <div className="p-4 sm:p-5">
                          <div className="flex items-start gap-3">
                            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary-50 text-primary-600 ring-1 ring-inset ring-primary-100/80 transition-colors group-hover:bg-primary-100 dark:bg-primary-500/10 dark:text-primary-400 dark:ring-primary-500/15 dark:group-hover:bg-primary-500/15">
                              <FileText className="h-4.5 w-4.5" aria-hidden="true" />
                            </span>

                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <h4 className="min-w-0 max-w-full truncate font-semibold text-gray-900 motion-safe:transition-colors group-hover:text-primary-600 dark:text-white dark:group-hover:text-primary-400" title={form.title || 'Untitled Form'}>
                                  <Link
                                    to={`/builder/${form.id}`}
                                    aria-label={`Open ${form.title || 'Untitled Form'} in the builder`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="focus-visible:outline-none"
                                  >
                                    {form.title || 'Untitled Form'}
                                  </Link>
                                </h4>
                                <Badge
                                  variant={form.status === 'published' ? 'success' : 'default'}
                                  size="sm"
                                  className="capitalize"
                                >
                                  {form.status}
                                </Badge>
                                {form.isPrivate && <PrivateLockBadge />}
                              </div>
                              {appOfForm[form.id] && (
                                <Badge variant="info" size="sm" className="mt-1.5 inline-flex max-w-full items-center gap-1" title={`In the ${appOfForm[form.id]} app`}>
                                  <Boxes className="h-3 w-3 flex-shrink-0" />
                                  <span className="truncate">{appOfForm[form.id]}</span>
                                </Badge>
                              )}
                            </div>

                            {/* The card itself is the Edit action. Keep only useful secondary
                                shortcuts at wide widths; compact/tablet layouts get the full
                                action set from the overflow menu instead of a cramped icon rail. */}
                            <div className="flex flex-shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => previewForm(form.id)}
                                title="Preview form"
                                aria-label="Preview form"
                                className="hidden text-slate-400 hover:text-gray-700 dark:hover:text-white @3xl/dash:flex"
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate(`/analytics/${form.id}`)}
                                title="View analytics"
                                aria-label="View analytics"
                                className="hidden text-slate-400 hover:text-gray-700 dark:hover:text-white @3xl/dash:flex"
                              >
                                <BarChart3 className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate(`/responses/${form.id}`)}
                                title="View data"
                                aria-label="View data"
                                className="hidden text-slate-400 hover:text-gray-700 dark:hover:text-white @3xl/dash:flex"
                              >
                                <Table className="h-4 w-4" />
                              </Button>
                              <FormActionsDropdown
                                formId={form.id}
                                formTitle={form.title}
                                onDelete={() => setDeleteTarget({ id: form.id, title: form.title })}
                                onEdit={() => navigate(`/builder/${form.id}`)}
                                onPreview={() => previewForm(form.id)}
                                onAnalytics={() => navigate(`/analytics/${form.id}`)}
                                onViewData={() => navigate(`/responses/${form.id}`)}
                                onShare={() => setEmbedModalForm({ id: form.id, title: form.title, status: form.status })}
                              />
                            </div>
                          </div>

                          <div className="mt-4 grid min-w-0 gap-3 @xl/dash:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)] @xl/dash:items-end">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-gray-500 dark:text-slate-400">
                              <span className="flex items-center gap-1.5 tabular-nums">
                                <Clock className="h-3.5 w-3.5 flex-none" />
                                <span className="font-mono">
                                  {formsSort === 'created'
                                    ? `created ${formatRelativeTime(form.createdAt)}`
                                    : formsSort === 'edited'
                                      ? `edited ${formatRelativeTime(form.updatedAt)}`
                                      : activityOf[form.id]
                                        ? `active ${formatRelativeTime(new Date(activityOf[form.id]))}`
                                        : `edited ${formatRelativeTime(form.updatedAt)}`}
                                </span>
                              </span>
                              <span className="flex items-center gap-1.5 tabular-nums">
                                <FileText className="h-3.5 w-3.5 flex-none" />
                                {fieldCount} field{fieldCount === 1 ? '' : 's'}
                              </span>
                              {statsLoading ? (
                                <Skeleton className="h-3 w-20" />
                              ) : (
                                <span className="flex items-center gap-1.5 tabular-nums">
                                  <Inbox className="h-3.5 w-3.5 flex-none" />
                                  {n} total response{n === 1 ? '' : 's'}
                                </span>
                              )}
                            </div>

                            <div className="min-w-0 rounded-xl border border-gray-200/80 bg-gray-50/80 px-3 pb-2 pt-2.5 dark:border-white/[0.06] dark:bg-white/[0.025]">
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                                  <BarChart3 className="h-3.5 w-3.5 flex-none text-primary-500" />
                                  Last 14 days
                                </span>
                                {statsLoading ? (
                                  <Skeleton className="h-3 w-10" />
                                ) : (
                                  <span className="flex-none text-[10px] font-semibold tabular-nums text-gray-500 dark:text-slate-400">
                                    {periodResponses} new
                                  </span>
                                )}
                              </div>
                              <PulseStrip days={days} loading={statsLoading} />
                              <div className="mt-0.5 flex justify-between text-[9px] font-medium uppercase tracking-wider text-gray-400 dark:text-slate-500">
                                <span>14 days ago</span>
                                <span>Today</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                <ShowMore
                  shown={recentForms.length}
                  total={forms.length}
                  onShowMore={() => setFormsShown((n) => n + DASH_FORMS_PAGE)}
                  noun="forms"
                  className="mt-1"
                />
              </div>
            )}

            {/* Apps strip — the user's most recently updated apps, mirroring the Apps page
                cards. Lives under My forms (sharing its 2/3-width column), not as a full-width
                strip — the AppIdentityTile treatment itself is unchanged ("as-is"). */}
            {recentApps.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Apps</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('/apps')}
                    className="text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300"
                  >
                    View all
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 @2xl/dash:grid-cols-2">
                  {recentApps.map((app) => {
                    // Real count from the list endpoint; navConfig.length is empty on pack-provisioned apps.
                    const formCount = app.formCount ?? app.navConfig?.length ?? 0;
                    return (
                      <button
                        key={app.id}
                        onClick={() => navigate(appClickPath(app))}
                        title={appClickLabel(app)}
                        className={cn(
                          'flex items-center gap-3 p-4 min-w-0 rounded-xl border text-left group cursor-pointer',
                          'bg-white dark:bg-slate-900/50 border-gray-200/80 dark:border-white/[0.06] shadow-sm shadow-gray-900/[0.03]',
                          'hover:bg-gray-50 dark:hover:bg-slate-800/60 hover:border-gray-300 dark:hover:border-slate-600 motion-safe:transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950'
                        )}
                      >
                        <AppIdentityTile app={app} />
                        <div className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-gray-900 dark:text-slate-100 truncate group-hover:text-primary-600 dark:group-hover:text-primary-400 motion-safe:transition-colors">
                            {app.name}
                          </span>
                          <span className="block text-xs text-gray-500 dark:text-slate-400 truncate tabular-nums">
                            {formCount} form{formCount === 1 ? '' : 's'} · <span className="capitalize">{app.status}</span>
                          </span>
                        </div>
                        <ChevronRight className="h-4 w-4 flex-none text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 motion-safe:transition-colors" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Recent Activity - Takes 1/3 on desktop (min-w-0: same grid-item rule as above) */}
          <div className="min-w-0 @4xl/dash:col-span-1">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Recent activity</h2>
            </div>

            <Card>
              <CardContent className="p-0">
                {statsLoading ? (
                  <div className="space-y-3 p-4" role="status" aria-busy="true" aria-label="Loading recent activity">
                    {Array.from({ length: 4 }).map((_, i) => <ListRowSkeleton key={i} />)}
                  </div>
                ) : recentResponses.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="No responses yet"
                    description="Share a form link and watch them arrive here."
                    action={
                      forms.length > 0 ? (
                        <Button variant="outline" size="sm" onClick={() => navigate('/forms')}>
                          View all forms
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="divide-y divide-gray-100 dark:divide-slate-800">
                    {recentResponses.map((response, index) => (
                      <button
                        key={`${response.formId}-${index}`}
                        onClick={() => navigate(response.id ? `/responses/${response.formId}?open=${response.id}` : `/responses/${response.formId}`)}
                        title={`Open this submission in ${response.formTitle}`}
                        className="w-full p-4 text-left hover:bg-gray-50 dark:hover:bg-slate-800/50 motion-safe:transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                      >
                        <div className="flex items-start gap-3">
                          {/* Per-form accent dot — same color = same form, real identity in
                              place of the old uniform green "Zap" chip. */}
                          <span
                            className={cn('mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full', accentDotForForm(response.formId))}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {response.formTitle}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-slate-500 mt-0.5">
                              New submission · <span className="font-mono">{formatRelativeTime(response.submittedAt)}</span>
                            </p>
                          </div>
                          <ArrowRight className="h-4 w-4 flex-shrink-0 self-center text-gray-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:transition-opacity" aria-hidden="true" />
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
                        Set up an automation to do something every time a form is submitted — send a text,
                        save a record, or notify someone.
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
          formStatus={embedModalForm.status}
        />
      )}

      {/* First-run welcome */}
      <WelcomeModal
        isOpen={showWelcome}
        onClose={dismissWelcome}
        onBlank={onWelcomeBlank}
        onTemplate={onWelcomeTemplate}
        onAI={onWelcomeAI}
      />

      {/* Template Selector */}
      <TemplateSelector
        isOpen={showTemplateSelector}
        onClose={() => setShowTemplateSelector(false)}
        onSelectTemplate={handleSelectTemplate}
      />

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
        title="Delete form"
        message={storageMode === 'api' && !api.isDemoMode()
          ? `Delete "${deleteTarget?.title || 'this form'}"? It will move to the recycle bin, where you can restore it (responses included) for 30 days.`
          : `Are you sure you want to delete "${deleteTarget?.title || 'this form'}"? This action cannot be undone and all responses will be lost.`}
        confirmLabel="Delete"
        variant="danger"
      />

      {/* Preview chooser — shown when a form is published in 2+ apps */}
      {previewChooser}
    </div>
  );
}
