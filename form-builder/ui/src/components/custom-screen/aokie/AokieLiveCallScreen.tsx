// Aokie Receptionist — Live Call screen (trusted host-rendered SDK screen, spec §27.2/§28).
//
// The operator's view of the phone bridge: the current call card (connector `call.current`),
// a live transcript feed from the desktop event hub, and answer / hang up / operator-speak
// controls through the permission-gated aokie connector client. Buttons are disabled when
// the app lacks the connector grant OR the viewer's role can't write to the Calls form —
// the connector layer and server stay the real trust boundary either way.
//
// With no FormLogic Desktop around the screen degrades to a friendly "Install FormLogic
// Desktop" state; the mock connector still serves reads, and a demo button drives the
// contract's scripted call lifecycle (AOKIE_PLUGIN_CONTRACT.md §4) so the whole flow —
// events → app logic → Calls records → dashboards — is explorable with zero hardware.
//
// REMOTE VIEWER (docs/FORMLOGIC_FLOWS.md §14): when the receptionist runs headless in
// FormLogic Desktop on ANOTHER machine (fresh desktop_connections row, or a recently
// desktop-claimed flow run as the member-visible fallback), this screen turns into a
// read-only monitor — the setup/simulate card hides, the call card + transcript render
// from stored Calls/Transcript Turns records, and both refresh every 10s while visible.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cast,
  Laptop,
  Mic,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  Send,
} from 'lucide-react';
import { EmptyState, useConnector, useConnectorPermission, useForms, usePermissions, useResponses } from '../../../sdk';
import { useAppRuntimeStore } from '../../../stores/appRuntimeStore';
import { toast } from '../../../stores/toastStore';
import { api } from '../../../lib/api';
import { subscribeDesktopEvents } from '../../../client-runtime/desktop/desktopEvents';
import { getDesktopInfo, subscribeDesktopStatus } from '../../../client-runtime/desktop/desktopDetection';
import { isDesktopPaired } from '../../../client-runtime/desktop/desktopPairing';
import { simulateIncomingCall } from '../../../client-runtime/connectors/aokieConnector';
import type { DesktopEventEnvelope } from '../../../client-runtime/desktop/desktopTypes';
import {
  REMOTE_RECORDS_POLL_MS,
  deriveRemoteCall,
  selectTurnsForCall,
  showSimulateSetup,
} from './aokiePresence';
import {
  canRunCommand,
  describeRelayOutcome,
  dispatchCallCommand,
  performRelayCommand,
  type CallOverlay,
} from './aokieRelay';
import { useAokiePresence } from './useAokiePresence';

const CALL_POLL_MS = 7000;

interface LiveCall {
  callId: string;
  from?: string;
  callerName?: string;
  state: 'ringing' | 'active' | 'ended';
  startedAt?: string;
}

interface TranscriptTurn {
  key: string;
  speaker: string;
  text: string;
  occurredAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function callFromEventData(callId: string, data: Record<string, unknown>, state: LiveCall['state']): LiveCall {
  return {
    callId,
    from: typeof data.from === 'string' ? data.from : typeof data.callerPhone === 'string' ? data.callerPhone : undefined,
    callerName: typeof data.callerName === 'string' ? data.callerName : undefined,
    state,
    startedAt: new Date().toISOString(),
  };
}

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';
const actionBtn =
  'inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45';

export function AokieLiveCallScreen({ params }: { params?: Record<string, unknown> }) {
  const callsFormId = typeof params?.formId === 'string' ? params.formId : undefined;
  const connector = useConnector('aokie', callsFormId ? { formId: callsFormId } : undefined);
  const { can } = useConnectorPermission('aokie', undefined, callsFormId ? { formId: callsFormId } : undefined);
  const permissions = usePermissions();
  const canSubmitCalls = useAppRuntimeStore((s) => s.canSubmit);
  const appSlug = useAppRuntimeStore((s) => s.appSlug);

  const [desktop, setDesktop] = useState(() => getDesktopInfo());
  const [paired, setPaired] = useState(() => isDesktopPaired());
  const [call, setCall] = useState<LiveCall | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [speakText, setSpeakText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  // Remote-mode relay: optimistic call-state overlay, in-flight command, and last round-trip latency.
  const [overlay, setOverlay] = useState<CallOverlay | null>(null);
  const [relayBusy, setRelayBusy] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  // Runtime presence: local bridge / remote desktop / neither (§14 remote viewer).
  const presence = useAokiePresence();
  const remoteMode = presence.kind === 'remote';

  // In local/no-desktop mode the recent-calls list has no other refresh, so poll
  // it every 10s to track in-flight calls (not just 1.5s after one ends). Remote
  // mode already polls both lists on its own timer below, so skip it there.
  const recent = useResponses(callsFormId ?? '', { limit: 8, pollInterval: remoteMode ? undefined : 10 });

  // Remote mode reads the stored Transcript Turns records (the local hub feed cannot exist
  // here). The form is resolved by its app display name — the same convention the pack's
  // app-logic formKeys rely on.
  const forms = useForms();
  const turnsFormId = useMemo(() => forms.find((f) => f.displayName === 'Transcript Turns')?.formId, [forms]);
  const storedTurns = useResponses((remoteMode ? turnsFormId : undefined) ?? '', { limit: 60 });

  // Role gate: operating the call maps to being allowed to write Calls records. Viewers
  // (no submit_responses on the Calls form) see everything but can't drive the phone.
  const roleAllowsOperating = callsFormId ? canSubmitCalls(callsFormId) : permissions.appLevel.includes('manage_app');

  useEffect(() => subscribeDesktopStatus((info) => { setDesktop(info); setPaired(isDesktopPaired()); }), []);

  // Poll call.current so a refreshed page picks up an in-flight call (permission-aware).
  const refreshCall = useCallback(async () => {
    if (!can('call.current')) return;
    try {
      const res = asRecord(await connector.request('call.current'));
      const c = asRecord(res.call);
      if (typeof c.callId === 'string') {
        setCall({
          callId: c.callId,
          from: typeof c.from === 'string' ? c.from : undefined,
          callerName: typeof c.callerName === 'string' ? c.callerName : undefined,
          state: c.state === 'active' ? 'active' : c.state === 'ended' ? 'ended' : 'ringing',
          startedAt: typeof c.startedAt === 'string' ? c.startedAt : undefined,
        });
      } else {
        setCall((prev) => (prev && prev.state !== 'ended' ? prev : null));
      }
    } catch {
      // Bridge unreachable — the event feed still drives the card.
    }
  }, [connector, can]);

  useEffect(() => {
    // Remote mode: the connector here is the browser mock — polling it would only
    // overwrite the record-derived call card with mock emptiness.
    if (remoteMode) return;
    void refreshCall();
    const timer = setInterval(() => void refreshCall(), CALL_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCall, remoteMode]);

  // Live feed: call lifecycle + final transcript turns from the desktop event hub (the
  // SAME validated/deduped stream app logic and flows consume).
  const reloadRef = useRef(recent.reload);
  useEffect(() => { reloadRef.current = recent.reload; }, [recent.reload]);
  const turnsReloadRef = useRef(storedTurns.reload);
  useEffect(() => { turnsReloadRef.current = storedTurns.reload; }, [storedTurns.reload]);

  // Remote viewer refresh: re-fetch the stored Calls + Transcript Turns records every 10s
  // while the tab is visible, so a call handled on the hosting desktop appears here live-ish.
  useEffect(() => {
    if (!remoteMode) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      reloadRef.current();
      turnsReloadRef.current();
    }, REMOTE_RECORDS_POLL_MS);
    return () => clearInterval(timer);
  }, [remoteMode]);
  useEffect(() => {
    return subscribeDesktopEvents((envelope: DesktopEventEnvelope) => {
      if ((envelope.connectorId ?? envelope.source) !== 'aokie') return;
      const data = asRecord(envelope.data);
      const callId = typeof data.callId === 'string' ? data.callId : envelope.correlationId;
      switch (envelope.name) {
        case 'aokie.call.incoming':
          setTurns([]);
          setCall(callFromEventData(callId, data, 'ringing'));
          break;
        case 'aokie.call.answered':
          setCall((prev) => (prev ? { ...prev, state: 'active' } : callFromEventData(callId, data, 'active')));
          break;
        case 'aokie.call.turn.final':
          setTurns((prev) => [
            ...prev.slice(-49),
            {
              key: envelope.idempotencyKey,
              speaker: typeof data.speaker === 'string' ? data.speaker : 'caller',
              text: typeof data.text === 'string' ? data.text : '',
              occurredAt: envelope.occurredAt,
            },
          ]);
          break;
        case 'aokie.call.rejected':
        case 'aokie.call.ended':
          setCall((prev) => (prev && prev.callId === callId ? { ...prev, state: 'ended' } : prev));
          // Give app logic a beat to write the Calls row, then refresh the history list.
          setTimeout(() => reloadRef.current(), 1500);
          break;
        default:
          break;
      }
    });
  }, []);

  const runCommand = useCallback(
    async (command: string, payload?: Record<string, unknown>, doneMessage?: string) => {
      setBusy(command);
      try {
        // Local bridge: straight to the connector client (the relay is only for remote runtimes).
        await dispatchCallCommand({ remote: false, connector }, command, undefined, payload);
        if (doneMessage) toast.success(doneMessage);
      } catch (err) {
        toast.error('Aokie command failed', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [connector]
  );

  const handleSpeak = useCallback(async () => {
    const message = speakText.trim();
    if (!message) return;
    await runCommand('call.operatorSpeak', { message }, 'Sent to the caller');
    setSpeakText('');
  }, [runCommand, speakText]);

  // Remote-runtime path: the receptionist is on another machine, so controls go through the relay
  // (enqueue → the owner's FormLogic Desktop claims/completes → poll back) instead of the local
  // connector. Optimistic overlay while in flight; reload records on success; revert + toast on
  // failure/expiry (expiry ⇒ "no desktop online").
  const relayDeviceName = presence.kind === 'remote' ? presence.deviceName : undefined;
  const runRelay = useCallback(
    async (command: string, callId: string | undefined, payload?: Record<string, unknown>) => {
      if (!appSlug || relayBusy) return;
      setRelayBusy(command);
      const startedAt = Date.now();
      try {
        const outcome = await performRelayCommand(api, appSlug, command, callId, payload, {
          onOptimistic: setOverlay,
          onReload: () => { reloadRef.current(); turnsReloadRef.current(); },
        });
        setLatencyMs(Date.now() - startedAt);
        const t = describeRelayOutcome(command, outcome, relayDeviceName);
        if (t.kind === 'success') toast.success(t.title, t.message);
        else toast.error(t.title, t.message);
      } catch (err) {
        toast.error('Could not reach FormLogic Desktop', err instanceof Error ? err.message : String(err));
      } finally {
        setRelayBusy(null);
      }
    },
    [appSlug, relayBusy, relayDeviceName]
  );

  const handleRelaySpeak = useCallback(
    async (callId: string | undefined) => {
      const message = speakText.trim();
      if (!message) return;
      setSpeakText('');
      await runRelay('call.operatorSpeak', callId, { message });
    },
    [runRelay, speakText]
  );

  const handleSimulate = useCallback(async () => {
    if (simulating) return;
    setSimulating(true);
    toast.info('Simulating a call', 'A scripted demo call sequence is being emitted.');
    try {
      await simulateIncomingCall();
    } finally {
      setSimulating(false);
    }
  }, [simulating]);

  const mockOnly = !desktop.available || !paired;

  // Remote mode derives the "current call" + transcript from stored records (newest call
  // auto-selected); local mode keeps the hub-event-driven state untouched. An in-flight relay
  // command paints its optimistic state over the matching call until it settles.
  const remoteCall = useMemo(() => {
    if (!remoteMode) return null;
    const derived = deriveRemoteCall(recent.rows);
    if (derived && overlay && overlay.callId === derived.callId) {
      return { ...derived, state: overlay.state };
    }
    return derived;
  }, [remoteMode, recent.rows, overlay]);
  const remoteCallId = remoteCall?.callId;
  const remoteTurns = useMemo(
    () => (remoteMode ? selectTurnsForCall(storedTurns.rows, remoteCallId) : []),
    [remoteMode, storedTurns.rows, remoteCallId]
  );
  const shownTurns = remoteMode ? remoteTurns : turns;

  const active = remoteMode
    ? (remoteCall && remoteCall.state !== 'ended' ? remoteCall : null)
    : (call && call.state !== 'ended' ? call : null);
  const stateBadge = useMemo(() => {
    if (!active) return null;
    const isRinging = active.state === 'ringing';
    return (
      <span
        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
          isRinging
            ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
            : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
        }`}
      >
        {isRinging ? 'Ringing' : 'Live'}
      </span>
    );
  }, [active]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <PhoneCall className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <h1 className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white">Live Call</h1>
        </div>
        <span className="text-xs text-gray-400 dark:text-slate-500">
          {remoteMode
            ? `Remote viewer · updates every ${REMOTE_RECORDS_POLL_MS / 1000}s`
            : mockOnly
              ? 'Demo phone bridge (no FormLogic Desktop)'
              : `FormLogic Desktop v${desktop.version ?? '?'} · paired`}
        </span>
      </div>

      {/* Remote runtime banner: the receptionist is running headless elsewhere. */}
      {presence.kind === 'remote' && (
        <div className={`${card} p-5`}>
          <div className="flex items-start gap-3">
            <Cast className="mt-0.5 h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                Receptionist running on {presence.deviceName}
              </p>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                Your receptionist runs in FormLogic Desktop on that machine. Manage calls here from
                anywhere — Answer, Reject, Hang up and Speak relay to it. Records and transcript refresh
                every {REMOTE_RECORDS_POLL_MS / 1000} seconds while this screen is open.
              </p>
            </div>
          </div>
        </div>
      )}

      {showSimulateSetup(presence) && (
        <div className={`${card} p-5`}>
          <div className="flex items-start gap-3">
            <Laptop className="mt-0.5 h-5 w-5 shrink-0 text-gray-400 dark:text-slate-500" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Install FormLogic Desktop to take real calls</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                FormLogic Desktop hosts the Aokie phone plugin that owns your Bluetooth dongle and paired phone.
                Until it is installed and paired (Device Setup section), this screen runs against a simulated bridge.
              </p>
              <button
                type="button"
                onClick={() => void handleSimulate()}
                disabled={simulating}
                className={`${actionBtn} mt-3 border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800`}
              >
                <PhoneIncoming className="h-4 w-4" />
                {simulating ? 'Simulating…' : 'Simulate incoming call (demo)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Current call card */}
      <div className={`${card} p-5`}>
        {active ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-gray-900 dark:text-white">
                  {active.callerName || active.from || 'Unknown caller'}
                </p>
                <p className="text-sm text-gray-500 dark:text-slate-400">{active.from ?? 'No caller id'}</p>
              </div>
              {stateBadge}
            </div>
            {remoteMode ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runRelay('call.answer', active.callId, { callId: active.callId })}
                    disabled={!canRunCommand('call.answer', { can, roleAllowsOperating }) || active.state !== 'ringing' || relayBusy !== null}
                    className={`${actionBtn} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20`}
                  >
                    <Phone className="h-4 w-4" /> {relayBusy === 'call.answer' ? 'Answering…' : 'Answer'}
                  </button>
                  {active.state === 'ringing' && canRunCommand('call.reject', { can, roleAllowsOperating }) && (
                    <button
                      type="button"
                      onClick={() => void runRelay('call.reject', active.callId, { callId: active.callId })}
                      disabled={relayBusy !== null}
                      className={`${actionBtn} border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20`}
                    >
                      <PhoneOff className="h-4 w-4" /> {relayBusy === 'call.reject' ? 'Rejecting…' : 'Reject'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void runRelay('call.hangup', active.callId, { callId: active.callId })}
                    disabled={!canRunCommand('call.hangup', { can, roleAllowsOperating }) || relayBusy !== null}
                    className={`${actionBtn} border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20`}
                  >
                    <PhoneOff className="h-4 w-4" /> {relayBusy === 'call.hangup' ? 'Hanging up…' : 'Hang up'}
                  </button>
                  {!roleAllowsOperating && (
                    <span className="text-xs text-gray-400 dark:text-slate-500">Your role can view calls but not operate them.</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={speakText}
                    onChange={(e) => setSpeakText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleRelaySpeak(active.callId); }}
                    placeholder="Say something to the caller as the operator…"
                    disabled={!canRunCommand('call.operatorSpeak', { can, roleAllowsOperating }) || active.state !== 'active' || relayBusy !== null}
                    className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleRelaySpeak(active.callId)}
                    disabled={!canRunCommand('call.operatorSpeak', { can, roleAllowsOperating }) || active.state !== 'active' || !speakText.trim() || relayBusy !== null}
                    className={`${actionBtn} border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/20 dark:bg-primary-500/10 dark:text-primary-400 dark:hover:bg-primary-500/20`}
                  >
                    <Send className="h-4 w-4" /> {relayBusy === 'call.operatorSpeak' ? 'Sending…' : 'Speak'}
                  </button>
                </div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400 dark:text-slate-500">
                  <Cast className="h-3 w-3" />
                  Commands run on {relayDeviceName ?? 'the hosting desktop'}
                  {relayBusy !== null
                    ? ' · sending…'
                    : latencyMs !== null
                      ? ` · last round-trip ${(latencyMs / 1000).toFixed(1)}s`
                      : ''}
                </p>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runCommand('call.answer', { callId: active.callId }, 'Call answered')}
                    disabled={!roleAllowsOperating || !can('call.answer') || active.state !== 'ringing' || busy !== null}
                    className={`${actionBtn} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20`}
                  >
                    <Phone className="h-4 w-4" /> Answer
                  </button>
                  <button
                    type="button"
                    onClick={() => void runCommand('call.hangup', { callId: active.callId }, 'Call ended')}
                    disabled={!roleAllowsOperating || !can('call.hangup') || busy !== null}
                    className={`${actionBtn} border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20`}
                  >
                    <PhoneOff className="h-4 w-4" /> Hang up
                  </button>
                  {!roleAllowsOperating && (
                    <span className="text-xs text-gray-400 dark:text-slate-500">Your role can view calls but not operate them.</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={speakText}
                    onChange={(e) => setSpeakText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSpeak(); }}
                    placeholder="Say something to the caller as the operator…"
                    disabled={!roleAllowsOperating || !can('call.operatorSpeak') || active.state !== 'active'}
                    className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSpeak()}
                    disabled={!roleAllowsOperating || !can('call.operatorSpeak') || active.state !== 'active' || !speakText.trim() || busy !== null}
                    className={`${actionBtn} border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/20 dark:bg-primary-500/10 dark:text-primary-400 dark:hover:bg-primary-500/20`}
                  >
                    <Send className="h-4 w-4" /> Speak
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="py-6 text-center">
            <Phone className="mx-auto mb-2 h-8 w-8 text-gray-300 dark:text-slate-600" />
            <p className="text-sm font-medium text-gray-900 dark:text-white">No call in progress</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-gray-500 dark:text-slate-400">
              {remoteMode
                ? `Your receptionist runs in FormLogic Desktop on ${relayDeviceName ?? 'another machine'}. Manage calls here from anywhere — the next incoming call appears the moment it rings.`
                : 'Incoming calls appear here the moment the Aokie plugin sees them ring.'}
            </p>
          </div>
        )}
      </div>

      {/* Live transcript (remote mode: the newest call's STORED turns — no local hub here) */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-gray-400 dark:text-slate-500" />
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">
              {remoteMode ? 'Latest call transcript' : 'Live transcript'}
            </h2>
          </div>
          {remoteMode && (
            <span className="text-[11px] text-gray-400 dark:text-slate-500">
              Stored records · updates every {REMOTE_RECORDS_POLL_MS / 1000}s
            </span>
          )}
        </div>
        {shownTurns.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {remoteMode
              ? 'No transcript recorded for the latest call yet.'
              : 'Final transcript turns stream in here during a call.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {shownTurns.map((t) => (
              <li key={t.key} className="flex gap-3 text-sm">
                <span
                  className={`w-16 shrink-0 text-xs font-semibold uppercase tracking-wide ${
                    t.speaker === 'caller' ? 'text-sky-600 dark:text-sky-400' : 'text-primary-600 dark:text-primary-400'
                  }`}
                >
                  {t.speaker}
                </span>
                <span className="min-w-0 text-gray-700 dark:text-slate-300">{t.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Call history (raw records the app logic wrote from events) */}
      <div className={`${card} p-5`}>
        <h2 className="mb-3 text-sm font-medium text-gray-900 dark:text-white">Recent calls</h2>
        {!callsFormId ? (
          <EmptyState title="No Calls form" message="This screen expects to be attached to the Calls form." />
        ) : recent.rows.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {recent.loading ? 'Loading…' : 'No calls logged yet — they are recorded automatically from call events.'}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {recent.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-gray-900 dark:text-white">
                    {String(r.answers.caller_name || r.answers.caller_phone || 'Unknown caller')}
                  </span>
                  <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">{String(r.answers.caller_phone || '')}</span>
                </div>
                <span className="text-xs capitalize text-gray-500 dark:text-slate-400">{String(r.answers.status || '')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
