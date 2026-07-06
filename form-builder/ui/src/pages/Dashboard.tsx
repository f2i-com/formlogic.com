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
  Package,
  Boxes,
  ChevronRight,
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import { ListRowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { api } from '../lib/api';
import { cn, formatRelativeTime, sanitizeFilename, parseServerDate } from '../lib/utils';
import { EmbedModal, TemplateSelector, PackImportModal } from '../components/builder';
import { WelcomeModal } from '../components/onboarding/WelcomeModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import type { FormTemplate } from '../data/formTemplates';
import type { App } from '../types/app';

interface DashboardStats {
  totalResponses: number;
  avgCompletionRate: number;
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
      className={`flex flex-col items-center justify-center gap-2.5 p-4 min-h-[5.5rem] rounded-xl border motion-safe:transition-all motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950 ${primary
        ? 'bg-primary-600 border-primary-500 text-primary-foreground hover:bg-primary-500 shadow-md shadow-primary-600/15'
        : 'bg-white dark:bg-slate-900/50 backdrop-blur-sm border-gray-200/80 dark:border-white/[0.06] text-gray-600 dark:text-slate-300 hover:border-primary-300 dark:hover:border-primary-500/40 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-slate-800/50 hover:shadow-sm'
        }`}
    >
      <Icon className={`h-5 w-5 ${primary ? 'text-primary-foreground' : 'text-gray-400 dark:text-slate-400 group-hover:text-gray-600 dark:group-hover:text-slate-200'} motion-safe:transition-colors`} />
      <span className={`text-[13px] font-medium ${primary ? 'text-primary-foreground' : 'text-gray-600 dark:text-slate-300'}`}>
        {label}
      </span>
    </button>
  );
}

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

export function Dashboard() {
  useDocumentTitle('Dashboard');
  const navigate = useNavigate();
  const { forms, createForm, setActiveForm, deleteForm, addField, storageMode } = useFormStore();
  const formsLoading = useFormStore((s) => s.isLoading || !s.isInitialized);
  const { getResponsesByFormId, responses } = useResponseStore();
  const user = useAuthStore((state) => state.user);
  const [stats, setStats] = useState<DashboardStats>({ totalResponses: 0, avgCompletionRate: 0 });
  // Cloud (API) mode keeps responses on the server, not in the local store, so
  // per-form counts + Recent Activity must come from the API (else the cards show
  // 0 / "No submissions yet" while the Total Responses stat shows the real number).
  const [responseCounts, setResponseCounts] = useState<Record<string, number>>({});
  const [apiRecent, setApiRecent] = useState<Array<{ id: string; formId: string; formTitle: string; submittedAt: string }>>([]);
  // formId -> the app it belongs to (cloud mode), so Recent Forms can tag which app a form is part of.
  const [appOfForm, setAppOfForm] = useState<Record<string, string>>({});
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);
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
  const onWelcomeAI = async () => {
    dismissWelcome();
    const form = await createForm('Untitled Form');
    if (!form) return;
    setActiveForm(form.id);
    navigate(`/builder/${form.id}?ai=1`);
  };

  // Calculate various stats
  const totalForms = forms.length;
  const publishedForms = forms.filter(f => f.status === 'published').length;
  const draftForms = totalForms - publishedForms;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getResponsesByFormId is a stable store method reading get().responses; 'responses' must stay so the memo recomputes when stored responses change
  }, [forms, responses, getResponsesByFormId]);

  // Fetch stats from API when in API mode
  useEffect(() => {
    let cancelled = false;
    async function fetchStats() {
      if (storageMode === 'api' && user && forms.length > 0) {
        try {
          let totalResponses = 0;
          let totalCompletionRate = 0;
          let formsWithAnalytics = 0;

          const analyticsResults = await Promise.all(
            forms.map((form) => api.getFormAnalytics(form.id))
          );
          if (cancelled) return;
          for (const result of analyticsResults) {
            if (result.data?.analytics) {
              const a = result.data.analytics;
              totalResponses += a.totalResponses;
              // Include every form that has received responses in the average —
              // even genuine 0% completion forms — so the average isn't biased
              // upward by silently dropping them from the denominator.
              if (a.totalResponses > 0) {
                totalCompletionRate += a.completionRate;
                formsWithAnalytics++;
              }
            }
          }

          setStats({
            totalResponses,
            avgCompletionRate: formsWithAnalytics > 0 ? Math.round(totalCompletionRate / formsWithAnalytics) : 0,
          });

          // Per-form counts for the cards (reuse the analytics we just fetched).
          const counts: Record<string, number> = {};
          // Last submission time per form, derived from the analytics we already have,
          // so Recent Activity ranks by submission recency. Submissions no longer bump
          // forms.updatedAt, so updatedAt alone would miss the newest activity.
          const lastActivity: Record<string, number> = {};
          analyticsResults.forEach((result, i) => {
            if (result.data?.analytics) {
              counts[forms[i].id] = result.data.analytics.totalResponses;
              const dated = (result.data.analytics.responsesByDate || []).filter((d) => d.count > 0);
              if (dated.length) {
                lastActivity[forms[i].id] = Math.max(...dated.map((d) => parseServerDate(d.date).getTime()));
              }
            }
          });
          if (cancelled) return;
          setResponseCounts(counts);

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
          setApiRecent(merged.slice(0, 5));
        } catch (error) {
          if (cancelled) return;
          logger.error('Failed to fetch dashboard stats:', error);
          toast.warning('Connection issue', 'Using local data. Some stats may not be up to date.');
          setStats(localStats);
        }
      } else {
        setStats(localStats);
      }
    }

    fetchStats();
    return () => { cancelled = true; };
  }, [forms, storageMode, user, localStats]);

  const totalResponses = stats.totalResponses;
  const avgCompletionRate = stats.avgCompletionRate;

  // Load which app each form belongs to (cloud mode) so Recent Forms can tag it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (storageMode !== 'api') { if (!cancelled) setAppOfForm({}); return; }
      const res = await api.getApps();
      const apps = (res.data?.apps || []) as Array<{ id: string; name: string }>;
      const map: Record<string, string> = {};
      await Promise.all(apps.map(async (a) => {
        const fr = await api.getAppForms(a.id);
        for (const f of (fr.data?.forms || []) as Array<{ formId: string }>) { map[f.formId] = a.name; }
      }));
      if (!cancelled) setAppOfForm(map);
    })();
    return () => { cancelled = true; };
  }, [storageMode]);

  // Get recent forms
  const recentForms = [...forms]
    .sort((a, b) => parseServerDate(b.updatedAt).getTime() - parseServerDate(a.updatedAt).getTime())
    .slice(0, 5);

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

  // Format date for welcome message
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  // Show getting started only for genuinely-new users — not during the initial
  // cloud-data load (which would briefly flash the onboarding hero + zeroed stats).
  const showGettingStarted = forms.length === 0 && !formsLoading;
  const showWelcome = showGettingStarted && !welcomeDismissed;

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
            Welcome back{user?.name ? `, ${user.name}` : ''}!
          </h1>
          <p className="text-gray-500 dark:text-slate-400 mt-1">{today}</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-8">
          <StatCard
            className="fade-in-up stagger-1"
            icon={FileText}
            iconBg="bg-primary-50 dark:bg-primary-500/10"
            iconColor="text-primary-600 dark:text-primary-400"
            value={formsLoading ? '—' : totalForms}
            label="Total forms"
            subtext={formsLoading ? 'Loading…' : totalForms === 0 ? 'Create your first form' : draftForms > 0 ? `${draftForms} draft${draftForms === 1 ? '' : 's'}` : 'All published'}
          />
          <StatCard
            className="fade-in-up stagger-2"
            icon={Globe}
            iconBg="bg-green-50 dark:bg-green-500/10"
            iconColor="text-green-600 dark:text-green-400"
            value={formsLoading ? '—' : publishedForms}
            label="Published"
            subtext={formsLoading ? 'Loading…' : totalForms > 0 ? `${Math.round((publishedForms / totalForms) * 100)}% of forms` : 'No forms yet'}
          />
          <StatCard
            className="fade-in-up stagger-3"
            icon={Inbox}
            iconBg="bg-blue-50 dark:bg-blue-500/10"
            iconColor="text-blue-600 dark:text-blue-400"
            value={formsLoading ? '—' : totalResponses}
            label="Total responses"
            subtext="Across all forms"
          />
          <StatCard
            className="fade-in-up stagger-4"
            icon={TrendingUp}
            iconBg="bg-amber-50 dark:bg-amber-500/10"
            iconColor="text-amber-600 dark:text-amber-400"
            value={formsLoading ? '—' : totalForms > 0 ? `${avgCompletionRate}%` : '—'}
            label="Completion rate"
            subtext={formsLoading ? 'Loading…' : totalForms > 0 ? 'Average across forms' : 'No forms yet'}
          />
        </div>

        {/* Quick Actions */}
        <div className="mb-8">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            Quick actions
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            <QuickActionButton
              icon={Plus}
              label="New form"
              onClick={handleCreateForm}
              primary
            />
            <QuickActionButton
              icon={FileText}
              label="All forms"
              onClick={() => navigate('/forms')}
            />
            <QuickActionButton
              icon={LayoutTemplate}
              label="Templates"
              onClick={() => setShowTemplateSelector(true)}
            />
            <QuickActionButton
              icon={Package}
              label="Manage packs"
              onClick={() => setShowPackImport(true)}
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

        {/* Apps strip — the user's most recently updated apps, mirroring the Apps page cards. */}
        {recentApps.length > 0 && (
          <div className="mb-8">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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

        {/* Main Content - Two Column Layout on Desktop */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent Forms - Takes 2/3 on desktop */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">My forms</h2>
              {forms.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/forms')}
                  className="text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300"
                >
                  View all
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
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
                          <div className="flex items-center gap-4 min-w-0 flex-1">
                            <div className="p-2.5 bg-primary-50 dark:bg-primary-500/10 rounded-xl flex-shrink-0 hidden sm:flex">
                              <DynamicIcon name={form.icon} className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h4 className="font-semibold text-gray-900 dark:text-white truncate group-hover:text-primary-600 dark:group-hover:text-primary-400 motion-safe:transition-colors" title={form.title || 'Untitled Form'}>
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
                                  {formatRelativeTime(form.updatedAt)}
                                </span>
                                <span className="hidden sm:inline">•</span>
                                <span className="hidden sm:inline">{fieldCount} field{fieldCount === 1 ? '' : 's'}</span>
                                <span>•</span>
                                {(() => { const n = storageMode === 'api' ? (responseCounts[form.id] ?? 0) : formResponses.length; return <span>{n} response{n === 1 ? '' : 's'}</span>; })()}
                              </div>
                            </div>
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
                              onClick={() => navigate(`/preview/${form.id}`)}
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
              <h2 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Recent activity</h2>
            </div>

            <Card>
              <CardContent className="p-0">
                {recentResponses.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="No submissions yet"
                    description="Responses will appear here as they come in."
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
        message={`Are you sure you want to delete "${deleteTarget?.title || 'this form'}"? This action cannot be undone and all responses will be lost.`}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
