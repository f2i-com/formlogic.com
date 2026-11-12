import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { forwardReturnTo, useReturnTo, type ReturnToState } from '../../hooks/useReturnTo';
import { Save, Check, ChevronRight, ExternalLink, Settings, Palette, LayoutGrid, Users, Shield, Rocket, Link2, MonitorPlay, Plug, Download, Trash2, Layers, Table, PencilRuler, Globe, Image as ImageIcon, LogIn, UserPlus, Lock, Power } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { PageBody, PAGE_GUTTER } from '../../components/layout/PageBody';
import { SectionNav, type SectionNavItem } from '../../components/ui/SectionNav';
import { Panel, PANEL_COLUMNS } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ConnectAiModal } from '../../components/mcp/ConnectAiModal';
import { Switch } from '../../components/ui/Switch';
import { AppTile } from '../../components/apps/AppTile';
import { RequirementsSetting } from '../../components/apps/RequirementsSetting';
import { SignInPageFields } from '../../components/apps/SignInPageFields';
import { TimezoneSelect } from '../../components/ui/TimezoneSelect';
import { IconPicker } from '../../components/ui/IconPicker';
import { DynamicIcon } from '../../components/ui/DynamicIcon';
import { cn, generateId } from '../../lib/utils';
import { hexContrast, contrastLevel, readableForegroundColor } from '../../lib/color';
import { statusLabel } from '../../lib/appStatus';
import { useAdminActing, useResourcePaths } from '../../components/admin/AdminActingContext';
import type { App, AppRole, AppForm, AppKind, AppNavItem } from '../../types/app';
import { DEFAULT_APP_THEME, KIND_LABELS } from '../../types/app';

// The page's five sections. Each is an address (?tab=…, none for General), so a link, a reload
// and Back land on it; `description` is the one line of help under the row of sections.
const tabs = [
  { label: 'General', value: 'general', icon: Settings, description: 'Name your app and set its address and timezone.' },
  { label: 'Appearance', value: 'theme', icon: Palette, description: 'Give your app its own logo, colors and typography.' },
  { label: 'Navigation', value: 'menu', icon: Link2, description: 'Choose the first screen and help members find their way around.' },
  { label: 'Access', value: 'access', icon: Shield, description: 'Decide how people join and manage their permissions.' },
  { label: 'Manage', value: 'manage', icon: LayoutGrid, description: 'Manage content, connected services, publishing and exports.' },
];

const TAB_VALUES = tabs.map((t) => t.value);

// One look for every text field, select and label on the page: the size and label the shared
// Input and the panels shared in from components/apps (the sign-in page's fields) have, so a
// page of panels reads as one form.
const FIELD = 'w-full min-w-0 rounded-lg border bg-white px-3.5 py-2.5 text-sm text-gray-900 transition focus:border-transparent focus:ring-2 focus:ring-primary-500 max-sm:text-base dark:bg-slate-800 dark:text-white';
const FIELD_LINE = 'border-gray-300 dark:border-slate-600';
const FIELD_WRONG = 'border-red-400 dark:border-red-500/60';
const LABEL = 'mb-1.5 block text-sm font-medium text-gray-700 dark:text-slate-300';
const HELP = 'mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400';

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
  'requires',
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
  const invalidField = useRef<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  // Snapshot of the persisted state; anything diverging from it is unsaved.
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const [pendingNav, setPendingNav] = useState<{ to: string; state: ReturnToState | undefined } | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The open section lives in ?tab= so refresh and Back (e.g. from the Manage sub-pages)
  // return to the same section. `replace` keeps section flips out of the history stack.
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam && TAB_VALUES.includes(tabParam) ? tabParam : 'general';
  const setActiveTab = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === 'general') next.delete('tab'); else next.set('tab', value);
      return next;
    }, { replace: true });
  };
  // The same address as a link, for the row of sections: this page with ?tab= changed and
  // whatever else the address carries left as it is.
  const sectionAddress = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'general') next.delete('tab'); else next.set('tab', value);
    const query = next.toString();
    return { search: query ? `?${query}` : '' };
  };

  // Wait for General to mount before focusing a validation error from another tab.
  useEffect(() => {
    if (activeTab === 'general' && invalidField.current) {
      document.getElementById(invalidField.current)?.focus();
      invalidField.current = null;
    }
  }, [activeTab]);

  const revealInvalidField = (id: string) => {
    if (activeTab === 'general') document.getElementById(id)?.focus();
    else {
      invalidField.current = id;
      setActiveTab('general');
    }
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
    // The page's frame from the first paint: the header and Back, then what is known so far.
    return (
      <div className="min-h-screen">
        <Header title="App settings" back={{ onClick: () => navigate(backTo.path, { state: backTo.state }), label: backTo.label ? `Back to ${backTo.label}` : 'Back to apps' }} />
        {!loaded ? (
          <div className={cn('flex items-center gap-3 py-8 text-sm text-gray-500 dark:text-slate-400', PAGE_GUTTER)}>
            <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading app settings" />
            Loading the app…
          </div>
        ) : (
          <div className={cn('py-8', PAGE_GUTTER)}>
            <p className="text-base font-semibold text-gray-900 dark:text-white">App not found</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">It may have been deleted, or you don’t have access.</p>
            <Button variant="outline" className="mt-4" onClick={() => navigate(paths.appsHome())}>Back to apps</Button>
          </div>
        )}
      </div>
    );
  }

  const handleSave = async () => {
    if (!appId || saving) return;
    if (app.name.trim().length < 2) {
      setNameError('Name must be at least 2 characters');
      revealInvalidField('app-name');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(app.slug)) {
      setSlugError('Use lowercase letters, digits, and hyphens (start with a letter or digit).');
      revealInvalidField('app-slug');
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

  const section = tabs.find((tab) => tab.value === activeTab) ?? tabs[0];
  const published = app.status === 'published';

  // Opening the running app, the App Studio and Deploy are what owners do most from here.
  // In the page Header where it has room for them; on a narrow screen under the app's name,
  // spelled out. `row` is that second form.
  const quickActions = (row: boolean) => {
    const word = (text: string) => row ? text : <span className="hidden @4xl/header:inline">{text}</span>;
    const size = row ? 'flex-1' : undefined;
    return (
      <>
        {!acting && (
          <Button variant="secondary" size="sm" aria-label="App Studio" title="App Studio" leftIcon={<PencilRuler className="h-4 w-4" />}
            onClick={() => navGuarded(paths.appSub(`${appId}`, 'studio'))} className={size}>
            {word('App Studio')}
          </Button>
        )}
        <Button variant="outline" size="sm" aria-label="Deploy" title="Deploy" leftIcon={<Rocket className="h-4 w-4" />}
          onClick={() => navGuarded(paths.appSub(`${appId}`, 'deploy'))} className={size}>
          {word('Deploy')}
        </Button>
        <Button
          size="sm"
          leftIcon={<ExternalLink className="h-4 w-4" />}
          disabled={!published || !!acting}
          title={acting
            ? 'The live app shows record data, which is not visible to platform admins'
            : published ? 'Open the app in a new tab' : 'Publish the app (Deploy) to open it'}
          onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener')}
          className={cn('whitespace-nowrap', size)}
        >
          Open app
        </Button>
      </>
    );
  };

  const sectionLinks: SectionNavItem[] = tabs.map((tab) => ({
    value: tab.value, label: tab.label, icon: tab.icon, to: sectionAddress(tab.value), replace: true,
  }));

  return (
    <div className="min-h-screen">
      <Header
        title="App settings"
        back={{ onClick: () => navGuarded(backTo.path, backTo.state), label: backTo.label ? `Back to ${backTo.label}` : 'Back to apps' }}
        actions={<div className="hidden items-center gap-2 @2xl/header:flex">{quickActions(false)}</div>}
      />
      {/* The body starts at the left and takes the page's width. `page` measures the page;
          each panel is a container of its own (`appsettings`), so a panel's fields lay
          themselves out for the column the panel stands in. */}
      <PageBody className="@container/page">
        {/* The page's five sections, and at the row's end which app this is: its name, whether
            it is live and its address. Links, not tabs: each section is an address. */}
        <SectionNav
          label="App settings sections"
          current={activeTab}
          items={sectionLinks}
          end={
            <div className="w-full min-w-0 @2xl/page:w-auto @2xl/page:max-w-full">
              <div className="flex min-w-0 items-center gap-2 py-2 text-xs text-gray-500 dark:text-slate-400">
                <AppTile app={app} size="sm" className="h-6 w-6 rounded-md" />
                <span className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">{app.name}</span>
                <span className={cn(
                  'inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  published ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-slate-300',
                )}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', published ? 'bg-emerald-500' : app.status === 'archived' ? 'bg-gray-400' : 'bg-amber-500')} aria-hidden="true" />
                  {statusLabel(app)}
                </span>
                <span className="min-w-0 truncate font-mono">/app/{app.slug}</span>
              </div>
              <div className="mb-2 flex gap-2 @2xl/page:hidden">{quickActions(true)}</div>
            </div>
          }
        />

        {/* The section's name is in the row above: a heading for a screen reader's outline,
            and one line saying what the section holds. */}
        <h2 className="sr-only">{section.label}</h2>
        <p className="mt-3 text-sm text-gray-500 dark:text-slate-400">{section.description}</p>

        <section aria-label={`${section.label} settings`} className={cn('mt-4', PANEL_COLUMNS)}>
          {activeTab === 'general' && (
            <>
            <SettingsPanel title="App details" icon={Settings} description="The name and description help people recognize this app.">
              <div>
              <label htmlFor="app-name" className={LABEL}>App name</label>
              <input id="app-name" type="text" value={app.name}
                onChange={(e) => { setApp({ ...app, name: e.target.value }); if (nameError) setNameError(null); }}
                onBlur={(e) => setNameError(e.target.value.trim().length < 2 ? 'Name must be at least 2 characters' : null)}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'app-name-error' : undefined}
                className={cn(FIELD, nameError ? FIELD_WRONG : FIELD_LINE)} />
              {nameError && <p id="app-name-error" className="mt-1 text-sm text-red-600 dark:text-red-400">{nameError}</p>}
            </div>
              <div>
              <label htmlFor="app-description" className={LABEL}>Description</label>
              <textarea id="app-description" value={app.description || ''} onChange={(e) => setApp({ ...app, description: e.target.value })}
                rows={3} className={cn(FIELD, FIELD_LINE, 'resize-none')} />
            </div>
              <div>
              <label htmlFor="app-kind" className={LABEL}>App type</label>
              <select
                id="app-kind"
                value={(app.settings?.appKind as string) || ''}
                onChange={(e) => updateSetting('appKind', e.target.value || undefined)}
                className={cn(FIELD, FIELD_LINE)}
              >
                <option value="">Not set</option>
                {(Object.keys(KIND_LABELS) as AppKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
              <p className={HELP}>Used for dashboard templates and labels — apps of any type can share the same forms.</p>
            </div>
            </SettingsPanel>
            <SettingsPanel title="Address & region" icon={Globe} description="Set where members find your app and how dates are displayed.">
              <div>
              <label htmlFor="app-slug" className={LABEL}>Public URL slug</label>
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
                className={cn(FIELD, 'font-mono', slugError ? FIELD_WRONG : FIELD_LINE)}
              />
              {slugError
                ? <p id="app-slug-error" className="mt-1 text-sm text-red-600 dark:text-red-400">{slugError}</p>
                : <p className={HELP}>Your app is served at <span className="font-mono">/app/{app.slug || '…'}</span>. Must be unique — changing it breaks old links.</p>}
            </div>
              <div>
                <label htmlFor="app-timezone" className={LABEL}>Timezone</label>
                <TimezoneSelect
                  id="app-timezone"
                  value={(app.settings?.timezone as string) || ''}
                  onChange={(tz) => updateSetting('timezone', tz || undefined)}
                  emptyLabel="UTC (default)"
                  className={cn(FIELD, FIELD_LINE)}
                />
                <p className={HELP}>Record times (call logs, submissions) display in this zone for members without their own timezone set. Also used for report date grouping.</p>
              </div>
            </SettingsPanel>
            </>
          )}

          {activeTab === 'theme' && (
            <>
            <SettingsPanel title="App identity" icon={ImageIcon} description="Use a logo, or choose an icon for app cards and tiles.">
              <div>
              <label htmlFor="app-logo" className={LABEL}>Logo URL</label>
              <input id="app-logo" type="text" value={app.logoUrl || ''} onChange={(e) => setApp({ ...app, logoUrl: e.target.value })}
                placeholder="https://example.com/logo.png"
                className={cn(FIELD, FIELD_LINE)} />
            </div>
              <div>
              <span className={LABEL}>App icon</span>
              <div className="flex flex-wrap items-center gap-3">
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
                <p className="min-w-0 basis-40 flex-1 text-xs leading-5 text-gray-500 dark:text-slate-400">Shown on the app card and tiles when there's no logo.</p>
              </div>
            </div>
            </SettingsPanel>
          <SettingsPanel title="Colors & typography" icon={Palette} description="Preview your choices before saving them to the app.">
            <div className="grid grid-cols-1 gap-4 @md/appsettings:grid-cols-2">
              <div>
                <label className={LABEL}>Accent color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" aria-label="Accent color picker" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })} className="h-11 w-11 shrink-0 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" aria-label="Accent color hex value" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })}
                    onBlur={(e) => { if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) setApp({ ...app, theme: { ...app.theme, primaryColor: '#6366f1' } }); }}
                    className={cn(FIELD, FIELD_LINE, 'flex-1 font-mono')} />
                </div>
                <p className={HELP}>Buttons, links and highlights inside the app.</p>
              </div>
              {/* The runtime applies the accent and the font and no background (AppRuntimeThemeProvider).
                  This one goes into the web app manifest, so it colours the screen an installed app
                  opens on. Called a background color and previewed behind the app, it promised more. */}
              <div>
                <label className={LABEL}>Installed app splash color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" aria-label="Splash color picker" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })} className="h-11 w-11 shrink-0 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" aria-label="Splash color hex value" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })}
                    onBlur={(e) => { if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) setApp({ ...app, theme: { ...app.theme, backgroundColor: '#ffffff' } }); }}
                    className={cn(FIELD, FIELD_LINE, 'flex-1 font-mono')} />
                </div>
                <p className={HELP}>Shown only while the app opens from a home screen. Screens inside the app don't use it.</p>
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
              <label className={LABEL}>Font family</label>
              <select aria-label="Font family" value={app.theme?.fontFamily || DEFAULT_APP_THEME.fontFamily} onChange={(e) => setApp({ ...app, theme: { ...app.theme, fontFamily: e.target.value } })}
                className={cn(FIELD, FIELD_LINE)}>
                <option value="DM Sans">DM Sans</option>
                <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
                <option value="system-ui">System</option>
                <option value="Georgia">Georgia</option>
                <option value="monospace">Monospace</option>
              </select>
            </div>
            {/* Live preview */}
            <div>
              <span className={LABEL}>Preview</span>
              <div
                className="rounded-xl border border-gray-200 dark:border-slate-700 p-4 transition-all"
                style={{ backgroundColor: '#ffffff', fontFamily: app.theme?.fontFamily || DEFAULT_APP_THEME.fontFamily }}
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
          </SettingsPanel>
          <SettingsPanel title="Sign-in page" icon={LogIn} description="What people see when they sign in or create an account to use this app. The page stays this site's, and tells them it's their FormLogic account.">
            <SignInPageFields app={app} onChange={(page) => updateSetting('signInPage', page)} />
          </SettingsPanel>
            </>
          )}

          {activeTab === 'menu' && (
            <>
            <SettingsPanel title="Starting screen & layout" icon={MonitorPlay} description="Choose what members see when they open the app.">
              <div>
                <label htmlFor="app-landing-page" className={LABEL}>Starting screen</label>
                {/* The Studio stores the default as the token 'dashboard'; an empty-string
                    option meant a landing page chosen there rendered this select blank. */}
                <select
                  id="app-landing-page"
                  value={(app.settings?.landingPage as string) || 'dashboard'}
                  onChange={(e) => updateSetting('landingPage', e.target.value)}
                  className={cn(FIELD, FIELD_LINE)}
                >
                  <option value="dashboard">Dashboard (default)</option>
                  {appForms.map((f) => (
                    <option key={f.formId} value={f.formId}>{f.displayName || 'Untitled form'}</option>
                  ))}
                </select>
                <p className={HELP}>Where members land when they open the app.</p>
              </div>
              <Switch
                checked={app.settings?.hideNav === true}
                onChange={(checked) => updateSetting('hideNav', checked)}
                label="Hide app navigation"
                description="Render the app full-screen without the sidebar and menu — for self-contained apps (e.g. a single custom home screen). Members navigate from within the screen."
              />
            </SettingsPanel>
          <SettingsPanel title="Menu links" icon={Link2} description="Add shortcuts alongside the app’s forms.">
            {(() => {
              // Custom LINK entries live in navConfig (kind 'link'); form entries keep
              // app_forms as their single source of truth (Manage forms edits name/
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
                  <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
                    Extra links shown in the app's menu alongside your forms — external sites (open a new tab) or places
                    inside the app (<code className="font-mono">records</code>, <code className="font-mono">reports</code>,{' '}
                    <code className="font-mono">form/&lt;form-id&gt;</code>). Form entries themselves — name, order, and
                    visibility (including <em>Unlisted</em> and <em>Data-only</em>) — are managed under{' '}
                    <button type="button" className="cursor-pointer font-medium text-primary-700 underline dark:text-primary-300" onClick={() => navGuarded(paths.appSub(`${appId}`, 'forms'))}>Manage forms</button>.
                  </p>
                  {navLinks.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-slate-400">No custom links yet.</p>
                  )}
                  <div className="space-y-3">
                    {navLinks.map((l) => (
                      <div key={l.id || l.displayName} className="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-slate-700">
                        <div className="grid grid-cols-1 gap-3 @md/appsettings:grid-cols-2">
                          <div>
                            <label htmlFor={`menu-label-${l.id}`} className={LABEL}>Label</label>
                            <input
                              type="text"
                              id={`menu-label-${l.id}`}
                              value={l.displayName}
                              onChange={(e) => patchLink(l.id!, { displayName: e.target.value })}
                              placeholder="Help centre"
                              className={cn(FIELD, FIELD_LINE)}
                            />
                          </div>
                          <div>
                            <label htmlFor={`menu-url-${l.id}`} className={LABEL}>Link</label>
                            <input
                              type="text"
                              id={`menu-url-${l.id}`}
                              value={l.url || ''}
                              onChange={(e) => patchLink(l.id!, { url: e.target.value })}
                              placeholder="https://example.com or records"
                              className={cn(FIELD, 'font-mono', looksValid(l) ? FIELD_LINE : 'border-amber-400 dark:border-amber-500')}
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <span className={LABEL}>Icon</span>
                            <IconPicker value={l.icon} onChange={(name) => patchLink(l.id!, { icon: name ?? undefined })} />
                          </div>
                          <div>
                            <label className={LABEL} htmlFor={`menu-position-${l.id}`} title="0 puts the link at the top of the Forms group; higher numbers sit further down among the form entries.">Position</label>
                            <input
                              type="number"
                              id={`menu-position-${l.id}`}
                              min={0}
                              value={Number.isFinite(l.sortOrder) ? l.sortOrder : 0}
                              onChange={(e) => patchLink(l.id!, { sortOrder: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                              className={cn(FIELD, FIELD_LINE, 'w-20')}
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
                  <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
                    Only <code className="font-mono">https://</code> sites and in-app targets ever render — anything else is
                    ignored by the menu. Choose Save changes to apply your menu edits.
                  </p>
                </>
              );
            })()}
          </SettingsPanel>
            </>
          )}

          {activeTab === 'access' && (
            <>
            <SettingsPanel title="Joining this app" icon={UserPlus} description="Keep access invite-only or let signed-in users request to join.">
              <Switch
                checked={app.settings?.allowSelfRegistration === true}
                onChange={(checked) => updateSetting('allowSelfRegistration', checked)}
                label="Let people join from the app link"
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
                    <label htmlFor="app-default-role" className={LABEL}>Default role for new members</label>
                    <select
                      id="app-default-role"
                      value={(app.settings?.defaultRoleId as string) || ''}
                      onChange={(e) => updateSetting('defaultRoleId', e.target.value || undefined)}
                      className={cn(FIELD, FIELD_LINE)}
                    >
                      <option value="">Lowest-privilege role (automatic)</option>
                      {roles.filter((r) => !(r.isSystem && r.name === 'Owner')).map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </SettingsPanel>
            <SettingsPanel title="Before it opens" icon={Lock} description="Ask members for a pass from one of this site's plugins, such as their age. Choose Save changes to apply it.">
              <RequirementsSetting value={app.settings?.requires} onChange={(next) => updateSetting('requires', next)} />
            </SettingsPanel>
            <SettingsPanel title="Members & permissions" icon={Users} description="Control who can use the app and what each role is allowed to do.">
              <ToolRows
                items={[
                  { label: 'Users', desc: 'Invite members and manage existing access', icon: Users, onClick: () => navGuarded(paths.appSub(`${appId}`, 'users')) },
                  { label: 'Roles', desc: 'Configure permissions and default access', icon: Shield, meta: `${roles.length}`, onClick: () => navGuarded(paths.appSub(`${appId}`, 'roles')) },
                ]}
              />
            </SettingsPanel>
            </>
          )}

          {/* The tools that work on a part of the app, a panel a group; each row opens its page. */}
          {activeTab === 'manage' && (
            <>
            <SettingsPanel title="Content & data" icon={Table} description="Work with the forms, records and relationships that power this app.">
              <ToolRows
                items={[
                  acting
                    ? { label: 'Record counts', desc: 'View totals per form without exposing record data', icon: Table, onClick: () => navGuarded(paths.appSub(`${appId}`, 'records')) }
                    : { label: 'Records', desc: 'Browse and export collected app data', icon: Table, onClick: () => navGuarded(paths.appSub(`${appId}`, 'records')) },
                  { label: 'Forms', desc: 'Attach, remove, rename and reorder forms', icon: LayoutGrid, meta: `${appForms.length}`, onClick: () => navGuarded(paths.appSub(`${appId}`, 'forms')) },
                  { label: 'Relations', desc: 'Connect records across the app’s forms', icon: Link2, onClick: () => navGuarded(paths.appSub(`${appId}`, 'relations')) },
                ]}
              />
            </SettingsPanel>

            <SettingsPanel title="Experience & delivery" icon={Rocket} description="Shape the frontend, create another view over the same data, and publish it.">
              <ToolRows
                items={[
                  { label: 'Home screen code', desc: 'Build the app home as custom HTML, CSS and TypeScript (Beta)', icon: MonitorPlay, onClick: () => navGuarded(paths.appSub(`${appId}`, 'home/edit')) },
                  { label: 'Companion app', desc: 'Create another app over these same forms and records', icon: Layers, onClick: () => navGuarded(`${paths.appSub(`${appId}`, 'forms')}#companion`) },
                  { label: 'Deploy', desc: 'Manage publishing, share links and PWA settings', icon: Rocket, onClick: () => navGuarded(paths.appSub(`${appId}`, 'deploy')) },
                ]}
              />
            </SettingsPanel>

            {!acting && (
              <SettingsPanel title="Tools & portability" icon={Plug} description="Connect external builders or move the app’s structure between workspaces.">
                <ToolRows
                  items={[
                    { label: 'Connect an AI', desc: 'Let an external AI build this app through MCP (Beta)', icon: Plug, onClick: () => setShowMcp(true) },
                    { label: exporting ? 'Exporting…' : 'Export app', desc: 'Download forms, app source, backend scripts and roles as portable JSON', icon: Download, disabled: exporting, onClick: handleExport },
                  ]}
                />
                <p className="rounded-xl bg-gray-50 px-3 py-2.5 text-xs leading-5 text-gray-500 dark:bg-white/[0.035] dark:text-slate-400">
                  <strong className="font-medium text-gray-700 dark:text-slate-300">Export app is a structure bundle, not a data backup.</strong>{' '}
                  It does not include collected responses or uploaded files. For app data, use{' '}
                  <strong className="font-medium text-gray-700 dark:text-slate-300">Records → Export data</strong> (SQLite bundle, or a
                  MySQL / SQL Server dump with one table per form). Settings → Backup &amp; restore covers workspace data;
                  hosted and native app databases also need operator backups as described in the hosting guide.
                </p>
              </SettingsPanel>
            )}
            {/* Included services (pack-declared; rendered only when the app's pack shipped any).
                Each toggle gates the service's backend endpoints — e.g. turning the Companion
                relay off makes its admission endpoints refuse with `service_disabled`. */}
            {app.settings?.services && Object.keys(app.settings.services).length > 0 && (
              <SettingsPanel title="Included services" icon={Layers} description="Services included with this app’s pack. Turning one off blocks its connections after you save.">
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
              </SettingsPanel>
            )}
            <SettingsPanel title="App availability" icon={Power} description="Draft and archived apps are unavailable to members. Publish through App Studio when you’re ready.">
              <div>
              <label htmlFor="app-status" className={LABEL}>Status</label>
              {/* "Published" is deliberately NOT offered here: going live has to run the
                  readiness checks and record a version, which only the App Studio's
                  Review & publish does. A raw flip left the app live with no version and
                  no history, and disabled the Studio's own Publish button. */}
              <select id="app-status" value={app.status} onChange={(e) => setApp({ ...app, status: e.target.value as App['status'] })}
                className={cn(FIELD, FIELD_LINE)}>
                {/* Acting admins have no Studio route, so they keep the raw option. */}
                {(acting || app.status === 'published') && <option value="published">Published</option>}
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
              <p className={HELP}>
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
            </SettingsPanel>
            <SettingsPanel title="Delete app" icon={Trash2} description="Remove the app while keeping its forms and records.">
              <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">Moves the app, its roles and memberships to the recycle bin for 30 days. Forms and their records stay in your workspace.</p>
              <Button variant="danger" size="sm" onClick={() => setShowDelete(true)} leftIcon={<Trash2 className="h-4 w-4" />}>
                Delete app
              </Button>
            </SettingsPanel>
            </>
          )}
        </section>

        {/* What is saved and what is not, with Save, kept in view while the page scrolls: at the
            left, where the body starts, and above the phone's bottom navigation and the chat
            launcher (--fl-mobile-reserve). One Save for every section. */}
        <div className="sticky bottom-[calc(var(--fl-mobile-reserve)+0.75rem)] z-20 mt-4 flex w-full max-w-xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur md:bottom-16 dark:border-slate-700 dark:bg-slate-900/95">
          <div className="min-w-0 flex-1" role="status" aria-live="polite">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{saving ? 'Saving your changes…' : dirty ? 'You have unsaved changes' : 'All changes saved'}</p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">Changes in any section save together.</p>
          </div>
          <Button onClick={handleSave} disabled={saving || !dirty} leftIcon={saveSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </PageBody>
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

/** The pages a panel leads to, a row each: what it is, what it is for, and how many it holds.
    They were large tiles in a grid; as rows the whole of Manage fits one screen. */
function ToolRows({ items }: { items: ManageAppItem[] }) {
  return (
    <ul className="-my-1 divide-y divide-gray-100 dark:divide-slate-800">
      {items.map((item) => (
        <li key={item.label}>
          <button
            type="button"
            onClick={item.onClick}
            disabled={item.disabled}
            className="group -mx-2 flex min-h-11 w-[calc(100%+1rem)] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-white/[0.04]"
          >
            <item.icon className="h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-primary-600 dark:text-slate-500 dark:group-hover:text-primary-400" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-gray-900 dark:text-white">{item.label}</span>
                {item.meta !== undefined && (
                  <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-gray-600 dark:bg-white/10 dark:text-slate-300">
                    {item.meta}
                  </span>
                )}
              </span>
              <span className="block text-xs leading-5 text-gray-500 dark:text-slate-400">{item.desc}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-500 dark:text-slate-600 dark:group-hover:text-primary-400" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One group of settings, as the panel every management page uses. Its fields lay themselves
    out for the panel's own width (`@…/appsettings`), which is a column of the page, not the
    page: the panels shared in from components/apps measure the same container. */
function SettingsPanel({ title, icon: Icon, description, children }: { title: string; icon: typeof Settings; description: string; children: ReactNode }) {
  return (
    <Panel title={title} icon={<Icon className="h-4 w-4" />} description={description}>
      <div className="@container/appsettings space-y-4">{children}</div>
    </Panel>
  );
}
