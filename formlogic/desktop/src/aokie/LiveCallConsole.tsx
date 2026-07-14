import { useCallback, useEffect, useRef, useState } from 'react';
import { plugins } from '../api';
import { PhoneCallIcon, XIcon } from '../Icons';
import { useToast } from '../Toasts';

/** Canonical `call.current` call object (contract: callId/from/state/startedAt). */
interface CurrentCall {
  callId: string;
  from?: string;
  state: 'ringing' | 'active' | 'ended' | string;
  startedAt?: string;
}

/**
 * The live-call operator console (redesign 2026-07, deferred follow-up).
 *
 * Polls `call.current` every 2 s while mounted+visible and drives the call
 * controls. Every control sends the KNOWN `callId`; when Aokie answers
 * `stale_call` (the call changed between our snapshot and the click) the
 * console tells the operator and refreshes `call.current` before the buttons
 * re-enable — it never retries blindly against whatever call is now live.
 *
 * "Speak to caller" is disabled while the built-in AI receptionist owns the
 * conversation: the radio runtime deliberately ignores operator speech in
 * that mode to prevent double replies, so offering the button would be a lie.
 */
export function LiveCallConsole({ aiReceptionist }: { aiReceptionist: boolean }) {
  const [call, setCall] = useState<CurrentCall | null>(null);
  const [known, setKnown] = useState(false); // first call.current answered
  const [busy, setBusy] = useState(false);
  const [speech, setSpeech] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const toast = useToast();
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await plugins.command('aokie', 'call.current');
      const data = res.data as { call?: CurrentCall | null } | undefined;
      const current = data?.call ?? null;
      setCall(current && current.state !== 'ended' ? current : null);
      setKnown(true);
    } catch {
      // Plugin briefly unavailable — keep the last snapshot; the readiness
      // grid above tells the bigger story.
    }
  }, []);

  useEffect(() => {
    let id: number | undefined;
    const start = () => {
      if (id !== undefined) return;
      void refresh();
      id = window.setInterval(() => {
        void refresh();
        setNow(Date.now());
      }, 2000);
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  /** Run one call control with callId + stale_call recovery. */
  const act = async (command: string, payload?: Record<string, unknown>) => {
    if (!call || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await plugins.command('aokie', command, { callId: call.callId, ...payload });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('stale_call')) {
        toast.push({
          kind: 'info',
          title: 'The call changed',
          body: 'Refreshing the live state — check the caller before acting again.',
        });
        await refresh();
      } else {
        toast.push({ kind: 'error', title: 'Call control failed', body: msg });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const speak = async () => {
    const text = speech.trim();
    if (!text) return;
    await act('call.operatorSpeak', { text });
    setSpeech('');
  };

  const duration = (() => {
    if (!call?.startedAt) return null;
    const t = Date.parse(call.startedAt);
    if (Number.isNaN(t)) return null;
    const secs = Math.max(0, Math.floor((now - t) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  })();

  return (
    <section className="desktop-panel-card desktop-live-call">
      <div className="desktop-panel-card__heading">
        <div>
          <small>LIVE CALL</small>
          <h3>{call ? call.from || 'Unknown caller' : 'No active call'}</h3>
        </div>
        {call && (
          <span className={`desktop-status-pill ${call.state === 'ringing' ? 'is-warn' : 'is-live'}`}>
            <i />
            {call.state === 'ringing' ? 'Ringing' : duration ?? 'Live call'}
          </span>
        )}
      </div>

      {!call && (
        <div className="desktop-empty-call">
          <span className="desktop-empty-call__icon">
            <PhoneCallIcon size={22} />
          </span>
          <h4>{known ? 'Waiting for the next call' : 'Checking for a live call…'}</h4>
          <p>
            When a call rings on the paired phone it appears here with answer, reject and hang-up
            controls.
          </p>
        </div>
      )}

      {call && call.state === 'ringing' && (
        <div className="desktop-ringing-call">
          <small>INCOMING CALL</small>
          <h4>{call.from || 'Unknown caller'}</h4>
          <div className="desktop-call-actions">
            <button
              type="button"
              className="desktop-call-action is-reject"
              disabled={busy}
              onClick={() => act('call.reject')}
            >
              <XIcon size={15} /> Reject
            </button>
            <button
              type="button"
              className="desktop-call-action is-answer"
              disabled={busy}
              onClick={() => act('call.answer')}
            >
              <PhoneCallIcon size={15} /> Answer
            </button>
          </div>
        </div>
      )}

      {call && call.state === 'active' && (
        <div className="desktop-active-call">
          <div className="desktop-active-call__footer">
            <span className="desktop-active-call__note">
              {aiReceptionist
                ? 'AI receptionist owns this conversation — operator speech is muted'
                : 'Operator mode — you can speak to the caller'}
            </span>
            <button
              type="button"
              className="desktop-call-action is-reject"
              disabled={busy}
              onClick={() => act('call.hangup')}
            >
              <PhoneCallIcon size={15} /> Hang up
            </button>
          </div>
          <div className="desktop-speak-row">
            <input
              type="text"
              value={speech}
              onChange={(e) => setSpeech(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void speak();
              }}
              placeholder={
                aiReceptionist ? 'Disabled while the AI receptionist replies' : 'Say something to the caller…'
              }
              aria-label="Text for Aokie to speak to the caller"
              disabled={busy || aiReceptionist}
            />
            <button
              type="button"
              className="desktop-button"
              disabled={busy || aiReceptionist || !speech.trim()}
              onClick={() => void speak()}
            >
              Speak
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
