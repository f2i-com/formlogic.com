/** @jsxImportSource preact */
// "What the receptionist is running now" - an authoritative settings.get
// summary. It never substitutes the saved form record for unavailable live
// settings, and Refresh can reconcile after Desktop/Aokie restarts.
import { refreshRunningClick, state } from '../store';

export function RunningCard() {
  const r = state.running;
  return (
    <div class="card running">
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
          <div class="running-facts" aria-label="Live receptionist configuration">
            <div data-running-mode><span>Live-call voice mode</span><strong>{r.voiceModeLabel}</strong></div>
            <div data-running-provider><span>Provider</span><strong>{r.providerLabel}</strong></div>
            <div data-running-model><span>Model</span><strong>{r.model}</strong></div>
            {r.voiceMode === 'desktop_realtime' ? (
              <div data-running-voice><span>Realtime voice</span><strong>{r.realtimeVoice + ' - ' + r.realtimeTurnDetection}</strong></div>
            ) : (
              <div data-running-voice><span>Voice</span><strong>{r.voice || 'Default'}</strong></div>
            )}
            <div data-running-appointments><span>Appointments</span><strong>{r.appointmentToolsLabel}</strong></div>
            <div data-running-hangup>
              <span>Agent hang-up</span>
              <strong>{r.agentHangup ? 'On - farewell then end the call' : 'Off - caller or operator ends the call'}</strong>
            </div>
            <div data-running-version><span>Configuration</span><strong>{typeof r.configVersion === 'number' ? 'v' + r.configVersion : 'Current version unavailable'}</strong></div>
          </div>
          {state.runningRefreshing ? <p class="running-refresh">Checking the live Desktop configuration...</p> : null}
          {r.persona ? <p class="persona" title={r.persona}>{r.persona}</p> : null}
        </>
      ) : (
        <p class="muted">
          {state.runningRefreshing
            ? 'Reading the live Desktop configuration...'
            : state.runningError
              ? 'Live configuration unavailable - ' + state.runningError
            : state.canGet
              ? 'Reading the live configuration...'
              : 'Your role cannot read the live configuration.'}
        </p>
      )}
      <p class="hint">{'This card is read directly from Aokie through FormLogic Desktop. The Configure Receptionist flow re-applies saved app settings on each incoming call; "Save & apply now" updates the live line immediately.'}</p>
    </div>
  );
}
