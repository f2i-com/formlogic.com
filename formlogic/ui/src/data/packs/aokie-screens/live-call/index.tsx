/** @jsxImportSource preact */
// Pack-owned Live Call section screen (TSX edition): the operator's front-desk console.
// The current call rides the hero stage card; live captions, the final transcript, the
// answer/reject/hangup/speak controls, and the recent-calls list sit below it.
//
// Runtime contract (CustomScreenRuntime in the APP runtime): opaque-origin iframe;
// window.FormLogic is the only capability. All bridge logic lives in ./controller (a
// 1:1 behavioral port of the previous embedded-JS console); these components are pure
// renderers over its state.
//
// CRITICAL standby rule (the "connected but shows Simulate" bug class): presence
// 'remote' means a REAL desktop answers this line via the relay, so the standby panel
// is a mirror note ONLY and must NEVER offer the scripted demo call. Only 'none'/demo
// offers Simulate; 'local' shows no panel. See Standby below and the controller notes.
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ConsoleController } from './controller';
import { createConsole, rec } from './controller';
import { hhmm } from './phone';
import { CallStage, LiveCaptions } from './components/CallStage';
import { Transcript } from './components/Transcript';
import { RecentCalls } from './components/RecentCalls';

function PresencePill({ c }: { c: ConsoleController }) {
  const p = c.state.presence;
  let cls = 'pill warn';
  let label = 'No desktop connected';
  if (p.kind === 'local') {
    cls = 'pill ok';
    label = 'Listening - direct bridge';
  } else if (p.kind === 'remote') {
    cls = 'pill accent';
    label = 'Listening on ' + (p.deviceName || 'another machine') + ' - relay';
  } else if (c.isDemo()) {
    cls = 'pill';
    label = 'Demo bridge - simulated';
  }
  return (
    <span id="presence" class={cls}>
      <span class={'dot' + (p.kind !== 'none' ? ' live' : '')} />
      {label}
    </span>
  );
}

/** The between-calls surface: the last-call line plus the presence-branched panel.
 *  - remote: a REAL desktop is running (reachable via the relay). Mirror note only,
 *    NEVER the demo Simulate (a scripted call must never be offered when real
 *    hardware is live; that was the "connected but shows Simulate" bug).
 *  - none / demo: no real runtime at all, so offer the scripted demo call.
 *  - local: direct bridge, no panel. */
function Standby({ c }: { c: ConsoleController }) {
  const s = c.state;
  const last = s.recent.length > 0 ? s.recent[0] : null;
  let when: string | null = null;
  if (last) {
    const a = rec(last.answers);
    const startedAt = a.started_at;
    when = hhmm(typeof startedAt === 'string' && startedAt !== '' ? startedAt : last.submittedAt || '');
  }
  const line = c.remoteMode() ? 'Updates every 10s' : when ? 'Last call ' + when : 'Waiting for the next call';
  return (
    <div class="standby">
      <div class="faint">{line}</div>
      {s.presence.kind === 'remote' ? (
        <div class="card">
          <p class="note">
            {'The receptionist runs on ' + (s.presence.deviceName || 'another machine')
              + '. This console mirrors its calls and relays your controls.'}
          </p>
        </div>
      ) : s.presence.kind !== 'local' ? (
        <div class="card">
          <p class="note lead">
            Install FormLogic Desktop (Device Setup) to take real calls. Until then, run a scripted demo call to explore the flow.
          </p>
          <button type="button" class="btn" data-act="simulate" disabled={s.simulating}
            onClick={() => c.simulate()}>
            {s.simulating ? 'Simulating...' : 'Simulate incoming call'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function App() {
  const [, setVersion] = useState(0);
  const c = useMemo(() => createConsole(() => setVersion((v) => v + 1)), []);
  useEffect(() => c.wire(), [c]);
  const call = c.activeCall();
  return (
    <div id="lc" aria-label="Live call console">
      <div class="console">
        <div class="chead">
          <div class="ident">
            <span class="logo" aria-hidden="true">A</span>
            <div>
              <h1>Aokie Receptionist</h1>
              <p class="sub">Front desk console</p>
            </div>
          </div>
          <PresencePill c={c} />
        </div>
        <div class="cbody">
          {call === null && <Standby c={c} />}
          {call !== null && <CallStage c={c} call={call} />}
          {call !== null && <LiveCaptions call={call} captions={c.state.captions} />}
          <Transcript c={c} call={call} />
          <RecentCalls c={c} />
        </div>
      </div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
