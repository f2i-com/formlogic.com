// Pack-owned Live Call section screen (plan §8.4 port #6 — self-contained apps).
//
// The SANDBOXED-CODE twin of the compiled registry screen `aokie-live-call`
// (components/custom-screen/aokie/AokieLiveCallScreen.tsx): the operator's
// front-desk console — the current call card, a live transcript, live captions,
// answer / reject / hang up / operator-speak controls, and the recent-calls
// list — shipped INSIDE the pack as plain HTML/CSS/JS. The compiled screen + its
// registry entry stay untouched for rollback (flip the Calls form's SECTION
// customScreen back to the sdk reference; the recordScreen transcript is a
// separate blob and is unaffected).
//
// Runtime contract (CustomScreenRuntime in the APP runtime): opaque-origin
// iframe; window.FormLogic is the only capability. This screen exercises the
// FULL bridge and the subscription lanes:
//  - connector('aokie', cmd) — call.current + answer/reject/hangup/operatorSpeak
//    (routing is transparent: local desktop bridge, or the owner's relay when
//    the receptionist runs on another machine; command failures RESOLVE);
//  - events.subscribe({connectorId:'aokie'}) — live call lifecycle + final
//    transcript turns from the desktop event hub (LOCAL bridge; best-effort —
//    demo/remote just poll instead);
//  - captions.subscribe(handler) — the volatile caller-partial + session phase
//    (LOCAL only; tombstoned when a durable caller turn lands, final wins);
//  - records({limit}) — the recent-calls list (the attached Calls form);
//  - queryRecords('transcript-turns' | 'customers') — the stored transcript in
//    remote/demo mode + the known-caller name lookup (server enforces the
//    member's per-form view permission);
//  - presence() — local / remote / none, which only changes strings + which
//    live lanes attach;
//  - can('connector.aokie.<cmd>') — greys out controls the app can't run;
//  - host.ceremony('simulate-call') — the scripted demo call, for exploring the
//    whole flow with zero hardware.
//
// Every bridge action is TRUSTED_ONLY: the Calls form's custom_screen_trust must
// be owner/verified. KEEP THE EMBEDDED JS regex-free (char checks, not
// .replace(/../)/.match) and free of emoji/arrows — the check-pack-screens gate
// enforces both, and the template-literal escaping trap is a documented foot-gun.

const HTML = `
<div id="lc" aria-label="Live call console">
  <div class="console">
    <div class="chead">
      <div class="ident">
        <span class="logo" aria-hidden="true">A</span>
        <div><h1>Aokie Receptionist</h1><p class="sub">Front desk console</p></div>
      </div>
      <span id="presence" class="pill"></span>
    </div>
    <div class="cbody">
      <div id="standby" class="faint"></div>
      <div id="setup"></div>
      <div id="stage"></div>
      <div id="captions"></div>
      <div id="transcript" class="card"></div>
      <div id="recent" class="card"></div>
    </div>
  </div>
</div>`;

const CSS = `
html, body { background: transparent; }
body { color: var(--fl-text); }
#lc { max-width: 820px; margin: 0 auto; padding: 8px; }
#lc .console { border: 1px solid var(--fl-border); border-radius: 18px; overflow: hidden; background: var(--fl-surface); }

#lc .chead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;
  padding: 13px 16px; border-bottom: 1px solid var(--fl-border); background: var(--fl-surface-2); }
#lc .ident { display: flex; align-items: center; gap: 11px; min-width: 0; }
#lc .logo { width: 38px; height: 38px; border-radius: 11px; flex: none; display: flex; align-items: center; justify-content: center;
  font-weight: 700; color: var(--fl-accent-contrast); background: var(--fl-accent); }
#lc h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
#lc .sub { margin: 0; font-size: 11px; color: var(--fl-faint); }

#lc .cbody { padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
#lc .card { border: 1px solid var(--fl-border); border-radius: 14px; padding: 14px 16px; background: var(--fl-surface); }
#lc #standby:empty, #lc #setup:empty, #lc #stage:empty, #lc #captions:empty { display: none; }
#lc .faint { font-size: 11px; color: var(--fl-faint); }
#lc .muted { color: var(--fl-muted); }
#lc .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

#lc .pill { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 5px 11px; font-size: 11px; font-weight: 600;
  border: 1px solid var(--fl-border); color: var(--fl-muted); background: var(--fl-surface); }
#lc .pill.ok { color: var(--fl-good); border-color: var(--fl-good); }
#lc .pill.warn { color: var(--fl-warn); border-color: var(--fl-warn); }
#lc .pill.accent { color: var(--fl-accent); border-color: var(--fl-accent); }
#lc .dot { width: 7px; height: 7px; border-radius: 999px; background: currentColor; }
#lc .dot.live { animation: fl-pulse 1.4s ease-in-out infinite; }
@keyframes fl-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

#lc .stage { border: 1px solid var(--fl-accent); border-radius: 16px; padding: 16px; background: var(--fl-surface); }
#lc .stage.ringing { animation: fl-ring 1.6s ease-in-out infinite; }
@keyframes fl-ring { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 0 4px var(--fl-track); } }
#lc .caller { display: flex; align-items: center; gap: 12px; }
#lc .avatar { width: 46px; height: 46px; flex: none; border-radius: 999px; display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 15px; color: var(--fl-accent-contrast); background: var(--fl-accent); }
#lc .eyebrow { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--fl-accent); }
#lc .eyebrow.live { color: var(--fl-good); }
#lc .cname { margin: 2px 0 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
#lc .cphone { margin: 2px 0 0; font-size: 12px; color: var(--fl-muted); }
#lc .known { display: inline-block; margin-left: 6px; border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 600;
  color: var(--fl-accent); border: 1px solid var(--fl-accent); }

#lc .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
#lc .btn { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 500;
  border-radius: 11px; padding: 8px 16px; border: 1px solid var(--fl-border); color: var(--fl-text); background: var(--fl-surface); }
#lc .btn:hover { background: var(--fl-surface-2); }
#lc .btn[disabled] { opacity: .45; cursor: not-allowed; }
#lc .btn.answer { background: var(--fl-accent); border-color: var(--fl-accent); color: var(--fl-accent-contrast); }
#lc .btn.reject { color: var(--fl-warn); border-color: var(--fl-warn); }
#lc .btn.hangup { color: var(--fl-bad); border-color: var(--fl-bad); }
#lc .stagefoot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--fl-border); font-size: 11px; color: var(--fl-faint); }

#lc .capcard { border: 1px solid var(--fl-border); border-radius: 14px; padding: 10px 16px; background: var(--fl-surface); }
#lc .caphd { display: flex; align-items: center; gap: 7px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--fl-faint); }
#lc .cappartial { margin: 5px 0 0; font-size: 14px; font-style: italic; color: var(--fl-muted); }
#lc .capbot { margin: 5px 0 0; font-size: 14px; color: var(--fl-good); }
#lc .capbot .tag { margin-right: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; opacity: .75; }

#lc .thead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
#lc .thead h2 { margin: 0; font-size: 13px; font-weight: 600; }
#lc .turns { display: flex; flex-direction: column; gap: 10px; max-height: 360px; overflow-y: auto; }
#lc .turn { display: flex; align-items: flex-start; gap: 8px; max-width: 86%; }
#lc .turn.caller { flex-direction: row-reverse; align-self: flex-end; }
#lc .tav { width: 26px; height: 26px; flex: none; margin-top: 2px; border-radius: 999px; display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; background: var(--fl-track); color: var(--fl-muted); }
#lc .turn.agent .tav { background: var(--fl-accent); color: var(--fl-accent-contrast); }
#lc .turn.caller .tav { background: var(--fl-surface-2); color: var(--fl-muted); }
#lc .tbody { min-width: 0; }
#lc .twho { display: flex; align-items: baseline; gap: 8px; font-size: 11px; font-weight: 600; }
#lc .turn.caller .twho { flex-direction: row-reverse; }
#lc .ttime { font-size: 10px; font-weight: 400; color: var(--fl-faint); }
#lc .ttext { margin: 4px 0 0; padding: 7px 11px; font-size: 13.5px; line-height: 1.5; color: var(--fl-text);
  border: 1px solid var(--fl-border); white-space: pre-wrap; overflow-wrap: break-word; }
#lc .turn.agent .ttext { border-radius: 4px 12px 12px 12px; background: var(--fl-surface-2); }
#lc .turn.caller .ttext { border-radius: 12px 4px 12px 12px; background: var(--fl-surface); }
#lc .turn.pending .ttext { font-style: italic; opacity: .75; }

#lc .composer { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--fl-border); }
#lc .composer input { flex: 1; min-width: 0; font: inherit; font-size: 13px; color: var(--fl-text);
  background: var(--fl-surface); border: 1px solid var(--fl-border); border-radius: 999px; padding: 8px 15px; }
#lc .composer input:disabled { opacity: .5; }
#lc .send { width: 36px; height: 36px; flex: none; border-radius: 999px; cursor: pointer; border: 0;
  color: var(--fl-accent-contrast); background: var(--fl-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; }
#lc .send[disabled] { opacity: .45; cursor: not-allowed; }

#lc ul.calls { list-style: none; margin: 0; padding: 0; }
#lc ul.calls li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 6px; margin: 0 -6px; border-top: 1px solid var(--fl-border); border-radius: 8px; cursor: pointer; }
#lc ul.calls li:first-child { border-top: 0; }
#lc ul.calls li:hover { background: var(--fl-surface-2); }
#lc ul.calls li:focus-visible { outline: 2px solid var(--fl-accent); outline-offset: -2px; }
#lc .cstat { border-radius: 999px; padding: 2px 9px; font-size: 10px; font-weight: 600; text-transform: capitalize; color: var(--fl-muted); background: var(--fl-surface-2); }
#lc .cstat.ok { color: var(--fl-good); }
#lc .cstat.bad { color: var(--fl-bad); }
#lc .link { color: var(--fl-accent); font-size: 12px; font-weight: 500; cursor: pointer; }
`;

const JS = `
(function () {
  var FL = window.FormLogic;
  var esc = FL.escapeHtml;
  var $ = function (id) { return document.getElementById(id); };
  function rec(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  // ── digit + time helpers (regex-free — the escaping foot-gun) ──────────────
  function digits(s) {
    var out = '';
    var str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) { var c = str.charAt(i); if (c >= '0' && c <= '9') out += c; }
    return out;
  }
  function tail9(s) { var d = digits(s); return d.length > 9 ? d.slice(-9) : d; }
  function utcify(s) {
    if (typeof s !== 'string') return s;
    if (s.length === 19 && s.charAt(4) === '-' && s.charAt(10) === ' ' && s.charAt(13) === ':') {
      return s.slice(0, 10) + 'T' + s.slice(11) + 'Z';
    }
    return s;
  }
  function ms(s) { var t = Date.parse(utcify(s || '')); return isNaN(t) ? null : t; }
  function clock(s) { var t = ms(s); if (t === null) return null; return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function hhmm(s) { var t = ms(s); if (t === null) return null; return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dur(msSpan) {
    var s = Math.max(0, Math.floor(msSpan / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
  }

  var state = {
    presence: { kind: 'none' },
    call: null,           // { callId, from, callerName, state, startedAt }
    turns: [],            // live/derived turns [{ key, speaker, text, occurredAt, callId, turn, corrected }]
    captions: null,       // { callId, partialText, botText, phase }
    customers: [],        // queryRecords cache for name lookup
    recent: [],           // Calls records
    grants: {},           // can() cache
    speakText: '',
    pendingSpeak: null,
    busy: null,
    simulating: false,
    startedAtMs: null,
    liveEvents: false     // events.subscribe attached (local); else poll-derived
  };
  var caps = { unsubEvents: null, capHandle: null };

  function isDemo() { return state.presence.kind === 'none' && state._demo === true; }
  function remoteMode() { return state.presence.kind === 'remote'; }
  function activeCall() { return state.call && state.call.state !== 'ended' ? state.call : null; }
  function can(perm) { return state.grants[perm] === true; }

  function nameForPhone(phone) {
    var t = tail9(phone);
    if (t.length < 5) return null;
    for (var i = 0; i < state.customers.length; i++) {
      var a = rec(state.customers[i].answers);
      if (tail9(a.phone) === t) { var n = String(a.name == null ? '' : a.name).trim(); return n || null; }
    }
    return null;
  }

  // ── presence pill ─────────────────────────────────────────────────────────
  function paintPresence() {
    var p = state.presence, html, cls;
    if (p.kind === 'local') { cls = 'pill ok'; html = 'Listening - direct bridge'; }
    else if (p.kind === 'remote') { cls = 'pill accent'; html = 'Listening on ' + esc(p.deviceName || 'another machine') + ' - relay'; }
    else if (isDemo()) { cls = 'pill'; html = 'Demo bridge - simulated'; }
    else { cls = 'pill warn'; html = 'No desktop connected'; }
    var el = $('presence');
    el.className = cls;
    el.innerHTML = '<span class="dot' + (p.kind !== 'none' ? ' live' : '') + '"></span>' + html;
  }

  // ── standby + setup ─────────────────────────────────────────────────────────
  function paintStandby() {
    if (activeCall()) { $('standby').textContent = ''; $('setup').innerHTML = ''; return; }
    var last = state.recent[0];
    var when = last ? hhmm(rec(last.answers).started_at || last.submittedAt) : null;
    $('standby').textContent = remoteMode() ? 'Updates every 10s' : (when ? 'Last call ' + when : 'Waiting for the next call');
    // Offer the demo simulate when there is no real local bridge.
    if (state.presence.kind !== 'local') {
      $('setup').innerHTML = '<div class="card"><p class="muted" style="margin:0 0 10px;font-size:13px">'
        + (state.presence.kind === 'remote'
            ? 'The receptionist runs on ' + esc(state.presence.deviceName || 'another machine') + '. This console mirrors its calls and relays your controls.'
            : 'Install FormLogic Desktop (Device Setup) to take real calls. Until then, run a scripted demo call to explore the flow.')
        + '</p><button type="button" class="btn" data-act="simulate"' + (state.simulating ? ' disabled' : '') + '>'
        + (state.simulating ? 'Simulating...' : 'Simulate incoming call') + '</button></div>';
    } else {
      $('setup').innerHTML = '';
    }
  }

  // ── call stage ──────────────────────────────────────────────────────────────
  function paintStage() {
    var c = activeCall();
    if (!c) { $('stage').innerHTML = ''; state.startedAtMs = null; return; }
    var ringing = c.state === 'ringing';
    var known = c.callerName || nameForPhone(c.from);
    var display = c.callerName || known || c.from || 'Unknown caller';
    var initial = String(display).trim().charAt(0).toUpperCase() || '?';
    var elapsed = state.startedAtMs !== null ? dur(Date.now() - state.startedAtMs) : null;
    var eyebrow = ringing ? 'Incoming call' : ('Call in progress' + (elapsed ? ' - ' + elapsed : ''));

    var html = '<div class="stage' + (ringing ? ' ringing' : '') + '">'
      + '<div class="caller"><span class="avatar" aria-hidden="true">' + esc(initial) + '</span>'
      + '<div style="min-width:0;flex:1"><p class="eyebrow' + (ringing ? '' : ' live') + '">' + esc(eyebrow) + '</p>'
      + '<p class="cname">' + esc(display) + '</p>'
      + '<p class="cphone mono">' + (c.from ? esc(c.from) : 'No caller id')
      + (!c.callerName && known ? '<span class="known">Known customer</span>' : '') + '</p></div></div>';

    // Controls
    var canAnswer = ringing && can('connector.aokie.call.answer') && state.busy === null;
    var canReject = ringing && can('connector.aokie.call.reject');
    var canHangup = can('connector.aokie.call.hangup') && state.busy === null;
    html += '<div class="controls">';
    if (ringing) html += '<button type="button" class="btn answer" data-act="answer"' + (canAnswer ? '' : ' disabled') + '>'
      + (state.busy === 'call.answer' ? 'Answering...' : 'Answer') + '</button>';
    if (canReject) html += '<button type="button" class="btn reject" data-act="reject"' + (state.busy !== null ? ' disabled' : '') + '>'
      + (state.busy === 'call.reject' ? 'Rejecting...' : 'Reject') + '</button>';
    html += '<button type="button" class="btn hangup" data-act="hangup"' + (canHangup ? '' : ' disabled') + '>'
      + (state.busy === 'call.hangup' ? 'Hanging up...' : 'Hang up') + '</button>';
    html += '</div>';

    var foot = remoteMode()
      ? 'Commands run on ' + esc(state.presence.deviceName || 'the hosting desktop')
      : state.presence.kind === 'local' ? 'Direct bridge - FormLogic Desktop' : 'Simulated call - demo bridge';
    html += '<div class="stagefoot">' + foot + '</div></div>';
    $('stage').innerHTML = html;
  }

  // ── live captions (volatile lane) ────────────────────────────────────────────
  function paintCaptions() {
    var c = activeCall(), cap = state.captions;
    if (!c || !cap || cap.callId !== c.callId || (!cap.partialText && !cap.botText && !cap.phase)) { $('captions').innerHTML = ''; return; }
    var phase = cap.phase || 'listening';
    var html = '<div class="capcard"><div class="caphd"><span class="dot live"></span>Live - ' + esc(phase) + '</div>';
    if (cap.partialText) html += '<p class="cappartial">"' + esc(cap.partialText) + '..."</p>';
    if (cap.botText) html += '<p class="capbot"><span class="tag">Aokie</span>' + esc(cap.botText) + '</p>';
    html += '</div>';
    $('captions').innerHTML = html;
  }

  // ── transcript + composer ─────────────────────────────────────────────────────
  function turnMeta(speaker) {
    if (speaker === 'caller') return { side: 'caller', label: 'Caller', initial: 'C' };
    if (speaker === 'operator') return { side: 'agent', label: 'You', initial: 'Y' };
    return { side: 'agent', label: 'Aokie', initial: 'A' };
  }
  function paintTranscript() {
    var c = activeCall();
    var heading = c ? 'Conversation' : (remoteMode() ? 'Latest call' : 'Last call');
    var html = '<div class="thead"><h2>' + esc(heading) + '</h2></div>';
    var turns = state.turns;
    if (turns.length === 0 && state.pendingSpeak === null) {
      html += '<p class="muted" style="font-size:13px">' + (remoteMode()
        ? 'No transcript recorded for the latest call yet.'
        : 'Final transcript turns stream in here during a call.') + '</p>';
    } else {
      html += '<div class="turns" id="turns">';
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i], mt = turnMeta(t.speaker), time = clock(t.occurredAt);
        var tip = t.corrected ? ' title="Corrected by the audio model"' : '';
        html += '<div class="turn ' + mt.side + '"><span class="tav" aria-hidden="true">' + esc(mt.initial) + '</span>'
          + '<div class="tbody"><div class="twho">' + esc(mt.label)
          + (time ? '<span class="ttime mono">' + esc(time) + '</span>' : '') + '</div>'
          + '<p class="ttext"' + tip + '>' + esc(t.text) + '</p></div></div>';
      }
      if (state.pendingSpeak !== null) {
        html += '<div class="turn agent pending"><span class="tav" aria-hidden="true">Y</span>'
          + '<div class="tbody"><div class="twho">You<span class="ttime">sending...</span></div>'
          + '<p class="ttext">' + esc(state.pendingSpeak) + '</p></div></div>';
      }
      html += '</div>';
    }
    // Composer — only while a call is up.
    if (c) {
      var reason = c.state === 'ringing' ? 'Answer the call to speak'
        : !can('connector.aokie.call.operatorSpeak') ? 'Speaking is not granted to this app' : null;
      var disabled = reason !== null || state.busy !== null;
      html += '<div class="composer"><input id="speak" type="text" placeholder="' + esc(reason || 'Speak to the caller as the operator...') + '"'
        + (disabled ? ' disabled' : '') + ' value="' + esc(state.speakText) + '">'
        + '<button type="button" class="send" id="send" aria-label="Send to caller"' + (disabled ? ' disabled' : '') + '>&rsaquo;</button></div>';
    }
    $('transcript').innerHTML = html;
    var box = $('turns'); if (box) box.scrollTop = box.scrollHeight;
    var input = $('speak');
    if (input) {
      input.addEventListener('input', function () { state.speakText = input.value; });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); void sendSpeak(); } });
    }
  }

  // ── recent calls ──────────────────────────────────────────────────────────────
  function paintRecent() {
    var html = '<div class="thead"><h2>Recent calls</h2><span class="link" data-act="viewall">View all</span></div>';
    var rows = state.recent;
    if (rows.length === 0) {
      html += '<p class="muted" style="font-size:13px">No calls logged yet - they are recorded automatically from call events.</p>';
    } else {
      html += '<ul class="calls">';
      for (var i = 0; i < rows.length; i++) {
        var a = rec(rows[i].answers), phone = String(a.caller_phone || ''), status = String(a.status || '');
        var sc = (status === 'missed' || status === 'failed' || status === 'rejected') ? 'cstat bad'
          : (status === 'completed' || status === 'answered') ? 'cstat ok' : 'cstat';
        html += '<li data-act="open" data-id="' + esc(rows[i].id) + '" role="button" tabindex="0"><div style="min-width:0">'
          + '<span style="font-weight:500">' + esc(String(a.caller_name || phone || 'Unknown caller')) + '</span>'
          + (phone ? ' <span class="mono faint">' + esc(phone) + '</span>' : '') + '</div>'
          + '<span class="' + sc + '">' + esc(status || 'unknown') + '</span></li>';
      }
      html += '</ul>';
    }
    $('recent').innerHTML = html;
  }

  function paintAll() { paintPresence(); paintStandby(); paintStage(); paintCaptions(); paintTranscript(); paintRecent(); }

  // ── data ─────────────────────────────────────────────────────────────────────
  function setCallFromCurrent(res) {
    var c = rec(res.call);
    if (typeof c.callId === 'string') {
      var st = c.state === 'active' ? 'active' : c.state === 'ended' ? 'ended' : 'ringing';
      var prev = state.call;
      state.call = {
        callId: c.callId,
        from: typeof c.from === 'string' ? c.from : (prev && prev.callId === c.callId ? prev.from : undefined),
        callerName: typeof c.callerName === 'string' ? c.callerName : undefined,
        state: st,
        startedAt: typeof c.startedAt === 'string' ? c.startedAt : (prev && prev.callId === c.callId ? prev.startedAt : undefined)
      };
      state.startedAtMs = ms(state.call.startedAt) || (prev && prev.callId === c.callId ? state.startedAtMs : Date.now());
    } else if (!state.call || state.call.state === 'ended') {
      state.call = null; state.startedAtMs = null;
    }
  }

  function refreshCall() {
    if (!can('connector.aokie.call.current')) return Promise.resolve();
    return FL.connector('aokie', 'call.current', {}).then(function (out) {
      if (out.status === 'done') setCallFromCurrent(rec(out.result));
    }).catch(function () {});
  }

  function refreshRecent() {
    return FL.records({ limit: 8 }).then(function (rows) { state.recent = rows || []; }).catch(function () {});
  }
  function refreshCustomers() {
    return FL.queryRecords('customers', { limit: 200 }).then(function (rows) { state.customers = rows || []; }).catch(function () {});
  }

  // Remote/demo transcript: stored Transcript Turns for the current call.
  function refreshStoredTurns() {
    var c = state.call;
    if (!c || state.liveEvents) return Promise.resolve();
    return FL.queryRecords('transcript-turns', { limit: 60 }).then(function (rows) {
      var out = [];
      for (var i = 0; i < (rows || []).length; i++) {
        var a = rec(rows[i].answers);
        if (String(a.call_id || '') !== c.callId) continue;
        var idx = a.turn_index;
        out.push({
          key: rows[i].id,
          speaker: typeof a.speaker === 'string' && a.speaker ? a.speaker : 'system',
          text: String(a.text == null ? '' : a.text),
          occurredAt: typeof a.timestamp === 'string' && a.timestamp ? a.timestamp : rows[i].submittedAt,
          callId: c.callId,
          turn: typeof idx === 'number' ? idx : (typeof idx === 'string' && idx !== '' && !isNaN(Number(idx)) ? Number(idx) : null),
          corrected: a.source === 'audio_model'
        });
      }
      out.sort(function (x, y) {
        if (x.occurredAt && y.occurredAt && x.occurredAt !== y.occurredAt) return x.occurredAt < y.occurredAt ? -1 : 1;
        if (x.turn != null && y.turn != null && x.turn !== y.turn) return x.turn - y.turn;
        return 0;
      });
      state.turns = out;
    }).catch(function () {});
  }

  // ── live event lane (LOCAL) ────────────────────────────────────────────────────
  function onEvent(frame) {
    if (frame.kind === 'dropped') { void refreshCall(); void refreshRecent(); return; }
    var env = rec(frame.data), data = rec(env.data);
    var callId = typeof data.callId === 'string' ? data.callId : env.correlationId;
    switch (env.name) {
      case 'aokie.call.incoming':
        state.turns = [];
        state.call = { callId: callId, from: typeof data.from === 'string' ? data.from : (typeof data.callerPhone === 'string' ? data.callerPhone : undefined),
          callerName: typeof data.callerName === 'string' ? data.callerName : undefined, state: 'ringing', startedAt: new Date().toISOString() };
        state.startedAtMs = Date.now();
        break;
      case 'aokie.call.answered':
        if (state.call) state.call.state = 'active'; break;
      case 'aokie.call.caller_id':
        if (state.call && state.call.callId === callId && !state.call.from && typeof data.from === 'string') state.call.from = data.from; break;
      case 'aokie.call.turn.final':
        state.turns = state.turns.slice(-49).concat([{
          key: env.idempotencyKey || (callId + ':' + data.turn),
          speaker: typeof data.speaker === 'string' ? data.speaker : 'caller',
          text: typeof data.text === 'string' ? data.text : '',
          occurredAt: env.occurredAt, callId: callId,
          turn: typeof data.turn === 'number' ? data.turn : Number(data.turn) || null
        }]);
        break;
      case 'aokie.call.turn.corrected': {
        var tn = typeof data.turn === 'number' ? data.turn : Number(data.turn);
        var fixed = typeof data.text === 'string' ? data.text : '';
        if (fixed && isFinite(tn)) {
          state.turns = state.turns.map(function (t) { return (t.callId === callId && t.turn === tn) ? { key: t.key, speaker: t.speaker, text: fixed, occurredAt: t.occurredAt, callId: t.callId, turn: t.turn, corrected: true } : t; });
        }
        break;
      }
      case 'aokie.call.rejected':
      case 'aokie.call.ended':
        if (state.call && state.call.callId === callId) state.call.state = 'ended';
        setTimeout(function () { void refreshRecent().then(paintAll); }, 1500);
        break;
      default: return;
    }
    paintAll();
  }

  function attachLiveLanes() {
    // Idempotent: only the LOCAL bridge carries live feeds, and never subscribe twice.
    if (state.presence.kind !== 'local' || caps.unsubEvents) return Promise.resolve();
    var evP = FL.events.subscribe({ connectorId: 'aokie' }, onEvent).then(function (h) {
      caps.unsubEvents = h.unsubscribe; state.liveEvents = true;
    }).catch(function () { state.liveEvents = false; });
    var capP = FL.captions.subscribe(function (frame) {
      if (frame.kind === 'dropped') return;
      state.captions = rec(frame.data); paintCaptions();
    }).then(function (h) { caps.capHandle = h; }).catch(function () {});
    // Tombstone the visible partial when a durable caller turn lands (final wins).
    return Promise.all([evP, capP]);
  }
  function detachLiveLanes() {
    if (caps.unsubEvents) { try { caps.unsubEvents(); } catch (e) {} caps.unsubEvents = null; }
    if (caps.capHandle && caps.capHandle.unsubscribe) { try { caps.capHandle.unsubscribe(); } catch (e) {} caps.capHandle = null; }
    state.liveEvents = false; state.captions = null;
  }
  var prevCallerTurns = 0;
  function maybeTombstone() {
    var n = 0;
    for (var i = 0; i < state.turns.length; i++) if (state.turns[i].speaker === 'caller') n++;
    if (n > prevCallerTurns && caps.capHandle && caps.capHandle.tombstone) caps.capHandle.tombstone();
    prevCallerTurns = n;
  }

  // ── actions ────────────────────────────────────────────────────────────────────
  function runCommand(command, payload) {
    state.busy = command; paintStage(); paintTranscript();
    return FL.connector('aokie', command, payload || {}).then(function (out) {
      if (out.status !== 'done') {
        var m = out.error && out.error.message ? out.error.message : out.status;
        if (out.status === 'uncertain') m = 'Sent, but the desktop has not confirmed it yet.';
        FL.toast.error(m);
        return false;
      }
      return true;
    }).catch(function (e) { FL.toast.error(e && e.message ? e.message : 'Command failed'); return false; })
      .then(function (ok) { state.busy = null; return ok; });
  }

  function sendSpeak() {
    var c = activeCall(); if (!c) return Promise.resolve();
    var text = String(state.speakText || '').trim(); if (!text) return Promise.resolve();
    state.speakText = ''; state.pendingSpeak = text; paintTranscript();
    return runCommand('call.operatorSpeak', { callId: c.callId, text: text }).then(function (ok) {
      state.pendingSpeak = null;
      if (!ok) state.speakText = text;
      paintTranscript();
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.body && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentElement;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-act');
    var c = activeCall();
    if (act === 'answer' && c) { runCommand('call.answer', { callId: c.callId }).then(function () { return refreshCall(); }).then(paintAll); }
    else if (act === 'reject' && c) { runCommand('call.reject', { callId: c.callId }).then(function () { return refreshCall(); }).then(paintAll); }
    else if (act === 'hangup' && c) { runCommand('call.hangup', { callId: c.callId }).then(function () { return refreshCall(); }).then(paintAll); }
    else if (act === 'send') { void sendSpeak(); }
    else if (act === 'simulate') {
      state.simulating = true; paintStandby();
      FL.host.ceremony('simulate-call').catch(function (err) { FL.toast.error(err && err.message ? err.message : 'Could not start the demo call'); })
        .then(function () { state.simulating = false; paintStandby(); });
    }
    else if (act === 'viewall') {
      // The attached form's own records table (NOT host.openScreen('calls'),
      // which would re-open this console). openRecords() is gated on the
      // viewer being able to see the records.
      FL.openRecords().catch(function (e) { FL.toast.error(e && e.message ? e.message : 'Records are not available.'); });
    }
    else if (act === 'open') {
      var id = t.getAttribute('data-id');
      if (id) FL.host.openRecord('calls', id).catch(function () {});
    }
  });

  // ── grants + boot ─────────────────────────────────────────────────────────────
  var GRANTS = ['call.current', 'call.answer', 'call.reject', 'call.hangup', 'call.operatorSpeak'];
  function loadGrants() {
    var checks = GRANTS.map(function (g) {
      return FL.can('connector.aokie.' + g).then(function (ok) { state.grants['connector.aokie.' + g] = ok === true; });
    });
    return Promise.all(checks);
  }

  function tick() {
    // Re-resolve presence every tick: detection is demand-driven and may only
    // finish AFTER this screen mounts (navigating in from another page), so a
    // late-connecting desktop self-heals here instead of needing a full reload.
    return FL.presence().then(function (p) {
      var prev = state.presence.kind;
      state.presence = p || { kind: 'none' };
      if (state.presence.kind === 'local' && prev !== 'local') return attachLiveLanes();
      if (prev === 'local' && state.presence.kind !== 'local') detachLiveLanes();
    }).catch(function () {})
      .then(refreshCall)
      .then(function () { return state.liveEvents ? Promise.resolve() : refreshStoredTurns(); })
      .then(function () { maybeTombstone(); paintAll(); });
  }

  function loadAll() {
    return FL.presence().then(function (p) { state.presence = p || { kind: 'none' }; }).catch(function () { state.presence = { kind: 'none' }; })
      .then(function () { return FL.currentUser(); }).then(function (u) { state._demo = !!(u && u.email === 'demo@formlogic.local'); }).catch(function () {})
      .then(loadGrants)
      .then(function () { return Promise.all([refreshCall(), refreshRecent(), refreshCustomers()]); })
      .then(attachLiveLanes)
      .then(function () { return state.liveEvents ? Promise.resolve() : refreshStoredTurns(); })
      .then(function () { maybeTombstone(); paintAll(); });
  }

  // Keyboard: Enter/Space on a focused recent-call row opens its record.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-act') === 'open') {
      e.preventDefault();
      var id = t.getAttribute('data-id');
      if (id) FL.host.openRecord('calls', id).catch(function () {});
    }
  });

  function wire() {
    void loadAll();
    // Call + recent poll every 3s; the elapsed timer repaints the stage every 1s.
    setInterval(function () { void tick(); }, 3000);
    setInterval(function () { void refreshRecent().then(paintRecent); }, 10000);
    setInterval(function () { if (activeCall()) paintStage(); }, 1000);
  }
  wire();
})();
`;

/**
 * The customScreen SECTION payload for the Calls form (kind 'code'). The Calls
 * form ALSO carries a recordScreen (the transcript widget); that is a separate
 * blob and is spread in alongside this at the pack site.
 */
export const AOKIE_LIVE_CALL_SCREEN = {
  enabled: true,
  allowNewResponses: false,
  kind: 'code' as const,
  title: 'Live Call',
  html: HTML,
  css: CSS,
  js: JS,
};
