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
  Loader2,
  ExternalLink,
  Settings,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { EmptyState } from '../components/ui/EmptyState';
import { FormCardSkeleton } from '../components/ui/Skeleton';
import { ShowMore } from '../components/ui/ShowMore';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { toast } from '../stores/toastStore';
import { formatRelativeTime, parseServerDate } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { PackImportModal } from '../components/builder/PackImportModal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { api } from '../lib/api';
import type { PackInstallation } from '../lib/api';
import type { Form } from '../types/form';

// Incremental pagination page sizes for the card grids.
const FORMS_PAGE = 12;
const APPS_PAGE = 8;

// An app as grouped on this page: identity (icon/logo/accent) + which forms belong to it.
type AppGroup = {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  logoUrl: string | null;
  icon: string | null;
  accent: string | null;
  formIds: string[];
};

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
  onDuplicate: (id: string) => void;
  onEmbed: (id: string, title: string) => void;
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
      className="cursor-pointer hover:shadow-md hover:shadow-gray-900/[0.04] dark:hover:shadow-black/20 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
    >
      <CardContent>
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="p-2.5 bg-primary-50 dark:bg-primary-500/10 rounded-lg flex-shrink-0">
              <DynamicIcon name={form.icon} className="h-5 w-5 text-primary-600 dark:text-primary-500" />
            </div>
            <div className="min-w-0">
              <h3 className="font-medium text-gray-900 dark:text-slate-100 truncate" title={form.title || 'Untitled Form'}>{form.title || 'Untitled Form'}</h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-slate-500">
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
          </div>
          <div className="relative">
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
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
                    onClick={() => { onNavigate(`/preview/${form.id}`); onMenuClose(); }}
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
                    onClick={() => { onEmbed(form.id, form.title); onMenuClose(); }}
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

        <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
          <span className="text-slate-500 truncate">
            {formatRelativeTime(form.updatedAt)}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Status as its own badge; the count is neutral text so color no longer
                stands in for lifecycle status. */}
            <Badge
              variant={form.status === 'published' ? 'success' : form.status === 'draft' ? 'warning' : 'default'}
              size="sm"
              className="capitalize"
            >
              {form.status}
            </Badge>
            <span className="text-slate-500">{`${responseCount} response${responseCount === 1 ? '' : 's'}`}</span>
          </div>
        </div>

        <div className="flex gap-2 mt-3 sm:mt-4">
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
            onClick={(e) => { e.stopPropagation(); onNavigate(`/preview/${form.id}`); }}
          >
            Preview
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});

export function FormsList() {
  useDocumentTitle('My Forms');
  const navigate = useNavigate();
  const { forms, setActiveForm, deleteForm, duplicateForm, updateForm } = useFormStore();
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
  const [activeMenu, setActiveMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [embedModalForm, setEmbedModalForm] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showPackImport, setShowPackImport] = useState(false);
  const [packFilter, setPackFilter] = useState<string>('all');
  const [installedPacks, setInstalledPacks] = useState<PackInstallation[]>([]);
  // App grouping: which forms belong to which app, and the current drill-in.
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appGroups, setAppGroups] = useState<AppGroup[]>([]);
  // Apps load async — track it so the section reserves space (skeleton) instead of popping in.
  const [appsLoading, setAppsLoading] = useState(() => useFormStore.getState().storageMode === 'api');
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

  // Fetch installed packs on mount
  useEffect(() => {
    api.getInstalledPacks().then((result) => {
      if (!result.error && result.data) {
        setInstalledPacks(result.data.installations);
      }
    });
  }, []);

  // Load apps + their form memberships so My Forms can group forms by app (cloud mode only).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (storageMode !== 'api') { if (!cancelled) { setAppGroups([]); setAppsLoading(false); } return; }
      if (!cancelled) setAppsLoading(true);
      try {
        const res = await api.getApps();
        const apps = (res.data?.apps || []) as Array<{
          id: string;
          name: string;
          slug?: string | null;
          description?: string | null;
          logoUrl?: string | null;
          settings?: { icon?: string | null } | null;
          theme?: { primaryColor?: string | null } | null;
        }>;
        const groups: AppGroup[] = await Promise.all(apps.map(async (a) => {
          const fr = await api.getAppForms(a.id);
          const formIds = ((fr.data?.forms || []) as Array<{ formId: string }>).map((f) => f.formId);
          return {
            id: a.id,
            name: a.name,
            slug: a.slug ?? null,
            description: a.description ?? null,
            logoUrl: a.logoUrl ?? null,
            icon: a.settings?.icon ?? null,
            accent: a.theme?.primaryColor ?? null,
            formIds,
          };
        }));
        if (!cancelled) setAppGroups(groups);
        // Refresh the layout hints for the next visit (skip on fetch errors so a
        // transient failure doesn't wrongly clear them).
        if (!res.error) {
          try {
            localStorage.setItem('fl-had-apps', groups.length > 0 ? '1' : '0');
            localStorage.setItem('fl-app-form-ids', JSON.stringify(groups.flatMap((g) => g.formIds)));
          } catch { /* storage unavailable — hints are optional */ }
        }
      } finally {
        if (!cancelled) setAppsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [storageMode]);

  // formId → its app (for grouping standalone vs in-app forms).
  const formToApp = useMemo(() => {
    const map: Record<string, { id: string; name: string }> = {};
    for (const g of appGroups) for (const fid of g.formIds) map[fid] = { id: g.id, name: g.name };
    return map;
  }, [appGroups]);

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
        setActiveForm(newForm.id);
        navigate(`/builder/${newForm.id}`);
      }
    } catch (error) {
      logger.error('Failed to duplicate form:', error);
      toast.error('Failed to duplicate form', 'Please try again');
    }
    setActiveMenu(null);
  }, [duplicateForm, setActiveForm, navigate]);

  const handleMenuToggle = useCallback((id: string, rect: DOMRect) => {
    setActiveMenu({ id, rect });
  }, []);

  const handleMenuClose = useCallback(() => {
    setActiveMenu(null);
  }, []);

  const handleEmbed = useCallback((id: string, title: string) => {
    setEmbedModalForm({ id, title });
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

  // The same search box also filters the apps rail (name or description).
  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return appGroups;
    return appGroups.filter((g) =>
      g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q)
    );
  }, [appGroups, searchQuery]);

  const filteredForms = useMemo(() =>
    viewForms
      .filter((form) => {
        const q = searchQuery.trim().toLowerCase();
        if (q && !form.title.toLowerCase().includes(q) && !(form.description ?? '').toLowerCase().includes(q)) {
          return false;
        }
        if (packFilter === 'all') return true;
        if (packFilter === 'none') return !formPackIdMap[form.id];
        return formPackIdMap[form.id] === packFilter;
      })
      .sort((a, b) => {
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
      }),
    [viewForms, searchQuery, sortBy, getResponsesByFormId, packFilter, formPackIdMap, storageMode]
  );

  const draftForms = useMemo(() => filteredForms.filter((f) => f.status === 'draft'), [filteredForms]);
  const publishedForms = useMemo(() => filteredForms.filter((f) => f.status === 'published'), [filteredForms]);
  const archivedForms = useMemo(() => filteredForms.filter((f) => f.status === 'archived'), [filteredForms]);

  // Shared across all tabs: when a search or pack filter is active, an empty tab offers
  // to clear the filters instead of claiming there are no forms of that status.
  const filtersActive = searchQuery.trim() !== '' || packFilter !== 'all';
  const clearFiltersEmptyState = (
    <EmptyState
      icon={Search}
      title="No forms match your filters"
      description="Try a different search term, or clear the filters to see all your forms."
      action={
        <Button variant="outline" onClick={() => { setSearchQuery(''); setPackFilter('all'); }}>
          Clear filters
        </Button>
      }
    />
  );

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
      onDuplicate={handleDuplicate}
      onEmbed={handleEmbed}
      onDelete={handleDelete}
      onStatusChange={handleStatusChange}
    />
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

        {/* Apps grouping (top level only). While apps load, skeleton space is reserved only when
            the cached hint says this user had apps — zero-apps users never see a skeleton vanish. */}
        {!selectedAppId && storageMode === 'api' && ((appsLoading && hadAppsHint) || appGroups.length > 0) && (
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-2.5 flex items-center gap-2">
              Apps {appsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400 dark:text-slate-500" />}
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
                  {filteredApps.slice(0, appLimit).map((g) => (
                    <button
                      key={g.id}
                      onClick={() => { setSelectedAppId(g.id); setSearchQuery(''); }}
                      className="flex items-center gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer"
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
                        {appPackMap[g.id] && (
                          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-gray-400 dark:text-slate-500" title={`From the ${appPackMap[g.id]} pack`}>
                            <Package className="h-3 w-3 shrink-0" />
                            <span className="truncate">{appPackMap[g.id]}</span>
                          </span>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 shrink-0" />
                    </button>
                  ))}
                </div>
                <ShowMore shown={Math.min(appLimit, filteredApps.length)} total={filteredApps.length} onShowMore={() => setAppLimit((n) => n + APPS_PAGE)} noun="apps" className="mt-3" />
              </>
            )}
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mt-6 mb-2.5">Standalone forms</h2>
          </div>
        )}

        {/* Search, sort and pack filter */}
        <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row gap-3">
          <Input
            placeholder={!selectedAppId && appGroups.length > 0 ? 'Search forms and apps...' : 'Search forms...'}
            aria-label="Search forms and apps"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" />}
            className="w-full sm:max-w-md"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'modified' | 'name' | 'responses')}
            aria-label="Sort forms by"
            className="px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-all duration-200 cursor-pointer w-full sm:w-auto"
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
              className="px-3.5 py-2.5 bg-white dark:bg-slate-900/60 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 transition-all duration-200 cursor-pointer w-full sm:w-auto"
            >
              <option value="all">All packs</option>
              {packOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value="none">Not from a pack</option>
            </select>
          )}
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(tab) => { setActiveTab(tab); setFormLimit(FORMS_PAGE); }}>
          <TabsList className="mb-4 sm:mb-6 overflow-x-auto flex-nowrap">
            <TabsTrigger value="all">All ({filteredForms.length})</TabsTrigger>
            <TabsTrigger value="published">Published ({publishedForms.length})</TabsTrigger>
            <TabsTrigger value="draft">Drafts ({draftForms.length})</TabsTrigger>
            <TabsTrigger value="archived">Archived ({archivedForms.length})</TabsTrigger>
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
                      description="Create your first form to get started"
                      action={
                        <Button onClick={openNewForm} leftIcon={<Plus className="h-4 w-4" />}>
                          Create Form
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : (
                filteredForms.slice(0, formLimit).map(renderFormCard)
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
                    />
                  )}
                </div>
              ) : (
                publishedForms.slice(0, formLimit).map(renderFormCard)
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
                    />
                  )}
                </div>
              ) : (
                draftForms.slice(0, formLimit).map(renderFormCard)
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
                    />
                  )}
                </div>
              ) : (
                archivedForms.slice(0, formLimit).map(renderFormCard)
              )}
            </div>
            <ShowMore shown={Math.min(formLimit, archivedForms.length)} total={archivedForms.length} onShowMore={() => setFormLimit((n) => n + FORMS_PAGE)} noun="forms" />
          </TabsContent>
        </Tabs>
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
        message={`Are you sure you want to delete "${deleteTarget?.title || 'this form'}"? This action cannot be undone and all responses will be lost.`}
        confirmLabel="Delete"
        variant="danger"
      />

      {newFormPicker}
    </div>
  );
}
