/** @jsxImportSource preact */
// Call screening: block list (with one-click unblock chips), accept filter,
// private-caller screening, abuse auto-block, whitelist mode, manager numbers
// and the MANAGER PIN.
//
// MANAGER PIN SECURITY (reviewed - do not weaken):
//  - the input is a blank password field; the stored PIN is NEVER readable
//    (the plugin's settings.get returns only the managerPinSet boolean);
//  - leaving it blank on save KEEPS the current PIN (saveScreening sends the
//    managerPin key only when a new one was typed);
//  - clearing requires the explicit "Remove PIN" affordance;
//  - the set/unset tag renders from managerPinSet alone.
import { splitList } from '../helpers';
import { removePin, saveScreening, screeningInput, screeningToggle, state, unblock } from '../store';

export function ScreeningCard() {
  if (!state.canSet) return null;
  const sc = state.screening;
  const blocked = splitList(sc.blockedNumbers);
  return (
    <div class="card">
      <h2>Call screening</h2>
      <p class="muted">Who gets through. Screened callers hear a short message (or nothing) and the call ends - no greeting, no AI. Changes apply on the next incoming call.</p>
      <label class="f">
        <span class="lbl">Blocked numbers</span>
        <textarea
          class="mono"
          data-sc="blockedNumbers"
          rows={3}
          placeholder="One per line (or comma-separated)"
          value={sc.blockedNumbers}
          onInput={(e) => screeningInput('blockedNumbers', e.currentTarget.value)}
        />
        {blocked.length ? (
          <div class="chips">
            {blocked.map((n, i) => (
              <span class="chip mono" key={i}>
                {n}
                <button type="button" data-unblock={n} aria-label="Unblock" onClick={() => unblock(n)}>x</button>
              </span>
            ))}
          </div>
        ) : null}
        <span class="hint">Any format - numbers match on their digits.</span>
      </label>
      <label class="f">
        <span class="lbl">Message for blocked numbers</span>
        <input
          type="text"
          data-sc="blockedMessage"
          value={sc.blockedMessage}
          placeholder="Blank = reject silently (just hang up)."
          onInput={(e) => screeningInput('blockedMessage', e.currentTarget.value)}
        />
        <span class="hint">Only for the blocked list above.</span>
      </label>
      <label class="f">
        <span class="lbl">Accept filter (regular expression)</span>
        <input
          type="text"
          class="mono"
          data-sc="acceptPattern"
          value={sc.acceptPattern}
          placeholder="e.g. ^(+?61|0)4 - Australian mobiles only. Blank = accept all."
          onInput={(e) => screeningInput('acceptPattern', e.currentTarget.value)}
        />
        <span class="hint">{"Caller IDs that don't match are screened out. An invalid pattern is ignored."}</span>
      </label>
      <label class="chk">
        <input
          type="checkbox"
          data-sc="rejectPrivate"
          checked={sc.rejectPrivate}
          onChange={(e) => screeningToggle('rejectPrivate', e.currentTarget.checked)}
        />
        <span>Screen private / withheld numbers</span>
      </label>
      <label class="f">
        <span class="lbl">Message for filtered / private callers</span>
        <input
          type="text"
          data-sc="screenMessage"
          value={sc.screenMessage}
          placeholder="e.g. Please call back with caller ID enabled. (blank = hang up silently)"
          onInput={(e) => screeningInput('screenMessage', e.currentTarget.value)}
        />
      </label>
      <label class="chk">
        <input
          type="checkbox"
          data-sc="autoBlockAbuse"
          checked={sc.autoBlockAbuse}
          onChange={(e) => screeningToggle('autoBlockAbuse', e.currentTarget.checked)}
        />
        <span>
          Auto-block abusive callers
          <span class="sub">When the AI flags genuine abuse it speaks a short notice, ends the call, and adds the number to the block list.</span>
        </span>
      </label>
      <label class="chk">
        <input
          type="checkbox"
          data-sc="whitelistOnly"
          checked={sc.whitelistOnly}
          onChange={(e) => screeningToggle('whitelistOnly', e.currentTarget.checked)}
        />
        <span>
          Whitelist mode - known customers only
          <span class="sub">Callers with no Customer record are rejected once their number is known.</span>
        </span>
      </label>
      <label class="f">
        <span class="lbl">Manager numbers</span>
        <textarea
          class="mono"
          data-sc="managerNumbers"
          rows={2}
          placeholder="One per line - e.g. your own mobile"
          value={sc.managerNumbers}
          onInput={(e) => screeningInput('managerNumbers', e.currentTarget.value)}
        />
        <span class="hint">Calls from these numbers get the manager treatment. Never screened out.</span>
      </label>
      <label class="f">
        <span class="lbl" style="display:flex;justify-content:space-between">Manager PIN (spoken) {sc.managerPinSet ? <span class="pill ok">PIN set</span> : <span class="faint">no PIN - read-only line</span>}</span>
        <input
          type="password"
          inputmode="numeric"
          autocomplete="off"
          class="mono"
          data-sc="managerPin"
          value={sc.managerPin}
          placeholder={sc.managerPinSet
            ? 'Enter a new PIN to replace it - blank keeps the current one'
            : 'Set a 6-8 digit PIN - blank = manager line stays read-only'}
          onInput={(e) => screeningInput('managerPin', e.currentTarget.value)}
        />
        <span class="hint">
          Booking changes by voice need this PIN spoken once per call. For your security the saved PIN is never shown back - leave blank to keep the current one.
          {sc.managerPinSet ? (
            <>
              {' '}
              <button type="button" data-act="remove-pin" class="btn sm" style="margin-top:4px" onClick={removePin}>Remove PIN</button>
            </>
          ) : null}
        </span>
      </label>
      <label class="f">
        <span class="lbl">Default country code for texts</span>
        <input
          type="text"
          class="mono"
          data-sc="defaultCountryCode"
          value={sc.defaultCountryCode}
          placeholder="e.g. +61 - blank = send numbers exactly as saved"
          onInput={(e) => screeningInput('defaultCountryCode', e.currentTarget.value)}
        />
      </label>
      <div class="savebtnrow">
        <button type="button" class="btn dark sm" data-act="save-screening" disabled={!!state.busy.screening || !sc.loaded} onClick={saveScreening}>
          {state.busy.screening ? 'Saving...' : 'Save screening'}
        </button>
        {sc.loaded ? null : <span class="faint">Loading current values...</span>}
      </div>
    </div>
  );
}
