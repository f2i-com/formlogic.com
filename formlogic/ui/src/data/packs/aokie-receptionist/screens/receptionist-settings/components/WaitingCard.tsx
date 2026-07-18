/** @jsxImportSource preact */
// Phone connection & call waiting: the three live plugin toggles. The queue
// toggle needs call-waiting detection on (unchecking the latter clears it).
import { saveWaiting, state, waitChange, type WaitKey } from '../store';

function WaitChk(props: { k: WaitKey; on: boolean; disabled: boolean; title: string; sub: string }) {
  return (
    <label class={'chk' + (props.disabled ? ' off' : '')}>
      <input
        type="checkbox"
        data-wait={props.k}
        checked={props.on}
        disabled={props.disabled}
        onChange={(e) => waitChange(props.k, e.currentTarget.checked)}
      />
      <span>
        {props.title}
        <span class="sub">{props.sub}</span>
      </span>
    </label>
  );
}

export function WaitingCard() {
  if (!state.canSet) return null;
  const w = state.waiting;
  return (
    <div class="card">
      <h2>{'Phone connection & call waiting'}</h2>
      <p class="muted">How the receptionist links to the phone and handles a second caller. All apply the next time it reconnects.</p>
      <WaitChk
        k="autoConnectPhone"
        on={w.autoConnectPhone}
        disabled={false}
        title="Connect the phone automatically on startup"
        sub="When the receptionist starts it pages the last connected phone itself, so the line comes up without pressing Reconnect."
      />
      <WaitChk
        k="holdAndCallWaiting"
        on={w.holdAndCallWaiting}
        disabled={false}
        title="Detect a second caller (call waiting)"
        sub="A second caller ringing mid-call is noticed and recorded without disturbing the live conversation. On its own it never answers them."
      />
      <WaitChk
        k="autoHoldQueue"
        on={w.autoHoldQueue}
        disabled={!w.holdAndCallWaiting}
        title={'Automatically hold & queue callers'}
        sub={'The receptionist tells the current caller another call came in, answers the new caller with "please hold - you\'re next in the queue", parks them, and returns to the first. Needs "Detect a second caller" on.'}
      />
      <div class="savebtnrow">
        <button type="button" class="btn dark sm" data-act="save-waiting" disabled={!!state.busy.waiting || !w.loaded} onClick={saveWaiting}>
          {state.busy.waiting ? 'Saving...' : 'Save call waiting'}
        </button>
        {w.loaded ? null : <span class="faint">Loading current values...</span>}
      </div>
    </div>
  );
}
