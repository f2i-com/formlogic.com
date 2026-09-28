/** @jsxImportSource preact */
// "What the receptionist is running now" - an authoritative settings.get
// summary. It never substitutes the saved form record for unavailable live
// settings, and Refresh can reconcile after OAIY or Aokie restarts.
import { refreshRunningClick, state } from '../store';

export function RunningCard() {
  const r = state.running;
  const toOaiy = !!r && r.voiceMode === 'oaiy';
  return (
    <section class="card running" aria-label="What the receptionist is running now">
      <div class="hdr">
        <h2>What the receptionist is running now</h2>
        <button
          type="button"
          class="btn sm"
          data-act="refresh-running"
          disabled={state.runningRefreshing}
          onClick={refreshRunningClick}
        >
          {state.runningRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      {r ? (
        <>
          <p class="greet"><span class="faint">Greeting: </span>"{r.greeting || '-'}"</p>
          <dl class="facts running-facts" aria-label="Live receptionist configuration">
            <div data-running-mode><dt>Calls go to</dt><dd>{r.voiceModeLabel}</dd></div>
            <div data-running-provider><dt>Who talks</dt><dd>{r.providerLabel}</dd></div>
            {/* On OAIY's route the model and voice are OAIY's: the OAIY card above shows them. */}
            {toOaiy ? null : <div data-running-model><dt>Model</dt><dd>{r.model}</dd></div>}
            {toOaiy ? null : r.voiceMode === 'desktop_realtime' ? (
              <div data-running-voice><dt>Realtime voice</dt><dd>{r.realtimeVoice + ' - ' + r.realtimeTurnDetection}</dd></div>
            ) : (
              <div data-running-voice><dt>Voice</dt><dd>{r.voice || 'Default'}</dd></div>
            )}
            <div data-running-appointments><dt>Appointments</dt><dd>{r.appointmentToolsLabel}</dd></div>
            <div data-running-hangup>
              <dt>Agent hang-up</dt>
              <dd>{r.agentHangup ? 'On - farewell then end the call' : 'Off - caller or operator ends the call'}</dd>
            </div>
            <div data-running-version><dt>Configuration</dt><dd>{typeof r.configVersion === 'number' ? 'v' + r.configVersion : 'Current version unavailable'}</dd></div>
          </dl>
          {state.runningRefreshing ? <p class="running-refresh">Checking what Aokie is running...</p> : null}
          {r.persona ? (
            <p class="persona" title={r.persona}>
              <span class="faint">{toOaiy ? 'Brief: ' : 'Persona: '}</span>
              {r.persona}
            </p>
          ) : null}
        </>
      ) : (
        <p class="muted" data-running-empty>
          {state.runningRefreshing
            ? 'Reading what Aokie is running...'
            : state.runningError
              ? 'Live configuration unavailable - ' + state.runningError
            : state.canGet
              ? 'Reading the live configuration...'
              : 'Your role cannot read the live configuration.'}
        </p>
      )}
      <p class="hint">{'Read from Aokie through OAIY. The Configure Receptionist flow re-applies the saved settings on every incoming call; "Save & apply now" updates the line at once. A new route takes effect when the receptionist restarts.'}</p>
    </section>
  );
}
