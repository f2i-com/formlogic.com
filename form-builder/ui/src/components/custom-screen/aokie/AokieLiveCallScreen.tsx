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
//
// LAYOUT ("the screen rings", 2026-07): driven by CALL STATE, not by presence mode. At idle
// a thin standby bar says where the receptionist is listening (local / remote via relay /
// demo bridge); the moment a call rings or is live, a single call-stage card takes its place
// and pulses in the primary token while ringing. Presence mode only changes strings and one
// footer hairline on that stage — local, remote and demo share one control set (CallControls
// below), routed through ONE dispatcher keyed off remoteMode so the three modes can't drift
// out of sync with each other.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cast,
  Laptop,
  Loader2,
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
import { cn } from '../../../lib/utils';
import { subscribeDesktopEvents } from '../../../client-runtime/desktop/desktopEvents';
import { getDesktopInfo, subscribeDesktopStatus } from '../../../client-runtime/desktop/desktopDetection';
import { desktopClient } from '../../../client-runtime/desktop/desktopClient';
import { simulateIncomingCall } from '../../../client-runtime/connectors/aokieConnector';
import type { DesktopEventEnvelope } from '../../../client-runtime/desktop/desktopTypes';
import {
  REMOTE_RECORDS_POLL_MS,
  deriveRemoteCall,
  describeLastSeen,
  parseDbTimestamp,
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

/** The minimal shape both LiveCall (local) and RemoteCallSnapshot (remote) satisfy — all the
 *  call stage / controls need to render, regardless of which presence mode produced it. */
interface StageCall {
  callId: string;
  from?: string;
  callerName?: string;
  state: 'ringing' | 'active' | 'ended';
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

/** mm:ss, rolling to h:mm:ss past an hour — the call stage timer and nothing else needs this. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Speaker → label + color. The palette carries meaning: caller is neutral, the receptionist's
 *  own voice (AI or the operator standing in for it) is brand-colored. */
function describeSpeaker(speaker: string): { label: string; className: string } {
  if (speaker === 'caller') return { label: 'Caller', className: 'text-gray-500 dark:text-slate-400' };
  if (speaker === 'operator') return { label: 'You', className: 'text-primary-600 dark:text-primary-400' };
  return { label: 'Aokie', className: 'text-primary-600 dark:text-primary-400' };
}

function turnBodyClass(speaker: string): string {
  return speaker === 'caller' ? 'text-gray-700 dark:text-slate-300' : 'text-primary-700 dark:text-primary-300';
}

function formatTurnTime(occurredAt: string): string | null {
  const ms = parseDbTimestamp(occurredAt);
  return ms === null ? null : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';
const actionBtn =
  'inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45';
// Same traffic-light treatment as actionBtn, scaled up for the call stage's one urgent decision.
const stageActionBtn =
  'inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45';

const LOCAL_COMMAND_LABEL: Record<string, string> = {
  'call.answer': 'Call answered',
  'call.reject': 'Call rejected',
  'call.hangup': 'Call ended',
};

// The one control set both local and remote (and, implicitly, demo) call stages render. Answer
// is the single solid-fill action (the one urgent decision); reject/hang up keep the tinted
// amber/red treatment. Every button is gated by the SAME canRunCommand predicate the relay path
// always used — unifying the branches means local and remote can no longer drift out of sync.
function CallControls({
  active,
  can,
  roleAllowsOperating,
  busyCommand,
  onCommand,
}: {
  active: StageCall;
  can: (command: string) => boolean;
  roleAllowsOperating: boolean;
  busyCommand: string | null;
  onCommand: (command: string, callId: string, payload?: Record<string, unknown>) => void;
}) {
  const isRinging = active.state === 'ringing';
  const answerDisabled = !canRunCommand('call.answer', { can, roleAllowsOperating }) || !isRinging || busyCommand !== null;
  const rejectAllowed = isRinging && canRunCommand('call.reject', { can, roleAllowsOperating });
  const hangupDisabled = !canRunCommand('call.hangup', { can, roleAllowsOperating }) || busyCommand !== null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {isRinging && (
        <button
          type="button"
          onClick={() => onCommand('call.answer', active.callId, { callId: active.callId })}
          disabled={answerDisabled}
          className={`${stageActionBtn} border-transparent bg-emerald-600 text-white hover:bg-emerald-500`}
        >
          {busyCommand === 'call.answer' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
          {busyCommand === 'call.answer' ? 'Answering…' : 'Answer'}
        </button>
      )}
      {rejectAllowed && (
        <button
          type="button"
          onClick={() => onCommand('call.reject', active.callId, { callId: active.callId })}
          disabled={busyCommand !== null}
          className={`${stageActionBtn} border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20`}
        >
          {busyCommand === 'call.reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
          {busyCommand === 'call.reject' ? 'Rejecting…' : 'Reject'}
        </button>
      )}
      <button
        type="button"
        onClick={() => onCommand('call.hangup', active.callId, { callId: active.callId })}
        disabled={hangupDisabled}
        className={`${stageActionBtn} border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20`}
      >
        {busyCommand === 'call.hangup' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
        {busyCommand === 'call.hangup' ? 'Hanging up…' : 'Hang up'}
      </button>
      {!roleAllowsOperating && (
        <span className="text-xs text-gray-400 dark:text-slate-500">Your role can view calls but not operate them.</span>
      )}
    </div>
  );
}

export function AokieLiveCallScreen({ params }: { params?: Record<string, unknown> }) {
  const callsFormId = typeof params?.formId === 'string' ? params.formId : undefined;
  const connector = useConnector('aokie', callsFormId ? { formId: callsFormId } : undefined);
  const { can } = useConnectorPermission('aokie', undefined, callsFormId ? { formId: callsFormId } : undefined);
  const permissions = usePermissions();
  const canSubmitCalls = useAppRuntimeStore((s) => s.canSubmit);
  const appSlug = useAppRuntimeStore((s) => s.appSlug);
  const navigate = useNavigate();

  const [desktop, setDesktop] = useState(() => getDesktopInfo());
  const [call, setCall] = useState<LiveCall | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [speakText, setSpeakText] = useState('');
  const [pendingSpeak, setPendingSpeak] = useState<string | null>(null);
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

  // Known-caller name on the ringing/active header (audit AOK-UX-004): the
  // incoming-caller-lookup flow already matches Customers by phone to shape
  // the greeting; surface that name to the operator too. Match on the last-9
  // phone digits (so +61… and 04… forms agree — the same rule the flow uses),
  // scanning the Customers the SDK already exposes to this role.
  const customersFormId = useMemo(() => forms.find((f) => f.displayName === 'Customers')?.formId, [forms]);
  const customers = useResponses(customersFormId ?? '', { limit: 200, pollInterval: remoteMode ? undefined : 30 });
  const customerNameForPhone = useCallback(
    (phone?: string): string | undefined => {
      const tail = String(phone ?? '').replace(/[^0-9]/g, '').slice(-9);
      if (tail.length < 5) return undefined; // too short to match confidently
      const hit = customers.rows.find(
        (c) => String(c.answers.phone ?? '').replace(/[^0-9]/g, '').slice(-9) === tail
      );
      const name = hit ? String(hit.answers.name ?? '').trim() : '';
      return name || undefined;
    },
    [customers.rows]
  );

  // Role gate: operating the call maps to being allowed to write Calls records. Viewers
  // (no submit_responses on the Calls form) see everything but can't drive the phone.
  const roleAllowsOperating = callsFormId ? canSubmitCalls(callsFormId) : permissions.appLevel.includes('manage_app');

  useEffect(() => subscribeDesktopStatus((info) => setDesktop(info)), []);

  // Truthful readiness (audit INT-006/C-15): while the LOCAL bridge is the
  // presence source, poll the desktop's info card for the aokie plugin's
  // computed health — "Listening" must not read green when the plugin says
  // it cannot answer or speak (no radio, no voice output, dead outbox rows).
  const [pluginHealth, setPluginHealth] = useState<{ status?: string; detail?: string | null } | null>(null);
  useEffect(() => {
    if (presence.kind !== 'local') {
      setPluginHealth(null);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      const res = await desktopClient.info();
      if (!cancelled) setPluginHealth(res.ok ? (res.data?.aokiePluginHealth ?? null) : null);
    };
    void probe();
    const timer = setInterval(() => void probe(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [presence.kind]);
  const degradedDetail = presence.kind === 'local' && pluginHealth && pluginHealth.status && pluginHealth.status !== 'ok'
    ? (pluginHealth.detail || `receptionist ${pluginHealth.status}`)
    : null;

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
  // The event subscription below has [] deps, so the incoming-call toast reads
  // the customer lookup through a ref to avoid a stale (empty) closure.
  const customerLookupRef = useRef(customerNameForPhone);
  useEffect(() => { customerLookupRef.current = customerNameForPhone; }, [customerNameForPhone]);
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
        case 'aokie.call.incoming': {
          setTurns([]);
          const incoming = callFromEventData(callId, data, 'ringing');
          setCall(incoming);
          // Surface it even when the operator isn't looking at this tab — name
          // the known customer when we can (audit AOK-UX-004).
          toast.info('Incoming call', incoming.callerName || customerLookupRef.current(incoming.from) || incoming.from || 'Unknown caller');
          break;
        }
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

  // Local dispatch — straight to the connector client (the relay is only for remote runtimes).
  // Returns success/failure so callers (the speak composer) can react without a rethrow.
  const runCommand = useCallback(
    async (command: string, payload?: Record<string, unknown>, doneMessage?: string): Promise<boolean> => {
      setBusy(command);
      try {
        await dispatchCallCommand({ remote: false, connector }, command, undefined, payload);
        if (doneMessage) toast.success(doneMessage);
        return true;
      } catch (err) {
        toast.error('Aokie command failed', err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [connector]
  );

  // Remote-runtime path: the receptionist is on another machine, so controls go through the relay
  // (enqueue → the owner's FormLogic Desktop claims/completes → poll back) instead of the local
  // connector. Optimistic overlay while in flight; reload records on success; revert + toast on
  // failure/expiry (expiry ⇒ "no desktop online"). Returns success/failure like runCommand.
  const relayDeviceName = presence.kind === 'remote' ? presence.deviceName : undefined;
  const runRelay = useCallback(
    async (command: string, callId: string | undefined, payload?: Record<string, unknown>): Promise<boolean> => {
      if (!appSlug || relayBusy) return false;
      setRelayBusy(command);
      const startedAt = Date.now();
      try {
        const outcome = await performRelayCommand(api, appSlug, command, callId, payload, {
          onOptimistic: setOverlay,
          onReload: () => { reloadRef.current(); turnsReloadRef.current(); },
        });
        setLatencyMs(Date.now() - startedAt);
        const t = describeRelayOutcome(command, outcome, relayDeviceName);
        if (t.kind === 'success') {
          toast.success(t.title, t.message);
          return true;
        }
        toast.error(t.title, t.message);
        return false;
      } catch (err) {
        toast.error('Could not reach FormLogic Desktop', err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setRelayBusy(null);
      }
    },
    [appSlug, relayBusy, relayDeviceName]
  );

  // The ONE dispatcher CallControls calls — keyed off remoteMode so local/remote/demo can never
  // fork into two different behaviours for the same button.
  const onCommand = useCallback(
    (command: string, callId: string, payload?: Record<string, unknown>) => {
      if (remoteMode) {
        void runRelay(command, callId, payload);
      } else {
        void runCommand(command, payload, LOCAL_COMMAND_LABEL[command]);
      }
    },
    [remoteMode, runRelay, runCommand]
  );

  const handleSpeak = useCallback(async () => {
    const text = speakText.trim();
    if (!text) return;
    setSpeakText('');
    setPendingSpeak(text);
    const ok = await runCommand('call.operatorSpeak', { text }, 'Sent to the caller');
    setPendingSpeak(null);
    if (!ok) setSpeakText(text); // don't discard the operator's words on failure
  }, [runCommand, speakText]);

  const handleRelaySpeak = useCallback(
    async (callId: string | undefined) => {
      const text = speakText.trim();
      if (!text) return;
      setSpeakText('');
      setPendingSpeak(text);
      const ok = await runRelay('call.operatorSpeak', callId, { text });
      setPendingSpeak(null);
      if (!ok) setSpeakText(text); // don't discard the operator's words on failure
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

  const active: StageCall | null = remoteMode
    ? (remoteCall && remoteCall.state !== 'ended' ? remoteCall : null)
    : (call && call.state !== 'ended' ? call : null);
  const isCallUp = active !== null;
  const isRinging = active?.state === 'ringing';
  const busyCommand = remoteMode ? relayBusy : busy;

  // The call stage timer: one mechanism for both ringing and active (it runs from the moment
  // the call started either way), ticking every second while a call is up.
  const startedAtMs = !active
    ? null
    : remoteMode
      ? (remoteCall?.startedAtMs ?? null)
      : parseDbTimestamp(call?.startedAt);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isCallUp) return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isCallUp]);
  const elapsedLabel = startedAtMs !== null ? formatDuration(Math.max(0, nowTick - startedAtMs)) : null;

  const transcriptHeading = active ? 'Conversation' : remoteMode ? 'Latest call' : 'Last call';

  // Speak composer gating: the placeholder explains WHY it's disabled instead of just hiding.
  const speakGateReason = !active
    ? null
    : active.state === 'ringing'
      ? 'Answer the call to speak'
      : !roleAllowsOperating
        ? 'Your role can view calls but not operate them'
        : !can('call.operatorSpeak')
          ? 'Speaking is not granted to this app'
          : null;
  const speakPlaceholder = speakGateReason ?? 'Speak to the caller as the operator…';
  const speakDisabled = speakGateReason !== null || busyCommand !== null;

  // Standby bar's last-call time (idle state only — the stage has its own live timer).
  const lastCallRow = recent.rows[0];
  const lastCallAt = lastCallRow ? parseDbTimestamp(lastCallRow.answers.started_at ?? lastCallRow.submittedAt) : null;
  const lastCallLabel = lastCallAt !== null
    ? `Last call ${new Date(lastCallAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : null;
  const seenLabel = presence.kind === 'remote' ? describeLastSeen(presence.lastSeenAt) : null;

  // Transcript auto-scroll: stays pinned to the newest turn while a call is up. Also re-fires
  // when the pending "sending…" ghost turn appears/clears, so it doesn't sit below the fold
  // in a long transcript between the operator sending it and the real turn landing.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isCallUp) return;
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shownTurns.length, isCallUp, pendingSpeak]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex items-center gap-3">
        <PhoneCall className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        <h1 className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white">Live Call</h1>
      </div>

      {/* IDLE: a thin standby bar — where the receptionist is listening, and when it last rang.
          Truthful (audit INT-006/C-15): a degraded plugin turns the dot amber and says WHY,
          instead of a green "Listening" over a receptionist that cannot answer or speak. */}
      {!active && (
        <div className="flex items-center gap-2.5 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 px-4 py-2.5 text-sm">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              presence.kind === 'local'
                ? degradedDetail
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-emerald-500 animate-pulse'
                : presence.kind === 'remote'
                  ? 'bg-primary-500 animate-pulse'
                  : 'bg-gray-300 dark:bg-slate-600'
            }`}
          />
          <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">
            {presence.kind === 'local'
              ? degradedDetail
                ? `Degraded — ${degradedDetail}`
                : `Listening — FormLogic Desktop v${desktop.version ?? '?'}`
              : presence.kind === 'remote'
                ? `Listening on ${presence.deviceName} — via relay`
                : 'Demo bridge — no desktop connected'}
          </span>
          <span className="ml-auto shrink-0 text-xs text-gray-400 dark:text-slate-500">
            {presence.kind === 'remote'
              ? `Updates every ${REMOTE_RECORDS_POLL_MS / 1000}s${seenLabel ? ` · seen ${seenLabel}` : ''}`
              : (lastCallLabel ?? '')}
          </span>
        </div>
      )}

      {showSimulateSetup(presence) && !active && (
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

      {/* RINGING / ACTIVE: the call stage takes over. Ring-pulse while ringing (static primary
          halo under reduced motion — see .call-ring in index.css); a steady ring once answered. */}
      {active && (
        <div
          className={cn(
            card,
            'p-6 border-2',
            isRinging
              ? 'call-ring border-primary-300 dark:border-primary-500/40'
              : 'border-primary-200 dark:border-primary-500/30 ring-1 ring-primary-500/20'
          )}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <span
                className={`text-xs font-semibold uppercase tracking-wider ${
                  isRinging ? 'text-primary-600 dark:text-primary-400' : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {isRinging ? 'Incoming call' : 'Live'}
              </span>
              {elapsedLabel && (
                <span className="font-mono text-xl tabular-nums text-gray-900 dark:text-white">{elapsedLabel}</span>
              )}
            </div>

            <div className="min-w-0">
              <p className="truncate text-3xl font-semibold tracking-tight text-gray-900 dark:text-white">
                {active.callerName || customerNameForPhone(active.from) || active.from || 'Unknown caller'}
              </p>
              <p className="mt-1 flex items-center gap-2 font-mono text-sm tabular-nums text-gray-500 dark:text-slate-400">
                {active.from ? <a href={`tel:${active.from}`}>{active.from}</a> : 'No caller id'}
                {!active.callerName && customerNameForPhone(active.from) && (
                  <span className="rounded bg-primary-100 px-1.5 py-0.5 font-sans text-xs font-medium text-primary-700 dark:bg-primary-900/40 dark:text-primary-300">
                    Known customer
                  </span>
                )}
              </p>
            </div>

            <CallControls
              active={active}
              can={can}
              roleAllowsOperating={roleAllowsOperating}
              busyCommand={busyCommand}
              onCommand={onCommand}
            />

            <div className="flex items-center gap-1.5 border-t border-gray-100 dark:border-slate-800 pt-3 text-[11px] text-gray-400 dark:text-slate-500">
              {remoteMode ? (
                <>
                  <Cast className="h-3 w-3 shrink-0" />
                  <span>
                    Commands run on {relayDeviceName ?? 'the hosting desktop'}
                    {relayBusy !== null
                      ? ' · sending…'
                      : latencyMs !== null
                        ? ` · last round-trip ${(latencyMs / 1000).toFixed(1)}s`
                        : ''}
                  </span>
                </>
              ) : presence.kind === 'local' ? (
                <span>Direct bridge · FormLogic Desktop v{desktop.version ?? '?'}</span>
              ) : (
                <span>Simulated call — demo bridge</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Transcript (remote mode: the newest call's STORED turns — no local hub here) + composer */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-gray-400 dark:text-slate-500" />
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">{transcriptHeading}</h2>
          </div>
          {remoteMode && (
            <span className="text-[11px] text-gray-400 dark:text-slate-500">
              Stored records · updates every {REMOTE_RECORDS_POLL_MS / 1000}s
            </span>
          )}
        </div>
        {shownTurns.length === 0 && pendingSpeak === null ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {remoteMode
              ? 'No transcript recorded for the latest call yet.'
              : 'Final transcript turns stream in here during a call.'}
          </p>
        ) : (
          <div ref={transcriptRef} className="max-h-96 space-y-3 overflow-y-auto">
            {shownTurns.map((t) => {
              const speaker = describeSpeaker(t.speaker);
              const time = formatTurnTime(t.occurredAt);
              return (
                <div key={t.key}>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-xs font-medium ${speaker.className}`}>{speaker.label}</span>
                    {time && <span className="font-mono text-[11px] tabular-nums text-gray-400 dark:text-slate-500">{time}</span>}
                  </div>
                  <p className={`text-sm leading-relaxed ${turnBodyClass(t.speaker)}`}>{t.text}</p>
                </div>
              );
            })}
            {pendingSpeak !== null && (
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-primary-600 dark:text-primary-400">You</span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-slate-500">
                    {remoteMode && <Cast className="h-3 w-3" />} sending…
                  </span>
                </div>
                <p className="text-sm italic leading-relaxed text-primary-600/80 dark:text-primary-400/80">{pendingSpeak}</p>
              </div>
            )}
          </div>
        )}

        {/* Speak composer — only while a call is up; an ended call's transcript is a record, not a conversation. */}
        {active && (
          <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-slate-800">
            <input
              type="text"
              value={speakText}
              onChange={(e) => setSpeakText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || speakDisabled || !speakText.trim()) return;
                if (remoteMode) void handleRelaySpeak(active.callId);
                else void handleSpeak();
              }}
              placeholder={speakPlaceholder}
              disabled={speakDisabled}
              className="min-w-0 flex-1 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={() => { if (remoteMode) void handleRelaySpeak(active.callId); else void handleSpeak(); }}
              disabled={speakDisabled || !speakText.trim()}
              aria-label="Send to caller"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-600 text-primary-foreground transition-colors hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
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
            {recent.rows.map((r) => {
              const phone = String(r.answers.caller_phone || '');
              const status = String(r.answers.status || '');
              // Same severity-coloring convention as AokiePairingScreen's hardware events list.
              const statusClass =
                status === 'missed' || status === 'failed' || status === 'rejected'
                  ? 'text-red-600 dark:text-red-400'
                  : status === 'completed' || status === 'answered'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-gray-500 dark:text-slate-400';
              // Click through to the record detail when the app runtime + Calls form are known.
              const openDetail = () => {
                if (appSlug && callsFormId) navigate(`/app/${appSlug}/form/${callsFormId}/responses/${r.id}`);
              };
              const clickable = !!appSlug && !!callsFormId;
              return (
                <li
                  key={r.id}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? openDetail : undefined}
                  onKeyDown={clickable ? (e) => { if (e.key === 'Enter') openDetail(); } : undefined}
                  className={`flex flex-wrap items-center justify-between gap-2 py-2 text-sm ${clickable ? 'cursor-pointer rounded-lg px-1 -mx-1 hover:bg-gray-50 dark:hover:bg-slate-800/50' : ''}`}
                >
                  <div className="min-w-0">
                    <span className="font-medium text-gray-900 dark:text-white">
                      {String(r.answers.caller_name || phone || 'Unknown caller')}
                    </span>
                    {phone && (
                      <a
                        href={`tel:${phone}`}
                        onClick={(e) => e.stopPropagation()}
                        className="ml-2 text-xs text-gray-400 dark:text-slate-500"
                      >
                        {phone}
                      </a>
                    )}
                  </div>
                  <span className={`text-xs font-medium capitalize ${statusClass}`}>{status}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
