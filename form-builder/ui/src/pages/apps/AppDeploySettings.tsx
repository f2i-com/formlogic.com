import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Check, Globe, Smartphone, ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { toast } from '../../stores/toastStore';
import type { App } from '../../types/app';

export function AppDeploySettings() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { fetchApps, updateApp } = useAppStore();
  const [app, setApp] = useState<App | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchApps().then(() => {
      if (appId) {
        const found = useAppStore.getState().getApp(appId);
        if (found) setApp(found as App);
      }
    });
  }, [appId, fetchApps]);

  if (!app) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading deploy settings" /></div>;
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
    if (!appId) return;
    await updateApp(appId, { status: 'published' });
    // Re-read from store to verify the update succeeded
    const updated = useAppStore.getState().getApp(appId);
    if (updated && (updated as App).status === 'published') {
      setApp({ ...app, status: 'published' });
      toast.success('Published', 'Your app is now live');
    } else {
      toast.error('Publish failed', 'Could not publish the app. Please try again.');
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Deploy & Share"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${appId}/settings`)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-3xl mx-auto">

      <div className="space-y-6">
        {/* Status */}
        {app.status !== 'published' && (
          <div className="bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-xl p-6">
            <h3 className="font-medium text-yellow-800 dark:text-yellow-400 mb-2">App is not published</h3>
            <p className="text-sm text-yellow-700 dark:text-yellow-300/70 mb-4">Publish your app to make it accessible to users.</p>
            <Button onClick={handlePublish}>Publish App</Button>
          </div>
        )}

        {/* Share Link */}
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Globe className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <h3 className="font-medium text-gray-900 dark:text-white">Share Link</h3>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 px-3 py-2 bg-gray-50 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 text-sm text-gray-700 dark:text-slate-300 font-mono overflow-hidden text-ellipsis">
              {appUrl}
            </div>
            <Button variant="outline" size="sm" onClick={handleCopy} leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.open(appUrl, '_blank')} leftIcon={<ExternalLink className="h-4 w-4" />}>
              Open
            </Button>
          </div>
        </div>

        {/* PWA */}
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Smartphone className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <h3 className="font-medium text-gray-900 dark:text-white">Progressive Web App</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
            Users can install this app on their mobile devices for a native-like experience.
          </p>
          <div className="bg-gray-50 dark:bg-slate-800 rounded-lg p-4 text-sm text-gray-600 dark:text-slate-400">
            <p className="font-medium mb-2">Install Instructions:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Open the app URL on a mobile device</li>
              <li>In Chrome: tap the menu and select "Install app"</li>
              <li>In Safari: tap the share button and select "Add to Home Screen"</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
    </div>
    </div>
  );
}
