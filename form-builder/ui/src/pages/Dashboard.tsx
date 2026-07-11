import { useState, useEffect, useMemo, useRef, useCallback, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Plug,
  Search,
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
import { cn, formatRelativeTime, sanitizeFilename, parseServerDate } from '../lib/utils';
import { EmbedModal, TemplateSelector, PackImportModal, useFormPreview } from '../components/builder';
import { WelcomeModal } from '../components/onboarding/WelcomeModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { ConnectAiModal } from '../components/mcp/ConnectAiModal';
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
  const barW = 5;
  const gap = 3;
  const barCount = days.length || PULSE_DAYS;
  const w = barCount * barW + (barCount - 1) * gap;
  const h = 28;

  if (loading) {
    return (
      <div className={cn('inline-flex items-end gap-[3px]', className)} style={{ width: w, height: h }} aria-hidden="true">
        {Array.from({ length: barCount }).map((_, i) => (
          <span
            key={i}
            className="w-[5px] animate-pulse rounded-sm bg-primary-200/70 dark:bg-primary-500/20"
            style={{ height: `${8 + ((i * 7) % 18)}px`, opacity: i === barCount - 1 ? 0.65 : 0.35 }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('relative inline-block', className)} style={{ width: w, height: h }}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`Responses over the last ${days.length} days: ${days.reduce((s, d) => s + d.count, 0)} total, busiest day ${realMax}`}
      >
        {days.map((d, i) => {
          const barH = Math.max(EMPTY_PULSE_BAR_H, Math.round((d.count / scaleMax) * (h - EMPTY_PULSE_BAR_H)));
          const x = i * (barW + gap);
          const y = h - barH;
          // Opacity is graded by count (min 0.15 so a quiet day still registers);
          // today is always full-opacity — the live edge of the ledger.
          const opacity = d.isToday ? 1 : 0.15 + (d.count / scaleMax) * 0.85;
          return (
            <g key={d.key}>
              {/* Full-height, gap-inclusive hit area — the visible bar can be as
                  short as 2px, too small a target to hover reliably on its own. */}
              <rect
                x={x - gap / 2}
                y={0}
                width={barW + gap}
                height={h}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
              >
                <title>{`${weekdayLabel(d.key)} · ${d.count} response${d.count === 1 ? '' : 's'}`}</title>
              </rect>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={1}
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
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-700 dark:text-slate-200 shadow-md motion-safe:transition-opacity"
          style={{ left: `${((hoverIndex + 0.5) / days.length) * 100}%` }}
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
          placeholder="Search..."
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
  // formId -> the app it belongs to (cloud mode), so Recent Forms can tag which app a form is
  // part of (badge only — preview routing does its own fresh per-click context lookup).
  const [appOfForm, setAppOfForm] = useState<Record<string, string>>({});
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string; status: Form['status'] } | null>(null);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showPackImport, setShowPackImport] = useState(false);
  const [showHandToAi, setShowHandToAi] = useState(false);

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

  const pulseByForm = storageMode === 'api' ? apiPulses : localPulses;

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
          // getTimezoneOffset() returns minutes BEHIND UTC (JS convention); the API wants
          // minutes AHEAD — negate it (see api.getFormAnalytics doc) so responsesByDate (and
          // therefore the pulse strip) buckets by the viewer's local calendar day.
          const tzOffsetMinutes = -new Date().getTimezoneOffset();
          const analyticsResults = await Promise.all(
            forms.map((form) => api.getFormAnalytics(form.id, tzOffsetMinutes))
          );
          if (cancelled) return;
          for (const result of analyticsResults) {
            if (result.data?.analytics) {
              totalResponses += result.data.analytics.totalResponses;
            }
          }

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
              counts[forms[i].id] = result.data.analytics.totalResponses;
              pulses[forms[i].id] = buildPulseFromSparse(result.data.analytics.responsesByDate);
              const dated = (result.data.analytics.responsesByDate || []).filter((d) => d.count > 0);
              if (dated.length) {
                lastActivity[forms[i].id] = Math.max(...dated.map((d) => parseServerDate(d.date).getTime()));
              }
            }
          });
          if (cancelled) return;
          setResponseCounts(counts);
          setApiLastActivity(lastActivity);
          setApiPulses(pulses);

          // Recent Activity: pull a few recent rows from the forms that have responses.
          const formsWithResponses = forms
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
          statsShownFor.current = user.id;
          saveUiCache<DashboardStatsCache>('dashboard-stats', user.id, {
            totalResponses,
            responseCounts: counts,
            pulses,
            recent,
            lastActivity,
          });
        } catch (error) {
          if (cancelled) return;
          logger.error('Failed to fetch dashboard stats:', error);
          // With cached data on screen a failed revalidate degrades silently to
          // the stale numbers; only an empty dashboard warns and falls back.
          if (statsShownFor.current !== user?.id) {
            toast.warning('Connection issue', 'Using local data. Some stats may not be up to date.');
            setStats(localStats);
          }
          setStatsReady(true);
        }
      } else {
        setStats(localStats);
        setStatsReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [forms, storageMode, user, localStats]);

  const totalResponses = stats.totalResponses;

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
  const activityOf = storageMode === 'api' ? apiLastActivity : localLastActivity;

  // "My forms", sorted by the chosen mode. Default = Last activity (most recent submission,
  // falling back to the edit time for forms with no responses yet) so the list surfaces the
  // forms actually being USED — not just the last ones added.
  const sortedForms = useMemo(() => {
    const editedMs = (f: Form) => parseServerDate(f.updatedAt).getTime();
    const activityMs = (f: Form) => activityOf[f.id] ?? editedMs(f);
    const countOf = (f: Form) =>
      storageMode === 'api' ? (responseCounts[f.id] ?? f.responseCount ?? 0) : getResponsesByFormId(f.id).length;
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
  }, [forms, formsSort, activityOf, responseCounts, storageMode, getResponsesByFormId]);
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
  const recentResponses = storageMode === 'api' ? apiRecent : localRecentResponses;
  const statsLoading = storageMode === 'api' && !statsReady;

  // Show getting started only for genuinely-new users — not during the initial
  // cloud-data load (which would briefly flash the onboarding hero + zeroed stats).
  const showGettingStarted = forms.length === 0 && !formsLoading;
  const showWelcome = showGettingStarted && !welcomeDismissed;

  // The headline band — one prose sentence, data figures set in primary color.
  // A stable order (dash discipline) while forms/stats are still loading; otherwise
  // the sentence reports either the empty-account state or the real weekly figures.
  // The old "completion rate" stat (which meant two different things in local vs api
  // mode) is retired here rather than carried forward under a new name.
  const headlineReady = !formsLoading && statsReady;
  let headline: React.ReactNode;
  const num = (n: number | string) => (
    <span className="tabular-nums text-primary-600 dark:text-primary-400">{n}</span>
  );
  if (!headlineReady) {
    headline = <>{num('—')} responses arrived across {num('—')} forms this week.</>;
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

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Headline band — the intake ledger reads as one live sentence, not four stat cards. */}
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900 dark:text-white">
            {headline}
          </h1>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
              New form
            </Button>
            {storageMode === 'api' && (
              <>
                <Button variant="outline" onClick={() => navigate('/apps/new')} leftIcon={<Boxes className="h-4 w-4" />}>
                  Create app
                </Button>
                <Button variant="outline" onClick={() => setShowHandToAi(true)} leftIcon={<Plug className="h-4 w-4" />}>
                  Connect an AI
                </Button>
              </>
            )}
            <Button variant="outline" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />}>
              Import pack
            </Button>
          </div>
        </div>

        {/* Quick find — jump straight to any form's records/builder/analytics. */}
        {forms.length > 0 && (
          <QuickFind
            forms={forms}
            countOf={(f) => (storageMode === 'api' ? (responseCounts[f.id] ?? f.responseCount ?? 0) : getResponsesByFormId(f.id).length)}
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
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent Forms - Takes 2/3 on desktop. min-w-0: grid items default to
              min-width:auto, so one long nowrap form title would otherwise blow the
              track past the viewport and shove the pulse strips over/under the text. */}
          <div className="min-w-0 lg:col-span-2">
            <div className="flex items-center justify-between gap-2 mb-4">
              <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">My forms</h2>
              {forms.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={formsSort}
                    onChange={(e) => changeFormsSort(e.target.value as DashFormsSort)}
                    aria-label="Sort my forms by"
                    className="cursor-pointer rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-600 transition-colors hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-600"
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
                    View all
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </div>

            {formsLoading && recentForms.length === 0 ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading recent forms">
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
                  const n = storageMode === 'api' ? (responseCounts[form.id] ?? 0) : formResponses.length;
                  const days = pulseByForm[form.id] ?? buildPulseFromTimestamps([]);
                  const countTitle = statsLoading ? 'Loading responses' : String(n);
                  return (
                    <Card
                      key={form.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${form.title || 'Untitled Form'} in the builder`}
                      onClick={() => navigate(`/builder/${form.id}`)}
                      onKeyDown={(e) => {
                        // Only act on the card itself — inner buttons handle their own keys.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/builder/${form.id}`);
                        }
                      }}
                      className="group cursor-pointer hover:shadow-md hover:shadow-gray-900/[0.04] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              {/* min-w-0: as a flex item the title must be allowed to shrink,
                                  else a long name can't truncate and spills under the pulse strip. */}
                              <h4 className="min-w-0 max-w-full font-semibold text-gray-900 dark:text-white truncate group-hover:text-primary-600 dark:group-hover:text-primary-400 motion-safe:transition-colors" title={form.title || 'Untitled Form'}>
                                {form.title || 'Untitled Form'}
                              </h4>
                              <Badge
                                variant={form.status === 'published' ? 'success' : 'default'}
                                size="sm"
                                className="capitalize"
                              >
                                {form.status}
                              </Badge>
                              {appOfForm[form.id] && (
                                <Badge variant="info" size="sm" className="inline-flex items-center gap-1 max-w-[10rem]" title={`In the ${appOfForm[form.id]} app`}>
                                  <Boxes className="h-3 w-3 flex-shrink-0" />
                                  <span className="truncate">{appOfForm[form.id]}</span>
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-slate-400 tabular-nums">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" />
                                <span className="font-mono text-xs">
                                  {formsSort === 'created'
                                    ? `created ${formatRelativeTime(form.createdAt)}`
                                    : formsSort === 'edited'
                                      ? `edited ${formatRelativeTime(form.updatedAt)}`
                                      : activityOf[form.id]
                                        ? `active ${formatRelativeTime(new Date(activityOf[form.id]))}`
                                        : `edited ${formatRelativeTime(form.updatedAt)}`}
                                </span>
                              </span>
                              <span className="hidden sm:inline">•</span>
                              <span className="hidden sm:inline">{fieldCount} field{fieldCount === 1 ? '' : 's'}</span>
                              <span className="sm:hidden">•</span>
                              {statsLoading ? (
                                <Skeleton className="h-3 w-20 sm:hidden" />
                              ) : (
                                <span className="sm:hidden">{n} response{n === 1 ? '' : 's'}</span>
                              )}
                            </div>
                          </div>

                          {/* Right rail: the 14-day pulse strip + the response count as a data figure —
                              this replaces the meta-line response count on ≥sm (kept above, for mobile,
                              where the strip is hidden to avoid crowding the row). */}
                          <div className="hidden sm:flex items-center gap-3 flex-none">
                            <PulseStrip days={days} loading={statsLoading} />
                            {statsLoading ? (
                              <Skeleton className="h-6 w-10 flex-none" />
                            ) : (
                              <span
                                className="w-10 flex-none truncate text-right text-lg font-semibold tabular-nums text-gray-900 dark:text-white"
                                title={countTitle}
                              >
                                {n}
                              </span>
                            )}
                          </div>

                          {/* stopPropagation: the whole row navigates to the builder — inner
                              actions (and the portal menu, which bubbles through the React
                              tree to here) must not double-fire that navigation. */}
                          <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/builder/${form.id}`)}
                              title="Edit form"
                              aria-label="Edit form"
                              className="hidden sm:flex text-slate-400 hover:text-gray-700 dark:hover:text-white"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => previewForm(form.id)}
                              title="Preview form"
                              aria-label="Preview form"
                              className="hidden sm:flex text-slate-400 hover:text-gray-700 dark:hover:text-white"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/analytics/${form.id}`)}
                              title="View analytics"
                              aria-label="View analytics"
                              className="hidden md:flex text-slate-400 hover:text-gray-700 dark:hover:text-white"
                            >
                              <BarChart3 className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/responses/${form.id}`)}
                              title="View data"
                              aria-label="View data"
                              className="hidden md:flex text-slate-400 hover:text-gray-700 dark:hover:text-white"
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {recentApps.map((app) => {
                    // Real count from the list endpoint; navConfig.length is empty on pack-provisioned apps.
                    const formCount = app.formCount ?? app.navConfig?.length ?? 0;
                    return (
                      <button
                        key={app.id}
                        onClick={() => navigate(`/apps/${app.id}/settings`)}
                        title={`Manage ${app.name}`}
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
          <div className="min-w-0 lg:col-span-1">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Recent activity</h2>
            </div>

            <Card>
              <CardContent className="p-0">
                {statsLoading ? (
                  <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading recent activity">
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

      <ConnectAiModal isOpen={showHandToAi} onClose={() => { setShowHandToAi(false); fetchApps(); }} creator />

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
        message={`Are you sure you want to delete "${deleteTarget?.title || 'this form'}"? This action cannot be undone and all responses will be lost.`}
        confirmLabel="Delete"
        variant="danger"
      />

      {/* Preview chooser — shown when a form is published in 2+ apps */}
      {previewChooser}
    </div>
  );
}
