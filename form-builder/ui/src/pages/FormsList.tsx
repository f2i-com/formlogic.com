import { useState, useEffect, useCallback, useMemo, useRef, memo, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { logger } from '../lib/logger';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useCreateFormFlow } from '../hooks/useCreateFormFlow';
import {
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
  ArchiveRestore,
  EyeOff,
  Package,
  FileText,
  Boxes,
  ChevronRight,
  Clock,
  Loader2,
  ExternalLink,
  Settings,
  LayoutGrid,
  List,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { ShowMore } from '../components/ui/ShowMore';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { useFormStore } from '../stores/formStore';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import { useResponseStore } from '../stores/responseStore';
import { toast } from '../stores/toastStore';
import { formatRelativeTime, parseServerDate } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { PackImportModal } from '../components/builder/PackImportModal';
import { useFormPreview } from '../components/builder/useFormPreview';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { api } from '../lib/api';
import { loadUiCache, saveUiCache } from '../lib/uiCache';
import { loadAppGroupsCache, fetchAppGroups, type AppGroup } from '../lib/appGroups';
import type { PackInstallation } from '../lib/api';
import type { Form } from '../types/form';

// Incremental pagination page sizes for the card grids.
const FORMS_PAGE = 12;
const APPS_PAGE = 8;

// App accents are user/pack-authored hex values; validate strictly before injecting into an
// inline CSS custom property (same rule as the landing page's DemoAppCard).
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

// App identity tile: logo image → DynamicIcon(settings.icon) tinted with the app's own
// theme.primaryColor (CSS var + color-mix keeps the tint dark-mode safe) → Boxes on primary tint.
function AppIdentityTile({ logoUrl, icon, accent, className, iconClassName }: {
  logoUrl?: string | null;
  icon?: string | null;
  accent?: string | null;
  /** Sizing + rounding for the tile, e.g. "h-9 w-9 rounded-lg". */
  className: string;
  /** Sizing for the glyph, e.g. "h-5 w-5". */
  iconClassName: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !imgFailed;
  const accented = !showLogo && isHexColor(accent);
  return (
    <div
      style={accented ? ({ '--fl-a': accent } as CSSProperties) : undefined}
      className={`flex flex-none items-center justify-center overflow-hidden ${className} ${
        showLogo
          ? 'bg-gray-50 dark:bg-slate-800/60'
          : accented
            ? 'bg-[color-mix(in_srgb,var(--fl-a)_11%,transparent)] text-[color:var(--fl-a)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--fl-a)_25%,transparent)] dark:bg-[color-mix(in_srgb,var(--fl-a)_16%,transparent)] dark:text-[color:color-mix(in_srgb,var(--fl-a)_62%,white)]'
            : 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 transition-colors'
      }`}
    >
      {showLogo ? (
        <img
          src={logoUrl ?? undefined}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <DynamicIcon name={icon} className={iconClassName} fallback={<Boxes className={iconClassName} />} />
      )}
    </div>
  );
}

// Lifecycle status → quiet tinted pill with a colored dot. Same token families as Badge
// (emerald/amber/neutral) but with a dot indicator so status reads at a glance without shouting.
const STATUS_PILLS: Record<Form['status'], { pill: string; dot: string }> = {
  published: {
    pill: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
  },
  draft: {
    pill: 'bg-amber-50 text-amber-700 ring-amber-200/60 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  archived: {
    pill: 'bg-gray-100 text-gray-600 ring-gray-200/60 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700/50',
    dot: 'bg-gray-400 dark:bg-slate-500',
  },
};

function StatusPill({ status }: { status: Form['status'] }) {
  const s = STATUS_PILLS[status] ?? STATUS_PILLS.draft;
  return (
    <span className={`inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset ${s.pill}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}

// Loading placeholder mirroring the form card's anatomy (icon tile + two-line header,
// divided status/meta row, action pair) so the grid doesn't reflow when data lands.
function FormCardSkeleton() {
  return (
    <div className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 flex-none rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <Skeleton className="h-8 w-8 flex-none rounded-lg" />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-gray-100 dark:border-white/5 pt-3">
        <Skeleton className="h-[22px] w-20 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-8 flex-1 rounded-lg" />
        <Skeleton className="h-8 flex-1 rounded-lg" />
      </div>
    </div>
  );
}

// Dashed shell around empty tabs so they read as a friendly placeholder, not a void.
const EMPTY_SHELL_CLASS =
  'rounded-2xl border border-dashed border-gray-300/80 dark:border-slate-700/60 bg-gray-50/50 dark:bg-slate-900/30';

// Soft numeric chip for tab labels — quieter than "(3)" and the numerals stay aligned.
function TabCount({ n }: { n: number }) {
  return (
    <span className="ml-1.5 rounded-full bg-gray-200/70 px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-gray-500 dark:bg-slate-600/60 dark:text-slate-300">
      {n}
    </span>
  );
}

// Extracted outside FormsList so React maintains a stable component identity across renders
const FormCard = memo(function FormCard({
  form,
  responseCount,
  packName,
  activeMenuId,
  activeMenuRect,
  onMenuToggle,
  onMenuClose,
  onNavigate,
  onPreview,
  onDuplicate,
  onEmbed,
  onDelete,
  onStatusChange,
}: {
  form: Form;
  responseCount: number;
  packName: string | null;
  activeMenuId: string | null;
  activeMenuRect: DOMRect | null;
  onMenuToggle: (id: string, rect: DOMRect) => void;
  onMenuClose: () => void;
  onNavigate: (path: string) => void;
  /** In-app forms open the real app runtime at this form (new tab); standalone forms use /preview. */
  onPreview: (id: string) => void;
  onDuplicate: (id: string) => void;
  onEmbed: (id: string, title: string, status: Form['status']) => void;
  onDelete: (id: string, title: string) => void;
  onStatusChange: (id: string, status: 'draft' | 'published' | 'archived') => void;
}) {
  const isMenuOpen = activeMenuId === form.id;
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasMenuOpen = useRef(false);

  // Menu focus management: focus the first item when it opens, return focus to the
  // kebab trigger when it closes (Escape, outside click, or action).
  useEffect(() => {
    if (isMenuOpen) {
      wasMenuOpen.current = true;
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    } else if (wasMenuOpen.current) {
      wasMenuOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [isMenuOpen]);

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`Open ${form.title || 'Untitled Form'} in the builder`}
      onClick={() => onNavigate(`/builder/${form.id}`)}
      onKeyDown={(e) => {
        // Only act on the card itself — inner buttons handle their own keys.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onNavigate(`/builder/${form.id}`);
        }
      }}
      className="group cursor-pointer transition-colors duration-200 hover:bg-gray-50/70 dark:hover:bg-slate-800/40 hover:border-gray-300 dark:hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
    >
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-500/10 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 transition-colors">
            <DynamicIcon name={form.icon} className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold leading-snug text-gray-900 dark:text-slate-100 truncate" title={form.title || 'Untitled Form'}>{form.title || 'Untitled Form'}</h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
              {(() => { const n = form.fieldCount ?? form.fields?.length ?? 0; return `${n} field${n === 1 ? '' : 's'}`; })()}
            </p>
            {packName && (
              <div className="mt-1.5">
                <Badge variant="info" size="sm" className="max-w-full whitespace-nowrap">
                  <Package className="h-3 w-3 mr-1 inline shrink-0" />
                  <span className="truncate" title={packName}>{packName}</span>
                </Badge>
              </div>
            )}
          </div>
          <div className="relative flex-none">
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 -mr-1 -mt-0.5 text-gray-400 dark:text-slate-500"
              aria-label={`Actions for ${form.title || 'Untitled Form'}`}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={(e) => {
                e.stopPropagation();
                if (isMenuOpen) {
                  onMenuClose();
                } else {
                  onMenuToggle(form.id, e.currentTarget.getBoundingClientRect());
                }
              }}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>

            {isMenuOpen && activeMenuRect && createPortal(
              <div
                className="fixed inset-0 z-[60]"
                style={{ zIndex: 60 }}
                // Portal events bubble through the React tree to the clickable Card —
                // stop them here so menu interactions never navigate to the builder.
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className="absolute inset-0 bg-transparent"
                  onClick={onMenuClose}
                />
                <div
                  ref={menuRef}
                  role="menu"
                  aria-label={`Actions for ${form.title || 'Untitled Form'}`}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    e.preventDefault();
                    e.stopPropagation();
                    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
                    if (items.length === 0) return;
                    const current = items.indexOf(document.activeElement as HTMLButtonElement);
                    const next = current < 0
                      ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
                      : (e.key === 'ArrowDown'
                        ? (current + 1) % items.length
                        : (current - 1 + items.length) % items.length);
                    items[next]?.focus();
                  }}
                  className="absolute w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 ring-1 ring-black/5 dark:ring-white/[0.06] overflow-hidden max-h-[80vh] overflow-y-auto"
                  style={{
                    // 330 ≈ the real height of the tallest menu variant — flip above the
                    // trigger when that wouldn't fit below.
                    ...(activeMenuRect.bottom + 330 > window.innerHeight
                      ? { bottom: window.innerHeight - activeMenuRect.top + 4 }
                      : { top: activeMenuRect.bottom + 4 }),
                    left: Math.max(8, activeMenuRect.right - 192),
                  }}
                >
                  <button
                    onClick={() => { onNavigate(`/builder/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Pencil className="h-4 w-4" /> Edit
                  </button>
                  <button
                    onClick={() => { onPreview(form.id); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Eye className="h-4 w-4" /> Preview
                  </button>
                  <button
                    onClick={() => { onNavigate(`/analytics/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <BarChart3 className="h-4 w-4" /> Analytics
                  </button>
                  <button
                    onClick={() => { onNavigate(`/responses/${form.id}`); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Table className="h-4 w-4" /> View Data
                  </button>
                  <button
                    onClick={() => onDuplicate(form.id)}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Copy className="h-4 w-4" /> Duplicate
                  </button>
                  <button
                    onClick={() => { onEmbed(form.id, form.title, form.status); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <Share2 className="h-4 w-4" /> Share & Embed
                  </button>
                  <hr className="my-1 border-gray-100 dark:border-slate-800" />
                  {form.status !== 'published' && form.status !== 'archived' && (
                    <button
                      onClick={() => { onStatusChange(form.id, 'published'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Globe className="h-4 w-4" /> Publish
                    </button>
                  )}
                  {form.status === 'published' && (
                    <button
                      onClick={() => { onStatusChange(form.id, 'draft'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <EyeOff className="h-4 w-4" /> Unpublish
                    </button>
                  )}
                  {form.status === 'archived' ? (
                    <button
                      onClick={() => { onStatusChange(form.id, 'draft'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <ArchiveRestore className="h-4 w-4" /> Restore to draft
                    </button>
                  ) : (
                    <button
                      onClick={() => { onStatusChange(form.id, 'archived'); onMenuClose(); }}
                      role="menuitem"
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Archive className="h-4 w-4" /> Archive
                    </button>
                  )}
                  <hr className="my-1 border-gray-100 dark:border-slate-800" />
                  <button
                    onClick={() => { onDelete(form.id, form.title); onMenuClose(); }}
                    role="menuitem"
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </div>
              </div>,
              document.body
            )}
          </div>
        </div>

        {/* Status + metadata columns: pill on the left, responses/updated aligned right so the
            numbers line up card-to-card. Color signals lifecycle only via the pill. */}
        <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-gray-100 dark:border-white/5 pt-3">
          <StatusPill status={form.status} />
          <div className="flex min-w-0 items-center gap-3 text-xs text-gray-500 dark:text-slate-400">
            <span
              className="inline-flex flex-none items-center gap-1"
              title={`${responseCount} response${responseCount === 1 ? '' : 's'}`}
            >
              <Inbox className="h-3.5 w-3.5 text-gray-400 dark:text-slate-500" aria-hidden="true" />
              <span className="tabular-nums">{responseCount}</span>
              <span className="sr-only">{` response${responseCount === 1 ? '' : 's'}`}</span>
            </span>
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={`Updated ${formatRelativeTime(form.updatedAt)}`}
            >
              <Clock className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
              <span className="truncate">{formatRelativeTime(form.updatedAt)}</span>
            </span>
          </div>
        </div>

        <div className="flex gap-2 mt-3">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={(e) => { e.stopPropagation(); onNavigate(`/builder/${form.id}`); }}
          >
            Edit
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            onClick={(e) => { e.stopPropagation(); onPreview(form.id); }}
          >
            Preview
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});

// Compact list-mode row (the data-browsing view): clicking the row opens the form's
// RECORDS, with explicit quick actions for Edit / Analytics / Preview. The full action
// menu (duplicate, embed, archive, delete…) stays on the card view.
const FormListRow = memo(function FormListRow({
  form,
  responseCount,
  packName,
  onNavigate,
  onPreview,
}: {
  form: Form;
  responseCount: number;
  packName: string | null;
  onNavigate: (path: string) => void;
  onPreview: (formId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(`/responses/${form.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(`/responses/${form.id}`); } }}
      title="View records"
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{form.title}</span>
          {packName && (
            <span className="hidden md:inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:text-slate-400 flex-none">
              <Package className="h-3 w-3" /> {packName}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-gray-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1" title={`${responseCount} response${responseCount === 1 ? '' : 's'}`}>
            <Inbox className="h-3.5 w-3.5 text-gray-400 dark:text-slate-500" aria-hidden="true" />
            <span className="tabular-nums">{responseCount}</span>
            <span className="sr-only">{` response${responseCount === 1 ? '' : 's'}`}</span>
          </span>
          <span className="hidden sm:inline-flex items-center gap-1 min-w-0" title={`Updated ${formatRelativeTime(form.updatedAt)}`}>
            <Clock className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
            <span className="truncate">{formatRelativeTime(form.updatedAt)}</span>
          </span>
        </div>
      </div>
      <StatusPill status={form.status} />
      <div className="flex items-center gap-0.5 flex-none" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => onNavigate(`/responses/${form.id}`)}
          title="View records"
          aria-label={`View records for ${form.title}`}
          className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
        >
          <Table className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onNavigate(`/analytics/${form.id}`)}
          title="Analytics"
          aria-label={`Analytics for ${form.title}`}
          className="hidden sm:block p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
        >
          <BarChart3 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onNavigate(`/builder/${form.id}`)}
          title="Edit form"
          aria-label={`Edit ${form.title}`}
          className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onPreview(form.id)}
          title="Preview"
          aria-label={`Preview ${form.title}`}
          className="hidden sm:block p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 transition-colors cursor-pointer"
        >
          <Eye className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
});

export function FormsList() {
  useDocumentTitle('My Forms');
  const navigate = useNavigate();
  const { forms, setActiveForm, deleteForm, duplicateForm, updateForm } = useFormStore();
  const addFormToApp = useAppStore((s) => s.addFormToApp);
  // "New Form" / "Create Form" open the New Form picker (template or blank).
  const { openNewForm, newFormPicker } = useCreateFormFlow();
  const formsLoading = useFormStore((s) => s.isLoading || !s.isInitialized);
  const storageMode = useFormStore((s) => s.storageMode);
  const { getResponsesByFormId } = useResponseStore();
  // Cloud mode keeps responses on the server, so the local store is empty — use the
  // server-provided per-form count there (falls back to the local store offline/local).
  const responseCountOf = (form: Form) =>
    storageMode === 'api' ? (form.responseCount ?? 0) : getResponsesByFormId(form.id).length;
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'modified' | 'name' | 'responses'>('modified');
  // Grid (cards) vs list (compact data-browsing rows) — remembered across visits.
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try { return localStorage.getItem('formsList.viewMode') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const changeViewMode = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    try { localStorage.setItem('formsList.viewMode', mode); } catch { /* ignore */ }
  };
  const [activeMenu, setActiveMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string; status: Form['status'] } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showPackImport, setShowPackImport] = useState(false);
  const [packFilter, setPackFilter] = useState<string>('all');
  const user = useAuthStore((s) => s.user);
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>(
    // Last visit's packs paint the badges/filter immediately; the fetch below refreshes them.
    () => loadUiCache<PackInstallation[]>('installed-packs', useAuthStore.getState().user?.id)?.data ?? []
  );
  // App grouping: which forms belong to which app, and the current drill-in.
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  // Hydrate the apps rail from the shared per-user cache (see lib/appGroups) so it
  // renders instantly on revisit; the background fetch below revalidates it.
  const [appGroups, setAppGroups] = useState<AppGroup[]>(() =>
    useFormStore.getState().storageMode === 'api'
      ? loadAppGroupsCache(useAuthStore.getState().user?.id) ?? []
      : []
  );
  // Apps load async — reserve skeleton space only when there's nothing cached to show.
  const [appsLoading, setAppsLoading] = useState(() =>
    useFormStore.getState().storageMode === 'api' &&
    !loadAppGroupsCache(useAuthStore.getState().user?.id)
  );
  // Hints cached from the previous apps fetch so this visit doesn't jump while apps load:
  // whether to reserve apps-rail skeleton space at all (zero-apps users must not see a
  // skeleton that vanishes), and which forms were in-app (hidden from the top level).
  const [hadAppsHint] = useState<boolean>(() => {
    try { return localStorage.getItem('fl-had-apps') === '1'; } catch { return false; }
  });
  const [cachedAppFormIds] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('fl-app-form-ids') || '[]') as unknown;
      return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
    } catch { return new Set<string>(); }
  });
  // Incremental pagination limits.
  const [appLimit, setAppLimit] = useState(APPS_PAGE);
  const [formLimit, setFormLimit] = useState(FORMS_PAGE);
  // Controlled tab so switching tabs resets the incremental form limit.
  const [activeTab, setActiveTab] = useState('all');

  // Build formId → packName map from installed packs
  const formPackMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const formId of pack.formIds ?? []) {
        map[formId] = pack.packName;
      }
    }
    return map;
  }, [installedPacks]);

  // Build formId → packId map for filtering
  const formPackIdMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const formId of pack.formIds ?? []) {
        map[formId] = pack.packId;
      }
    }
    return map;
  }, [installedPacks]);

  // Build appId → packName map so each app card can show which pack it came from
  const appPackMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const pack of installedPacks) {
      for (const appId of pack.appIds ?? []) {
        map[appId] = pack.packName;
      }
    }
    return map;
  }, [installedPacks]);

  // Fetch installed packs on mount (cached copy already painted; this revalidates it).
  useEffect(() => {
    api.getInstalledPacks().then((result) => {
      if (!result.error && result.data) {
        setInstalledPacks(result.data.installations);
        saveUiCache('installed-packs', useAuthStore.getState().user?.id, result.data.installations);
      }
    });
  }, []);

  // Load apps + their form memberships so My Forms can group forms by app (cloud mode
  // only). Shared cached fetch (lib/appGroups): a cached rail renders immediately and
  // this refresh lands silently; only a cache miss shows the skeleton.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (storageMode !== 'api') { if (!cancelled) { setAppGroups([]); setAppsLoading(false); } return; }
      const cached = loadAppGroupsCache(user?.id);
      if (!cancelled) {
        if (cached) { setAppGroups(cached); setAppsLoading(false); }
        else setAppsLoading(true);
      }
      try {
        const groups = await fetchAppGroups(user?.id);
        if (!cancelled) setAppGroups(groups);
        // Refresh the layout hints for the next visit (skip on fetch errors so a
        // transient failure doesn't wrongly clear them).
        try {
          localStorage.setItem('fl-had-apps', groups.length > 0 ? '1' : '0');
          localStorage.setItem('fl-app-form-ids', JSON.stringify(groups.flatMap((g) => g.formIds)));
        } catch { /* storage unavailable — hints are optional */ }
      } catch {
        // Keep whatever is on screen (cached or empty) on a transient failure.
      } finally {
        if (!cancelled) setAppsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [storageMode, user?.id]);

  // formId → its app, for GROUPING standalone vs in-app forms only. Preview routing does NOT
  // use this map — a form can be in several apps (companion apps), so preview does a fresh
  // per-click context lookup via the shared useFormPreview mechanism below.
  const formToApp = useMemo(() => {
    const map: Record<string, { id: string; name: string; slug: string | null }> = {};
    for (const g of appGroups) for (const fid of g.formIds) map[fid] = { id: g.id, name: g.name, slug: g.slug };
    return map;
  }, [appGroups]);

  // Preview IN CONTEXT, always in a NEW TAB: fresh app-context lookup on click — one published
  // app opens the real app runtime AT that form, several published apps ask which, otherwise
  // (or on fetch failure) the standalone fillable form (?form=1 shows the form even when it has
  // a custom screen — the screen keeps its own preview in the Studio).
  const { openPreview: handlePreview, previewChooser } = useFormPreview();

  // The forms to show in the current view: a drilled-in app's forms, or top-level standalone forms.
  // While apps are still loading at the top level, filter with the membership cached from the last
  // visit so form cards render immediately instead of waiting on the apps fetch (and without
  // briefly listing in-app forms and then filtering them out, which caused a visible jump).
  const viewForms = useMemo(() => {
    if (selectedAppId) {
      const ids = new Set(appGroups.find((g) => g.id === selectedAppId)?.formIds ?? []);
      return forms.filter((f) => ids.has(f.id));
    }
    if (storageMode === 'api' && appsLoading) return forms.filter((f) => !cachedAppFormIds.has(f.id));
    return forms.filter((f) => !formToApp[f.id]);
  }, [forms, selectedAppId, appGroups, formToApp, storageMode, appsLoading, cachedAppFormIds]);

  const selectedApp = selectedAppId ? appGroups.find((g) => g.id === selectedAppId) : null;
  // The grid only waits on the forms themselves — the apps rail loads independently.
  const gridLoading = formsLoading;

  // Close dropdown menu on scroll, resize, or Escape to prevent stale positioning
  useEffect(() => {
    if (!activeMenu) return;
    const close = () => setActiveMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveMenu(null); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [activeMenu]);

  const handleNavigate = useCallback((path: string) => {
    navigate(path);
  }, [navigate]);

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const newForm = await duplicateForm(id);
      if (newForm) {
        // duplicateForm() only clones the form row — app membership (app_forms) is a
        // separate relation the backend never copies. Re-attach the copy to the same
        // app it was duplicated from so it doesn't silently fall out into "standalone".
        // Only applies when duplicating from inside a drilled-in app view.
        if (selectedAppId) {
          await addFormToApp(selectedAppId, newForm.id, newForm.title);
        }
        setActiveForm(newForm.id);
        navigate(`/builder/${newForm.id}`);
      }
    } catch (error) {
      logger.error('Failed to duplicate form:', error);
      toast.error('Failed to duplicate form', 'Please try again');
    }
    setActiveMenu(null);
  }, [duplicateForm, setActiveForm, navigate, selectedAppId, addFormToApp]);

  const handleMenuToggle = useCallback((id: string, rect: DOMRect) => {
    setActiveMenu({ id, rect });
  }, []);

  const handleMenuClose = useCallback(() => {
    setActiveMenu(null);
  }, []);

  const handleEmbed = useCallback((id: string, title: string, status: Form['status']) => {
    setEmbedModalForm({ id, title, status });
  }, []);

  const handleDelete = useCallback((id: string, title: string) => {
    setDeleteTarget({ id, title });
  }, []);

  const handleStatusChange = useCallback(async (id: string, status: 'draft' | 'published' | 'archived') => {
    try {
      await updateForm(id, { status });
      const label = status === 'published' ? 'published' : status === 'archived' ? 'archived' : 'moved to draft';
      toast.success('Form updated', `Form ${label}.`);
    } catch (error) {
      logger.error('Failed to update form status:', error);
      toast.error('Update failed', 'Could not change the form status.');
    }
  }, [updateForm]);

  // Unique installed packs for the pack filter (a pack can be installed more than once).
  const packOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of installedPacks) if (!seen.has(p.packId)) seen.set(p.packId, p.packName);
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [installedPacks]);

  // formId -> title, so an app's member forms can be matched by name even though they're
  // not in `viewForms` at the top level (viewForms only holds standalone forms there).
  const formTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of forms) map.set(f.id, f.title);
    return map;
  }, [forms]);

  // Per-app titles of its member forms that match the current search query. Lets the Apps
  // rail search reach forms tucked inside an app, not just the app's own name/description —
  // otherwise a form becomes unfindable the moment it's organized into an app. Apps whose own
  // name/description already match are skipped here — showing "found via a form inside" on
  // top of an obvious match would just be noise, and it lets the render loop below reuse this
  // map directly instead of re-deriving the same own-match check per row.
  const appMemberMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return {} as Record<string, string[]>;
    const map: Record<string, string[]> = {};
    for (const g of appGroups) {
      const ownMatch = g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q);
      if (ownMatch) continue;
      const titles = g.formIds
        .map((id) => formTitleById.get(id))
        .filter((t): t is string => !!t && t.toLowerCase().includes(q));
      if (titles.length > 0) map[g.id] = titles;
    }
    return map;
  }, [appGroups, searchQuery, formTitleById]);

  // The same search box also filters the apps rail (name, description, or a member form's title).
  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return appGroups;
    return appGroups.filter((g) =>
      g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q) || appMemberMatches[g.id]
    );
  }, [appGroups, searchQuery, appMemberMatches]);

  const compareForms = useCallback((a: Form, b: Form): number => {
    switch (sortBy) {
      case 'name':
        return a.title.localeCompare(b.title);
      case 'responses': {
        const ca = storageMode === 'api' ? (a.responseCount ?? 0) : getResponsesByFormId(a.id).length;
        const cb = storageMode === 'api' ? (b.responseCount ?? 0) : getResponsesByFormId(b.id).length;
        return cb - ca;
      }
      case 'modified':
      default:
        return parseServerDate(b.updatedAt).getTime() - parseServerDate(a.updatedAt).getTime();
    }
  }, [sortBy, storageMode, getResponsesByFormId]);

  const matchesPackFilter = useCallback((form: Form): boolean => {
    if (packFilter === 'all') return true;
    if (packFilter === 'none') return !formPackIdMap[form.id];
    return formPackIdMap[form.id] === packFilter;
  }, [packFilter, formPackIdMap]);

  const filteredForms = useMemo(() =>
    viewForms.filter(matchesPackFilter).sort(compareForms),
    [viewForms, compareForms, matchesPackFilter]
  );

  // GLOBAL search (free search — nothing is scoped away): every owned form, standalone AND
  // inside apps, grouped standalone-first then per app. Typing a query switches the page to
  // these results, so an item can never be "missing" just because a scope was selected.
  const searchActive = searchQuery.trim() !== '';
  const globalFormGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const matches = forms
      .filter((form) =>
        (form.title.toLowerCase().includes(q) || (form.description ?? '').toLowerCase().includes(q))
        && matchesPackFilter(form))
      .sort(compareForms);
    const standalone: Form[] = [];
    const byApp = new Map<string, { name: string; forms: Form[] }>();
    for (const form of matches) {
      const app = formToApp[form.id];
      if (!app) {
        standalone.push(form);
        continue;
      }
      const entry = byApp.get(app.id) ?? { name: app.name, forms: [] };
      entry.forms.push(form);
      byApp.set(app.id, entry);
    }
    const groups: { key: string; label: string | null; forms: Form[] }[] = [];
    if (standalone.length > 0) groups.push({ key: 'standalone', label: null, forms: standalone });
    for (const [appId, entry] of byApp) groups.push({ key: appId, label: entry.name, forms: entry.forms });
    return groups;
  }, [forms, searchQuery, matchesPackFilter, compareForms, formToApp]);
  const globalFormCount = useMemo(
    () => globalFormGroups.reduce((n, g) => n + g.forms.length, 0),
    [globalFormGroups]
  );

  const draftForms = useMemo(() => filteredForms.filter((f) => f.status === 'draft'), [filteredForms]);
  const publishedForms = useMemo(() => filteredForms.filter((f) => f.status === 'published'), [filteredForms]);
  const archivedForms = useMemo(() => filteredForms.filter((f) => f.status === 'archived'), [filteredForms]);

  // Shared across all tabs: when a pack filter is active, an empty tab offers to clear the
  // filters instead of claiming there are no forms of that status (search now switches the
  // whole page to global results, so it never empties a tab).
  const filtersActive = packFilter !== 'all';
  const clearFiltersEmptyState = (
    <EmptyState
      icon={Search}
      title="No forms match your filters"
      description="Try a different search term, or clear the filters to see all your forms."
      className={EMPTY_SHELL_CLASS}
      action={
        <Button variant="outline" onClick={() => { setSearchQuery(''); setPackFilter('all'); }}>
          Clear filters
        </Button>
      }
    />
  );

  const renderAppTile = (g: (typeof appGroups)[number]) => {
    // appMemberMatches already excludes apps with an obvious own-name/description
    // match (see its definition above), so no need to re-derive that here.
    const memberMatches = appMemberMatches[g.id];
    return (
      <button
        key={g.id}
        onClick={() => { setSelectedAppId(g.id); setSearchQuery(''); }}
        className="flex items-center gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50/70 dark:hover:bg-slate-800/50 hover:border-gray-300 dark:hover:border-slate-600 transition-colors duration-200 text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
      >
        <AppIdentityTile
          logoUrl={g.logoUrl}
          icon={g.icon}
          accent={g.accent}
          className="h-9 w-9 rounded-lg"
          iconClassName="h-5 w-5"
        />
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-gray-900 dark:text-slate-100 truncate">{g.name}</span>
          <span className="block text-xs text-gray-500 dark:text-slate-400">{g.formIds.length} form{g.formIds.length === 1 ? '' : 's'}</span>
          {memberMatches && memberMatches.length > 0 ? (
            <span
              className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-primary-600 dark:text-primary-400"
              title={`Contains matching form${memberMatches.length === 1 ? '' : 's'}: ${memberMatches.join(', ')}`}
            >
              <Search className="h-3 w-3 shrink-0" />
              <span className="truncate">
                in app: "{memberMatches[0]}"{memberMatches.length > 1 ? ` +${memberMatches.length - 1} more` : ''}
              </span>
            </span>
          ) : appPackMap[g.id] && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-gray-400 dark:text-slate-500" title={`From the ${appPackMap[g.id]} pack`}>
              <Package className="h-3 w-3 shrink-0" />
              <span className="truncate">{appPackMap[g.id]}</span>
            </span>
          )}
        </div>
        <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 shrink-0" />
      </button>
    );
  };

  const renderFormCard = (form: Form) => (
    <FormCard
      key={form.id}
      form={form}
      responseCount={responseCountOf(form)}
      packName={formPackMap[form.id] ?? null}
      activeMenuId={activeMenu?.id ?? null}
      activeMenuRect={activeMenu?.id === form.id ? activeMenu.rect : null}
      onMenuToggle={handleMenuToggle}
      onMenuClose={handleMenuClose}
      onNavigate={handleNavigate}
      onPreview={handlePreview}
      onDuplicate={handleDuplicate}
      onEmbed={handleEmbed}
      onDelete={handleDelete}
      onStatusChange={handleStatusChange}
    />
  );

  // Render a set of forms in the active view mode. Cards fill the surrounding grid;
  // the list renders as one full-width block inside it (col-span-full), so the tabs'
  // skeleton/empty-state plumbing works unchanged for both modes.
  const renderFormsView = (list: Form[]) =>
    viewMode === 'grid' ? (
      list.map(renderFormCard)
    ) : (
      <div className="col-span-full overflow-hidden rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 divide-y divide-gray-100 dark:divide-slate-800">
        {list.map((form) => (
          <FormListRow
            key={form.id}
            form={form}
            responseCount={responseCountOf(form)}
            packName={formPackMap[form.id] ?? null}
            onNavigate={handleNavigate}
            onPreview={handlePreview}
          />
        ))}
      </div>
    );

  return (
    <div className="min-h-screen">
      <Header
        title="My Forms"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />} aria-label="Manage Packs" title="Manage Packs">
              <span className="hidden sm:inline">Manage Packs</span>
            </Button>
            <Button onClick={openNewForm} size="sm" leftIcon={<Plus className="h-4 w-4" />}>
              <span className="hidden sm:inline">New Form</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Breadcrumb + app actions when drilled into an app */}
        {selectedAppId && (
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <nav className="flex items-center gap-1.5 text-sm min-w-0" aria-label="Breadcrumb">
              <button onClick={() => setSelectedAppId(null)} className="text-gray-500 dark:text-slate-400 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer">My Forms</button>
              <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 shrink-0" />
              <span className="font-medium text-gray-900 dark:text-slate-100 inline-flex items-center gap-1.5 min-w-0">
                <AppIdentityTile
                  logoUrl={selectedApp?.logoUrl}
                  icon={selectedApp?.icon}
                  accent={selectedApp?.accent}
                  className="h-5 w-5 rounded"
                  iconClassName="h-3.5 w-3.5"
                />
                <span className="truncate">{selectedApp?.name ?? 'App'}</span>
              </span>
            </nav>
            <div className="flex items-center gap-2 sm:ml-auto">
              {selectedApp?.slug && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`/app/${selectedApp.slug}`, '_blank', 'noopener')}
                  leftIcon={<ExternalLink className="h-4 w-4" />}
                >
                  Open app
                </Button>
              )}
              {selectedAppId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/apps/${selectedAppId}/settings`)}
                  leftIcon={<Settings className="h-4 w-4" />}
                >
                  Manage
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Search first (free search): typing switches the page to GLOBAL results across every
            app and form — nothing is scoped away. Sort/view/pack controls sit to the right. */}
        <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
          <Input
            placeholder="Search all forms and apps..."
            aria-label="Search forms and apps"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" />}
            className="w-full sm:max-w-md"
          />
          <div className="flex gap-3 sm:ml-auto">
            {/* Grid / list view toggle */}
            <div className="flex flex-none rounded-lg border border-gray-300 dark:border-slate-700 overflow-hidden" role="group" aria-label="View mode">
              <button
                type="button"
                onClick={() => changeViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                title="Card view"
                className={`px-3 py-2.5 transition-colors cursor-pointer ${viewMode === 'grid'
                  ? 'bg-primary-50 dark:bg-primary-500/15 text-primary-600 dark:text-primary-400'
                  : 'bg-white dark:bg-slate-900/60 text-gray-400 hover:text-gray-700 dark:hover:text-slate-300'}`}
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="sr-only">Card view</span>
              </button>
              <button
                type="button"
                onClick={() => changeViewMode('list')}
                aria-pressed={viewMode === 'list'}
                title="List view"
                className={`px-3 py-2.5 border-l border-gray-300 dark:border-slate-700 transition-colors cursor-pointer ${viewMode === 'list'
                  ? 'bg-primary-50 dark:bg-primary-500/15 text-primary-600 dark:text-primary-400'
                  : 'bg-white dark:bg-slate-900/60 text-gray-400 hover:text-gray-700 dark:hover:text-slate-300'}`}
              >
                <List className="h-4 w-4" />
                <span className="sr-only">List view</span>
              </button>
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'modified' | 'name' | 'responses')}
              aria-label="Sort forms by"
              className="min-w-0 flex-1 sm:flex-none px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-colors duration-200 cursor-pointer"
            >
              <option value="modified">Last Modified</option>
              <option value="name">Name A-Z</option>
              <option value="responses">Most Responses</option>
            </select>
            {packOptions.length > 0 && (
              <select
                value={packFilter}
                onChange={(e) => setPackFilter(e.target.value)}
                aria-label="Filter forms by pack"
                className="min-w-0 flex-1 sm:flex-none px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-colors duration-200 cursor-pointer"
              >
                <option value="all">All packs</option>
                {packOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                <option value="none">Not from a pack</option>
              </select>
            )}
          </div>
        </div>

        {/* GLOBAL search results — the whole workspace, grouped standalone-first then per app. */}
        {searchActive ? (
          <div>
            {storageMode === 'api' && filteredApps.length > 0 && (
              <div className="mb-6">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-2.5 flex items-center gap-2">
                  Apps
                  <span className="font-medium tabular-nums text-gray-300 dark:text-slate-600">{filteredApps.length}</span>
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {filteredApps.slice(0, appLimit).map(renderAppTile)}
                </div>
                <ShowMore shown={Math.min(appLimit, filteredApps.length)} total={filteredApps.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" className="mt-3" />
              </div>
            )}
            {globalFormCount === 0 && (storageMode !== 'api' || filteredApps.length === 0) ? (
              <EmptyState
                icon={Search}
                title={`No matches for "${searchQuery.trim()}"`}
                description="Search covers every app and form you own — try a different term, or clear the search."
                className={EMPTY_SHELL_CLASS}
                action={
                  <Button variant="outline" onClick={() => { setSearchQuery(''); setPackFilter('all'); }}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              globalFormGroups.map((group) => (
                <div key={group.key} className="mb-6">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-2.5 flex items-center gap-1.5">
                    {group.label ? (
                      <>
                        <Boxes className="h-3.5 w-3.5" />
                        <span className="normal-case tracking-normal">{group.label}</span>
                      </>
                    ) : (
                      'Standalone forms'
                    )}
                    <span className="font-medium tabular-nums text-gray-300 dark:text-slate-600">{group.forms.length}</span>
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
                    {renderFormsView(group.forms)}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <>
        {/* Apps grouping (top level only). While apps load, skeleton space is reserved only when
            the cached hint says this user had apps — zero-apps users never see a skeleton vanish. */}
        {!selectedAppId && storageMode === 'api' && ((appsLoading && hadAppsHint) || appGroups.length > 0) && (
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-2.5 flex items-center gap-2">
              Apps
              {appsLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400 dark:text-slate-500" />
                : <span className="font-medium tabular-nums text-gray-300 dark:text-slate-600">{filteredApps.length}</span>}
            </h2>
            {appsLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" aria-busy="true">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 motion-safe:animate-pulse">
                    <div className="h-9 w-9 rounded-lg bg-gray-200 dark:bg-slate-700 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-2/3 rounded bg-gray-200 dark:bg-slate-700" />
                      <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-slate-700" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredApps.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-slate-400">No apps match your search.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {filteredApps.slice(0, appLimit).map(renderAppTile)}
                </div>
                <ShowMore shown={Math.min(appLimit, filteredApps.length)} total={filteredApps.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" className="mt-3" />
              </>
            )}
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mt-6 mb-2.5">Standalone forms</h2>
          </div>
        )}

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(tab) => { setActiveTab(tab); setFormLimit(FORMS_PAGE); }}>
          <TabsList className="mb-4 sm:mb-6 overflow-x-auto flex-nowrap">
            <TabsTrigger value="all" className="inline-flex items-center">All<TabCount n={filteredForms.length} /></TabsTrigger>
            <TabsTrigger value="published" className="inline-flex items-center">Published<TabCount n={publishedForms.length} /></TabsTrigger>
            <TabsTrigger value="draft" className="inline-flex items-center">Drafts<TabCount n={draftForms.length} /></TabsTrigger>
            <TabsTrigger value="archived" className="inline-flex items-center">Archived<TabCount n={archivedForms.length} /></TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4" aria-busy={gridLoading && filteredForms.length === 0}>
              {gridLoading && filteredForms.length === 0 && !filtersActive ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : filteredForms.length === 0 ? (
                <div className="col-span-full">
                  {filtersActive ? (
                    clearFiltersEmptyState
                  ) : (
                    <EmptyState
                      icon={Inbox}
                      title="No forms yet"
                      description="Create your first form from scratch, or start faster with a ready-made pack."
                      className={EMPTY_SHELL_CLASS}
                      action={
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          <Button onClick={openNewForm} leftIcon={<Plus className="h-4 w-4" />}>
                            Create Form
                          </Button>
                          <Button variant="outline" onClick={() => setShowPackImport(true)} leftIcon={<Package className="h-4 w-4" />}>
                            Browse packs
                          </Button>
                        </div>
                      }
                    />
                  )}
                </div>
              ) : (
                renderFormsView(filteredForms.slice(0, formLimit))
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, filteredForms.length)} total={filteredForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>

          <TabsContent value="published">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
              {gridLoading && publishedForms.length === 0 && !filtersActive ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : publishedForms.length === 0 ? (
                <div className="col-span-full">
                  {filtersActive ? clearFiltersEmptyState : (
                    <EmptyState
                      icon={Globe}
                      title="No published forms"
                      description="Publish a form to make it available to respondents"
                      className={EMPTY_SHELL_CLASS}
                    />
                  )}
                </div>
              ) : (
                renderFormsView(publishedForms.slice(0, formLimit))
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, publishedForms.length)} total={publishedForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>

          <TabsContent value="draft">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
              {gridLoading && draftForms.length === 0 && !filtersActive ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : draftForms.length === 0 ? (
                <div className="col-span-full">
                  {filtersActive ? clearFiltersEmptyState : (
                    <EmptyState
                      icon={FileText}
                      title="No drafts"
                      description="Draft forms will appear here while you work on them"
                      className={EMPTY_SHELL_CLASS}
                    />
                  )}
                </div>
              ) : (
                renderFormsView(draftForms.slice(0, formLimit))
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, draftForms.length)} total={draftForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>

          <TabsContent value="archived">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
              {gridLoading && archivedForms.length === 0 && !filtersActive ? (
                Array.from({ length: 6 }).map((_, i) => <FormCardSkeleton key={i} />)
              ) : archivedForms.length === 0 ? (
                <div className="col-span-full">
                  {filtersActive ? clearFiltersEmptyState : (
                    <EmptyState
                      icon={Archive}
                      title="No archived forms"
                      description="Archived forms will appear here"
                      className={EMPTY_SHELL_CLASS}
                    />
                  )}
                </div>
              ) : (
                renderFormsView(archivedForms.slice(0, formLimit))
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, archivedForms.length)} total={archivedForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>
        </Tabs>
          </>
        )}
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
        title="Delete Form"
        message={storageMode === 'api' && !api.isDemoMode()
          ? `Delete "${deleteTarget?.title || 'this form'}"? It will move to the recycle bin, where you can restore it (responses included) for 30 days.`
          : `Are you sure you want to delete "${deleteTarget?.title || 'this form'}"? This action cannot be undone and all responses will be lost.`}
        confirmLabel="Delete"
        variant="danger"
      />

      {/* Preview chooser — shown when a form is published in 2+ apps */}
      {previewChooser}

      {newFormPicker}
    </div>
  );
}
