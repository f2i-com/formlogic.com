/** @jsxImportSource preact */
// Where calls go: OAIY first and recommended; Aokie's own speech lanes and
// "as set in Aokie" (another realtime provider, or whatever Aokie's own
// settings name) stay available behind "Other routes". The route rides the
// record (call_route); the Configure Receptionist flow applies it per call
// and "Save & apply now" applies it at once. A route change takes effect when
// the receptionist next starts.
import { d, draftInput, route, routeChange, state, toggleOtherRoutes } from '../store';

function Choice(props: { value: string; current: string; title: string; badge?: string; children: string }) {
  const on = props.current === props.value;
  return (
    <label class={'choice' + (on ? ' on' : '')}>
      <input
        type="radio"
        name="call_route"
        data-route={props.value || 'aokie-settings'}
        checked={on}
        onChange={() => routeChange(props.value)}
      />
      <span class="choice-body">
        <span class="choice-title">
          {props.title}
          {props.badge ? <span class="pill accent">{props.badge}</span> : null}
        </span>
        <span class="choice-sub">{props.children}</span>
      </span>
    </label>
  );
}

export function RouteCard() {
  const current = route();
  const other = current !== 'oaiy';
  return (
    <section class="card" data-route-card aria-label="Where calls go">
      <h2>Where calls go</h2>
      <Choice value="oaiy" current={current} title="OAIY (this computer)" badge="Recommended">
        {"OAIY hears the caller (Parakeet), its Front desk agent talks with its own brief, knowledge and caller notes, and it speaks in the voice chosen in OAIY. FormLogic still sends the greeting and the brief below, screens callers, answers bookings and lookups, and keeps every record."}
      </Choice>
      <details class="others" open={state.showOtherRoutes || other} onToggle={(e) => toggleOtherRoutes(e.currentTarget.open)}>
        <summary data-act="toggle-other-routes">Other routes</summary>
        <Choice value="aokie" current={current} title="Aokie's own speech">
          {"Aokie hears and speaks on this computer with the model, speech-to-text and voice you pick below. Takes calls back from OAIY or any realtime provider."}
        </Choice>
        <Choice value="" current={current} title="As set in Aokie">
          {"Leave the route to Aokie's own settings (for example another realtime provider). FormLogic still sends the greeting, persona and speech picks, but never moves the route."}
        </Choice>
      </details>
      <p class="hint">{'A new route takes effect when the receptionist restarts (OAIY > Plugins > Aokie). Everything else applies on the next call.'}</p>
      <label class="f inline">
        <span class="lbl">These settings are</span>
        <select data-d="active" value={d().active} onChange={(e) => draftInput('active', e.currentTarget.value)}>
          <option value="yes">Active - used on every call</option>
          <option value="no">Inactive - the flows fall back to defaults</option>
        </select>
      </label>
    </section>
  );
}
