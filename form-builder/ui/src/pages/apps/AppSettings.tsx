import { useState, useEffect, type CSSProperties } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Save, Check, Settings, Palette, LayoutGrid, Users, Shield, Rocket, Link2, MonitorPlay, Plug, Download, Trash2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ConnectAiModal } from '../../components/mcp/ConnectAiModal';
import { Switch } from '../../components/ui/Switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import { IconPicker } from '../../components/ui/IconPicker';
import { DynamicIcon } from '../../components/ui/DynamicIcon';
import { cn } from '../../lib/utils';
import { hexContrast, contrastLevel, readableForegroundColor } from '../../lib/color';
import type { App, AppRole, AppForm } from '../../types/app';
import { DEFAULT_APP_THEME } from '../../types/app';

const tabs = [
  { label: 'General', value: 'general', icon: Settings },
  { label: 'Theme', value: 'theme', icon: Palette },
  { label: 'Manage', value: 'manage', icon: LayoutGrid },
];

const TAB_VALUES = tabs.map((t) => t.value);

// The accent hex lands in an inline CSS custom property, so keep the format strict.
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

export function AppSettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
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
  const [pendingNav, setPendingNav] = useState<string | null>(null);
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

  // Navigate, but confirm first if there are unsaved edits.
  const navGuarded = (to: string) => { if (dirty) setPendingNav(to); else navigate(to); };

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
        <Button variant="outline" className="mt-4" onClick={() => navigate('/apps')}>Back to apps</Button>
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
    const ok = await updateApp(appId, app);
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
        navigate('/apps');
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
      a.download = `${app.slug || 'app'}.formlogic-app.json`;
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
        title={app.name}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navGuarded('/apps')} leftIcon={<ArrowLeft className="h-4 w-4" />}>
              Back
            </Button>
            {/* Nothing on the Manage tab is savable — hide the Save action there. */}
            {activeTab !== 'manage' && (
              <Button size="sm" onClick={handleSave} disabled={saving} leftIcon={saveSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}>
                {saving ? 'Saving...' : saveSuccess ? 'Saved!' : 'Save'}
              </Button>
            )}
          </>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">

      {/* Tab navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="underline" aria-label="App settings sections" className="mb-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.value} value={tab.value} variant="underline">
                <span className="flex items-center gap-2"><Icon className="h-4 w-4" />{tab.label}</span>
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
              <select id="app-status" value={app.status} onChange={(e) => setApp({ ...app, status: e.target.value as App['status'] })}
                className="px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Archived: hidden from members; data kept.</p>
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
                <select
                  id="app-landing-page"
                  value={(app.settings?.landingPage as string) || ''}
                  onChange={(e) => updateSetting('landingPage', e.target.value || undefined)}
                  className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                >
                  <option value="">Dashboard (default)</option>
                  {appForms.map((f) => (
                    <option key={f.formId} value={f.formId}>{f.displayName}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Where members land when they open the app.</p>
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

            {/* Danger zone */}
            <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
              <h3 className="text-sm font-medium text-red-700 dark:text-red-400 mb-3">Danger zone</h3>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-red-200/80 dark:border-red-500/20 bg-red-50/50 dark:bg-red-500/5 p-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Delete this app</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Permanently removes the app with all its forms, members, roles, and data. This cannot be undone.</p>
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              const bg = app.theme?.backgroundColor || '#ffffff';
              // The accent is painted as text/links on CARDS — white in light mode,
              // slate-900 (#0f172a) in dark. Check both and report the WORST case, so
              // the badge reflects dark mode too (not just the configured page bg).
              const rBg = hexContrast(primary, bg);
              const rDark = hexContrast(primary, '#0f172a');
              if (rBg === null) return null;
              const ratio = rDark === null ? rBg : Math.min(rBg, rDark);
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

          <TabsContent value="manage">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { label: 'Forms', desc: 'Add, remove, and reorder forms', icon: LayoutGrid, path: 'forms' },
              { label: 'Users', desc: 'Manage users and invitations', icon: Users, path: 'users' },
              { label: 'Roles', desc: 'Configure roles and permissions', icon: Shield, path: 'roles' },
              { label: 'Relations', desc: 'Define links between forms', icon: Link2, path: 'relations' },
              { label: 'Custom', desc: 'Build a full custom frontend (HTML/CSS/TypeScript) over your forms (Beta)', icon: MonitorPlay, path: 'home/edit' },
              { label: 'Deploy', desc: 'Share link and PWA settings', icon: Rocket, path: 'deploy' },
            ].map((item) => (
              <button
                key={item.path}
                onClick={() => navGuarded(`/apps/${appId}/${item.path}`)}
                className="flex items-start gap-3.5 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
              >
                <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-500/10 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 transition-colors">
                  <item.icon className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                </div>
                <div>
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">{item.label}</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">{item.desc}</span>
                </div>
              </button>
            ))}
            <button
              onClick={() => setShowMcp(true)}
              className="flex items-start gap-3.5 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
            >
              <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-500/10 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 transition-colors">
                <Plug className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              </div>
              <div>
                <span className="block text-sm font-medium text-gray-900 dark:text-white">Connect an AI</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">Let an external AI build via MCP (Beta)</span>
              </div>
            </button>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex items-start gap-3.5 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
            >
              <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-500/10 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 transition-colors">
                <Download className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              </div>
              <div>
                <span className="block text-sm font-medium text-gray-900 dark:text-white">{exporting ? 'Exporting…' : 'Export app'}</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">Portable .json: forms, screens, scripts &amp; roles. Not responses, members, or secrets.</span>
              </div>
            </button>
          </div>
          <p className="mt-3 text-xs text-gray-500 dark:text-slate-400">
            <strong className="font-medium text-gray-700 dark:text-slate-300">Export is a structure bundle, not a data backup.</strong>{' '}
            It re-creates the app's forms, dashboards, scripts and roles in another account, but does
            <em> not</em> include your collected responses or uploaded files. For a full backup of your
            data, back up the database + <code>backend/storage</code> (see DEPLOYMENT.md).
          </p>
          </TabsContent>
        </div>
      </Tabs>
    </div>
    </div>
      <ConfirmDialog
        isOpen={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        onConfirm={() => { const to = pendingNav; setPendingNav(null); if (to) navigate(to); }}
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
        message={`Are you sure you want to delete "${app.name}"? This will permanently remove all forms, users, roles, and data associated with this app. This action cannot be undone.`}
        confirmLabel="Delete app"
        variant="danger"
        isLoading={deleting}
      />
      <ConnectAiModal isOpen={showMcp} onClose={() => setShowMcp(false)} appId={appId} appName={app?.name} />
    </div>
  );
}
