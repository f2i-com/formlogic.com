/** @jsxImportSource preact */
// "What the receptionist is running now" - the live settings.get strip
// (greeting / voice / model / agent-vs-flow / configVersion) with Refresh.
import { refreshRunningClick, state } from '../store';

export function RunningCard() {
  const r = state.running;
  return (
    <div class="card running">
      <div class="hdr">
        <h2>What the receptionist is running now</h2>
        <button type="button" class="btn sm" data-act="refresh-running" onClick={refreshRunningClick}>Refresh</button>
      </div>
      {r ? (
        <>
          <p class="greet"><span class="faint">Greeting: </span>"{r.greeting || '-'}"</p>
          <p class="meta">
            {'Voice ' + (r.voice || 'default') + ' - model ' + (r.model || 'auto') + ' - '
              + (r.aiReceptionist ? 'built-in AI agent replies' : 'flow-driven replies')
              + (typeof r.configVersion === 'number' ? ' - config v' + r.configVersion : '')}
          </p>
          {r.persona ? <p class="persona" title={r.persona}>{r.persona}</p> : null}
        </>
      ) : (
        <p class="muted">
          {state.runningError
            ? 'Live configuration unavailable - ' + state.runningError
            : state.canGet
              ? 'Reading the live configuration...'
              : 'Your role cannot read the live configuration.'}
        </p>
      )}
      <p class="hint">{'The Configure Receptionist flow re-applies the saved settings on every incoming call, so saving is enough - "Save & apply now" just updates the live line immediately.'}</p>
    </div>
  );
}
