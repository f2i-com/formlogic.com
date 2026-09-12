import { useCallback, useState } from 'react';
import { HostedAppFrame } from '../studio/HostedAppFrame';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useCustomAppLogic } from '../../client-runtime/logic/useCustomAppLogic';
import { useDesktopConnectorEvents } from '../../client-runtime/desktop/useDesktopConnectorEvents';
import { downloadHostedClient } from '../../lib/hosting';
import template from '../../data/aokie-workspace.json';

/** This portable client can be the home or a view within another app. */
export function AokieWorkspace({ listen = true }: { listen?: boolean }) {
  const slug = useAppRuntimeStore(state => state.appSlug);
  const config = useAppRuntimeStore(state => state.config);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (downloading) return;
    setError('');
    setDownloading(true);
    try { await downloadHostedClient(template.client, 'Aokie front desk'); }
    catch { setError('Could not download the project. Please try again.'); }
    finally { setDownloading(false); }
  };
  const noopApplyValues = useCallback(() => {}, []);
  const { enabled, runConnectorEvent } = useCustomAppLogic({ applyValues: noopApplyValues });
  useDesktopConnectorEvents({ appSlug: slug, enabled: listen && enabled, runConnectorEvent });
  if (!slug) return null;
  return <div className="p-3 sm:p-6">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm"><span className="text-slate-600 dark:text-slate-400">Your app's receptionist workspace</span><button disabled={downloading} className="min-h-11 rounded-lg border border-slate-300 px-4 font-medium disabled:opacity-50 dark:border-slate-600" onClick={() => void download()}>{downloading ? 'Preparing download…' : 'Download editable app'}</button></div>
    {error && <p role="alert">{error}</p>}
    <div className="h-[calc(100dvh-13rem)] min-h-[560px]"><HostedAppFrame slug={slug} client={template.client} version={1} /></div>
    {config?.app.canManage && <p className="mt-3 text-xs text-slate-500">Customise the downloaded project in App hosting, or share these forms with another app in App Studio.</p>}
  </div>;
}
