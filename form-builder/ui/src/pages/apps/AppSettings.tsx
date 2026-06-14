import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Check, Settings, Palette, LayoutGrid, Users, Shield, Rocket, Link2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Switch } from '../../components/ui/Switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import { cn } from '../../lib/utils';
import { hexContrast, contrastLevel, readableForegroundColor } from '../../lib/color';
import type { App, AppRole, AppForm } from '../../types/app';
import { DEFAULT_APP_THEME } from '../../types/app';

const tabs = [
  { label: 'General', value: 'general', icon: Settings },
  { label: 'Theme', value: 'theme', icon: Palette },
  { label: 'Manage', value: 'manage', icon: LayoutGrid },
];

export function AppSettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { updateApp, fetchApps, fetchRoles, fetchAppForms } = useAppStore();
  const [app, setApp] = useState<App | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [appForms, setAppForms] = useState<AppForm[]>([]);

  useEffect(() => {
    fetchApps().then(() => {
      if (appId) {
        const found = useAppStore.getState().getApp(appId);
        if (found) {
          const appData = found as App;
          // Ensure theme has defaults to prevent undefined spread
          setApp({ ...appData, theme: { ...DEFAULT_APP_THEME, ...appData.theme } });
        }
      }
    }).finally(() => setLoaded(true));
  }, [appId, fetchApps]);

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
        <Button variant="outline" className="mt-4" onClick={() => navigate('/apps')}>Back to Apps</Button>
      </div>
    );
  }

  const handleSave = async () => {
    if (!appId) return;
    setSaving(true);
    setSaveSuccess(false);
    const ok = await updateApp(appId, app);
    setSaving(false);
    // Only show the success state when the update actually persisted; updateApp
    // already surfaces an error toast on failure.
    if (ok) {
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title={app.name}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/apps')} leftIcon={<ArrowLeft className="h-4 w-4" />}>
              Back
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} leftIcon={saveSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}>
              {saving ? 'Saving...' : saveSuccess ? 'Saved!' : 'Save'}
            </Button>
          </>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto">

      {/* Tab navigation */}
      <Tabs defaultValue="general">
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
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">App Name</label>
              <input type="text" value={app.name} onChange={(e) => setApp({ ...app, name: e.target.value })}
                className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Public URL slug</label>
              <input type="text" value={app.slug} readOnly aria-readonly="true"
                className="w-full px-3.5 py-2.5 border border-gray-200/80 dark:border-slate-700/60 rounded-xl bg-gray-50 dark:bg-slate-800/60 text-gray-500 dark:text-slate-400 font-mono text-sm cursor-default focus:outline-none" />
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Permanent — set when the app was created. Your app is served at <span className="font-mono">/app/{app.slug}</span>.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Description</label>
              <textarea value={app.description || ''} onChange={(e) => setApp({ ...app, description: e.target.value })}
                rows={3} className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Status</label>
              <select value={app.status} onChange={(e) => setApp({ ...app, status: e.target.value as App['status'] })}
                className="px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200">
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Logo URL</label>
              <input type="text" value={app.logoUrl || ''} onChange={(e) => setApp({ ...app, logoUrl: e.target.value })}
                placeholder="https://example.com/logo.png"
                className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
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
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Default role for new members</label>
                    <select
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
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Landing page</label>
                <select
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
          </div>
          </TabsContent>

          <TabsContent value="theme">
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Primary Color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" aria-label="Primary color picker" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })} className="h-10 w-10 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" aria-label="Primary color hex value" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })}
                    className="flex-1 px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Background Color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" aria-label="Background color picker" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })} className="h-10 w-10 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" aria-label="Background color hex value" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })}
                    className="flex-1 px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200" />
                </div>
              </div>
            </div>
            {(() => {
              const primary = app.theme?.primaryColor || '#6366f1';
              const bg = app.theme?.backgroundColor || '#ffffff';
              const ratio = hexContrast(primary, bg);
              if (ratio === null) return null;
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
                    Accent vs background contrast: <strong className="font-semibold tabular-nums">{ratio.toFixed(1)}:1</strong>
                    {ok
                      ? ` — meets WCAG ${level === 'aa-large' ? 'AA (large text)' : level.toUpperCase()}.`
                      : ' — too low; accent text and links may be hard to read. Buttons stay legible (text auto-adjusts).'}
                  </span>
                </div>
              );
            })()}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Font Family</label>
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
                  Sample Button
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
              { label: 'Deploy', desc: 'Share link and PWA settings', icon: Rocket, path: 'deploy' },
            ].map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(`/apps/${appId}/${item.path}`)}
                className="flex items-start gap-3.5 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200 text-left group cursor-pointer"
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
          </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
    </div>
    </div>
  );
}
