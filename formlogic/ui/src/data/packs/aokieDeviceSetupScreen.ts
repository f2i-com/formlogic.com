// Pack-owned Device Setup section screen (plan §8.4 port #4 — self-contained apps).
//
// The SANDBOXED-CODE twin of the compiled registry screen `aokie-pairing`
// (components/custom-screen/aokie/AokiePairingScreen.tsx): desktop runtime status,
// Bluetooth dongles + driver install, the paired phone with reconnect/disconnect,
// Companion endpoint administration, the hardware-event log, and the Start-fresh
// reset — all shipped INSIDE the pack as plain HTML/CSS/JS. The compiled screen +
// its registry entry stay untouched; rollback is flipping the Hardware Events
// form's customScreen back to the sdk reference.
//
// Runtime contract (CustomScreenRuntime in the APP runtime):
//  - opaque-origin iframe; window.FormLogic is the only capability;
//  - uses the FULL bridge: connector() (dongle/phone commands, local-or-relay
//    routing is transparent), service() (linked desktops + Companion admin),
//    records()/deleteRecords() (hardware-event log), presence(), can()
//    (advisory button gating), host.ceremony() ('connect-desktop' pairing,
//    'start-fresh' reset — both host-owned with the host's own consent UI);
//  - every one of those actions is TRUSTED_ONLY, so the form's
//    custom_screen_trust must be owner/verified;
//  - PARITY GAPS vs the compiled screen (deliberate, documented): no desktop
//    plugin list (desktop-app detail), and Companion routing groups / history
//    live in FormLogic Desktop's Companion admin — this screen covers
//    endpoints (revoke/approve) + the remote-access policy.
//
// KEEP THE EMBEDDED JS ES5-ish and free of regex/template literals — string
// escapes inside this TS template literal are a documented foot-gun
// (retrofit lesson 2026-07-14): character checks beat regexes here.

const HTML = `
<div id="ds" aria-label="Device setup">
  <div class="head">
    <h1>Device Setup</h1>
    <button type="button" id="refresh" class="btn">Refresh</button>
  </div>
  <div id="banner"></div>
  <div id="runtime" class="card"></div>
  <div id="dongles" class="card"></div>
  <div id="phones" class="card"></div>
  <div id="companion" class="card"></div>
  <div id="events" class="card"></div>
  <div id="fresh" class="card danger"></div>
</div>`;

const CSS = `
html, body { background: transparent; }
body { padding: 14px 16px; color: var(--fl-text); }
#ds { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }

#ds .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
#ds h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
#ds h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--fl-text); }

#ds .card { background: var(--fl-surface); border: 1px solid var(--fl-border); border-radius: 14px; padding: 14px 16px; }
#ds .card.danger { border-color: var(--fl-bad); }

#ds .btn {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 500; color: var(--fl-text);
  background: var(--fl-surface); border: 1px solid var(--fl-border);
  border-radius: 10px; padding: 6px 12px;
}
#ds .btn:hover { background: var(--fl-surface-2); }
#ds .btn[disabled] { opacity: .45; cursor: not-allowed; }
#ds .btn.primary { background: var(--fl-accent); border-color: var(--fl-accent); color: var(--fl-accent-contrast); }
#ds .btn.danger-btn { background: var(--fl-bad); border-color: var(--fl-bad); color: #fff; }

#ds .muted { color: var(--fl-muted); font-size: 12.5px; }
#ds .faint { color: var(--fl-faint); font-size: 12px; }
#ds .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }

#ds .pill {
  display: inline-flex; align-items: center; border-radius: 999px;
  padding: 2px 9px; font-size: 10.5px; font-weight: 600;
  border: 1px solid var(--fl-border); color: var(--fl-muted); background: var(--fl-surface-2);
}
#ds .pill.ok { color: var(--fl-good); border-color: var(--fl-good); background: transparent; }
#ds .pill.warn { color: var(--fl-warn); border-color: var(--fl-warn); background: transparent; }
#ds .pill.bad { color: var(--fl-bad); border-color: var(--fl-bad); background: transparent; }
#ds .pill.accent { color: var(--fl-accent); border-color: var(--fl-accent); background: transparent; }

#ds #banner:empty { display: none; }
#ds #banner { border: 1px solid var(--fl-bad); border-radius: 12px; padding: 10px 14px; font-size: 13px; color: var(--fl-bad); overflow-wrap: break-word; }

#ds table { width: 100%; border-collapse: collapse; font-size: 13px; }
#ds th { text-align: left; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--fl-faint); padding: 4px 10px 6px 0; }
#ds td { padding: 7px 10px 7px 0; border-top: 1px solid var(--fl-border); vertical-align: middle; }
#ds .tscroll { overflow-x: auto; }

#ds ul { list-style: none; margin: 0; padding: 0; }
#ds li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; border-top: 1px solid var(--fl-border); }
#ds li:first-child { border-top: 0; }
#ds .rowmain { min-width: 0; }
#ds .rowname { font-size: 13.5px; font-weight: 500; }

#ds .policy { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px 14px; margin: 8px 0 10px; }
#ds .policy label { display: flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; }

#ds .freshrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
#ds input[type="text"] {
  font: inherit; font-size: 13px; color: var(--fl-text);
  background: var(--fl-surface); border: 1px solid var(--fl-border);
  border-radius: 10px; padding: 7px 11px; width: 220px;
}
#ds .sectionrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
#ds .sectionrow h2 { margin: 0; }
`;

const JS = `
// Device Setup console, pack-owned. All host access goes through window.FormLogic;
// every record/service value is escaped with FormLogic.escapeHtml before innerHTML.
(function () {
  var FL = window.FormLogic;
  var esc = FL.escapeHtml;
  var $ = function (id) { return document.getElementById(id); };

  // ── tiny helpers ────────────────────────────────────────────────────────
  function el(id, html) { $(id).innerHTML = html; }
  function banner(msg) { $('banner').textContent = msg || ''; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rec(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  // connector command -> result object, or throw with a readable message.
  function cmd(name, payload) {
    return FL.connector('aokie', name, payload || {}).then(function (out) {
      if (out.status === 'done') return rec(out.result);
      var m = out.error && out.error.message ? String(out.error.message) : out.status;
      if (out.error && out.error.code === 'connector_unavailable') {
        m = 'FormLogic Desktop is not reachable right now - connect it above, then press Refresh.';
      }
      throw new Error(m);
    });
  }

  // typed service op -> result object, or throw with the server's message.
  function svc(op, input) {
    return FL.service(op, input || {}).then(function (out) {
      if (out.status === 'done') return rec(out.result);
      throw new Error(out.error && out.error.message ? String(out.error.message) : 'Service operation failed');
    });
  }

  // Zone-less 'YYYY-MM-DD HH:MM:SS' timestamps are stored UTC — stamp the Z
  // (character checks, not a regex: template-literal escaping foot-gun).
  function utcify(s) {
    if (typeof s !== 'string') return s;
    if (s.length === 19 && s.charAt(4) === '-' && s.charAt(10) === ' ' && s.charAt(13) === ':') {
      return s.slice(0, 10) + 'T' + s.slice(11) + 'Z';
    }
    return s;
  }
  function whenLabel(iso) {
    var ms = Date.parse(utcify(iso || ''));
    if (isNaN(ms)) return null;
    var d = new Date(ms);
    return {
      short: d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
      full: d.toLocaleString()
    };
  }
  function agoLabel(iso) {
    var ms = Date.parse(utcify(iso || ''));
    if (isNaN(ms)) return null;
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  var state = {
    demo: false,
    presence: null,          // { kind, deviceName?, lastSeenAt? }
    desktops: null,          // linked-desktop registry rows (owner only)
    dongles: null, enumNote: null, preferred: {},
    phones: null,            // bonded list
    companion: null,         // { devices?, policy?, canEdit }
    events: null,            // hardware-event records
    busy: {}                 // per-action busy flags
  };

  // ── runtime / desktop card ─────────────────────────────────────────────
  function paintRuntime() {
    if (state.demo) {
      el('runtime', '<h2>Demo bridge</h2>'
        + '<p class="muted">This is the shared demo, so the hardware below is simulated - FormLogic Desktop and real phones are never used here. Use "Simulate incoming call" on the Calls screen to see the receptionist in action.</p>');
      return;
    }
    var p = state.presence;
    var html = '<div class="sectionrow"><h2>FormLogic Desktop</h2>';
    if (p && p.kind === 'local') html += '<span class="pill ok">Connected on this computer</span>';
    else if (p && p.kind === 'remote') html += '<span class="pill accent">Running on ' + esc(p.deviceName || 'another machine') + '</span>';
    else html += '<span class="pill warn">Not connected</span>';
    html += '</div>';

    if (p && p.kind === 'remote') {
      var ago = agoLabel(p.lastSeenAt);
      html += '<p class="muted">The receptionist runs on <strong>' + esc(p.deviceName || 'another machine') + '</strong>'
        + (ago ? ' (last seen ' + esc(ago) + ')' : '') + ' - phone commands below are relayed to that machine.</p>';
    } else if (p && p.kind === 'local') {
      html += '<p class="muted">Device plugins and hardware connectors are served by the FormLogic Desktop on this computer.</p>';
    } else {
      html += '<p class="muted">FormLogic Desktop hosts the phone bridge and hardware connectors. Start it on this computer, then connect it - approving the request on the desktop issues a token bound to this site.</p>'
        + '<p style="margin:10px 0 0"><button type="button" class="btn primary" data-act="connect-desktop">Connect FormLogic Desktop</button></p>';
    }

    if (state.desktops && state.desktops.length > 0) {
      html += '<p class="faint" style="margin:10px 0 4px">Linked desktops</p><ul>';
      for (var i = 0; i < state.desktops.length; i++) {
        var d = state.desktops[i];
        var seen = agoLabel(d.lastSeenAt);
        html += '<li><div class="rowmain"><span class="rowname">' + esc(d.deviceName || 'Desktop') + '</span></div>'
          + '<span class="faint">' + esc(seen ? 'Last seen ' + seen : '') + '</span></li>';
      }
      html += '</ul>';
    }
    el('runtime', html);
  }

  // ── dongles ────────────────────────────────────────────────────────────
  function paintDongles() {
    var html = '<h2>Bluetooth dongles</h2>';
    return FL.can('connector.aokie.dongle.list').then(function (allowed) {
      if (!allowed) { el('dongles', html + '<p class="faint">This app has not been granted dongle access.</p>'); return; }
      var rows = state.dongles;
      if (rows === null) { el('dongles', html + '<p class="faint">Loading...</p>'); return; }
      if (rows.length === 0) {
        el('dongles', html + '<p class="faint">' + esc(state.enumNote
          ? 'Live USB scan unavailable: ' + state.enumNote
          : 'No supported dongles detected. Plug in the certified USB dongle (or one with the WinUSB driver bound).') + '</p>');
        return;
      }
      html += '<div class="tscroll"><table><thead><tr><th>Dongle</th><th>USB id</th><th>Driver</th><th></th></tr></thead><tbody>';
      for (var i = 0; i < rows.length; i++) {
        var d = rows[i];
        html += '<tr><td><span class="rowname">' + esc(d.name) + '</span>'
          + (d.preferred ? ' <span class="pill accent">preferred</span>' : '')
          + (d.matchesCatalog ? ' <span class="pill ok">supported</span>' : '')
          + '</td><td class="mono">' + esc(d.usbId) + '</td>'
          + '<td><span class="' + (d.driverInstalled ? 'pill ok' : 'pill warn') + '">' + (d.driverInstalled ? 'Installed' : 'Required') + '</span></td>'
          + '<td style="text-align:right;white-space:nowrap">';
        if (!d.driverInstalled) {
          html += '<button type="button" class="btn" data-act="install-driver" data-i="' + i + '"'
            + (state.busy.driver ? ' disabled' : '') + '>'
            + (state.busy.driver === d.id ? 'Installing...' : 'Install driver') + '</button> ';
        }
        if (!d.preferred) {
          html += '<button type="button" class="btn" data-act="set-preferred" data-i="' + i + '">Set preferred</button>';
        }
        html += '</td></tr>';
      }
      html += '</tbody></table></div>';
      el('dongles', html);
    });
  }

  // ── phones ─────────────────────────────────────────────────────────────
  function paintPhones() {
    var html = '<h2>Paired phone</h2>';
    var rows = state.phones;
    if (rows === null) { el('phones', html + '<p class="faint">Loading...</p>'); return; }
    if (rows.length === 0) {
      el('phones', html + '<p class="faint">No phones paired yet. On your phone, open Bluetooth settings and pair with "Aokie AI Assistant" once the dongle driver is installed.</p>');
      return;
    }
    html += '<ul>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var busy = state.busy.phone === r.address;
      html += '<li><div class="rowmain"><span class="rowname">' + esc(r.name || 'Paired phone') + '</span> '
        + '<span class="' + (r.connected ? 'pill ok' : 'pill') + '">' + (r.connected ? 'Connected' : 'Not connected') + '</span>'
        + '<div class="mono faint">' + esc(r.address) + '</div></div>';
      if (r.connected) {
        html += '<button type="button" class="btn" data-act="phone-disconnect" data-i="' + i + '"' + (busy ? ' disabled' : '')
          + ' title="Disconnect this phone. It usually reconnects on its own - use this to clear a stuck connection.">'
          + (busy ? 'Disconnecting...' : 'Disconnect') + '</button>';
      } else {
        html += '<button type="button" class="btn" data-act="phone-connect" data-i="' + i + '"' + (busy ? ' disabled' : '')
          + ' title="Reconnect this phone - the dongle pages it and re-establishes the hands-free link.">'
          + (busy ? 'Reconnecting...' : 'Reconnect') + '</button>';
      }
      html += '</li>';
    }
    html += '</ul><p class="faint" style="margin:8px 0 0">Disconnecting keeps the pairing - the phone normally reconnects on its own within a few seconds. To add a new phone, pair it from the phone\\'s Bluetooth settings.</p>';
    el('phones', html);
  }

  // ── Companion access ───────────────────────────────────────────────────
  function paintCompanion() {
    if (state.demo) { el('companion', '<h2>Companion access</h2><p class="faint">Not available in the shared demo.</p>'); return; }
    var c = state.companion;
    var html = '<h2>Companion access</h2>';
    if (c === null) { el('companion', html + '<p class="faint">Loading...</p>'); return; }
    if (c.hidden) { el('companion', html + '<p class="faint">Your role does not include Companion administration.</p>'); return; }

    if (c.policy) {
      html += '<p class="muted" style="margin:0 0 2px">Remote access policy - what linked Companion endpoints may do on live calls.</p>';
      var keys = [
        ['remoteMonitoring', 'Monitor live calls'],
        ['remoteConsult', 'Consult (talk to Aokie privately)'],
        ['remoteTakeover', 'Take over calls'],
        ['remoteCaptions', 'Live captions'],
        ['remoteAssistance', 'Assistance requests']
      ];
      html += '<div class="policy">';
      for (var k = 0; k < keys.length; k++) {
        html += '<label><input type="checkbox" data-policy="' + keys[k][0] + '"'
          + (c.policy[keys[k][0]] ? ' checked' : '') + (c.canEdit ? '' : ' disabled') + '> ' + esc(keys[k][1]) + '</label>';
      }
      html += '</div>';
      if (!c.policy.configured) {
        html += '<p class="faint" style="margin:0 0 8px">No explicit policy is set yet - everything stays OFF until one is saved.</p>';
      }
      if (c.canEdit) {
        html += '<button type="button" class="btn" data-act="save-policy"' + (state.busy.policy ? ' disabled' : '') + '>'
          + (state.busy.policy ? 'Saving...' : 'Save policy') + '</button>';
      }
    }

    if (c.devices) {
      html += '<p class="faint" style="margin:12px 0 4px">Linked endpoints</p>';
      if (c.devices.length === 0) {
        html += '<p class="faint">No Companion endpoints are linked to this app.</p>';
      } else {
        html += '<ul>';
        for (var i = 0; i < c.devices.length; i++) {
          var d = c.devices[i];
          var revoked = !!d.revokedAt;
          var seen = agoLabel(d.lastSeenAt);
          var busyD = state.busy.companion === d.id;
          html += '<li><div class="rowmain"><span class="rowname">' + esc(d.displayName || d.id) + '</span> '
            + '<span class="pill">' + esc(d.role || '') + '</span> '
            + '<span class="' + (revoked ? 'pill bad' : 'pill ok') + '">' + (revoked ? 'Revoked' : 'Active') + '</span>'
            + (seen ? '<div class="faint">Last seen ' + esc(seen) + '</div>' : '') + '</div>';
          if (revoked) {
            html += '<button type="button" class="btn" data-act="companion-approve" data-i="' + i + '"' + (busyD ? ' disabled' : '') + '>'
              + (busyD ? 'Working...' : 'Approve again') + '</button>';
          } else if (state.busy.confirmRevoke === d.id) {
            html += '<span><button type="button" class="btn danger-btn" data-act="companion-revoke" data-i="' + i + '"' + (busyD ? ' disabled' : '') + '>'
              + (busyD ? 'Revoking...' : 'Confirm revoke') + '</button> '
              + '<button type="button" class="btn" data-act="companion-revoke-cancel">Cancel</button></span>';
          } else {
            html += '<button type="button" class="btn" data-act="companion-revoke-ask" data-i="' + i + '">Revoke</button>';
          }
          html += '</li>';
        }
        html += '</ul>';
      }
      html += '<p class="faint" style="margin:6px 0 0">Routing groups and the session history live in FormLogic Desktop\\'s Companion admin.</p>';
    }
    el('companion', html);
  }

  // ── hardware events ────────────────────────────────────────────────────
  var EVENTS_SHOWN = 8;
  function paintEvents() {
    var html = '<div class="sectionrow"><h2>Recent hardware events</h2>';
    var rows = state.events;
    if (rows && rows.length > 0 && !state.demo) {
      if (state.busy.confirmClear) {
        html += '<span><button type="button" class="btn danger-btn" data-act="clear-events"' + (state.busy.clearing ? ' disabled' : '') + '>'
          + (state.busy.clearing ? 'Clearing...' : 'Confirm clear') + '</button> '
          + '<button type="button" class="btn" data-act="clear-events-cancel">Cancel</button></span>';
      } else {
        html += '<button type="button" class="btn" data-act="clear-events-ask" title="Delete every recorded hardware event.">Clear</button>';
      }
    }
    html += '</div>';
    if (rows === null) { el('events', html + '<p class="faint">Loading...</p>'); return; }
    if (rows.length === 0) {
      el('events', html + '<p class="faint">No hardware events recorded. Errors from the dongle/plugin land here automatically.</p>');
      return;
    }
    html += '<ul>';
    var shown = rows.slice(0, EVENTS_SHOWN);
    for (var i = 0; i < shown.length; i++) {
      var a = rec(shown[i].answers);
      var when = whenLabel(typeof a.occurred_at === 'string' && a.occurred_at !== '' ? a.occurred_at : shown[i].submittedAt);
      var sev = String(a.severity || 'info');
      var sevClass = sev === 'error' ? 'pill bad' : sev === 'warning' ? 'pill warn' : 'pill';
      html += '<li><div class="rowmain"><span class="rowname">' + esc(String(a.event_name || 'event')) + '</span> '
        + '<span class="muted">' + esc(String(a.message || '')) + '</span></div>'
        + '<span style="display:inline-flex;align-items:center;gap:8px">'
        + (when ? '<span class="faint" title="' + esc(when.full) + '">' + esc(when.short) + '</span>' : '')
        + '<span class="' + sevClass + '">' + esc(sev) + '</span></span></li>';
    }
    html += '</ul>';
    if (rows.length > EVENTS_SHOWN) html += '<p class="faint" style="margin:6px 0 0">Showing the ' + EVENTS_SHOWN + ' most recent of ' + rows.length + '.</p>';
    el('events', html);
  }

  // ── start fresh ────────────────────────────────────────────────────────
  function paintFresh() {
    var html = '<h2>Start fresh</h2>'
      + '<p class="muted">Deletes <strong>every record</strong> in this app - calls, transcripts, appointments, customers, follow-up tasks, messages and hardware events - so testing starts from a clean slate. Your Receptionist Settings, forms and flows are <strong>not</strong> touched.</p>';
    if (state.demo) {
      html += '<p class="faint" style="margin:8px 0 0">Not available in the shared demo.</p>';
    } else {
      html += '<div class="freshrow">'
        + '<input type="text" id="fresh-confirm" placeholder=\\'Type "delete all" to enable\\' autocomplete="off" spellcheck="false">'
        + '<button type="button" class="btn danger-btn" id="fresh-go" disabled>Delete all records</button>'
        + '<span class="faint" id="fresh-note"></span></div>';
    }
    el('fresh', html);
    var input = $('fresh-confirm');
    var go = $('fresh-go');
    if (input && go) {
      input.addEventListener('input', function () {
        go.disabled = input.value.trim().toLowerCase() !== 'delete all' || !!state.busy.fresh;
      });
      go.addEventListener('click', function () { void startFresh(); });
    }
  }

  function startFresh() {
    if (state.busy.fresh) return Promise.resolve();
    state.busy.fresh = true;
    var go = $('fresh-go'); if (go) { go.disabled = true; go.textContent = 'Waiting for confirmation...'; }
    // The HOST owns the reset: its own confirm dialog, its own bulk clear —
    // this screen only asks. denied = the operator cancelled the dialog.
    return FL.host.ceremony('start-fresh').then(function (out) {
      var note = $('fresh-note');
      if (out.status === 'done') {
        if (note) note.textContent = (out.deleted || 0) + ' records removed.';
        return refreshEvents();
      }
      if (note) note.textContent = out.status === 'denied' ? '' : (out.message || 'The reset did not run.');
    }).catch(function (e) {
      banner(e && e.message ? e.message : 'The reset failed.');
    }).then(function () {
      state.busy.fresh = false;
      var go2 = $('fresh-go'); var input = $('fresh-confirm');
      if (go2) { go2.textContent = 'Delete all records'; go2.disabled = !input || input.value.trim().toLowerCase() !== 'delete all'; }
    });
  }

  // ── loaders ────────────────────────────────────────────────────────────
  function loadRuntime() {
    return FL.presence().then(function (p) {
      state.presence = p;
      if (state.demo) { state.desktops = null; return; }
      // Owner-only registry - a member's refusal just hides the list.
      return svc('desktop.connections.list').then(function (r) {
        state.desktops = Array.isArray(r.connections) ? r.connections : [];
      }).catch(function () { state.desktops = null; });
    }).then(paintRuntime);
  }

  function loadDongles() {
    return FL.can('connector.aokie.dongle.list').then(function (allowed) {
      if (!allowed) return paintDongles();
      return cmd('dongle.list').then(function (res) {
        var pref = {};
        return FL.can('connector.aokie.dongle.getPreferred').then(function (canPref) {
          return (canPref ? cmd('dongle.getPreferred').then(function (p) { pref = rec(p.preferred); }).catch(function () {}) : Promise.resolve());
        }).then(function () {
          var live = Array.isArray(res.connected) ? res.connected : [];
          state.enumNote = res.liveEnumeration === false && typeof res.note === 'string' ? res.note : null;
          var rows = [];
          for (var i = 0; i < live.length; i++) {
            var d = rec(live[i]);
            if (typeof d.vid !== 'number' || typeof d.pid !== 'number') continue;
            var usbId = (typeof d.vidHex === 'string' ? d.vidHex : d.vid) + ':' + (typeof d.pidHex === 'string' ? d.pidHex : d.pid);
            rows.push({
              id: typeof d.hardwareId === 'string' && d.hardwareId !== '' ? d.hardwareId : usbId,
              name: typeof d.description === 'string' && d.description !== '' ? d.description : 'USB device ' + usbId,
              vid: d.vid, pid: d.pid, usbId: usbId,
              driverInstalled: d.driverBound === true,
              matchesCatalog: d.matchesCatalog === true,
              preferred: pref.vid === d.vid && pref.pid === d.pid
            });
          }
          state.dongles = rows;
          return paintDongles();
        });
      }).catch(function (e) { banner(e.message); state.dongles = []; return paintDongles(); });
    });
  }

  function loadPhones() {
    return FL.can('connector.aokie.phone.listPaired').then(function (allowed) {
      if (!allowed) { el('phones', '<h2>Paired phone</h2><p class="faint">This app has not been granted phone status access.</p>'); return; }
      return cmd('phone.listPaired').then(function (res) {
        var rows = Array.isArray(res.devices) ? res.devices : [];
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var d = rec(rows[i]);
          if (typeof d.address !== 'string' || d.address === '') continue;
          out.push({ address: d.address, name: typeof d.name === 'string' && d.name !== '' ? d.name : null, connected: d.connected === true });
        }
        state.phones = out;
        paintPhones();
      }).catch(function (e) { banner(e.message); state.phones = []; paintPhones(); });
    });
  }

  function loadCompanion() {
    if (state.demo) { paintCompanion(); return Promise.resolve(); }
    // policy.get is the section's admission ticket (member + connector grant);
    // devices need audit rights - each degrades independently.
    return svc('aokie.companion.policy.get').then(function (policy) {
      var c = { policy: policy, devices: null, canEdit: false, hidden: false };
      return svc('aokie.companion.devices.list').then(function (r) {
        c.devices = Array.isArray(r.devices) ? r.devices : [];
      }).catch(function () { c.devices = null; }).then(function () {
        // Edit rights are probed by attempting a save only when the user acts;
        // show the controls to everyone the DEVICES list admits (audit ⊂ manage
        // is not true, so a save may still refuse - surfaced honestly then).
        c.canEdit = c.devices !== null;
        state.companion = c;
        paintCompanion();
      });
    }).catch(function () {
      state.companion = { hidden: true };
      paintCompanion();
    });
  }

  function refreshEvents() {
    return FL.records({ limit: 100 }).then(function (rows) {
      state.events = rows || [];
      paintEvents();
    }).catch(function (e) { state.events = []; paintEvents(); banner(e && e.message ? e.message : 'Failed to load events'); });
  }

  function loadAll() {
    banner('');
    // Paint every card in its null/Loading state up front so nothing sits blank
    // while a command is in flight — a relayed dongle/phone read against a
    // remote desktop can take several seconds.
    state.dongles = null; state.phones = null; state.companion = null; state.events = null;
    paintPhones(); paintCompanion(); paintEvents(); void paintDongles();
    return FL.currentUser().then(function (u) {
      state.demo = !!(u && typeof u.email === 'string' && u.email === 'demo@formlogic.local');
    }).catch(function () {}).then(function () {
      paintFresh();
      return Promise.all([loadRuntime(), loadDongles(), loadPhones(), loadCompanion(), refreshEvents()]);
    });
  }

  // ── actions ────────────────────────────────────────────────────────────
  function pollPhone(address, wantConnected, tries, delayMs) {
    var attempt = function (left) {
      if (left <= 0) return Promise.resolve(false);
      return sleep(delayMs).then(function () {
        return cmd('phone.listPaired').then(function (res) {
          var rows = Array.isArray(res.devices) ? res.devices : [];
          for (var i = 0; i < rows.length; i++) {
            var d = rec(rows[i]);
            if (d.address === address && (d.connected === true) === wantConnected) return true;
          }
          return attempt(left - 1);
        }).catch(function () { return attempt(left - 1); });
      });
    };
    return attempt(tries);
  }

  function phoneAction(row, connect) {
    state.busy.phone = row.address; paintPhones(); banner('');
    return cmd(connect ? 'phone.connect' : 'phone.disconnect', { address: row.address }).then(function () {
      // Accepted-only command - watch the bonded list for the real outcome.
      return pollPhone(row.address, connect, connect ? 6 : 4, connect ? 2000 : 1500);
    }).then(function (ok) {
      if (!ok) {
        banner(connect
          ? 'Still trying to reconnect - if it does not connect, make sure the phone is nearby with Bluetooth on, or tap "Aokie AI Assistant" in its Bluetooth settings.'
          : 'Disconnect sent - the link is taking a moment to drop. Press Refresh if the list looks stale.');
      }
    }).catch(function (e) { banner(e.message); }).then(function () {
      state.busy.phone = null;
      return loadPhones();
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.body && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentElement;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-act');
    var i = parseInt(t.getAttribute('data-i') || '-1', 10);
    if (act === 'connect-desktop') {
      t.disabled = true; t.textContent = 'Waiting for approval on the desktop...';
      FL.host.ceremony('connect-desktop').then(function (out) {
        if (out.status !== 'done' && out.message) banner(out.message);
        return loadAll();
      }).catch(function (err) { banner(err.message); paintRuntime(); });
    } else if (act === 'install-driver' && state.dongles && state.dongles[i]) {
      var dd = state.dongles[i];
      state.busy.driver = dd.id; paintDongles();
      cmd('dongle.installDriver', { vid: dd.vid, pid: dd.pid }).then(function () {
        banner(''); return loadDongles();
      }).catch(function (err) { banner(err.message); }).then(function () { state.busy.driver = null; return paintDongles(); });
    } else if (act === 'set-preferred' && state.dongles && state.dongles[i]) {
      var dp = state.dongles[i];
      cmd('dongle.setPreferred', { vid: dp.vid, pid: dp.pid }).then(function () { return loadDongles(); })
        .catch(function (err) { banner(err.message); });
    } else if (act === 'phone-connect' && state.phones && state.phones[i]) {
      void phoneAction(state.phones[i], true);
    } else if (act === 'phone-disconnect' && state.phones && state.phones[i]) {
      void phoneAction(state.phones[i], false);
    } else if (act === 'companion-revoke-ask' && state.companion && state.companion.devices && state.companion.devices[i]) {
      state.busy.confirmRevoke = state.companion.devices[i].id; paintCompanion();
    } else if (act === 'companion-revoke-cancel') {
      state.busy.confirmRevoke = null; paintCompanion();
    } else if (act === 'companion-revoke' && state.companion && state.companion.devices && state.companion.devices[i]) {
      var dev = state.companion.devices[i];
      state.busy.companion = dev.id; paintCompanion();
      svc('aokie.companion.devices.revoke', { deviceId: dev.id }).then(function () {
        state.busy.confirmRevoke = null; return loadCompanion();
      }).catch(function (err) { banner(err.message); }).then(function () { state.busy.companion = null; paintCompanion(); });
    } else if (act === 'companion-approve' && state.companion && state.companion.devices && state.companion.devices[i]) {
      var dev2 = state.companion.devices[i];
      state.busy.companion = dev2.id; paintCompanion();
      svc('aokie.companion.devices.approve', { deviceId: dev2.id }).then(function () {
        return loadCompanion();
      }).catch(function (err) { banner(err.message); }).then(function () { state.busy.companion = null; paintCompanion(); });
    } else if (act === 'save-policy') {
      var boxes = document.querySelectorAll('[data-policy]');
      var draft = {};
      for (var b = 0; b < boxes.length; b++) draft[boxes[b].getAttribute('data-policy')] = !!boxes[b].checked;
      state.busy.policy = true; paintCompanion();
      // paintCompanion re-rendered the checkboxes - restore the draft state.
      var boxes2 = document.querySelectorAll('[data-policy]');
      for (var b2 = 0; b2 < boxes2.length; b2++) boxes2[b2].checked = !!draft[boxes2[b2].getAttribute('data-policy')];
      svc('aokie.companion.policy.update', { remoteConsent: draft }).then(function () {
        banner(''); return loadCompanion();
      }).catch(function (err) { banner(err.message); }).then(function () { state.busy.policy = false; paintCompanion(); });
    } else if (act === 'clear-events-ask') {
      state.busy.confirmClear = true; paintEvents();
    } else if (act === 'clear-events-cancel') {
      state.busy.confirmClear = false; paintEvents();
    } else if (act === 'clear-events') {
      state.busy.clearing = true; paintEvents();
      // Bounded passes of 25 explicit ids (the bridge's batch cap); a huge log
      // may need another press - honest, never a firehose.
      var clearPass = function (passes) {
        if (passes <= 0) return Promise.resolve();
        return FL.records({ limit: 25 }).then(function (rows) {
          if (!rows || rows.length === 0) return;
          var ids = [];
          for (var r = 0; r < rows.length; r++) ids.push(rows[r].id);
          return FL.deleteRecords(ids).then(function (out) {
            if (out.failed && out.failed.length > 0) throw new Error(out.failed[0].error || 'Some events could not be deleted');
            return clearPass(passes - 1);
          });
        });
      };
      clearPass(8).catch(function (err) { banner(err.message); }).then(function () {
        state.busy.clearing = false; state.busy.confirmClear = false;
        return refreshEvents();
      });
    }
  });

  // Attach the static handlers + first load (the kit convention's wire step).
  function wire() {
    $('refresh').addEventListener('click', function () { void loadAll(); });
    void loadAll();
  }
  wire();
})();
`;

/**
 * The customScreen payload for the Hardware Events form section (kind 'code').
 * allowNewResponses stays false — rows are written automatically from
 * aokie.hardware.error events.
 */
export const AOKIE_DEVICE_SETUP_SCREEN = {
  enabled: true,
  allowNewResponses: false,
  kind: 'code' as const,
  title: 'Device Setup',
  html: HTML,
  css: CSS,
  js: JS,
};
