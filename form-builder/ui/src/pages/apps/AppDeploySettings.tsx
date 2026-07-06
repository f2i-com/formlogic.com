import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Check, Globe, Smartphone, ExternalLink, CheckCircle2, Package, Download } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CustomDomainsPanel } from '../../components/apps/CustomDomainsPanel';
import { AppLogicPanel } from '../../components/apps/AppLogicPanel';
import { toast } from '../../stores/toastStore';
import type { App } from '../../types/app';

export function AppDeploySettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { fetchApps, updateApp } = useAppStore();
  const [app, setApp] = useState<App | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pwaShortName, setPwaShortName] = useState('');
  const [pwaThemeColor, setPwaThemeColor] = useState('#6366f1');
  const [savingPwa, setSavingPwa] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showUnpublish, setShowUnpublish] = useState(false);

  useEffect(() => {
    fetchApps().then(() => {
      if (appId) {
        const found = useAppStore.getState().getApp(appId) as App | undefined;
        if (found) {
          setApp(found);
          setPwaShortName(found.settings?.pwaShortName ?? found.name.slice(0, 12));
          setPwaThemeColor(found.settings?.pwaThemeColor ?? found.theme?.primaryColor ?? '#6366f1');
        }
      }
    }).finally(() => setLoaded(true));
  }, [appId, fetchApps]);

  const handleSavePwa = async () => {
    if (!appId || !app) return;
    setSavingPwa(true);
    const ok = await updateApp(appId, { settings: { ...app.settings, pwaShortName, pwaThemeColor } });
    setSavingPwa(false);
    if (ok) toast.success('PWA settings saved', 'Install name and theme color updated.');
  };

  const [exporting, setExporting] = useState(false);
  const handleExportPackage = async () => {
    if (!appId || !app || exporting) return;
    setExporting(true);
    const res = await api.exportAppSignedPackage(appId);
    setExporting(false);
    if (res.error || !res.data) {
      toast.error('Export failed', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${app.slug}.formlogic-app.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    toast.success('Package exported', 'Signed .formlogic-app downloaded.');
  };

  const [exportingArchive, setExportingArchive] = useState(false);
  const handleExportArchive = async () => {
    if (!appId || !app || exportingArchive) return;
    setExportingArchive(true);
    try {
      // Full .formlogic-app ARCHIVE (ZIP): manifest + pack + quickjs + assets + detached signature.
      await api.exportAppPackageArchive(appId, app.slug);
      toast.success('Package exported', 'Downloaded a .formlogic-app archive.');
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined);
    } finally {
      setExportingArchive(false);
    }
  };

  if (!app) {
    if (!loaded) {
      return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading deploy settings" /></div>;
    }
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <p className="text-lg font-medium text-gray-700 dark:text-slate-300">App not found</p>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">It may have been deleted, or you don’t have access.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/apps')}>Back to apps</Button>
      </div>
    );
  }

  const appUrl = `${window.location.origin}/app/${app.slug}`;

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(appUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = appUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed', 'Could not copy to clipboard');
    }
  };

  const handlePublish = async () => {
    if (!appId || publishing) return;
    setPublishing(true);
    await updateApp(appId, { status: 'published' });
    // Re-read from store to verify the update succeeded
    const updated = useAppStore.getState().getApp(appId);
    setPublishing(false);
    if (updated && (updated as App).status === 'published') {
      setApp(updated as App);
      toast.success('Published', 'Your app is now live');
    } else {
      toast.error('Publish failed', 'Could not publish the app. Please try again.');
    }
  };

  const handleUnpublish = async () => {
    if (!appId || publishing) return;
    setShowUnpublish(false);
    setPublishing(true);
    await updateApp(appId, { status: 'draft' });
    const updated = useAppStore.getState().getApp(appId);
    setPublishing(false);
    if (updated && (updated as App).status !== 'published') {
      setApp(updated as App);
      toast.success('Unpublished', 'Your app is now offline.');
    } else {
      toast.error('Unpublish failed', 'Could not take the app offline. Please try again.');
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Deploy & share"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${appId}/settings?tab=manage`)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-3xl mx-auto">

      <div className="space-y-6">
        {/* Status */}
        {app.status === 'published' ? (
          <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200/80 dark:border-emerald-500/20 rounded-2xl p-6">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-emerald-800 dark:text-emerald-400 tracking-tight">App is live</h3>
                <p className="text-sm text-emerald-700 dark:text-emerald-300/70 mt-1 mb-4">Anyone with access can use this app at its share link below.</p>
                <Button variant="outline" onClick={() => setShowUnpublish(true)} disabled={publishing} isLoading={publishing}>Unpublish</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200/80 dark:border-yellow-500/20 rounded-2xl p-6">
            <h3 className="font-medium text-yellow-800 dark:text-yellow-400 mb-2 tracking-tight">App is not published</h3>
            <p className="text-sm text-yellow-700 dark:text-yellow-300/70 mb-4">Publish your app to make it accessible to users.</p>
            <Button onClick={handlePublish} disabled={publishing} isLoading={publishing}>Publish app</Button>
          </div>
        )}

        {/* Share Link */}
        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Globe className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">Share link</h3>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={appUrl}
              aria-label="App share URL"
              onFocus={(e) => e.target.select()}
              className="flex-1 min-w-0 px-3.5 py-2.5 bg-gray-50 dark:bg-slate-800 rounded-xl border border-gray-200/80 dark:border-slate-700/60 text-sm text-gray-700 dark:text-slate-300 font-mono overflow-hidden text-ellipsis focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            />
            <Button variant="outline" size="sm" onClick={handleCopy} leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.open(appUrl, '_blank', 'noopener,noreferrer')} leftIcon={<ExternalLink className="h-4 w-4" />}>
              Open
            </Button>
          </div>
        </div>

        {/* PWA */}
        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Smartphone className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">Progressive Web App</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
            Users can install this app on their mobile devices for a native-like experience.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label htmlFor="pwa-short-name" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Install name</label>
              <input
                id="pwa-short-name"
                type="text"
                value={pwaShortName}
                maxLength={12}
                onChange={(e) => setPwaShortName(e.target.value)}
                placeholder={app.name.slice(0, 12)}
                className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Short label shown under the home-screen icon (max 12 chars).</p>
            </div>
            <div>
              <label htmlFor="pwa-theme-color" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Theme color</label>
              <div className="flex gap-2 items-center">
                <input id="pwa-theme-color" type="color" aria-label="PWA theme color picker" value={pwaThemeColor} onChange={(e) => setPwaThemeColor(e.target.value)} className="h-10 w-12 rounded-lg border border-gray-300 dark:border-slate-600 cursor-pointer" />
                <input type="text" aria-label="PWA theme color hex value" value={pwaThemeColor} onChange={(e) => setPwaThemeColor(e.target.value)} onBlur={(e) => { if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) setPwaThemeColor('#6366f1'); }} className="flex-1 px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all" />
              </div>
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Browser/status-bar color when the app is installed.</p>
            </div>
          </div>
          <div className="flex justify-end mb-4">
            <Button size="sm" onClick={handleSavePwa} isLoading={savingPwa} disabled={savingPwa}>Save PWA settings</Button>
          </div>
          <div className="bg-gray-50 dark:bg-slate-800 rounded-xl p-4 text-sm text-gray-600 dark:text-slate-400">
            <p className="font-medium mb-2">Install instructions:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Open the app URL on a mobile device</li>
              <li>In Chrome: tap the menu and select "Install app"</li>
              <li>In Safari: tap the share button and select "Add to Home Screen"</li>
            </ol>
          </div>
        </div>

        {/* Custom domains */}
        <CustomDomainsPanel appId={appId!} appSlug={app.slug} />

        {/* App logic (QuickJS) */}
        <AppLogicPanel appId={appId!} initialLogic={app.customLogic} />

        {/* Application package */}
        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Package className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">Application package</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
            Export this app (forms, screens, reports, roles, and app logic) as a signed
            <span className="font-mono"> .formlogic-app</span> package — portable, and verifiable against FormLogic's key.
            The <span className="font-mono">.formlogic-app</span> archive additionally bundles the QuickJS logic and any assets as a ZIP.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={handleExportPackage} isLoading={exporting} disabled={exporting} leftIcon={<Download className="h-4 w-4" />}>
              Export signed package (JSON)
            </Button>
            <Button variant="outline" onClick={handleExportArchive} isLoading={exportingArchive} disabled={exportingArchive} leftIcon={<Download className="h-4 w-4" />}>
              Export archive (ZIP)
            </Button>
          </div>
        </div>
      </div>
    </div>
    </div>
      <ConfirmDialog
        isOpen={showUnpublish}
        onClose={() => setShowUnpublish(false)}
        onConfirm={handleUnpublish}
        title="Take this app offline?"
        message="Users will lose access until you republish. Existing data is kept."
        confirmLabel="Unpublish"
        variant="danger"
      />
    </div>
  );
}
