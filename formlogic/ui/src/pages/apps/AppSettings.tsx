import { useState, useEffect, type CSSProperties } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { forwardReturnTo, useReturnTo, type ReturnToState } from '../../hooks/useReturnTo';
import { ArrowLeft, Save, Check, ChevronRight, ExternalLink, Settings, Palette, LayoutGrid, Users, Shield, Rocket, Link2, MonitorPlay, Plug, Download, Trash2, Layers, Table, PencilRuler } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ConnectAiModal } from '../../components/mcp/ConnectAiModal';
import { Switch } from '../../components/ui/Switch';
import { TimezoneSelect } from '../../components/ui/TimezoneSelect';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import { IconPicker } from '../../components/ui/IconPicker';
import { DynamicIcon } from '../../components/ui/DynamicIcon';
import { cn, generateId } from '../../lib/utils';
import { hexContrast, contrastLevel, readableForegroundColor } from '../../lib/color';
import { useAdminActing, useResourcePaths } from '../../components/admin/AdminActingContext';
import type { App, AppRole, AppForm, AppKind, AppNavItem } from '../../types/app';
import { DEFAULT_APP_THEME, KIND_LABELS } from '../../types/app';

const tabs = [
  { label: 'General', value: 'general', icon: Settings },
  { label: 'Theme', value: 'theme', icon: Palette },
  { label: 'Menu', value: 'menu', icon: Link2 },
  { label: 'Manage', value: 'manage', icon: LayoutGrid },
];

const TAB_VALUES = tabs.map((t) => t.value);

/**
 * The `settings` keys this page has controls for. Save sends only the ones whose value
 * actually CHANGED here, merged onto a fresh read — so a key another surface owns
 * (landingPage from the Studio's Screens section, the sign-up keys from its Access
 * section, the PWA keys from Deploy) is never in the payload unless this page edited it.
 *
 * The previous version replayed every key in this list on every save, which reverted
 * exactly the keys the comment claimed were safe.
 */
const EDITED_SETTING_KEYS = [
  'icon',
  'appKind',
  'allowSelfRegistration',
  'requireApproval',
  'defaultRoleId',
  'landingPage',
  'timezone',
  'hideNav',
  'services',
] as const;

// The accent hex lands in an inline CSS custom property, so keep the format strict.
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

export function AppSettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Platform-admin acting mode (managing another user's app): links stay inside
  // /admin/..., and data-showing/identity-bound actions are hidden or disabled.
  const acting = useAdminActing();
  const paths = useResourcePaths();
  // Origin-relative Back: opened from the App Studio this returns to its step.
  const backTo = useReturnTo(paths.appsHome());
  const [searchParams, setSearchParams] = useSearchParams();
  const { updateApp, deleteApp, fetchApps, fetchRoles, fetchAppForms } = useAppStore();
  const [app, setApp] = useState<App | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  // Snapshot of the persisted state; anything diverging from it is unsaved.
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const [pendingNav, setPendingNav] = useState<{ to: string; state: ReturnToState | undefined } | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Active tab lives in ?tab= so refresh and Back (e.g. from the Manage sub-pages)
  // return to the same section. `replace` keeps tab flips out of the history stack.
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam && TAB_VALUES.includes(tabParam) ? tabParam : 'general';
  const setActiveTab = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === 'general') next.delete('tab'); else next.set('tab', value);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    fetchApps().then(() => {
      if (appId) {
        const found = useAppStore.getState().getApp(appId);
        if (found) {
          const appData = found as App;
          // Ensure theme has defaults to prevent undefined spread
          const merged = { ...appData, theme: { ...DEFAULT_APP_THEME, ...appData.theme } };
          setApp(merged);
          setInitialSnapshot(JSON.stringify(merged));
        }
      }
    }).finally(() => setLoaded(true));
  }, [appId, fetchApps]);

  const dirty = !!app && JSON.stringify(app) !== initialSnapshot;

  // Warn on tab close / refresh while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Every sub-page opened from here carries this page AND the origin this page was
  // opened from, so two Backs in a row return to the App Studio instead of /apps.
  const childState = forwardReturnTo(`${location.pathname}${location.search}`, 'App settings', backTo);

  // Navigate, but confirm first if there are unsaved edits. Sub-pages get childState;
  // going Back hands over the origin THIS page was opened from.
  const navGuarded = (to: string, state: ReturnToState | undefined = childState) => {
    if (dirty) setPendingNav({ to, state }); else navigate(to, { state });
  };

  // Roles + forms power the membership defaults (default role, landing page).
  useEffect(() => {
    if (!appId) return;
    fetchRoles(appId).then(setRoles).catch(() => {});
    fetchAppForms(appId).then(setAppForms).catch(() => {});
  }, [appId, fetchRoles, fetchAppForms]);

  const updateSetting = (key: string, value: unknown) =>
    setApp((prev) => (prev ? { ...prev, settings: { ...prev.settings, [key]: value } } : prev));

  if (!app) {
    if (!loaded) {
      return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading app settings" /></div>;
    }
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <p className="text-lg font-medium text-gray-700 dark:text-slate-300">App not found</p>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">It may have been deleted, or you don’t have access.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate(paths.appsHome())}>Back to apps</Button>
      </div>
    );
  }

  const handleSave = async () => {
    if (!appId) return;
    if (app.name.trim().length < 2) {
      setNameError('Name must be at least 2 characters');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(app.slug)) {
      setSlugError('Use lowercase letters, digits, and hyphens (start with a letter or digit).');
      return;
    }
    setNameError(null);
    setSlugError(null);
    setSaving(true);
    setSaveSuccess(false);

    // Send ONLY WHAT CHANGED ON THIS PAGE, diffed against the snapshot this page
    // loaded, merged onto a fresh read.
    //
    // The server writes each present key wholesale with no merge, so anything this
    // page sends and did not itself change reverts whatever another surface saved in
    // the meantime. Replaying a fixed key list was not enough: the list included
    // `landingPage` (owned by the Studio's Screens section) and the three sign-up keys
    // (owned by its Access section), so saving a rename here silently reverted a
    // landing screen or a sign-up policy changed minutes earlier — and `status` was
    // replayed from the mount snapshot, which could un-publish an app published since.
    //
    // A diff has the property the key list was reaching for: a value this page did not
    // touch is never in the payload at all.
    await fetchApps();
    const server = useAppStore.getState().getApp(appId);
    const before = initialSnapshot ? (JSON.parse(initialSnapshot) as App) : null;
    const payload: Record<string, unknown> = {};
    // `customScreen` is deliberately absent: the server re-stamps
    // custom_screen_trust = 'owner' whenever that key is present, and this page has no
    // screen editor — sending it promoted unreviewed pack screens to full bridge access.
    const TOP_LEVEL = ['name', 'slug', 'description', 'logoUrl', 'status', 'theme', 'navConfig'] as const;
    const current = app as unknown as Record<string, unknown>;
    const mounted = (before ?? {}) as unknown as Record<string, unknown>;
    for (const key of TOP_LEVEL) {
      if (!before || JSON.stringify(current[key]) !== JSON.stringify(mounted[key])) payload[key] = current[key];
    }
    // Settings: merge the CHANGED keys onto the server's current map, so keys other
    // surfaces own survive untouched.
    const edited = app.settings as unknown as Record<string, unknown> | undefined;
    const mountedSettings = (before?.settings ?? {}) as unknown as Record<string, unknown>;
    const changedSettingKeys = EDITED_SETTING_KEYS.filter(
      (key) => !before || JSON.stringify(edited?.[key]) !== JSON.stringify(mountedSettings[key])
    );
    if (changedSettingKeys.length > 0) {
      const merged = { ...(server?.settings ?? {}) } as unknown as Record<string, unknown>;
      for (const key of changedSettingKeys) merged[key] = edited?.[key];
      payload.settings = merged;
    }
    if (Object.keys(payload).length === 0) {
      setSaving(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      return;
    }
    const ok = await updateApp(appId, payload);
    setSaving(false);
    // Only show the success state when the update actually persisted; updateApp
    // already surfaces an error toast on failure.
    if (ok) {
      setInitialSnapshot(JSON.stringify(app)); // edits are now persisted
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  // Same flow as the Apps dashboard: the store deletes + toasts on failure. Only
  // leave the page when the app is actually gone from the store.
  const handleDeleteConfirmed = async () => {
    if (!appId || deleting) return;
    setDeleting(true);
    try {
      await deleteApp(appId);
      if (!useAppStore.getState().getApp(appId)) {
        setShowDelete(false);
        navigate(paths.appsHome());
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = async () => {
    if (!appId || exporting) return;
    // Export comes from the server (the saved version) — warn if there are unsaved edits.
    if (dirty && !window.confirm('You have unsaved changes. Export the last saved version? Click Cancel to go back and Save first.')) return;
    setExporting(true);
    try {
      const r = await api.exportApp(appId);
      if (r.error || !r.data?.pack) {
        toast.error('Export failed', r.error || 'Could not export this app.');
        return;
      }
      const blob = new Blob([JSON.stringify(r.data.pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${app.slug || 'app'}.formlogic.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('App exported', 'Downloaded a self-contained .json bundle.');
    } catch {
      toast.error('Export failed', 'Could not export this app.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="App settings"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navGuarded(backTo.path, backTo.state)}
              leftIcon={<ArrowLeft className="h-4 w-4" />}
              aria-label={backTo.label ? `Back to ${backTo.label}` : 'Back'}
              title={backTo.label ? `Back to ${backTo.label}` : 'Back'}
            >
              <span className="hidden sm:inline">{backTo.label ? `Back to ${backTo.label}` : 'Back'}</span>
            </Button>
            {/* Save stays mounted on every tab. Hiding it on Manage made edits made on
                Theme look already-committed, and clicking any Manage tile then asked to
                "discard unsaved changes" the user believed were saved. Disabled-when-clean
                is a self-explaining control; a vanishing one is not. */}
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty} leftIcon={saveSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}>
              {saving ? 'Saving...' : saveSuccess ? 'Saved!' : dirty ? 'Save' : 'Saved'}
            </Button>
          </>
        }
      />
      <div className="@container/appsettings w-full flex-1 p-4 @xl/appsettings:p-6 @3xl/appsettings:p-8">
      <div className="max-w-4xl mx-auto">

      {/* Identity + quick actions: opening the running app and jumping to Deploy are the two
          things owners do most from here — surface them above the settings tabs instead of
          burying them in the Manage grid. */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900/50">
        {app.logoUrl ? (
          <img src={app.logoUrl} alt="" className="h-11 w-11 flex-none rounded-xl object-cover ring-1 ring-black/5 dark:ring-white/10" />
        ) : (
          <div
            className="flex h-11 w-11 flex-none items-center justify-center rounded-xl"
            style={(() => {
              const accent = isHexColor(app.theme?.primaryColor) ? app.theme.primaryColor : '#6366f1';
              return { background: accent, color: readableForegroundColor(accent) };
            })()}
          >
            <DynamicIcon name={app.settings?.icon} className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{app.name}</p>
            <span
              className={cn(
                'flex-none rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide',
                app.status === 'published'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : 'border-gray-200 bg-gray-100 text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
              )}
            >
              {app.status}
            </span>
          </div>
          <p className="truncate font-mono text-xs text-gray-400 dark:text-slate-500">/app/{app.slug}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-none">
          {!acting && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<PencilRuler className="h-4 w-4" />}
              onClick={() => navGuarded(paths.appSub(`${appId}`, 'studio'))}
              className="flex-1 sm:flex-none"
            >
              App Studio
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Rocket className="h-4 w-4" />}
            onClick={() => navGuarded(paths.appSub(`${appId}`, 'deploy'))}
            className="flex-1 sm:flex-none"
          >
            Deploy
          </Button>
          <Button
            size="sm"
            leftIcon={<ExternalLink className="h-4 w-4" />}
            disabled={app.status !== 'published' || !!acting}
            title={acting
              ? 'The live app shows record data, which is not visible to platform admins'
              : app.status === 'published' ? 'Open the app in a new tab' : 'Publish the app (Deploy) to open it'}
            onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener')}
            className="flex-1 sm:flex-none"
          >
            Open app
          </Button>
        </div>
      </div>

      {/* Tab navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="underline" aria-label="App settings sections" className="mb-6 w-full">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                variant="underline"
                className="w-1/4 justify-center px-0.5 text-xs sm:w-auto sm:px-4 sm:text-sm"
              >
                <span className="flex items-center gap-1 sm:gap-2"><Icon className="h-4 w-4" />{tab.label}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
          <TabsContent value="general">
          <div className="space-y-4">
            <div>
              <label htmlFor="app-name" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">App name</label>
              <input id="app-name" type="text" value={app.name}
                onChange={(e) => { setApp({ ...app, name: e.target.value }); if (nameError) setNameError(null); }}
                onBlur={(e) => setNameError(e.target.value.trim().length < 2 ? 'Name must be at least 2 characters' : null)}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'app-name-error' : undefined}
                className={cn('w-full px-3.5 py-2.5 border rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200', nameError ? 'border-red-400 dark:border-red-500/60' : 'border-gray-300 dark:border-slate-600')} />
              {nameError && <p id="app-name-error" className="mt-1 text-sm text-red-600 dark:text-red-400">{nameError}</p>}
            </div>
            <div>
              <label htmlFor="app-slug" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Public URL slug</label>
              <input
                id="app-slug"
                type="text"
                value={app.slug}
                onChange={(e) => {
                  // Normalize as you type: lowercase, non-alphanumerics → hyphens, collapse repeats.
                  const s = e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 61);
                  setApp({ ...app, slug: s });
                  if (slugError) setSlugError(null);
                }}
                onBlur={(e) => {
                  const s = e.target.value.replace(/^-+|-+$/g, '');
                  if (s !== app.slug) setApp({ ...app, slug: s });
                  setSlugError(s && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(s) ? 'Use lowercase letters, digits, and hyphens.' : null);
                }}
                aria-invalid={slugError ? true : undefined}
                aria-describedby={slugError ? 'app-slug-error' : undefined}
                className={cn('w-full px-3.5 py-2.5 border rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200', slugError ? 'border-red-400 dark:border-red-500/60' : 'border-gray-300 dark:border-slate-600')}
              />
              {slugError
                ? <p id="app-slug-error" className="mt-1 text-sm text-red-600 dark:text-red-400">{slugError}</p>
                : <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Your app is served at <span className="font-mono">/app/{app.slug || '…'}</span>. Must be unique — changing it breaks old links.</p>}
            </div>
            <div>
              <label htmlFor="app-description" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Description</label>
              <textarea id="app-description" value={app.description || ''} onChange={(e) => setApp({ ...app, description: e.target.value })}
                rows={3} className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200 resize-none" />
            </div>
            <div>
              <label htmlFor="app-status" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Status</label>
              {/* "Published" is deliberately NOT offered here: going live has to run the
                  readiness checks and record a version, which only the App Studio's
                  Review & publish does. A raw flip left the app live with no version and
                  no history, and disabled the Studio's own Publish button. */}
              <select id="app-status" value={app.status} onChange={(e) => setApp({ ...app, status: e.target.value as App['status'] })}
                className="px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
                {/* Acting admins have no Studio route, so they keep the raw option. */}
                {(acting || app.status === 'published') && <option value="published">Published</option>}
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                Archived: hidden from members; data kept.{' '}
                {!acting && app.status !== 'published' && (
                  <button
                    type="button"
                    onClick={() => navGuarded(paths.appSub(`${appId}`, 'studio/publish'))}
                    className="cursor-pointer font-semibold text-primary-600 hover:underline dark:text-primary-400"
                  >
                    Publish in the App Studio
                  </button>
                )}
              </p>
            </div>
            <div>
              <label htmlFor="app-logo" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Logo URL</label>
              <input id="app-logo" type="text" value={app.logoUrl || ''} onChange={(e) => setApp({ ...app, logoUrl: e.target.value })}
                placeholder="https://example.com/logo.png"
                className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
            </div>
            <div>
              <span className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">App icon</span>
              <div className="flex items-center gap-3">
                {/* Live preview: the icon on a tile tinted with the app's accent color. */}
                {(() => {
                  const accent = app.theme?.primaryColor;
                  const accented = isHexColor(accent);
                  return (
                    <div
                      style={accented ? ({ '--fl-a': accent } as CSSProperties) : undefined}
                      className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
                        accented
                          ? 'bg-[color-mix(in_srgb,var(--fl-a)_11%,transparent)] text-[color:var(--fl-a)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--fl-a)_25%,transparent)] dark:bg-[color-mix(in_srgb,var(--fl-a)_16%,transparent)] dark:text-[color:color-mix(in_srgb,var(--fl-a)_62%,white)]'
                          : 'bg-primary-100 dark:bg-primary-500/20 text-primary-600 dark:text-primary-400'
                      )}
                      aria-hidden="true"
                    >
                      <DynamicIcon
                        name={app.settings?.icon}
                        className="h-5 w-5"
                        fallback={<span className="text-sm font-semibold">{(app.name.trim()[0] || '?').toUpperCase()}</span>}
                      />
                    </div>
                  );
                })()}
                <IconPicker value={app.settings?.icon} onChange={(name) => updateSetting('icon', name ?? undefined)} />
                <p className="text-xs text-gray-400 dark:text-slate-500 min-w-0">Shown on the app card and tiles when there's no logo.</p>
              </div>
            </div>
            <div>
              <label htmlFor="app-kind" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">App type</label>
              <select
                id="app-kind"
                value={(app.settings?.appKind as string) || ''}
                onChange={(e) => updateSetting('appKind', e.target.value || undefined)}
                className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              >
                <option value="">Not set</option>
                {(Object.keys(KIND_LABELS) as AppKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Used for dashboard templates and labels — apps of any type can share the same forms.</p>
            </div>

            {/* Membership */}
            <div className="pt-2 border-t border-gray-100 dark:border-slate-800 space-y-4">
              <h3 className="text-sm font-medium text-gray-900 dark:text-white">Membership</h3>
              <Switch
                checked={app.settings?.allowSelfRegistration === true}
                onChange={(checked) => updateSetting('allowSelfRegistration', checked)}
                label="Allow self-registration"
                description="Let any signed-in user join this app from its link"
              />
              {app.settings?.allowSelfRegistration && (
                <>
                  <Switch
                    checked={app.settings?.requireApproval === true}
                    onChange={(checked) => updateSetting('requireApproval', checked)}
                    label="Require approval"
                    description="New members start as 'pending' until an admin approves them"
                  />
                  <div>
                    <label htmlFor="app-default-role" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Default role for new members</label>
                    <select
                      id="app-default-role"
                      value={(app.settings?.defaultRoleId as string) || ''}
                      onChange={(e) => updateSetting('defaultRoleId', e.target.value || undefined)}
                      className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    >
                      <option value="">Lowest-privilege role (automatic)</option>
                      {roles.filter((r) => !(r.isSystem && r.name === 'Owner')).map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div>
                <label htmlFor="app-landing-page" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Landing page</label>
                {/* The Studio stores the default as the token 'dashboard'; an empty-string
                    option meant a landing page chosen there rendered this select blank. */}
                <select
                  id="app-landing-page"
                  value={(app.settings?.landingPage as string) || 'dashboard'}
                  onChange={(e) => updateSetting('landingPage', e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                >
                  <option value="dashboard">Dashboard (default)</option>
                  {appForms.map((f) => (
                    <option key={f.formId} value={f.formId}>{f.displayName}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Where members land when they open the app.</p>
              </div>
              <div>
                <label htmlFor="app-timezone" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Timezone</label>
                <TimezoneSelect
                  id="app-timezone"
                  value={(app.settings?.timezone as string) || ''}
                  onChange={(tz) => updateSetting('timezone', tz || undefined)}
                  emptyLabel="UTC (default)"
                  className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Record times (call logs, submissions) display in this zone for members without their own timezone set. Also used for report date grouping.</p>
              </div>
            </div>

            {/* Layout */}
            <div className="pt-2 border-t border-gray-100 dark:border-slate-800 space-y-4">
              <h3 className="text-sm font-medium text-gray-900 dark:text-white">Layout</h3>
              <Switch
                checked={app.settings?.hideNav === true}
                onChange={(checked) => updateSetting('hideNav', checked)}
                label="Hide app navigation"
                description="Render the app full-screen without the sidebar and menu — for self-contained apps (e.g. a single custom home screen). Members navigate from within the screen."
              />
            </div>

            {/* Included services (pack-declared; rendered only when the app's pack shipped any).
                Each toggle gates the service's backend endpoints — e.g. turning the Companion
                relay off makes its admission endpoints refuse with `service_disabled`. */}
            {app.settings?.services && Object.keys(app.settings.services).length > 0 && (
              <div className="pt-2 border-t border-gray-100 dark:border-slate-800 space-y-4">
                <h3 className="text-sm font-medium text-gray-900 dark:text-white">Included services</h3>
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  Services this app's pack ships. Turning one off blocks its connections as soon as you save.
                </p>
                {Object.entries(app.settings.services).map(([id, svc]) => (
                  <Switch
                    key={id}
                    checked={svc?.enabled !== false}
                    onChange={(checked) =>
                      updateSetting('services', {
                        ...app.settings?.services,
                        [id]: { ...svc, enabled: checked },
                      })
                    }
                    label={svc?.title || id}
                    description={svc?.description}
                  />
                ))}
              </div>
            )}

            {/* Danger zone */}
            <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
              <h3 className="text-sm font-medium text-red-700 dark:text-red-400 mb-3">Danger zone</h3>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-red-200/80 dark:border-red-500/20 bg-red-50/50 dark:bg-red-500/5 p-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Delete this app</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Moves the app, its roles and memberships to the recycle bin for 30 days. Forms and their records stay in your workspace.</p>
                </div>
                <Button variant="danger" size="sm" className="flex-shrink-0 self-start sm:self-auto" onClick={() => setShowDelete(true)} leftIcon={<Trash2 className="h-4 w-4" />}>
                  Delete app
                </Button>
              </div>
            </div>
          </div>
          </TabsContent>

          <TabsContent value="theme">
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 @xl/appsettings:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Accent color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" aria-label="Accent color picker" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })} className="h-10 w-10 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" aria-label="Accent color hex value" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })}
                    onBlur={(e) => { if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) setApp({ ...app, theme: { ...app.theme, primaryColor: '#6366f1' } }); }}
                    className="flex-1 px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
                </div>
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Buttons, links and highlights inside the app.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Background color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" aria-label="Background color picker" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })} className="h-10 w-10 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" aria-label="Background color hex value" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })}
                    onBlur={(e) => { if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) setApp({ ...app, theme: { ...app.theme, backgroundColor: '#ffffff' } }); }}
                    className="flex-1 px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
                </div>
              </div>
            </div>
            {(() => {
              const primary = app.theme?.primaryColor || '#6366f1';
              // The accent is painted as text/links on CARDS — white in light mode,
              // slate-900 (#0f172a) in dark. The page background is NOT one of those
              // surfaces, and measuring against it certified failures: #ffd400 on a
              // #111111 page scored ~15:1 and went green, while the runtime renders it
              // on white cards at ~1.4:1 — invisible. Report the worst REAL case.
              const rLight = hexContrast(primary, '#ffffff');
              const rDark = hexContrast(primary, '#0f172a');
              if (rLight === null) return null;
              const ratio = rDark === null ? rLight : Math.min(rLight, rDark);
              const level = contrastLevel(ratio);
              const ok = level !== 'fail';
              return (
                <div
                  role="status"
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm',
                    ok
                      ? 'border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : 'border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  )}
                >
                  <Shield className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    Accent contrast (worst of light/dark): <strong className="font-semibold tabular-nums">{ratio.toFixed(1)}:1</strong>
                    {ok
                      ? ` — meets WCAG ${level === 'aa-large' ? 'AA (large text)' : level.toUpperCase()}.`
                      : ' — too low on some surfaces; accent text/links may be hard to read (especially in dark mode). Buttons stay legible (text auto-adjusts).'}
                  </span>
                </div>
              );
            })()}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Font family</label>
              <select aria-label="Font family" value={app.theme?.fontFamily || DEFAULT_APP_THEME.fontFamily} onChange={(e) => setApp({ ...app, theme: { ...app.theme, fontFamily: e.target.value } })}
                className="px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
                <option value="DM Sans">DM Sans</option>
                <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
                <option value="system-ui">System</option>
                <option value="Georgia">Georgia</option>
                <option value="monospace">Monospace</option>
              </select>
            </div>
            {/* Live preview */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Preview</label>
              <div
                className="rounded-xl border border-gray-200 dark:border-slate-700 p-5 transition-all"
                style={{ backgroundColor: app.theme?.backgroundColor || '#ffffff', fontFamily: app.theme?.fontFamily || DEFAULT_APP_THEME.fontFamily }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${app.theme?.primaryColor || '#6366f1'}20` }}>
                    <div className="w-4 h-4 rounded" style={{ backgroundColor: app.theme?.primaryColor || '#6366f1' }} />
                  </div>
                  <span className="font-semibold text-sm" style={{ color: app.theme?.primaryColor || '#6366f1' }}>{app.name}</span>
                </div>
                <div className="rounded-lg px-4 py-2 text-sm font-medium inline-block" style={{ backgroundColor: app.theme?.primaryColor || '#6366f1', color: readableForegroundColor(app.theme?.primaryColor || '#6366f1') }}>
                  Sample button
                </div>
              </div>
            </div>
          </div>
          </TabsContent>

          <TabsContent value="menu">
          <div className="space-y-6">
            {(() => {
              // Custom LINK entries live in navConfig (kind 'link'); form entries keep
              // app_forms as their single source of truth (Manage → Forms edits name/
              // order/visibility incl. Unlisted and Data-only) — no drift between the two.
              const navLinks = (app.navConfig || []).filter((n): n is AppNavItem => !!n && n.kind === 'link');
              const otherNav = (app.navConfig || []).filter((n) => !n || n.kind !== 'link');
              const setNavLinks = (links: AppNavItem[]) => setApp({ ...app, navConfig: [...otherNav, ...links] });
              const patchLink = (id: string, patch: Partial<AppNavItem>) =>
                setNavLinks(navLinks.map((l) => (l.id === id ? { ...l, ...patch } : l)));
              const looksValid = (l: AppNavItem) => {
                const url = String(l.url ?? '').trim();
                return url === '' || /^https?:\/\//i.test(url) || /^(records|reports|form\/[A-Za-z0-9_-]+)/.test(url);
              };
              return (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-gray-900 dark:text-white">Custom menu links</h3>
                    <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                      Extra links shown in the app's menu alongside your forms — external sites (open a new tab) or places
                      inside the app (<code className="font-mono">records</code>, <code className="font-mono">reports</code>,{' '}
                      <code className="font-mono">form/&lt;form-id&gt;</code>). Form entries themselves — name, order, and
                      visibility (including <em>Unlisted</em> and <em>Data-only</em>) — are managed under{' '}
                      <button type="button" className="underline cursor-pointer" onClick={() => navigate(paths.appSub(`${appId}`, 'forms'))}>Manage → Forms</button>.
                    </p>
                  </div>
                  {navLinks.length === 0 && (
                    <p className="text-sm text-gray-400 dark:text-slate-500">No custom links yet.</p>
                  )}
                  <div className="space-y-3">
                    {navLinks.map((l) => (
                      <div key={l.id || l.displayName} className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 space-y-3">
                        <div className="grid grid-cols-1 gap-3 @xl/appsettings:grid-cols-2">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Label</label>
                            <input
                              type="text"
                              value={l.displayName}
                              onChange={(e) => patchLink(l.id!, { displayName: e.target.value })}
                              placeholder="Help centre"
                              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Link</label>
                            <input
                              type="text"
                              value={l.url || ''}
                              onChange={(e) => patchLink(l.id!, { url: e.target.value })}
                              placeholder="https://example.com or records"
                              className={cn(
                                'w-full px-3 py-2 border rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent',
                                looksValid(l) ? 'border-gray-300 dark:border-slate-600' : 'border-amber-400 dark:border-amber-500'
                              )}
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Icon</label>
                            <IconPicker value={l.icon} onChange={(name) => patchLink(l.id!, { icon: name ?? undefined })} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1" title="0 puts the link at the top of the Forms group; higher numbers sit further down among the form entries.">Position</label>
                            <input
                              type="number"
                              min={0}
                              value={Number.isFinite(l.sortOrder) ? l.sortOrder : 0}
                              onChange={(e) => patchLink(l.id!, { sortOrder: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                              className="w-20 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            />
                          </div>
                          <div className="flex-1" />
                          <Switch
                            checked={l.isVisible !== false}
                            onChange={(checked) => patchLink(l.id!, { isVisible: checked })}
                            label="Shown"
                          />
                          <Button variant="ghost" size="sm" onClick={() => setNavLinks(navLinks.filter((x) => x.id !== l.id))} leftIcon={<Trash2 className="h-4 w-4" />}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setNavLinks([...navLinks, { kind: 'link', id: generateId(), displayName: '', url: '', sortOrder: navLinks.length + 99, isVisible: true }])}
                  >
                    Add link
                  </Button>
                  <p className="text-xs text-gray-400 dark:text-slate-500">
                    Only <code className="font-mono">https://</code> sites and in-app targets ever render — anything else is
                    ignored by the menu. Save with the button above.
                  </p>
                </>
              );
            })()}
          </div>
          </TabsContent>

          <TabsContent value="manage">
          <div className="space-y-7">
            <div className="flex flex-col gap-3 rounded-2xl border border-primary-200/70 bg-primary-50/60 p-4 dark:border-primary-500/20 dark:bg-primary-500/[0.07] sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">Manage {app.name}</h2>
                <p className="mt-1 text-sm leading-5 text-gray-500 dark:text-slate-400">
                  Jump directly to the app’s data, people, permissions, delivery and advanced tools.
                </p>
              </div>
              {!acting && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<PencilRuler className="h-4 w-4" />}
                  onClick={() => navGuarded(paths.appSub(`${appId}`, 'studio'))}
                  className="w-full shrink-0 sm:w-auto"
                >
                  Open App Studio
                </Button>
              )}
            </div>

            <ManageAppGroup
              title="Content & data"
              description="Work with the forms, records and relationships that power this app."
              items={[
                acting
                  ? { label: 'Record counts', desc: 'View totals per form without exposing record data', icon: Table, onClick: () => navGuarded(paths.appSub(`${appId}`, 'records')) }
                  : { label: 'Records', desc: 'Browse and export collected app data', icon: Table, onClick: () => navGuarded(paths.appSub(`${appId}`, 'records')) },
                { label: 'Forms', desc: 'Attach, remove, rename and reorder forms', icon: LayoutGrid, meta: `${appForms.length}`, onClick: () => navGuarded(paths.appSub(`${appId}`, 'forms')) },
                { label: 'Relations', desc: 'Connect records across the app’s forms', icon: Link2, onClick: () => navGuarded(paths.appSub(`${appId}`, 'relations')) },
              ]}
            />

            <ManageAppGroup
              title="People & access"
              description="Control who can use the app and what each role is allowed to do."
              items={[
                { label: 'Users', desc: 'Invite members and manage existing access', icon: Users, onClick: () => navGuarded(paths.appSub(`${appId}`, 'users')) },
                { label: 'Roles', desc: 'Configure permissions and default access', icon: Shield, meta: `${roles.length}`, onClick: () => navGuarded(paths.appSub(`${appId}`, 'roles')) },
              ]}
            />

            <ManageAppGroup
              title="Experience & delivery"
              description="Shape the frontend, create another view over the same data, and publish it."
              items={[
                { label: 'Home screen code', desc: 'Build the app home as custom HTML, CSS and TypeScript (Beta)', icon: MonitorPlay, onClick: () => navGuarded(paths.appSub(`${appId}`, 'home/edit')) },
                { label: 'Companion app', desc: 'Create another app over these same forms and records', icon: Layers, onClick: () => navGuarded(`${paths.appSub(`${appId}`, 'forms')}#companion`) },
                { label: 'Deploy', desc: 'Manage publishing, share links and PWA settings', icon: Rocket, onClick: () => navGuarded(paths.appSub(`${appId}`, 'deploy')) },
              ]}
            />

            {!acting && (
              <ManageAppGroup
                title="Tools & portability"
                description="Connect external builders or move the app’s structure between workspaces."
                items={[
                  { label: 'Connect an AI', desc: 'Let an external AI build this app through MCP (Beta)', icon: Plug, onClick: () => setShowMcp(true) },
                  { label: exporting ? 'Exporting…' : 'Export app', desc: 'Download forms, screens, scripts and roles as portable JSON', icon: Download, disabled: exporting, onClick: handleExport },
                ]}
              />
            )}
          </div>
          {!acting && <p className="mt-5 rounded-xl bg-gray-50 px-3.5 py-3 text-xs leading-5 text-gray-500 dark:bg-white/[0.035] dark:text-slate-400">
            <strong className="font-medium text-gray-700 dark:text-slate-300">Export app is a structure bundle, not a data backup.</strong>{' '}
            It does not include collected responses or uploaded files. For app data, use{' '}
            <strong className="font-medium text-gray-700 dark:text-slate-300">Records → Export data</strong> (SQLite bundle, or a
            MySQL / SQL Server dump with one table per form); for a restorable full-workspace backup, use Settings → Backup &amp; restore.
          </p>}
          </TabsContent>
        </div>
      </Tabs>
    </div>
    </div>
      <ConfirmDialog
        isOpen={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        onConfirm={() => { const target = pendingNav; setPendingNav(null); if (target) navigate(target.to, { state: target.state }); }}
        title="Discard unsaved changes?"
        message="You have unsaved changes to this app. If you leave now, they'll be lost."
        confirmLabel="Discard changes"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={showDelete}
        onClose={() => { if (!deleting) setShowDelete(false); }}
        onConfirm={handleDeleteConfirmed}
        title="Delete app"
        message={`Delete "${app.name}"? The app (with its flows, roles and members) moves to the recycle bin, restorable for 30 days. Its forms and their records stay in your workspace.`}
        confirmLabel="Delete app"
        variant="danger"
        isLoading={deleting}
      />
      <ConnectAiModal isOpen={showMcp} onClose={() => setShowMcp(false)} appId={appId} appName={app?.name} />
    </div>
  );
}

interface ManageAppItem {
  label: string;
  desc: string;
  icon: typeof Settings;
  onClick: () => void;
  meta?: string;
  disabled?: boolean;
}

function ManageAppGroup({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: ManageAppItem[];
}) {
  return (
    <section aria-labelledby={`manage-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <div className="mb-3">
        <h3
          id={`manage-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          className="text-sm font-semibold text-gray-900 dark:text-white"
        >
          {title}
        </h3>
        <p className="mt-0.5 text-xs leading-5 text-gray-500 dark:text-slate-400">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 @2xl/appsettings:grid-cols-2">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            disabled={item.disabled}
            className="group flex min-h-24 cursor-pointer items-center gap-3.5 rounded-xl border border-gray-200/80 bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-md hover:shadow-gray-900/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700/60 dark:bg-white/[0.02] dark:hover:border-primary-500/40 dark:hover:bg-primary-500/[0.04] dark:hover:shadow-black/20 dark:focus-visible:ring-offset-slate-950"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600 transition-colors group-hover:bg-primary-100 dark:bg-primary-500/10 dark:text-primary-400 dark:group-hover:bg-primary-500/20">
              <item.icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{item.label}</span>
                {item.meta !== undefined && (
                  <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-gray-500 dark:bg-white/[0.06] dark:text-slate-400">
                    {item.meta}
                  </span>
                )}
              </span>
              <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-slate-400">{item.desc}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-500 dark:text-slate-600 dark:group-hover:text-primary-400" />
          </button>
        ))}
      </div>
    </section>
  );
}
