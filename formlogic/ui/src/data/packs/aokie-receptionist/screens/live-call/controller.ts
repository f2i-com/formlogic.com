// Live Call console: state + bridge logic (no JSX). This is the behavioral core of the
// pack-owned operator console, ported 1:1 from the previous embedded-JS screen; every
// gating rule, connector payload, and user-facing string is preserved. Only the
// rendering mechanism changed: the preact components under ./components read `state`
// and re-render when `repaint` bumps (the old paint*() calls all map to repaint()).
//
// Load-bearing rules kept intact:
//  - the STANDBY panel branches by presence (rendered in index.tsx from this state):
//    'remote' means a REAL desktop is reachable via the relay, so the panel is a mirror
//    note ONLY and NEVER offers the scripted demo Simulate; 'none'/demo offers the demo
//    call via host.ceremony('simulate-call'); 'local' shows no panel at all;
//  - presence() is re-polled every tick: detection is demand-driven and may only finish
//    AFTER this screen mounts, so a late-connecting desktop self-heals here; the events
//    and captions lanes attach on a transition TO 'local' and detach when it goes away;
//  - command outcomes are surfaced honestly: 'uncertain' means the desktop may have
//    acted, and the operator is told exactly that.

import { ms, tail9 } from './phone';

/** How long to show the loading spinner while desktop presence is still resolving.
 *  Detection is demand-driven and warms AFTER mount, so the first presence() reads
 *  can be a transient 'none' even when a desktop is a beat away from connecting.
 *  We hold the spinner (instead of flashing the demo Simulate card) until presence
 *  settles to a real runtime, the demo account is confirmed, or this grace elapses —
 *  a genuinely absent desktop then shows the Install/Simulate card. Covers one full
 *  3s poll cycle plus headroom. */
export const PRESENCE_GRACE_MS = 4000;

/** The effective grace — a host/test may override it via window.__flPresenceGraceMs
 *  (the screen behavioral tests set 0 for steady-state assertions). */
function presenceGraceMs(): number {
  const w = typeof window !== 'undefined' ? (window as unknown as { __flPresenceGraceMs?: unknown }) : undefined;
  const o = w && typeof w.__flPresenceGraceMs === 'number' ? w.__flPresenceGraceMs : NaN;
  return Number.isFinite(o) ? (o as number) : PRESENCE_GRACE_MS;
}

/** The presence/call poll cadence — overridable via window.__flPollMs so the
 *  behavioral tests can drive multiple poll cycles without real 3s waits. */
function pollMs(): number {
  const w = typeof window !== 'undefined' ? (window as unknown as { __flPollMs?: unknown }) : undefined;
  const o = w && typeof w.__flPollMs === 'number' ? w.__flPollMs : NaN;
  return Number.isFinite(o) && (o as number) > 0 ? (o as number) : 3000;
}

/** Loose record view of an unknown value (the old rec() helper). */
export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface CallInfo {
  callId: string | undefined;
  from?: string;
  callerName?: string;
  state: 'ringing' | 'active' | 'ended';
  startedAt?: string;
}

export interface Turn {
  key: string;
  speaker: string;
  text: string;
  occurredAt?: string;
  callId: string | undefined;
  turn: number | null;
  corrected?: boolean;
}

export interface ConsoleState {
  presence: FlPresence;
  /** The viewer is the shared demo account (demo@formlogic.local). */
  demo: boolean;
  call: CallInfo | null;
  /** Live/derived transcript turns for the current call. */
  turns: Turn[];
  /** Volatile captions frame (caller partial + bot line + session phase). */
  captions: Record<string, unknown> | null;
  /** queryRecords('customers') cache for the known-caller name lookup. */
  customers: FlScreenRecord[];
  /** records() cache: the recent Calls rows. */
  recent: FlScreenRecord[];
  /** can() cache. */
  grants: Record<string, boolean>;
  speakText: string;
  pendingSpeak: string | null;
  busy: string | null;
  simulating: boolean;
  startedAtMs: number | null;
  /** events.subscribe attached (local bridge); else the stored-turns poll drives the transcript. */
  liveEvents: boolean;
}

export interface ConsoleController {
  state: ConsoleState;
  isDemo(): boolean;
  remoteMode(): boolean;
  /** False only during the brief boot window while desktop presence is still
   *  resolving — the standby surface shows a loading spinner until this is true. */
  presenceSettled(): boolean;
  activeCall(): CallInfo | null;
  can(perm: string): boolean;
  nameForPhone(phone: unknown): string | null;
  callControl(command: 'call.answer' | 'call.reject' | 'call.hangup'): void;
  setSpeakText(v: string): void;
  sendSpeak(): Promise<void>;
  simulate(): void;
  viewAll(): void;
  openRecent(id: string): void;
  /** Boot + start the poll timers; returns the dispose function. */
  wire(): () => void;
}

export function createConsole(repaint: () => void): ConsoleController {
  const state: ConsoleState = {
    presence: { kind: 'none' },
    demo: false,
    call: null,
    turns: [],
    captions: null,
    customers: [],
    recent: [],
    grants: {},
    speakText: '',
    pendingSpeak: null,
    busy: null,
    simulating: false,
    startedAtMs: null,
    liveEvents: false,
  };
  const caps: {
    unsubEvents: (() => Promise<unknown>) | null;
    capHandle: { unsubscribe(): Promise<unknown>; tombstone(): Promise<unknown> } | null;
  } = { unsubEvents: null, capHandle: null };
  let prevCallerTurns = 0;
  // When the console mounted — the presence grace is measured from here (0 until wired).
  let bootAtMs = 0;
  // Consecutive call.current polls that reported NO call while we still show a
  // live one — see setCallFromCurrent.
  let currentMisses = 0;

  const isDemo = () => state.presence.kind === 'none' && state.demo === true;
  const remoteMode = () => state.presence.kind === 'remote';
  // Settled once a real runtime is present, the demo account is confirmed, or the boot
  // grace has elapsed for a genuinely absent desktop. While unsettled the standby shows
  // a spinner instead of the demo Simulate card (avoids the "connecting" flash).
  const presenceSettled = () =>
    state.presence.kind === 'local' ||
    state.presence.kind === 'remote' ||
    isDemo() ||
    (bootAtMs > 0 && Date.now() - bootAtMs >= presenceGraceMs());
  const activeCall = () => (state.call && state.call.state !== 'ended' ? state.call : null);
  const can = (perm: string) => state.grants[perm] === true;

  function nameForPhone(phone: unknown): string | null {
    const t = tail9(phone);
    if (t.length < 5) return null;
    for (let i = 0; i < state.customers.length; i++) {
      const a = rec(state.customers[i].answers);
      if (tail9(a.phone) === t) {
        const n = String(a.name == null ? '' : a.name).trim();
        return n || null;
      }
    }
    return null;
  }

  /** The old `e && e.message ? e.message : fallback` shape, typed. */
  function errMessage(e: unknown, fallback: string): string {
    if (e && typeof e === 'object') {
      const m = (e as { message?: unknown }).message;
      if (m) return String(m);
    }
    return fallback;
  }

  // ---- data ----------------------------------------------------------------

  function setCallFromCurrent(res: Record<string, unknown>): void {
    const c = rec(res.call);
    if (typeof c.callId === 'string') {
      currentMisses = 0;
      const st: CallInfo['state'] = c.state === 'active' ? 'active' : c.state === 'ended' ? 'ended' : 'ringing';
      const prev = state.call;
      const same = prev !== null && prev.callId === c.callId;
      state.call = {
        callId: c.callId,
        from: typeof c.from === 'string' ? c.from : (same ? prev.from : undefined),
        callerName: typeof c.callerName === 'string' ? c.callerName : undefined,
        state: st,
        startedAt: typeof c.startedAt === 'string' ? c.startedAt : (same ? prev.startedAt : undefined),
      };
      state.startedAtMs = ms(state.call.startedAt) || (same ? state.startedAtMs : Date.now());
    } else if (!state.call || state.call.state === 'ended') {
      currentMisses = 0;
      state.call = null;
      state.startedAtMs = null;
    } else {
      // The plugin is AUTHORITATIVE and reports no current call while the
      // stage still shows one as ringing/active: the ended event was missed
      // (the relay path has no event lane at all, and even the local lane can
      // shed a frame). Two consecutive misses (~2 poll cycles) end the call
      // here; a single miss is forgiven so an in-flight null response racing
      // a just-started call can never kill the fresh stage. Without this the
      // hangup button stuck forever (live report 2026-07-18).
      currentMisses += 1;
      if (currentMisses >= 2) {
        currentMisses = 0;
        state.call.state = 'ended';
        state.startedAtMs = null;
        setTimeout(() => { void refreshRecent().then(() => repaint()); }, 1500);
      }
    }
  }

  function refreshCall(): Promise<void> {
    if (!can('connector.aokie.call.current')) return Promise.resolve();
    return FormLogic.connector('aokie', 'call.current', {}).then((out) => {
      if (out.status === 'done') setCallFromCurrent(rec(out.result));
    }).catch(() => undefined);
  }

  function refreshRecent(): Promise<void> {
    return FormLogic.records({ limit: 8 }).then((rows) => {
      state.recent = rows || [];
    }).catch(() => undefined);
  }

  function refreshCustomers(): Promise<void> {
    return FormLogic.queryRecords('customers', { limit: 200 }).then((rows) => {
      state.customers = rows || [];
    }).catch(() => undefined);
  }

  /** Remote/demo transcript: stored Transcript Turns for the current call. */
  function refreshStoredTurns(): Promise<void> {
    const c = state.call;
    if (!c || state.liveEvents) return Promise.resolve();
    return FormLogic.queryRecords('transcript-turns', { limit: 60 }).then((rows) => {
      const list = rows || [];
      const out: Turn[] = [];
      for (let i = 0; i < list.length; i++) {
        const a = rec(list[i].answers);
        if (String(a.call_id || '') !== c.callId) continue;
        const idx = a.turn_index;
        out.push({
          key: list[i].id,
          speaker: typeof a.speaker === 'string' && a.speaker ? a.speaker : 'system',
          text: String(a.text == null ? '' : a.text),
          occurredAt: typeof a.timestamp === 'string' && a.timestamp ? a.timestamp : list[i].submittedAt,
          callId: c.callId,
          turn: typeof idx === 'number' ? idx : (typeof idx === 'string' && idx !== '' && !isNaN(Number(idx)) ? Number(idx) : null),
          corrected: a.source === 'audio_model',
        });
      }
      out.sort((x, y) => {
        if (x.occurredAt && y.occurredAt && x.occurredAt !== y.occurredAt) return x.occurredAt < y.occurredAt ? -1 : 1;
        if (x.turn != null && y.turn != null && x.turn !== y.turn) return x.turn - y.turn;
        return 0;
      });
      state.turns = out;
    }).catch(() => undefined);
  }

  // ---- live event lane (LOCAL bridge only) ---------------------------------

  function onEvent(frame: FlPushFrame): void {
    if (frame.kind === 'dropped') {
      void refreshCall();
      void refreshRecent();
      return;
    }
    const env = rec(frame.data);
    const data = rec(env.data);
    const callId = typeof data.callId === 'string' ? data.callId
      : (typeof env.correlationId === 'string' ? env.correlationId : undefined);
    switch (env.name) {
      case 'aokie.call.incoming':
        state.turns = [];
        state.call = {
          callId,
          from: typeof data.from === 'string' ? data.from
            : (typeof data.callerPhone === 'string' ? data.callerPhone : undefined),
          callerName: typeof data.callerName === 'string' ? data.callerName : undefined,
          state: 'ringing',
          startedAt: new Date().toISOString(),
        };
        state.startedAtMs = Date.now();
        break;
      case 'aokie.call.answered':
        if (state.call) state.call.state = 'active';
        break;
      case 'aokie.call.caller_id':
        if (state.call && state.call.callId === callId && !state.call.from && typeof data.from === 'string') {
          state.call.from = data.from;
        }
        break;
      case 'aokie.call.turn.final':
        state.turns = state.turns.slice(-49).concat([{
          key: typeof env.idempotencyKey === 'string' && env.idempotencyKey !== ''
            ? env.idempotencyKey
            : String(callId) + ':' + String(data.turn),
          speaker: typeof data.speaker === 'string' ? data.speaker : 'caller',
          text: typeof data.text === 'string' ? data.text : '',
          occurredAt: typeof env.occurredAt === 'string' ? env.occurredAt : undefined,
          callId,
          turn: typeof data.turn === 'number' ? data.turn : (Number(data.turn) || null),
        }]);
        break;
      case 'aokie.call.turn.corrected': {
        const tn = typeof data.turn === 'number' ? data.turn : Number(data.turn);
        const fixed = typeof data.text === 'string' ? data.text : '';
        if (fixed && isFinite(tn)) {
          state.turns = state.turns.map((t) => (t.callId === callId && t.turn === tn)
            ? { key: t.key, speaker: t.speaker, text: fixed, occurredAt: t.occurredAt, callId: t.callId, turn: t.turn, corrected: true }
            : t);
        }
        break;
      }
      case 'aokie.call.rejected':
      case 'aokie.call.ended':
        if (state.call && state.call.callId === callId) state.call.state = 'ended';
        setTimeout(() => { void refreshRecent().then(() => repaint()); }, 1500);
        break;
      default:
        return;
    }
    repaint();
  }

  function attachLiveLanes(): Promise<unknown> {
    // Idempotent: only the LOCAL bridge carries live feeds, and never subscribe twice.
    if (state.presence.kind !== 'local' || caps.unsubEvents) return Promise.resolve();
    const evP = FormLogic.events.subscribe({ connectorId: 'aokie' }, onEvent).then((h) => {
      caps.unsubEvents = h.unsubscribe;
      state.liveEvents = true;
    }).catch(() => { state.liveEvents = false; });
    const capP = FormLogic.captions.subscribe((frame) => {
      if (frame.kind === 'dropped') return;
      state.captions = rec(frame.data);
      repaint();
    }).then((h) => { caps.capHandle = h; }).catch(() => undefined);
    // The visible partial is tombstoned when a durable caller turn lands (final wins).
    return Promise.all([evP, capP]);
  }

  function detachLiveLanes(): void {
    if (caps.unsubEvents) {
      try { void caps.unsubEvents(); } catch { /* best effort */ }
      caps.unsubEvents = null;
    }
    if (caps.capHandle) {
      try { void caps.capHandle.unsubscribe(); } catch { /* best effort */ }
      caps.capHandle = null;
    }
    state.liveEvents = false;
    state.captions = null;
  }

  function maybeTombstone(): void {
    let n = 0;
    for (let i = 0; i < state.turns.length; i++) {
      if (state.turns[i].speaker === 'caller') n++;
    }
    if (n > prevCallerTurns && caps.capHandle && typeof caps.capHandle.tombstone === 'function') {
      void caps.capHandle.tombstone();
    }
    prevCallerTurns = n;
  }

  // ---- actions -------------------------------------------------------------

  function runCommand(command: string, payload?: Record<string, unknown>): Promise<boolean> {
    state.busy = command;
    repaint();
    return FormLogic.connector('aokie', command, payload || {})
      .then((out) => {
        if (out.status !== 'done') {
          let m = errMessage(out.error, out.status);
          if (out.status === 'uncertain') m = 'Sent, but the desktop has not confirmed it yet.';
          void FormLogic.toast.error(m);
          return false;
        }
        return true;
      })
      .catch((e: unknown) => {
        void FormLogic.toast.error(errMessage(e, 'Command failed'));
        return false;
      })
      .then((ok) => {
        state.busy = null;
        return ok;
      });
  }

  function callControl(command: 'call.answer' | 'call.reject' | 'call.hangup'): void {
    const c = activeCall();
    if (!c) return;
    void runCommand(command, { callId: c.callId }).then(() => refreshCall()).then(() => repaint());
  }

  function setSpeakText(v: string): void {
    state.speakText = v;
    repaint();
  }

  function sendSpeak(): Promise<void> {
    const c = activeCall();
    if (!c) return Promise.resolve();
    const text = String(state.speakText || '').trim();
    if (!text) return Promise.resolve();
    state.speakText = '';
    state.pendingSpeak = text;
    repaint();
    return runCommand('call.operatorSpeak', { callId: c.callId, text }).then((ok) => {
      state.pendingSpeak = null;
      if (!ok) state.speakText = text;
      repaint();
    });
  }

  function simulate(): void {
    state.simulating = true;
    repaint();
    void FormLogic.host.ceremony('simulate-call')
      .catch((err: unknown) => {
        void FormLogic.toast.error(errMessage(err, 'Could not start the demo call'));
      })
      .then(() => {
        state.simulating = false;
        repaint();
      });
  }

  function viewAll(): void {
    // The attached form's own records table. NOT a host screen open by name: the
    // Calls SECTION screen IS this console, so that would just re-open it.
    // openRecords() is gated on the viewer being able to see the records.
    void FormLogic.openRecords().catch((e: unknown) => {
      void FormLogic.toast.error(errMessage(e, 'Records are not available.'));
    });
  }

  function openRecent(id: string): void {
    if (id) void FormLogic.host.openRecord('calls', id).catch(() => undefined);
  }

  // ---- grants + boot -------------------------------------------------------

  const GRANTS = ['call.current', 'call.answer', 'call.reject', 'call.hangup', 'call.operatorSpeak'];

  function loadGrants(): Promise<unknown> {
    return Promise.all(GRANTS.map((g) =>
      FormLogic.can('connector.aokie.' + g).then((ok) => {
        state.grants['connector.aokie.' + g] = ok === true;
      })
    ));
  }

  function tick(): Promise<void> {
    // Re-resolve presence every tick: detection is demand-driven and may only
    // finish AFTER this screen mounts (navigating in from another page), so a
    // late-connecting desktop self-heals here instead of needing a full reload.
    return FormLogic.presence()
      .then((p) => {
        const prev = state.presence.kind;
        state.presence = p || { kind: 'none' };
        if (state.presence.kind === 'local' && prev !== 'local') return attachLiveLanes();
        if (prev === 'local' && state.presence.kind !== 'local') detachLiveLanes();
        return undefined;
      })
      .catch(() => undefined)
      .then(() => refreshCall())
      .then(() => (state.liveEvents ? Promise.resolve() : refreshStoredTurns()))
      .then(() => {
        maybeTombstone();
        repaint();
      });
  }

  function loadAll(): Promise<void> {
    return FormLogic.presence()
      .then((p) => { state.presence = p || { kind: 'none' }; })
      .catch(() => { state.presence = { kind: 'none' }; })
      .then(() => FormLogic.currentUser())
      .then((u) => { state.demo = !!(u && u.email === 'demo@formlogic.local'); })
      .catch(() => undefined)
      .then(() => loadGrants())
      .then(() => Promise.all([refreshCall(), refreshRecent(), refreshCustomers()]))
      .then(() => attachLiveLanes())
      .then(() => (state.liveEvents ? Promise.resolve() : refreshStoredTurns()))
      .then(() => {
        maybeTombstone();
        repaint();
      });
  }

  function wire(): () => void {
    bootAtMs = Date.now();
    void loadAll();
    // Presence + call poll every 3s; recent calls every 10s; the elapsed timer
    // repaints the stage every 1s while a call is up.
    const pollTimer = setInterval(() => { void tick(); }, pollMs());
    const recentTimer = setInterval(() => { void refreshRecent().then(() => repaint()); }, 10000);
    const elapsedTimer = setInterval(() => { if (activeCall()) repaint(); }, 1000);
    // One repaint exactly at grace-end so a genuinely absent desktop drops the spinner
    // for the Install/Simulate card on time (not only on the next 3s poll).
    const graceTimer = setTimeout(() => repaint(), presenceGraceMs());
    return () => {
      clearInterval(pollTimer);
      clearInterval(recentTimer);
      clearInterval(elapsedTimer);
      clearTimeout(graceTimer);
      detachLiveLanes();
    };
  }

  return {
    state,
    isDemo,
    remoteMode,
    presenceSettled,
    activeCall,
    can,
    nameForPhone,
    callControl,
    setSpeakText,
    sendSpeak,
    simulate,
    viewAll,
    openRecent,
    wire,
  };
}
