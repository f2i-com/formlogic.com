// Local runtime panel for the Deploy & Share page (docs/FORMLOGIC_DESKTOP.md §3/§5).
//
// Generic over the local runtime that backs device plugins + hardware connectors:
//   • OAIY Desktop — the successor (oaiy.com), on 127.0.0.1:17972. PREFERRED
//     whenever present; this is what will fully replace FormLogic Desktop.
//   • FormLogic Desktop — the original companion, on 127.0.0.1:17872. Used only
//     when OAIY is not detected, until OAIY is fully working.
//
// The panel detects both, connects whichever the user has, and — once connected —
// lists that runtime's plugins. The two pair differently and the panel surfaces
// whichever applies: OAIY shows a short CODE the user confirms in the OAIY window;
// FormLogic Desktop shows a native OS confirmation. Connector status + demo
// simulation stay with the APP that registers the pack connector, not this host
// panel.
//
// On a successful FormLogic Desktop pairing the server-side registry
// (POST /api/desktop-connections, owned by the Flows backend) is updated
// best-effort: a 404/failed call never blocks pairing.
import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, Play, Plug, RefreshCw, Square, Unplug } from 'lucide-react';
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
import {
  getOaiyStatus,
  refreshOaiyStatus,
  subscribeOaiyStatus,
} from '../../client-runtime/oaiy/oaiyDetection';
import {
  isOaiyPaired,
  listOaiyPlugins,
  setOaiyToken,
  startOaiyPlugin,
  stopOaiyPlugin,
  subscribeOaiyPaired,
  type OaiyInfo,
  type OaiyPluginSummary,
} from '../../client-runtime/oaiy/oaiyRuntime';
import { pairWithOaiy } from '../../client-runtime/oaiy/oaiyPairing';

type PairingUiState = 'idle' | 'pending' | 'approved' | 'denied' | 'failed';

/** Which local runtime the panel is currently talking to. OAIY wins when present. */
type ActiveRuntime = 'oaiy' | 'desktop';

/** One list row, common to both runtimes' plugin summaries. */
type PluginRow = DesktopPluginSummary | OaiyPluginSummary;

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

const RUNTIME_LABEL: Record<ActiveRuntime, string> = {
  oaiy: 'OAIY Desktop',
  desktop: 'FormLogic Desktop',
};

export function LocalRuntimePanel() {
  const [oaiy, setOaiy] = useState<OaiyInfo>(() => getOaiyStatus());
  const [desktop, setDesktop] = useState<DesktopInfo>(() => getDesktopInfo());
  const [oaiyPaired, setOaiyPairedState] = useState<boolean>(() => isOaiyPaired());
  const [desktopPaired, setDesktopPairedState] = useState<boolean>(() => isDesktopPaired());
  const [pairing, setPairing] = useState<PairingUiState>('idle');
  /** The OAIY confirmation code to show the user while a request is pending. */
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<PluginRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Plugin ids with an in-flight start/stop, so their button shows a spinner. */
  const [pluginBusy, setPluginBusy] = useState<Set<string>>(new Set());

  // Detection runs only while this panel (or the app runtime) is subscribed.
  useEffect(() => subscribeOaiyStatus(setOaiy), []);
  useEffect(() => subscribeDesktopStatus(setDesktop), []);
  // Reflect token changes (incl. a silent reconnect completing) without a reload.
  useEffect(() => subscribeOaiyPaired(setOaiyPairedState), []);
  useEffect(() => subscribeDesktopPaired(setDesktopPairedState), []);

  // OAIY is the preferred runtime: when it is present, it IS the active one, and
  // FormLogic Desktop is not surfaced for connection (it stays a silent connector
  // fallback). FormLogic Desktop is active only when OAIY is absent.
  const active: ActiveRuntime | null = oaiy.available ? 'oaiy' : desktop.available ? 'desktop' : null;
  const activePaired = active === 'oaiy' ? oaiyPaired : active === 'desktop' ? desktopPaired : false;
  const activeVersion = active === 'oaiy' ? oaiy.version : active === 'desktop' ? desktop.version : undefined;
  const activeLabel = active ? RUNTIME_LABEL[active] : null;
  const detected = active !== null;
  // The OTHER runtime, when it is also running — a small note, since only one is active.
  const alsoRunning =
    active === 'oaiy' && desktop.available ? 'FormLogic Desktop' : active === 'desktop' && oaiy.available ? 'OAIY Desktop' : null;

  // Auto-reconnect is a FormLogic Desktop capability (origin-trusted silent
  // re-pair). Only attempt it when FormLogic Desktop is the active runtime — OAIY
  // has no silent path (every OAIY pairing needs an explicit approval).
  useEffect(() => {
    if (active === 'desktop' && desktop.available && !desktopPaired) void attemptSilentReconnect();
  }, [active, desktop.available, desktopPaired]);

  const loadDetails = useCallback(async () => {
    if (active === 'oaiy' && isOaiyPaired()) {
      setPlugins(await listOaiyPlugins());
      return;
    }
    if (active === 'desktop' && isDesktopPaired()) {
      const res = await desktopClient.plugins.list();
      // A 401 drops the token inside the client — reflect that instead of a stale list.
      setDesktopPairedState(isDesktopPaired());
      setPlugins(res.ok ? res.data : null);
      return;
    }
    setPlugins(null);
  }, [active]);

  useEffect(() => {
    // Deliberate load-on-mount/-on-change: loadDetails only clears stale state
    // before the async fetch.
    void loadDetails();
  }, [active, oaiyPaired, desktopPaired, loadDetails]);

  const connectOaiy = async () => {
    setPairing('pending');
    setPairCode(null);
    // product stays generic ('formlogic'); OAIY stores + echoes it, never parses
    // it. The label is this origin, which OAIY shows in its approval prompt.
    const res = await pairWithOaiy('formlogic', window.location.origin, {
      onPending: (h) => setPairCode(h.code),
    });
    if (res.state === 'approved') {
      setPairing('approved');
      setPairCode(null);
      // pairWithOaiy already stored the token (→ subscribeOaiyPaired fired).
      toast.success('OAIY Desktop connected', 'Flows on this machine now run through OAIY Desktop.');
      void loadDetails();
      return;
    }
    setPairCode(null);
    if (res.state === 'denied') {
      setPairing('denied');
      toast.warning('Pairing denied', 'The request was declined in OAIY Desktop.');
    } else {
      setPairing('failed');
      toast.warning('Pairing didn’t complete', 'Approve the request in OAIY Desktop, then try again.');
    }
  };

  const connectDesktop = async () => {
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
    setDesktopPairedState(true);
    toast.success('FormLogic Desktop connected', 'This origin is now trusted by your desktop.');

    // Best-effort server registry (Flows backend). A 404 (endpoint not deployed yet) or
    // any error is non-fatal — pairing itself is purely local.
    const desktopInfo = await desktopClient.info();
    const d = desktopInfo.ok ? desktopInfo.data : undefined;
    void api.registerDesktopConnection({
      deviceName: d?.name ?? (d?.platform ? `FormLogic Desktop (${d.platform})` : 'FormLogic Desktop'),
      desktopInstanceId: d?.instanceId ?? desktop.baseUrl,
      capabilities: {
        version: d?.version ?? desktop.version,
        apiVersion: d?.apiVersion ?? desktop.apiVersion,
        pluginApiVersion: d?.pluginApiVersion ?? desktop.pluginApiVersion,
      },
      trustedOrigins: [window.location.origin],
    });

    void loadDetails();
  };

  const handleConnect = () => (active === 'oaiy' ? connectOaiy() : active === 'desktop' ? connectDesktop() : Promise.resolve());

  const handleDisconnect = () => {
    if (active === 'oaiy') {
      setOaiyToken(null); // drops this session's OAIY token (→ subscribeOaiyPaired fires)
      setPairing('idle');
      setPlugins(null);
      toast.info('Disconnected', 'The OAIY Desktop token for this browser session was discarded.');
      return;
    }
    disconnectDesktop(); // drops the token AND suppresses auto-reconnect until an explicit Connect
    setDesktopPairedState(false);
    setPairing('idle');
    setPlugins(null);
    toast.info('Disconnected', 'The pairing token for this browser session was discarded.');
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshOaiyStatus(), refreshDesktopStatus()]);
    await loadDetails();
    setRefreshing(false);
  };

  // Start/stop an OAIY-hosted plugin, then refresh the list so its state badge
  // reflects the new lifecycle. OAIY only — its routes/shapes are known here; the
  // FormLogic Desktop panel was always listing-only.
  const togglePlugin = async (p: PluginRow, start: boolean) => {
    setPluginBusy((s) => new Set(s).add(p.id));
    try {
      const res = start ? await startOaiyPlugin(p.id) : await stopOaiyPlugin(p.id);
      if (!res.ok) {
        toast.error(`Could not ${start ? 'start' : 'stop'} ${p.name ?? p.id}`, res.error);
      }
      await loadDetails();
    } finally {
      setPluginBusy((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <HardDrive className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">Local runtime</h3>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              detected
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                : 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
            }`}
          >
            {detected ? `${activeLabel}${activeVersion ? ` · v${activeVersion}` : ''}` : 'Not detected'}
          </span>
          {detected && (
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                activePaired
                  ? 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20'
                  : 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20'
              }`}
            >
              {activePaired ? 'Connected' : 'Not connected'}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleRefresh} isLoading={refreshing} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
          Check again
        </Button>
      </div>

      <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
        The local runtime is the companion that hosts device plugins, local AI models, and hardware
        connectors on this machine. Apps in this browser talk to it over{' '}
        <span className="font-mono">127.0.0.1</span> — never to raw hardware directly. OAIY Desktop is
        used when present; FormLogic Desktop is the fallback until OAIY fully replaces it.
      </p>

      {!detected && (
        <div className="bg-gray-50 dark:bg-slate-800 rounded-xl p-4 text-sm text-gray-600 dark:text-slate-400 mb-4">
          No local runtime is running on this machine (or none is installed). Start OAIY Desktop (or
          FormLogic Desktop), then click <span className="font-medium">Check again</span>.
        </div>
      )}

      {detected && !activePaired && (
        <div className="mb-4">
          <Button onClick={handleConnect} isLoading={pairing === 'pending'} disabled={pairing === 'pending'} leftIcon={<Plug className="h-4 w-4" />}>
            {pairing === 'pending' ? `Waiting for approval in ${activeLabel}…` : `Connect ${activeLabel}`}
          </Button>
          {active === 'oaiy' && pairing === 'pending' && pairCode && (
            <p className="mt-2 text-xs text-gray-600 dark:text-slate-300">
              Confirm this code matches the prompt in OAIY Desktop:{' '}
              <span className="font-mono font-semibold tracking-widest">{pairCode}</span>
            </p>
          )}
          {pairing === 'denied' && (
            <p className="mt-2 text-xs text-red-500 dark:text-red-400">
              The pairing request was denied in {activeLabel}. You can try again any time.
            </p>
          )}
          {pairing === 'failed' && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Pairing didn’t complete — approve the confirmation in {activeLabel}, then retry.
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-400 dark:text-slate-500">
            {active === 'oaiy' ? (
              <>Approving in OAIY Desktop issues a token this browser session holds — it lives only in this session and you can revoke the connection from OAIY Desktop at any time.</>
            ) : (
              <>Approving on the desktop issues a token bound to <span className="font-mono">{window.location.origin}</span> — other websites cannot reuse it, and it lives only in this browser session.</>
            )}
          </p>
        </div>
      )}

      {detected && activePaired && (
        <div className="space-y-4 mb-4">
          {/* Plugins */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Plugins</p>
            {plugins === null ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
            ) : plugins.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">No plugins installed on this runtime.</p>
            ) : (
              <ul className="space-y-2">
                {plugins.map((p) => {
                  const running = String(p.state) === 'running';
                  const busy = pluginBusy.has(p.id);
                  return (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200/80 dark:border-slate-700/60 px-3 py-2">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{p.name ?? p.id}</span>
                        {p.version && <span className="ml-2 text-xs text-gray-400 dark:text-slate-500 font-mono">v{p.version}</span>}
                        {p.detail && <p className="text-[11px] text-gray-400 dark:text-slate-500 truncate">{p.detail}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <PluginStateBadge state={String(p.state)} />
                        {active === 'oaiy' && (
                          <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={busy}
                            title={running ? 'Stop this plugin' : 'Start this plugin'}
                            onClick={() => togglePlugin(p, !running)}
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : running ? (
                              <Square className="h-3.5 w-3.5" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            {running ? 'Stop' : 'Start'}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-400 dark:text-slate-500">
              Connected to <span className="font-medium">{activeLabel}</span> on this machine. Disconnect here to
              drop this session’s token{active === 'desktop' ? ', or revoke the origin from the desktop’s settings' : ', or revoke this app from OAIY Desktop'}.
            </p>
            <Button variant="ghost" size="sm" onClick={handleDisconnect} leftIcon={<Unplug className="h-3.5 w-3.5" />}>
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {alsoRunning && (
        <p className="text-[11px] text-gray-400 dark:text-slate-500">
          {alsoRunning} is also running on this machine. {activeLabel} is used while it is present.
        </p>
      )}
    </div>
  );
}
