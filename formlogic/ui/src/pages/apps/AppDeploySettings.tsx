import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReturnTo } from '../../hooks/useReturnTo';
import { Copy, Check, Globe, Smartphone, ExternalLink, CheckCircle2, Package, Download } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useAdminActing, useResourcePaths } from '../../components/admin/AdminActingContext';
import { api } from '../../lib/api';
import { cn, copyToClipboard } from '../../lib/utils';
import { Header } from '../../components/layout/Header';
import { PageBody, PAGE_GUTTER } from '../../components/layout/PageBody';
import { Panel } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CustomDomainsPanel } from '../../components/apps/CustomDomainsPanel';
import { statusLabel } from '../../lib/appStatus';
import { ShareQrCode } from '../../components/ui/ShareQrCode';
import { AppLogicPanel } from '../../components/apps/AppLogicPanel';
import { FlowsPanel } from '../../components/apps/FlowsPanel';
import { LocalRuntimePanel } from '../../components/desktop/LocalRuntimePanel';
import { toast } from '../../stores/toastStore';
import type { App } from '../../types/app';

// The page's text fields and their labels, as the shared Input draws them.
const FIELD = 'w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 transition focus:border-transparent focus:ring-2 focus:ring-primary-500 max-sm:text-base dark:border-slate-600 dark:bg-slate-800 dark:text-white';
const LABEL = 'mb-1.5 block text-sm font-medium text-gray-700 dark:text-slate-300';

export function AppDeploySettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const paths = useResourcePaths();
  // Origin-relative Back: opened from the App Studio this returns to its step.
  const backTo = useReturnTo(paths.appSub(`${appId}`, 'settings?tab=manage'));
  const acting = useAdminActing();
  const { fetchApps, updateApp } = useAppStore();
  const [app, setApp] = useState<App | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pwaShortName, setPwaShortName] = useState('');
  const [pwaThemeColor, setPwaThemeColor] = useState('#6366f1');
  const [savingPwa, setSavingPwa] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // The App logic panel hosts a Monaco editor; without a dirty signal, Back or a
  // sidebar click threw away however long the owner had spent in it.
  const [logicDirty, setLogicDirty] = useState(false);
  const pwaDirty = !!app && (
    pwaShortName !== (app.settings?.pwaShortName ?? app.name.slice(0, 12))
    || pwaThemeColor !== (app.settings?.pwaThemeColor ?? app.theme?.primaryColor ?? '#6366f1')
  );
  const dirty = logicDirty || pwaDirty;
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [showUnpublish, setShowUnpublish] = useState(false);

  // Warn on tab close / refresh while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

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
    // Merge onto the CURRENT settings, read at click time. `app` is captured once at
    // mount, so spreading it replayed a stale blob and reverted whatever the Studio
    // (or a second tab, or a chat tool) had saved in the meantime — landing screen,
    // sign-up settings, icon, timezone — with no warning.
    const current = useAppStore.getState().getApp(appId)?.settings ?? app.settings;
    const ok = await updateApp(appId, { settings: { ...current, pwaShortName, pwaThemeColor } });
    setSavingPwa(false);
    if (ok) {
      // Re-sync this page's own copy, or the NEXT save here replays the stale one again.
      const fresh = useAppStore.getState().getApp(appId) as App | undefined;
      if (fresh) setApp(fresh);
      toast.success('PWA settings saved', 'Install name and theme color updated.');
    }
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
    a.download = `${app.slug}.formlogic.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    toast.success('Package exported', 'Signed .formlogic downloaded.');
  };

  const [exportingArchive, setExportingArchive] = useState(false);
  const handleExportArchive = async () => {
    if (!appId || !app || exportingArchive) return;
    setExportingArchive(true);
    try {
      // Full .formlogic ARCHIVE (ZIP): manifest + pack + quickjs/customLogic.json (historical entry name
      // for the sandboxed app logic) + assets + detached signature.
      await api.exportAppPackageArchive(appId, app.slug);
      toast.success('Package exported', 'Downloaded a .formlogic archive.');
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined);
    } finally {
      setExportingArchive(false);
    }
  };

  if (!app) {
    // The page's frame from the first paint: the header and Back, then what is known so far.
    return (
      <div className="min-h-screen">
        <Header title="Deploy & share" back={{ onClick: () => navigate(backTo.path, { state: backTo.state }), label: backTo.label ? `Back to ${backTo.label}` : 'Back to app settings' }} />
        {!loaded ? (
          <div className={cn('flex items-center gap-3 py-8 text-sm text-gray-500 dark:text-slate-400', PAGE_GUTTER)}>
            <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading deploy settings" />
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

  const appUrl = `${window.location.origin}/app/${app.slug}`;

  const handleCopy = async () => {
    // One shared helper (secure-context Clipboard API, legacy textarea fallback) —
    // the hand-rolled duplicate here is how the domains panel drifted into a version
    // that failed silently on plain HTTP.
    if (await copyToClipboard(appUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Copy failed', 'Select the link and copy it manually.');
    }
  };

  /**
   * Going live is owned by the App Studio's Review & publish section, which runs the
   * preflight and records a version. This page used to flip `status` directly: that
   * produced a live app with no version and no publishedAt, and the Studio then had
   * nothing to compare against — its Publish button stayed disabled forever. Deploy
   * now reports the status and hands off.
   *
   * Platform admins acting on someone else's app have no Studio route (the acting
   * boundary registers no `studio` child), so they keep a direct control here rather
   * than a link to a page that does not exist for them.
   */
  const openPublish = () => navigate(paths.appSub(`${appId}`, 'studio/publish'));

  const setStatus = async (status: 'published' | 'draft') => {
    if (!appId || publishing) return;
    setShowUnpublish(false);
    setPublishing(true);
    await updateApp(appId, { status });
    const updated = useAppStore.getState().getApp(appId) as App | undefined;
    setPublishing(false);
    if (updated && updated.status === status) {
      setApp(updated);
      toast.success(status === 'published' ? 'Published' : 'Unpublished',
        status === 'published' ? 'The app is now live.' : 'The app is now offline.');
    } else {
      toast.error(status === 'published' ? 'Publish failed' : 'Unpublish failed', 'Please try again.');
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Deploy & share"
        back={{ onClick: () => { if (dirty) setPendingNav(backTo.path); else navigate(backTo.path, { state: backTo.state }); }, label: backTo.label ? `Back to ${backTo.label}` : 'Back to app settings' }}
      />
      {/* Left-aligned and as wide as the page. The app's state in one strip, then what there is
          to share and install in two columns of panels; the app's logic and its flows, which
          hold an editor and lists, take the whole width under them. */}
      <PageBody className="@container/page">
        {/* Status — publishing itself lives in the App Studio (versioned + preflight). */}
        {app.status === 'published' ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-emerald-200/80 bg-emerald-50 px-4 py-3 dark:border-emerald-500/20 dark:bg-emerald-500/10">
            <CheckCircle2 className="h-5 w-5 flex-none text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0 flex-1 basis-64">
              <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-400">
                {statusLabel(app)}
              </h2>
              <p className="mt-0.5 text-sm text-emerald-700 dark:text-emerald-300/70">
                Anyone with access can use this app at its share link below.
                {acting ? '' : ' Releases, the release log and taking the app offline live in Review & publish.'}
              </p>
            </div>
            {acting ? (
              <Button variant="outline" size="sm" onClick={() => setShowUnpublish(true)} disabled={publishing} isLoading={publishing}>Unpublish</Button>
            ) : (
              <Button variant="outline" size="sm" onClick={openPublish}>Review &amp; publish</Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-yellow-200/80 bg-yellow-50 px-4 py-3 dark:border-yellow-500/20 dark:bg-yellow-500/10">
            <div className="min-w-0 flex-1 basis-64">
              <h2 className="text-sm font-semibold text-yellow-800 dark:text-yellow-400">App is not published</h2>
              <p className="mt-0.5 text-sm text-yellow-700 dark:text-yellow-300/70">
                {acting
                  ? 'Publish this app to make it accessible to its users.'
                  : 'Publishing runs the readiness checks and records a version, so it happens in the App Studio.'}
              </p>
            </div>
            {acting ? (
              <Button size="sm" onClick={() => void setStatus('published')} disabled={publishing} isLoading={publishing}>Publish app</Button>
            ) : (
              <Button size="sm" onClick={openPublish}>Review &amp; publish</Button>
            )}
          </div>
        )}

        <div className="mt-4 grid items-start gap-4 @4xl/page:grid-cols-2">
          <div className="min-w-0 space-y-4">
            {/* Share Link */}
            <Panel title="Share link" icon={<Globe className="h-4 w-4" />}>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={appUrl}
                  aria-label="App share URL"
                  onFocus={(e) => e.target.select()}
                  className={cn(FIELD, 'min-w-0 flex-1 basis-56 overflow-hidden text-ellipsis border-gray-200/80 bg-gray-50 font-mono text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700/60 dark:text-slate-300')}
                />
                <Button variant="outline" size="sm" onClick={handleCopy} leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="outline" size="sm" disabled={!!acting} title={acting ? 'The live app shows record data, which is not visible to platform admins' : undefined} onClick={() => window.open(appUrl, '_blank', 'noopener,noreferrer')} leftIcon={<ExternalLink className="h-4 w-4" />}>
                  Open
                </Button>
              </div>
              <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
                <ShareQrCode url={appUrl} downloadName={`${app.slug}-qr`} size={144} />
                <div className="min-w-0 text-sm text-gray-600 dark:text-slate-400">
                  <p className="mb-1 font-medium text-gray-900 dark:text-white">Share by QR code</p>
                  <p>Anyone who scans this opens your app straight away — print it, put it on a poster, or drop it in a slide deck.</p>
                </div>
              </div>
            </Panel>

            {/* PWA */}
            <Panel title="Progressive Web App" icon={<Smartphone className="h-4 w-4" />} description="Users can install this app on their mobile devices for a native-like experience.">
              <div className="@container/pwa">
              <div className="mb-3 grid grid-cols-1 gap-4 @md/pwa:grid-cols-2">
                <div>
                  <label htmlFor="pwa-short-name" className={LABEL}>Install name</label>
                  <input
                    id="pwa-short-name"
                    type="text"
                    value={pwaShortName}
                    maxLength={12}
                    onChange={(e) => setPwaShortName(e.target.value)}
                    placeholder={app.name.slice(0, 12)}
                    className={FIELD}
                  />
                  <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">Short label shown under the home-screen icon (max 12 chars).</p>
                </div>
                <div>
                  <label htmlFor="pwa-theme-color" className={LABEL}>Theme color</label>
                  <div className="flex items-center gap-2">
                    <input id="pwa-theme-color" type="color" aria-label="PWA theme color picker" value={pwaThemeColor} onChange={(e) => setPwaThemeColor(e.target.value)} className="h-10 w-12 flex-none cursor-pointer rounded-lg border border-gray-300 dark:border-slate-600" />
                    <input type="text" aria-label="PWA theme color hex value" value={pwaThemeColor} onChange={(e) => setPwaThemeColor(e.target.value)} onBlur={(e) => { if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) setPwaThemeColor('#6366f1'); }} className={cn(FIELD, 'flex-1 font-mono')} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">Browser/status-bar color when the app is installed.</p>
                </div>
              </div>
              <div className="mb-4">
                <Button size="sm" onClick={handleSavePwa} isLoading={savingPwa} disabled={savingPwa}>Save PWA settings</Button>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-xs leading-5 text-gray-600 dark:bg-slate-800 dark:text-slate-400">
                <p className="mb-1 font-medium">Install instructions:</p>
                <ol className="list-inside list-decimal space-y-0.5">
                  <li>Open the app URL on a mobile device</li>
                  <li>In Chrome: tap the menu and select "Install app"</li>
                  <li>In Safari: tap the share button and select "Add to Home Screen"</li>
                </ol>
              </div>
              </div>
            </Panel>
          </div>

          <div className="min-w-0 space-y-4">
            {/* Custom domains */}
            <CustomDomainsPanel appId={appId!} appSlug={app.slug} published={app.status === 'published'} />

            {/* Local runtime (OAIY Desktop, or FormLogic Desktop as fallback) — hidden
                while acting: this panel shows the signed-in ADMIN's own machine, not the owner's. */}
            {!acting && <LocalRuntimePanel />}

            {/* Application package — hidden while acting (exports can embed seeded records;
                the API layer refuses them for admins regardless) */}
            {!acting && <Panel title="Application package" icon={<Package className="h-4 w-4" />}>
              <p className="mb-3 text-sm text-gray-600 dark:text-slate-400">
                Export this app (forms, screens, reports, roles, and app logic) as a signed
                <span className="font-mono"> .formlogic</span> package — portable, and verifiable against FormLogic's key.
                The <span className="font-mono">.formlogic</span> archive additionally bundles the app logic and any assets as a ZIP.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleExportPackage} isLoading={exporting} disabled={exporting} leftIcon={<Download className="h-4 w-4" />}>
                  Export signed package (JSON)
                </Button>
                <Button variant="outline" size="sm" onClick={handleExportArchive} isLoading={exportingArchive} disabled={exportingArchive} leftIcon={<Download className="h-4 w-4" />}>
                  Export archive (ZIP)
                </Button>
              </div>
            </Panel>}
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {/* App logic */}
          <AppLogicPanel appId={appId!} initialLogic={app.customLogic} onDirtyChange={setLogicDirty} />

          {/* FormLogic Flows (event-driven automations, docs/FORMLOGIC_FLOWS.md) */}
          <FlowsPanel appId={appId!} appSlug={app.slug} />
        </div>
      </PageBody>
      <ConfirmDialog
        isOpen={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        onConfirm={() => { const to = pendingNav; setPendingNav(null); if (to) navigate(to, { state: backTo.state }); }}
        title="Discard unsaved changes?"
        message="You have unsaved app logic or PWA settings on this page. Leaving now discards them."
        confirmLabel="Discard and leave"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={showUnpublish}
        onClose={() => setShowUnpublish(false)}
        onConfirm={() => void setStatus('draft')}
        title="Take this app offline?"
        message="Users will lose access until it is published again. Existing data is kept."
        confirmLabel="Unpublish"
        variant="danger"
      />
    </div>
  );
}
