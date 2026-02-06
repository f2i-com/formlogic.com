import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Check, Settings, Palette, LayoutGrid, Users, Shield, Rocket, Link2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/utils';
import type { App } from '../../types/app';

const tabs = [
  { label: 'General', icon: Settings },
  { label: 'Theme', icon: Palette },
  { label: 'Manage', icon: LayoutGrid },
];

export function AppSettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { updateApp, fetchApps } = useAppStore();
  const [activeTab, setActiveTab] = useState(0);
  const [app, setApp] = useState<App | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    fetchApps().then(() => {
      if (appId) {
        const found = useAppStore.getState().getApp(appId);
        if (found) setApp(found as App);
      }
    });
  }, [appId, fetchApps]);

  if (!app) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading app settings" /></div>;
  }

  const handleSave = async () => {
    if (!appId) return;
    setSaving(true);
    setSaveSuccess(false);
    await updateApp(appId, app);
    setSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2000);
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
      <div className="flex border-b border-gray-200 dark:border-slate-700 mb-6">
        {tabs.map((tab, i) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.label}
              onClick={() => setActiveTab(i)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                i === activeTab
                  ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-6">
        {activeTab === 0 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">App Name</label>
              <input type="text" value={app.name} onChange={(e) => setApp({ ...app, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Description</label>
              <textarea value={app.description || ''} onChange={(e) => setApp({ ...app, description: e.target.value })}
                rows={3} className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Status</label>
              <select value={app.status} onChange={(e) => setApp({ ...app, status: e.target.value as App['status'] })}
                className="px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent">
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Logo URL</label>
              <input type="text" value={app.logoUrl || ''} onChange={(e) => setApp({ ...app, logoUrl: e.target.value })}
                placeholder="https://example.com/logo.png"
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
            </div>
          </div>
        )}

        {activeTab === 1 && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Primary Color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })} className="h-10 w-10 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" value={app.theme?.primaryColor || '#6366f1'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, primaryColor: e.target.value } })}
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Background Color</label>
                <div className="flex gap-2 items-center">
                  <input type="color" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })} className="h-10 w-10 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
                  <input type="text" value={app.theme?.backgroundColor || '#ffffff'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, backgroundColor: e.target.value } })}
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Font Family</label>
              <select value={app.theme?.fontFamily || 'Inter'} onChange={(e) => setApp({ ...app, theme: { ...app.theme, fontFamily: e.target.value } })}
                className="px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent">
                <option value="Inter">Inter</option>
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
                style={{ backgroundColor: app.theme?.backgroundColor || '#ffffff', fontFamily: app.theme?.fontFamily || 'Inter' }}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${app.theme?.primaryColor || '#6366f1'}20` }}>
                    <div className="w-4 h-4 rounded" style={{ backgroundColor: app.theme?.primaryColor || '#6366f1' }} />
                  </div>
                  <span className="font-semibold text-sm" style={{ color: app.theme?.primaryColor || '#6366f1' }}>{app.name}</span>
                </div>
                <div className="rounded-lg px-4 py-2 text-white text-sm font-medium inline-block" style={{ backgroundColor: app.theme?.primaryColor || '#6366f1' }}>
                  Sample Button
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 2 && (
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
                className="flex items-start gap-3.5 p-4 rounded-xl border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-all text-left group"
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
        )}
      </div>
    </div>
    </div>
    </div>
  );
}
