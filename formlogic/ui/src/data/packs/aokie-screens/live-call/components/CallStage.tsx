/** @jsxImportSource preact */
// The call stage (hero card) + the volatile live-captions card. Rendered only while a
// call is up; every label, gating rule, and footer string matches the previous
// embedded-JS console.
import type { CallInfo, ConsoleController } from '../controller';
import { dur } from '../phone';

export function CallStage({ c, call }: { c: ConsoleController; call: CallInfo }) {
  const s = c.state;
  const ringing = call.state === 'ringing';
  const known = call.callerName || c.nameForPhone(call.from);
  const display = call.callerName || known || call.from || 'Unknown caller';
  const initial = display.trim().charAt(0).toUpperCase() || '?';
  const elapsed = s.startedAtMs !== null ? dur(Date.now() - s.startedAtMs) : null;
  const eyebrow = ringing ? 'Incoming call' : 'Call in progress' + (elapsed ? ' - ' + elapsed : '');

  const canAnswer = ringing && c.can('connector.aokie.call.answer') && s.busy === null;
  const canReject = ringing && c.can('connector.aokie.call.reject');
  const canHangup = c.can('connector.aokie.call.hangup') && s.busy === null;

  const foot = c.remoteMode()
    ? 'Commands run on ' + (s.presence.deviceName || 'the hosting desktop')
    : s.presence.kind === 'local'
      ? 'Direct bridge - FormLogic Desktop'
      : 'Simulated call - demo bridge';

  return (
    <section class={'stage' + (ringing ? ' ringing' : '')}>
      <div class="caller">
        <span class="avatar" aria-hidden="true">{initial}</span>
        <div class="cid">
          <p class={'eyebrow' + (ringing ? '' : ' live')}>{eyebrow}</p>
          <p class="cname">{display}</p>
          <p class="cphone mono">
            {call.from ? call.from : 'No caller id'}
            {!call.callerName && known ? <span class="known">Known customer</span> : null}
          </p>
        </div>
      </div>
      <div class="controls">
        {ringing && (
          <button type="button" class="btn answer" data-act="answer" disabled={!canAnswer}
            onClick={() => c.callControl('call.answer')}>
            {s.busy === 'call.answer' ? 'Answering...' : 'Answer'}
          </button>
        )}
        {canReject && (
          <button type="button" class="btn reject" data-act="reject" disabled={s.busy !== null}
            onClick={() => c.callControl('call.reject')}>
            {s.busy === 'call.reject' ? 'Rejecting...' : 'Reject'}
          </button>
        )}
        <button type="button" class="btn hangup" data-act="hangup" disabled={!canHangup}
          onClick={() => c.callControl('call.hangup')}>
          {s.busy === 'call.hangup' ? 'Hanging up...' : 'Hang up'}
        </button>
      </div>
      <div class="stagefoot">{foot}</div>
    </section>
  );
}

/** The volatile captions strip: caller partial (italic), the bot's spoken line, and the
 *  session phase. Only shown for the CURRENT call's frame, and only when it has content. */
export function LiveCaptions({ call, captions }: { call: CallInfo; captions: Record<string, unknown> | null }) {
  if (!captions) return null;
  if (captions.callId !== call.callId) return null;
  const partial = captions.partialText;
  const bot = captions.botText;
  const phaseRaw = captions.phase;
  if (!partial && !bot && !phaseRaw) return null;
  const phase = String(phaseRaw || 'listening');
  return (
    <div class="capcard">
      <div class="caphd"><span class="dot live" />{'Live - ' + phase}</div>
      {partial ? <p class="cappartial">{'"' + String(partial) + '..."'}</p> : null}
      {bot ? <p class="capbot"><span class="tag">Aokie</span>{String(bot)}</p> : null}
    </div>
  );
}
