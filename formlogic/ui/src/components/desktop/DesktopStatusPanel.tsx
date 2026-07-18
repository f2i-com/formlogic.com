// FormLogic Desktop panel for the Deploy & Share page (docs/FORMLOGIC_DESKTOP.md §3/§5).
//
// Shows whether FormLogic Desktop is running on this machine, runs the pairing flow
// ("Connect FormLogic Desktop" → native confirmation on the desktop → origin-bound
// token), and — once paired — lists the desktop's plugins. Connector status +
// demo simulation belong to the APP that registers the pack connector (its own
// screens / host ceremonies), not to this host panel.
//
// On a successful pairing the server-side registry (POST /api/desktop-connections, owned
// by the Flows backend) is updated best-effort: a 404/failed call never blocks pairing.
import { useCallback, useEffect, useState } from 'react';
import { Laptop, Plug, RefreshCw, Unplug } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { toast } from '../../stores/toastStore';
import {
  getDesktopInfo,
  refreshDesktopStatus,
  subscribeDesktopStatus,
  type DesktopInfo,
} from '../../client-runtime/desktop/desktopDetection';
import {
  allowAutoReconnect,
  attemptSilentReconnect,
  disconnectDesktop,
  isDesktopPaired,
  pollPairing,
  requestPairing,
  subscribeDesktopPaired,
} from '../../client-runtime/desktop/desktopPairing';
import { desktopClient } from '../../client-runtime/desktop/desktopClient';
import type { DesktopPluginSummary } from '../../client-runtime/desktop/desktopTypes';

type PairingUiState = 'idle' | 'pending' | 'approved' | 'denied' | 'failed';

/** Plugin lifecycle badge — colour semantics match the domain StatusBadge conventions. */
function PluginStateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    running: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20',
    starting: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20',
    unhealthy: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20',
    crashed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20',
    disabled: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  };
  const fallback = 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[state] ?? fallback}`}>
      {state}
    </span>
  );
}

export function DesktopStatusPanel() {
  const [info, setInfo] = useState<DesktopInfo>(() => getDesktopInfo());
  const [paired, setPaired] = useState<boolean>(() => isDesktopPaired());
  const [pairing, setPairing] = useState<PairingUiState>('idle');
  const [plugins, setPlugins] = useState<DesktopPluginSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Detection runs only while this panel (or the app runtime) is mounted/subscribed.
  useEffect(() => subscribeDesktopStatus(setInfo), []);

  // Reflect token changes (incl. a silent reconnect completing) without a reload.
  useEffect(() => subscribeDesktopPaired(setPaired), []);

  // Auto-reconnect: when the desktop is detected but this browser session has no
  // token (the session-scoped token dies on browser restart), silently re-pair
  // IF the desktop already trusts this origin — no native prompt, no click. A
  // never-trusted origin no-ops here and the explicit "Connect" button shows.
  useEffect(() => {
    if (info.available && !paired) void attemptSilentReconnect();
  }, [info.available, paired]);

  const loadDesktopDetails = useCallback(async () => {
    if (!getDesktopInfo().available || !isDesktopPaired()) {
      setPlugins(null);
      setPaired(isDesktopPaired());
      return;
    }
    const pluginsRes = await desktopClient.plugins.list();
    // A 401 drops the token inside the client — reflect that instead of stale lists.
    setPaired(isDesktopPaired());
    setPlugins(pluginsRes.ok ? pluginsRes.data : null);
  }, []);

  useEffect(() => {
    void loadDesktopDetails();
  }, [info.available, paired, loadDesktopDetails]);

  const handleConnect = async () => {
    allowAutoReconnect(); // the user chose to connect — undo any prior explicit disconnect
    setPairing('pending');
    const begun = await requestPairing(window.location.origin);
    if (!begun || !begun.requestId) {
      setPairing('failed');
      toast.error('Could not reach FormLogic Desktop', 'Make sure it is running, then try again.');
      return;
    }
    const result = await pollPairing(begun.requestId);
    if (result.status !== 'approved') {
      setPairing(result.status === 'denied' ? 'denied' : 'failed');
      if (result.status === 'denied') {
        toast.warning('Pairing denied', 'The request was declined on the desktop.');
      } else {
        toast.warning('Pairing timed out', 'Approve the request on the desktop and try again.');
      }
      return;
    }
    setPairing('approved');
    setPaired(true);
    toast.success('FormLogic Desktop connected', 'This origin is now trusted by your desktop.');

    // Best-effort server registry (Flows backend). A 404 (endpoint not deployed yet) or
    // any error is non-fatal — pairing itself is purely local.
    const desktopInfo = await desktopClient.info();
    const d = desktopInfo.ok ? desktopInfo.data : undefined;
    void api.registerDesktopConnection({
      deviceName: d?.name ?? (d?.platform ? `FormLogic Desktop (${d.platform})` : 'FormLogic Desktop'),
      desktopInstanceId: d?.instanceId ?? info.baseUrl,
      capabilities: {
        version: d?.version ?? info.version,
        apiVersion: d?.apiVersion ?? info.apiVersion,
        pluginApiVersion: d?.pluginApiVersion ?? info.pluginApiVersion,
      },
      trustedOrigins: [window.location.origin],
    });

    void loadDesktopDetails();
  };

  const handleDisconnect = () => {
    disconnectDesktop(); // drops the token AND suppresses auto-reconnect until an explicit Connect
    setPaired(false);
    setPairing('idle');
    setPlugins(null);
    toast.info('Disconnected', 'The pairing token for this browser session was discarded.');
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshDesktopStatus();
    await loadDesktopDetails();
    setRefreshing(false);
  };

  const detected = info.available;

  return (
    <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <Laptop className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">FormLogic Desktop</h3>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              detected
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                : 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
            }`}
          >
            {detected ? `Detected${info.version ? ` · v${info.version}` : ''}` : 'Not detected'}
          </span>
          {detected && (
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                paired
                  ? 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20'
                  : 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20'
              }`}
            >
              {paired ? 'Paired' : 'Not paired'}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleRefresh} isLoading={refreshing} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
          Check again
        </Button>
      </div>

      <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
        FormLogic Desktop is the local companion that hosts device plugins,
        local AI models, and hardware connectors. Apps in this browser talk to it over{' '}
        <span className="font-mono">127.0.0.1</span> — never to raw hardware directly.
      </p>

      {!detected && (
        <div className="bg-gray-50 dark:bg-slate-800 rounded-xl p-4 text-sm text-gray-600 dark:text-slate-400 mb-4">
          FormLogic Desktop isn’t running on this machine (or hasn’t been installed). Start it, then click{' '}
          <span className="font-medium">Check again</span>.
        </div>
      )}

      {detected && !paired && (
        <div className="mb-4">
          <Button onClick={handleConnect} isLoading={pairing === 'pending'} disabled={pairing === 'pending'} leftIcon={<Plug className="h-4 w-4" />}>
            {pairing === 'pending' ? 'Waiting for approval on the desktop…' : 'Connect FormLogic Desktop'}
          </Button>
          {pairing === 'denied' && (
            <p className="mt-2 text-xs text-red-500 dark:text-red-400">
              The pairing request was denied on the desktop. You can try again any time.
            </p>
          )}
          {pairing === 'failed' && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Pairing didn’t complete — approve the confirmation on the desktop, then retry.
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-400 dark:text-slate-500">
            Approving on the desktop issues a token bound to <span className="font-mono">{window.location.origin}</span> —
            other websites cannot reuse it, and it lives only in this browser session.
          </p>
        </div>
      )}

      {detected && paired && (
        <div className="space-y-4 mb-4">
          {/* Plugins */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Plugins</p>
            {plugins === null ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
            ) : plugins.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">No plugins installed on this desktop.</p>
            ) : (
              <ul className="space-y-2">
                {plugins.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200/80 dark:border-slate-700/60 px-3 py-2">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{p.name ?? p.id}</span>
                      {p.version && <span className="ml-2 text-xs text-gray-400 dark:text-slate-500 font-mono">v{p.version}</span>}
                      {p.detail && <p className="text-[11px] text-gray-400 dark:text-slate-500 truncate">{p.detail}</p>}
                    </div>
                    <PluginStateBadge state={String(p.state)} />
                  </li>
                ))}
              </ul>
            )}
          </div>


          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-400 dark:text-slate-500">
              This desktop trusts <span className="font-mono">{window.location.origin}</span>. Revoke it any time from
              the desktop’s settings — or disconnect here to drop this session’s token.
            </p>
            <Button variant="ghost" size="sm" onClick={handleDisconnect} leftIcon={<Unplug className="h-3.5 w-3.5" />}>
              Disconnect
            </Button>
          </div>
        </div>
      )}

    </div>
  );
}
