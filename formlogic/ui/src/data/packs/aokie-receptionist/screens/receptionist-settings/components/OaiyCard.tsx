/** @jsxImportSource preact */
// OAIY status: is the desktop that answers calls reachable (and when it was
// last seen when it is not), where Aokie sends calls right now, the model and
// voice OAIY reports, who calls back missed calls - and the one next step when
// something needs doing (Use OAIY, record the route, restart, consent).
import {
  agoText,
  dirty,
  doSave,
  liveCallRoute,
  oaiyReport,
  reachable,
  refreshRunningClick,
  state,
  unreachableText,
  useOaiy,
} from '../store';

function routeText(r: string): string {
  if (r === 'oaiy') return 'OAIY';
  if (r === 'realtime') return 'Another realtime provider';
  if (r === 'local') return "Aokie's own speech";
  if (r === 'flows') return 'Your flows (no AI receptionist)';
  return 'Not known yet';
}

export function OaiyCard() {
  const reach = reachable();
  const live = liveCallRoute();
  const report = oaiyReport();
  const p = state.presence as FlPresence;
  const note = state.applyNote;
  const busy = !!state.busy.apply || !!state.busy.save;
  // The follow-ups read the SAVED record's route, not the draft on screen.
  const savedOaiy = !!state.saved && String(state.saved.call_route || '').trim() === 'oaiy';
  let pill = <span class="pill">Checking...</span>;
  if (reach === 'yes' && p.kind === 'local') pill = <span class="pill ok">Connected on this computer</span>;
  else if (reach === 'yes') pill = <span class="pill ok">{'Connected: ' + (p.deviceName || 'linked computer')}</span>;
  else if (reach === 'no') pill = <span class="pill warn">Offline</span>;
  const seen = p.kind === 'remote' ? agoText(p.lastSeenAt) : '';
  return (
    <section class="card oaiy" data-oaiy-card aria-label="OAIY">
      <div class="hdr">
        <div class="titlewrap">
          <span class="mark" aria-hidden="true">O</span>
          <div>
            <h2 class="title">OAIY</h2>
            <p class="sub">Answers calls on your computer: its Front desk agent talks, OAIY Voice hears and speaks.</p>
          </div>
        </div>
        {pill}
      </div>
      {reach === 'no' ? (
        <div class="notice warn" role="status" data-oaiy-offline>
          <strong>{unreachableText()}</strong>
          <span>
            While it is away it keeps answering calls, lookups and appointment requests from its own calendar, and it
            syncs the Appointments form when it reconnects. Settings saved here apply on the first call after that.
          </span>
        </div>
      ) : null}
      {reach === 'yes' && p.kind === 'remote' ? (
        <p class="muted">{'Running on ' + (p.deviceName || 'a linked computer') + (seen ? ' (seen ' + seen + ')' : '') + '. Reads and saves are relayed to it.'}</p>
      ) : null}
      <dl class="facts" aria-label="OAIY status">
        <div data-oaiy-route>
          <dt>Calls go to</dt>
          <dd>
            <span class={'dot ' + (live === 'oaiy' ? 'ok' : live === 'unknown' ? '' : 'warn')} aria-hidden="true" />
            {routeText(live)}
          </dd>
        </div>
        <div data-oaiy-model>
          <dt>Model</dt>
          <dd>{report.model || 'Chosen in OAIY > Engines'}</dd>
        </div>
        <div data-oaiy-voice>
          <dt>Voice</dt>
          <dd>{report.voiceStatus ? 'OAIY Voice ' + report.voiceStatus + ' - the voice chosen in OAIY' : 'The voice chosen in OAIY'}</dd>
        </div>
        <div data-oaiy-callbacks>
          <dt>Missed-call callbacks</dt>
          <dd>
            {savedOaiy
              ? 'OAIY rings them back - set in OAIY > Agent > Phone'
              : 'FormLogic follow-ups ring them back (when outbound calling is on in Aokie)'}
          </dd>
        </div>
      </dl>
      {live !== 'oaiy' && live !== 'unknown' && !state.routeAdopted ? (
        <div class="notice" data-use-oaiy-offer>
          <span>
            {live === 'realtime'
              ? 'Aokie sends calls to another realtime provider. Nothing moves until you choose: Use OAIY sends calls to OAIY on this computer.'
              : live === 'flows'
                ? 'Aokie has no AI receptionist on: your flows or you speak to callers. Use OAIY lets its Front desk agent answer.'
                : "Aokie answers with its own speech lanes. Use OAIY lets OAIY's Front desk agent answer in the OAIY voice."}
          </span>
          <button type="button" class="btn primary" data-act="use-oaiy" disabled={busy || !state.mayWrite} onClick={useOaiy}>
            {state.busy.apply ? 'Moving calls...' : 'Use OAIY'}
          </button>
        </div>
      ) : null}
      {state.routeAdopted ? (
        <div class="notice" data-route-adopted>
          <span>Aokie already sends calls to OAIY. Save to record it here too: the follow-ups then leave missed-call callbacks to OAIY.</span>
          <button type="button" class="btn primary" data-act="record-oaiy" disabled={busy || !dirty()} onClick={doSave}>
            {state.busy.save ? 'Saving...' : 'Save'}
          </button>
        </div>
      ) : null}
      {note ? (
        <div class={'notice ' + note.tone} role={note.tone === 'ok' ? 'status' : 'alert'} data-apply-note={note.tone}>
          <span>{note.text}</span>
        </div>
      ) : null}
      <div class="actions">
        <button type="button" class="btn sm" data-act="refresh-oaiy" disabled={state.runningRefreshing} onClick={refreshRunningClick}>
          {state.runningRefreshing ? 'Checking...' : 'Check again'}
        </button>
      </div>
    </section>
  );
}
