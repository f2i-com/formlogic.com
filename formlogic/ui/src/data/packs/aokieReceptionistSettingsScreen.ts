// Pack-owned Receptionist Settings console (plan §8.4 port #3 — the LAST screen).
//
// The SANDBOXED-CODE twin of the compiled registry screen
// `aokie-receptionist-settings` (components/custom-screen/aokie/
// AokieReceptionistSettingsScreen.tsx): the grouped-card console over the
// singleton Receptionist Settings record PLUS the live plugin settings, shipped
// INSIDE the pack as plain HTML/CSS/JS. The compiled screen + its registry entry
// stay for rollback (flip the form's SECTION customScreen back to the sdk ref).
//
// Behavior-preserving port (investigation 2026-07-17, GO): the security boundary
// for the manager PIN lives ENTIRELY in the plugin — settings.get never returns
// it (only `managerPinSet`), settings.set seals it (DPAPI) and redacts it from
// the response, and the plugin validates it. The sandbox can only WRITE a new
// PIN (same as the compiled screen) and can NEVER read the stored one; it also
// ADDS a per-screen TRUSTED_ONLY gate + a `connect-src 'none'` CSP the compiled
// screen never had. AOK-304 (settings OWNERSHIP split) is a separate supervised
// refactor, not a prerequisite for this UI move.
//
// Runtime contract (CustomScreenRuntime, APP runtime): opaque-origin iframe;
// window.FormLogic only. Lanes used: connector('aokie', 'settings.get'/'.set')
// (routing local-or-relay is transparent), records()/submit()/updateRecord()
// (the singleton record — create-on-first-save, then PARTIAL patches which the
// controller PATCH-merges), aiSources() (host-resolved desktop AI-sources for
// the lane pickers), presence(), can(). "Save & apply now" composes the
// settings.set payload with the EMBEDDED composeAgentPayload — the SAME
// self-contained function buildAgentPayload wraps, so console, flow and this
// screen can never disagree (pinned by the embed parity test).
//
// Every bridge action is TRUSTED_ONLY: the form's custom_screen_trust must be
// owner/verified. KEEP THE EMBEDDED JS regex-free (char scans, not .replace(/../)
// /.match) and free of emoji/arrows — the check-pack-screens gate enforces both,
// and the template-literal escaping trap is a documented foot-gun.
import { composeAgentPayload, AI_GATEWAY_BASE } from '../../components/custom-screen/aokie/receptionistPayload';
import { DEFAULT_PERSONA } from './aokieReceptionistPersona';

// The self-contained composer, embedded verbatim (its .toString() has NO
// cross-scope free identifiers, so it survives production minification — the
// two constants arrive as arguments). Locked to the imported buildAgentPayload
// by the embed parity test in aokieReceptionistPack.test.ts.
const PAYLOAD_EMBED = `
  var AI_GATEWAY_BASE = ${JSON.stringify(AI_GATEWAY_BASE)};
  var DEFAULT_PERSONA = ${JSON.stringify(DEFAULT_PERSONA)};
  var composeAgentPayload = ${composeAgentPayload.toString()};
`;

const HTML = `<div id="rs" aria-label="Receptionist settings"><div id="cards"></div></div>`;

const CSS = `
html, body { background: transparent; }
body { color: var(--fl-text); }
#rs { max-width: 780px; margin: 0 auto; padding: 8px 8px 88px; display: flex; flex-direction: column; }
#rs #cards { display: flex; flex-direction: column; gap: 14px; }

#rs .card { border: 1px solid var(--fl-border); border-radius: 16px; padding: 14px 16px; background: var(--fl-surface); }
#rs .card.danger { border-color: var(--fl-bad); }
#rs h2 { margin: 0 0 3px; font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
#rs h3 { margin: 12px 0 4px; font-size: 12.5px; font-weight: 600; }
#rs .hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
#rs .hdr h2 { margin: 0; }

#rs label.f { display: block; margin: 10px 0 0; }
#rs label.f:first-child { margin-top: 0; }
#rs .lbl { display: block; margin-bottom: 4px; font-size: 11.5px; font-weight: 500; color: var(--fl-muted); }
#rs .hint { margin: 4px 0 0; font-size: 11px; line-height: 1.45; color: var(--fl-faint); }
#rs .muted { color: var(--fl-muted); font-size: 12.5px; }
#rs .faint { color: var(--fl-faint); font-size: 11px; }
#rs .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

#rs input[type="text"], #rs input[type="password"], #rs textarea, #rs select {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; color: var(--fl-text);
  background: var(--fl-surface); border: 1px solid var(--fl-border); border-radius: 10px; padding: 8px 11px;
}
#rs textarea { resize: vertical; min-height: 64px; line-height: 1.5; }
#rs select { cursor: pointer; }
#rs .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 520px) { #rs .row2 { grid-template-columns: 1fr; } }

#rs .chk { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 0; font-size: 12.5px; cursor: pointer; }
#rs .chk input { margin-top: 2px; width: 15px; height: 15px; flex: none; }
#rs .chk .sub { display: block; margin-top: 2px; font-size: 11px; color: var(--fl-faint); font-weight: 400; }
#rs .chk.off { opacity: .55; }

#rs .btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 500;
  border-radius: 10px; padding: 7px 13px; border: 1px solid var(--fl-border); color: var(--fl-text); background: var(--fl-surface); }
#rs .btn:hover { background: var(--fl-surface-2); }
#rs .btn[disabled] { opacity: .45; cursor: not-allowed; }
#rs .btn.dark { background: var(--fl-text); color: var(--fl-surface); border-color: var(--fl-text); }
#rs .btn.primary { background: var(--fl-accent); border-color: var(--fl-accent); color: var(--fl-accent-contrast); }
#rs .btn.sm { font-size: 11.5px; padding: 5px 10px; }
#rs .savebtnrow { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

#rs .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 10px; font-weight: 600; border: 1px solid var(--fl-border); color: var(--fl-muted); }
#rs .pill.ok { color: var(--fl-good); border-color: var(--fl-good); }
#rs .pill.accent { color: var(--fl-accent); border-color: var(--fl-accent); }

#rs .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#rs .chip { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; background: var(--fl-surface-2); padding: 3px 5px 3px 10px; font-size: 11px; }
#rs .chip button { cursor: pointer; border: 0; background: transparent; color: var(--fl-faint); font-size: 14px; line-height: 1; padding: 0 2px; }
#rs .chip button:hover { color: var(--fl-bad); }

#rs #banner:empty { display: none; }
#rs #err { border: 1px solid var(--fl-bad); border-radius: 12px; padding: 10px 14px; font-size: 13px; color: var(--fl-bad); overflow-wrap: break-word; }

#rs .running .greet { font-size: 13.5px; }
#rs .running .meta { margin-top: 3px; font-size: 11.5px; color: var(--fl-muted); }
#rs .running .persona { margin-top: 3px; font-size: 11px; color: var(--fl-faint); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

#rs .savebar { position: sticky; bottom: 8px; margin-top: 14px; z-index: 5; }
#rs .savebar .inner { border: 1px solid var(--fl-border); border-radius: 14px; padding: 10px 12px; background: var(--fl-surface); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; box-shadow: 0 8px 30px -18px rgba(0,0,0,.4); }
#rs .savebar .right { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
#rs .dirty { font-size: 11.5px; font-weight: 600; color: var(--fl-warn); }
#rs .clean { font-size: 11.5px; color: var(--fl-faint); }

#rs .adv summary { cursor: pointer; font-size: 13px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 6px; }
#rs .adv summary::-webkit-details-marker { display: none; }
/* Disclosure triangle driven by the native [open] state so it can never go
   stale (toggling <details> does not re-render the screen). */
#rs .adv summary::before { content: '>'; color: var(--fl-faint); font-family: ui-monospace, monospace; }
#rs .adv[open] summary::before { content: 'v'; }
`;

const JS = `
${PAYLOAD_EMBED}
(function () {
  var FL = window.FormLogic;
  var esc = FL.escapeHtml;
  var $ = function (id) { return document.getElementById(id); };
  function rec(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function boolish(v) { return v === true || v === 'true'; }
  function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel === v ? ' selected' : '') + '>' + esc(label) + '</option>'; }

  // ── regex-free helpers (the check-pack-screens gate forbids regex literals) ──
  // Split a block/manager list on newline, comma or semicolon.
  function splitList(s) {
    var out = [], cur = '', str2 = String(s == null ? '' : s);
    for (var i = 0; i < str2.length; i++) {
      var c = str2.charAt(i);
      if (c === '\\n' || c === '\\r' || c === ',' || c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  // Basename of a windows/unix path (last non-empty segment) — matches the
  // original split(/[\\\\/]/).filter(Boolean).pop(): trailing separators are
  // ignored ('foo/bar/' -> 'bar', not '').
  function baseName(p) {
    var s = String(p == null ? '' : p);
    while (s.length && (s.charAt(s.length - 1) === '/' || s.charAt(s.length - 1) === '\\\\')) s = s.slice(0, -1);
    var start = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charAt(i); if (c === '\\\\' || c === '/') start = i + 1; }
    return s.slice(start);
  }
  // Human label for a piper/vits bundle folder name (regex-free port of
  // prettifyBundleName): 'vits-piper-en_GB-jenny_dioco-medium' -> 'Jenny Dioco (en_GB, medium)'.
  var ENGINE_TOKENS = { vits:1, piper:1, kokoro:1, matcha:1, mms:1, coqui:1, icefall:1 };
  var QUALITY_TOKENS = { low:1, medium:1, high:1, x_low:1, x_high:1 };
  function isLocale(t) {
    // ^[a-z]{2,3}(_[A-Z]{2})? without a regex.
    var us = t.indexOf('_'), lang = us < 0 ? t : t.slice(0, us), reg = us < 0 ? '' : t.slice(us + 1);
    if (lang.length < 2 || lang.length > 3) return false;
    for (var i = 0; i < lang.length; i++) { var c = lang.charAt(i); if (c < 'a' || c > 'z') return false; }
    if (us >= 0) { if (reg.length !== 2) return false; for (var j = 0; j < 2; j++) { var d = reg.charAt(j); if (d < 'A' || d > 'Z') return false; } }
    return true;
  }
  function titleCase(words) {
    var joined = words.join(' '), parts = [], cur = '';
    for (var i = 0; i < joined.length; i++) { var c = joined.charAt(i); if (c === '_' || c === ' ') { if (cur) parts.push(cur); cur = ''; } else cur += c; }
    if (cur) parts.push(cur);
    return parts.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  function prettifyBundle(name) {
    var all = String(name || '').split('-'), parts = [];
    for (var i = 0; i < all.length; i++) if (all[i]) parts.push(all[i]);
    var k = 0;
    while (k < parts.length && ENGINE_TOKENS[parts[k].toLowerCase()]) k++;
    var restStart = k, rest = parts.slice(restStart);
    if (rest.length === 0) return name;
    var locale = isLocale(rest[0]) ? rest[0] : null;
    var last = rest[rest.length - 1];
    var quality = rest.length > 1 && QUALITY_TOKENS[last.toLowerCase()] ? last.toLowerCase() : null;
    var voiceTokens = rest.slice(locale ? 1 : 0, quality ? rest.length - 1 : rest.length);
    if (voiceTokens.length === 0) return name;
    var voice = titleCase(voiceTokens);
    var meta = [locale, quality].filter(Boolean).join(', ');
    return meta ? voice + ' (' + meta + ')' : voice;
  }

  // ── voice catalog parse (port of parseTtsVoiceCatalog) ──
  var FALLBACK_POCKET = ['', 'alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];
  var DEFAULT_ENGINES = [{ id: 'pocket', label: 'Pocket-TTS (default)' }, { id: 'sherpa', label: 'Sherpa - Piper/VITS voices (fast)' }];
  function parseCatalog(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var engines = raw.engines;
    if (!Array.isArray(engines)) return null;
    var out = [];
    for (var i = 0; i < engines.length; i++) {
      var e = engines[i];
      if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.id !== 'string' || !e.id) continue;
      var voices = Array.isArray(e.voices) ? e.voices.filter(function (v) { return typeof v === 'string' && v; }) : undefined;
      var bundles = Array.isArray(e.bundles) ? e.bundles.map(function (b) {
        if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.dir !== 'string' || !b.dir) return null;
        return { dir: b.dir, name: typeof b.name === 'string' && b.name ? b.name : b.dir, kind: typeof b.kind === 'string' && b.kind ? b.kind : 'vits' };
      }).filter(Boolean) : undefined;
      var eng = { id: e.id, label: typeof e.label === 'string' && e.label ? e.label : e.id };
      if (voices) eng.voices = voices;
      if (bundles) eng.bundles = bundles;
      if (typeof e.scanRoot === 'string' && e.scanRoot) eng.scanRoot = e.scanRoot;
      out.push(eng);
    }
    return out.length ? out : null;
  }
  function pocketVoices(cat) {
    var p = (cat || []).filter(function (e) { return e.id === 'pocket'; })[0];
    var vs = (p && p.voices) || [];
    if (vs.length === 0) return FALLBACK_POCKET;
    var uniq = [];
    for (var i = 0; i < vs.length; i++) if (uniq.indexOf(vs[i]) < 0) uniq.push(vs[i]);
    uniq.sort(function (a, b) { return a.localeCompare(b); });
    return [''].concat(uniq);
  }

  // ── state ──
  var EMPTY = { business_name:'', instructions:'', business_info:'', greeting:'', model:'', llm_endpoint:'', stt_endpoint:'', tts_endpoint:'', llm_source:'', stt_source:'', tts_source:'', correction_source:'', correction_endpoint:'', voice:'', reply_mode:'agent', active:'yes' };
  var state = {
    presence: { kind: 'none' }, demo: false,
    canGet: false, canSet: false, mayWrite: false,
    draft: null, saved: null, recordId: null,
    running: null, runningError: null, err: null,
    aiSources: null, catalog: null,
    engine: { loaded:false, engine:'', modelDir:'', customDir:false },
    audio: { loaded:false, sendAudio:false, audioTranscript:false },
    waiting: { loaded:false, holdAndCallWaiting:false, autoHoldQueue:false, autoConnectPhone:true },
    screening: { loaded:false, recordLoaded:false, blockedNumbers:'', acceptPattern:'', rejectPrivate:false, screenMessage:'', blockedMessage:'', autoBlockAbuse:true, managerNumbers:'', managerPin:'', managerPinSet:false, whitelistOnly:false, defaultCountryCode:'' },
    showAdvanced: false, busy: {}
  };
  function d() { return state.draft || EMPTY; }
  function services() {
    if (state.aiSources === null) return undefined;
    var out = [];
    for (var i = 0; i < state.aiSources.length; i++) { var s = state.aiSources[i]; if (s.kind === 'service') out.push({ id: s.refId, name: s.name, category: s.category, status: s.status, url: s.url }); }
    return out;
  }
  function dirty() { return JSON.stringify(state.draft) !== JSON.stringify(state.saved); }
  function setDraft(patch) { var nd = {}; var cur = d(); for (var k in cur) nd[k] = cur[k]; for (var j in patch) nd[j] = patch[j]; state.draft = nd; }

  // ── connector helpers ──
  function settingsGet() { return FL.connector('aokie', 'settings.get', {}).then(function (o) { return o.status === 'done' ? rec(o.result) : null; }).catch(function () { return null; }); }
  function settingsSet(payload) {
    return FL.connector('aokie', 'settings.set', payload).then(function (o) {
      if (o.status === 'done') return rec(o.result);
      var m = o.error && o.error.message ? o.error.message : o.status;
      throw new Error(m);
    });
  }

  // ── lane picker option list (port of laneOptionsFor) ──
  var LANE_CAP = { llm:'chat', stt:'transcription', tts:'speech' };
  var LANE_DEFAULT = { stt:'aokie-stt', tts:'aokie-tts' };
  function laneOptions(lane) {
    var cap = LANE_CAP[lane], defId = LANE_DEFAULT[lane], all = state.aiSources || [];
    var svcs = all.filter(function (s) { return s.kind === 'service' && s.capabilities.indexOf(cap) >= 0; });
    var opts = [];
    function withStatus(s) { return s.status === 'running' ? '' : ' (' + s.status + ')'; }
    var def = defId ? svcs.filter(function (s) { return s.refId === defId; })[0] : null;
    if (def) opts.push({ value: def.id, label: 'Aokie default - ' + def.name + withStatus(def) });
    for (var i = 0; i < svcs.length; i++) { var s = svcs[i]; if (def && s.refId === def.refId) continue; opts.push({ value: s.id, label: 'This computer: ' + s.name + withStatus(s) }); }
    if (lane === 'llm') {
      for (var p = 0; p < all.length; p++) { var pr = all[p]; if (pr.kind !== 'provider' || !pr.enabled) continue; if (pr.capabilities.length > 0 && pr.capabilities.indexOf('chat') < 0) continue; opts.push({ value: pr.id, label: 'Provider: ' + pr.name }); }
    }
    opts.push({ value: 'custom', label: 'Custom URL...' });
    opts.push({ value: '', label: 'Built-in (plugin fallback)' });
    return opts;
  }
  function laneHtml(lane, label, source, endpoint, placeholder, hint) {
    var listed = state.aiSources !== null, opts = laneOptions(lane);
    var isPick = source.indexOf('service:') === 0 || source.indexOf('provider:') === 0;
    var missing = isPick && !opts.some(function (o) { return o.value === source; });
    var showUrl = source === 'custom' || (source === '' && endpoint.trim() !== '');
    var h = '<label class="f"><span class="lbl">' + esc(label) + '</span>';
    h += '<select data-lane="' + lane + '">';
    if (missing) h += '<option value="' + esc(source) + '" selected>' + (source.indexOf('provider:') === 0 ? 'AI provider' : 'Desktop service') + ': ' + esc(source.slice(source.indexOf(':') + 1)) + (listed ? ' (not found)' : ' (saved)') + '</option>';
    for (var i = 0; i < opts.length; i++) h += opt(opts[i].value, opts[i].value === '' && endpoint.trim() && source === '' ? opts[i].label + ' - custom URL below wins' : opts[i].label, source);
    h += '</select>';
    if (showUrl) h += '<input type="text" class="mono" data-laneurl="' + lane + '" value="' + esc(endpoint) + '" placeholder="' + esc(placeholder) + '" style="margin-top:6px;font-size:11.5px">';
    if (hint) h += '<span class="hint">' + esc(hint) + '</span>';
    return h + '</label>';
  }

  // ── card painters ──
  function cardRunning() {
    var r = state.running;
    var body;
    if (r) {
      body = '<p class="greet"><span class="faint">Greeting: </span>"' + esc(r.greeting || '-') + '"</p>'
        + '<p class="meta">Voice ' + esc(r.voice || 'default') + ' - model ' + esc(r.model || 'auto') + ' - ' + (r.aiReceptionist ? 'built-in AI agent replies' : 'flow-driven replies') + (typeof r.configVersion === 'number' ? ' - config v' + r.configVersion : '') + '</p>'
        + (r.persona ? '<p class="persona" title="' + esc(r.persona) + '">' + esc(r.persona) + '</p>' : '');
    } else {
      body = '<p class="muted">' + (state.runningError ? 'Live configuration unavailable - ' + esc(state.runningError) : state.canGet ? 'Reading the live configuration...' : 'Your role cannot read the live configuration.') + '</p>';
    }
    return '<div class="card running"><div class="hdr"><h2>What the receptionist is running now</h2><button type="button" class="btn sm" data-act="refresh-running">Refresh</button></div>'
      + body + '<p class="hint">The Configure Receptionist flow re-applies the saved settings on every incoming call, so saving is enough - "Save &amp; apply now" just updates the live line immediately.</p></div>';
  }
  function cardBusiness() {
    var preview = composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE);
    return '<div class="card"><h2>Business &amp; greeting</h2>'
      + '<label class="f"><span class="lbl">Business name</span><input type="text" data-d="business_name" value="' + esc(d().business_name) + '" placeholder="e.g. Bright Smile Dental"></label>'
      + '<label class="f"><span class="lbl">Greeting (spoken first)</span><input type="text" data-d="greeting" value="' + esc(d().greeting) + '" placeholder="' + esc(str(preview.greeting)) + '"><span class="hint">Blank uses the friendly default shown above. Known callers are greeted by name automatically.</span></label></div>';
  }
  function cardPersonality() {
    return '<div class="card"><h2>How should it talk &amp; behave?</h2>'
      + '<textarea data-d="instructions" rows="6" placeholder="e.g. Be warm and concise. Offer to book Mon-Fri 9-5. Give the standard checkup price of $90 and offer to book.">' + esc(d().instructions) + '</textarea>'
      + '<p class="hint">Blank uses Aokie\\'s built-in receptionist persona. Plain English works - treat it like briefing a new hire.</p>'
      + '<h3>Business info the AI may share</h3>'
      + '<textarea data-d="business_info" rows="6" placeholder="Menu, services, prices, opening hours, parking, policies, FAQ... The AI answers business questions ONLY from this text and never invents details.">' + esc(d().business_info) + '</textarea>'
      + '<p class="hint">The only facts it will state about the business. Anything not covered here, it offers to have the team confirm - so an empty box means no invented menus or prices.</p></div>';
  }
  function cardVoice() {
    var cat = state.catalog, eng = state.engine;
    var isSherpa = eng.engine === 'sherpa';
    var engines = cat && cat.length ? cat : DEFAULT_ENGINES;
    var bundles = ((cat || []).filter(function (e) { return e.id === 'sherpa'; })[0] || {}).bundles || [];
    var voices = pocketVoices(cat);
    var matched = bundles.filter(function (b) { return b.dir === eng.modelDir; })[0];
    var bundleValue = eng.customDir || (eng.modelDir !== '' && !matched) ? '__custom__' : (matched ? matched.dir : '');
    var showCustomDir = isSherpa && state.canSet && (bundles.length === 0 || bundleValue === '__custom__');
    var isKokoro = isSherpa && matched && matched.kind === 'kokoro';
    var engineValue = eng.engine === 'pocket' ? '' : eng.engine;

    var h = '<div class="card"><h2>Voice &amp; replies</h2>'
      + '<p class="hint" style="margin-top:0">The voice pick is saved with this record and applies per call. The speech engine and voice model folder are live plugin settings.</p><div class="row2">';
    if (state.canSet) {
      h += '<label class="f"><span class="lbl">Speech engine</span><select data-eng="engine">';
      for (var i = 0; i < engines.length; i++) { var e = engines[i]; var label = e.id === 'pocket' ? 'Pocket-TTS (default)' : e.id === 'sherpa' ? 'Sherpa - Piper/VITS voices (fast)' : e.label; h += opt(e.id === 'pocket' ? '' : e.id, label, engineValue); }
      h += '</select></label>';
    }
    if (!isSherpa) {
      h += '<label class="f"><span class="lbl">Voice</span><select data-d="voice">';
      for (var v = 0; v < voices.length; v++) h += opt(voices[v], voices[v] === '' ? 'Default' : voices[v].charAt(0).toUpperCase() + voices[v].slice(1), d().voice);
      h += '</select><span class="hint">Pocket-TTS voice - saved with the record, applied on the next call.</span></label>';
    }
    if (isSherpa && state.canSet && bundles.length > 0) {
      h += '<label class="f"><span class="lbl">Voice</span><select data-eng="bundle"><option value="">Automatic (first installed voice)</option>';
      for (var b = 0; b < bundles.length; b++) h += opt(bundles[b].dir, prettifyBundle(bundles[b].name), bundleValue);
      h += '<option value="__custom__"' + (bundleValue === '__custom__' ? ' selected' : '') + '>Custom folder...</option></select><span class="hint">Installed sherpa voice bundles on the desktop machine. The pick applies per call.</span></label>';
    }
    if (showCustomDir) h += '<label class="f"' + (bundles.length > 0 ? ' style="grid-column:1/-1"' : '') + '><span class="lbl">Voice model folder (blank = auto)</span><input type="text" data-eng="modelDir" value="' + esc(eng.modelDir) + '" placeholder="blank = first voice under models/tts"><span class="hint">A sherpa voice bundle folder on the desktop machine (the voice\\'s .onnx + tokens.txt).</span></label>';
    if (isKokoro) h += '<label class="f"><span class="lbl">Speaker id</span><input type="text" class="mono" data-d="voice" value="' + esc(d().voice) + '" placeholder="e.g. 0"><span class="hint">Kokoro bundles hold many speakers - the numeric id picks one.</span></label>';
    h += '</div>';
    if (state.canSet) h += '<div class="savebtnrow"><button type="button" class="btn dark sm" data-act="save-engine"' + (state.busy.engine || !eng.loaded ? ' disabled' : '') + '>' + (state.busy.engine ? 'Saving...' : 'Save speech engine') + '</button></div>';
    h += '<div class="row2" style="margin-top:12px;border-top:1px solid var(--fl-border);padding-top:12px">'
      + '<label class="f"><span class="lbl">Active</span><select data-d="active">' + opt('yes', 'Yes - use these settings', d().active) + opt('no', 'No - fall back to defaults', d().active) + '</select></label>'
      + '<label class="f" style="grid-column:1/-1"><span class="lbl">Who answers the caller</span><select data-d="reply_mode">' + opt('agent', 'Built-in AI agent (recommended - fast, on-device)', d().reply_mode) + opt('flow', 'Custom flow (edit the Live Reply flow yourself)', d().reply_mode) + '</select><span class="hint">Reply mode only takes effect the next time Aokie reconnects - the plugin reads it once at startup, not per call.</span></label></div></div>';
    return h;
  }
  function cardServices() {
    var h = '<div class="card"><h2>Connected services</h2><p class="hint" style="margin-top:0">Which engine answers, hears and speaks. Picks resolve to the service\\'s live address on every call. AI providers route through the desktop\\'s AI gateway.'
      + (state.aiSources === null ? ' Connect FormLogic Desktop on this machine to pick services by name - saved picks still resolve per call on the desktop.' : '') + '</p>';
    h += laneHtml('llm', 'Reply model (LLM)', d().llm_source, d().llm_endpoint, 'e.g. http://127.0.0.1:8080/v1/chat/completions', 'Built-in = the plugin\\'s configured endpoint (auto-detects a local llama.cpp/Ollama).');
    h += laneHtml('stt', 'Speech to text', d().stt_source, d().stt_endpoint, 'e.g. http://127.0.0.1:17921/v1/audio/transcriptions', '');
    h += laneHtml('tts', 'Text to speech', d().tts_source, d().tts_endpoint, 'e.g. http://127.0.0.1:17922/v1/audio/speech', '');
    return h + '</div>';
  }
  function cardAudio() {
    if (!state.canSet) return '';
    var a = state.audio;
    var mode = a.sendAudio && a.audioTranscript ? 'both' : a.sendAudio ? 'direct' : a.audioTranscript ? 'corrections' : 'off';
    var modeHint = a.sendAudio && a.audioTranscript ? 'The reply model hears the caller directly AND a small side request per turn fixes the stored transcript from the audio.'
      : a.sendAudio ? 'Each caller turn\\'s audio rides along with the reply request - needs an audio-capable reply model; no extra side run.'
      : a.audioTranscript ? 'For text-only reply models: a small extra request per caller turn corrects the stored transcript from the audio - replies never wait on it.'
      : 'Replies use the on-device speech-to-text transcript only - no audio leaves the plugin.';
    var h = '<div class="card"><h2>Audio understanding</h2><p class="muted">What happens with the caller\\'s actual audio each turn. Applies the next time the receptionist reconnects.</p>'
      + '<label class="f"><span class="lbl">Caller audio</span><select data-audio="mode">'
      + opt('off', 'Text only', mode) + opt('direct', 'Send audio to the reply model (direct)', mode) + opt('corrections', 'Side-run transcript corrections', mode) + opt('both', 'Both', mode)
      + '</select><span class="hint">' + esc(modeHint) + '</span></label>';
    if (a.audioTranscript) {
      var cs = d().correction_source;
      h += '<div style="border:1px solid var(--fl-border);border-radius:12px;padding:10px;margin-top:10px"><label class="f"><span class="lbl">Correction source</span><select data-d="correction_source">';
      var chatSvcs = (state.aiSources || []).filter(function (s) { return s.kind === 'service' && s.capabilities.indexOf('chat') >= 0; });
      if (cs.indexOf('service:') === 0 && !chatSvcs.some(function (s) { return s.id === cs; })) h += '<option value="' + esc(cs) + '" selected>Desktop service: ' + esc(cs.slice(8)) + (state.aiSources !== null ? ' (not found)' : ' (saved)') + '</option>';
      h += opt('', 'Automatic (main reply model)', cs);
      for (var i = 0; i < chatSvcs.length; i++) { var s = chatSvcs[i]; h += opt(s.id, 'This computer: ' + s.name + (s.model ? ' - ' + s.model : '') + (s.status === 'running' ? '' : ' (' + s.status + ')'), cs); }
      h += opt('custom', 'Custom URL...', cs) + '</select>';
      if (cs === 'custom') h += '<input type="text" class="mono" data-d="correction_endpoint" value="' + esc(d().correction_endpoint) + '" placeholder="e.g. http://127.0.0.1:8081/v1/chat/completions" style="margin-top:6px;font-size:11.5px">';
      h += '<span class="hint">Which model runs the corrections - a separate chat service keeps them from competing with live replies. Resolved per call.</span></label></div>';
    }
    h += '<div class="savebtnrow"><button type="button" class="btn dark sm" data-act="save-audio"' + (state.busy.audio || !a.loaded ? ' disabled' : '') + '>' + (state.busy.audio ? 'Saving...' : 'Save audio settings') + '</button>' + (a.loaded ? '' : '<span class="faint">Loading current values...</span>') + '</div>';
    return h + '</div>';
  }
  function cardWaiting() {
    if (!state.canSet) return '';
    var w = state.waiting;
    function chk(key, on, disabled, title, sub) {
      return '<label class="chk' + (disabled ? ' off' : '') + '"><input type="checkbox" data-wait="' + key + '"' + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span>' + esc(title) + '<span class="sub">' + esc(sub) + '</span></span></label>';
    }
    return '<div class="card"><h2>Phone connection &amp; call waiting</h2><p class="muted">How the receptionist links to the phone and handles a second caller. All apply the next time it reconnects.</p>'
      + chk('autoConnectPhone', w.autoConnectPhone, false, 'Connect the phone automatically on startup', 'When the receptionist starts it pages the last connected phone itself, so the line comes up without pressing Reconnect.')
      + chk('holdAndCallWaiting', w.holdAndCallWaiting, false, 'Detect a second caller (call waiting)', 'A second caller ringing mid-call is noticed and recorded without disturbing the live conversation. On its own it never answers them.')
      + chk('autoHoldQueue', w.autoHoldQueue, !w.holdAndCallWaiting, 'Automatically hold & queue callers', 'The receptionist tells the current caller another call came in, answers the new caller with "please hold - you\\'re next in the queue", parks them, and returns to the first. Needs "Detect a second caller" on.')
      + '<div class="savebtnrow"><button type="button" class="btn dark sm" data-act="save-waiting"' + (state.busy.waiting || !w.loaded ? ' disabled' : '') + '>' + (state.busy.waiting ? 'Saving...' : 'Save call waiting') + '</button>' + (w.loaded ? '' : '<span class="faint">Loading current values...</span>') + '</div></div>';
  }
  function cardScreening() {
    if (!state.canSet) return '';
    var sc = state.screening, blocked = splitList(sc.blockedNumbers);
    var chips = '';
    if (blocked.length) { chips = '<div class="chips">'; for (var i = 0; i < blocked.length; i++) chips += '<span class="chip mono">' + esc(blocked[i]) + '<button type="button" data-unblock="' + esc(blocked[i]) + '" aria-label="Unblock">x</button></span>'; chips += '</div>'; }
    var pinTag = sc.managerPinSet ? '<span class="pill ok">PIN set</span>' : '<span class="faint">no PIN - read-only line</span>';
    var h = '<div class="card"><h2>Call screening</h2><p class="muted">Who gets through. Screened callers hear a short message (or nothing) and the call ends - no greeting, no AI. Changes apply on the next incoming call.</p>'
      + '<label class="f"><span class="lbl">Blocked numbers</span><textarea class="mono" data-sc="blockedNumbers" rows="3" placeholder="One per line (or comma-separated)">' + esc(sc.blockedNumbers) + '</textarea>' + chips + '<span class="hint">Any format - numbers match on their digits.</span></label>'
      + '<label class="f"><span class="lbl">Message for blocked numbers</span><input type="text" data-sc="blockedMessage" value="' + esc(sc.blockedMessage) + '" placeholder="Blank = reject silently (just hang up)."><span class="hint">Only for the blocked list above.</span></label>'
      + '<label class="f"><span class="lbl">Accept filter (regular expression)</span><input type="text" class="mono" data-sc="acceptPattern" value="' + esc(sc.acceptPattern) + '" placeholder="e.g. ^(+?61|0)4 - Australian mobiles only. Blank = accept all."><span class="hint">Caller IDs that don\\'t match are screened out. An invalid pattern is ignored.</span></label>'
      + '<label class="chk"><input type="checkbox" data-sc="rejectPrivate"' + (sc.rejectPrivate ? ' checked' : '') + '><span>Screen private / withheld numbers</span></label>'
      + '<label class="f"><span class="lbl">Message for filtered / private callers</span><input type="text" data-sc="screenMessage" value="' + esc(sc.screenMessage) + '" placeholder="e.g. Please call back with caller ID enabled. (blank = hang up silently)"></label>'
      + '<label class="chk"><input type="checkbox" data-sc="autoBlockAbuse"' + (sc.autoBlockAbuse ? ' checked' : '') + '><span>Auto-block abusive callers<span class="sub">When the AI flags genuine abuse it speaks a short notice, ends the call, and adds the number to the block list.</span></span></label>'
      + '<label class="chk"><input type="checkbox" data-sc="whitelistOnly"' + (sc.whitelistOnly ? ' checked' : '') + '><span>Whitelist mode - known customers only<span class="sub">Callers with no Customer record are rejected once their number is known.</span></span></label>'
      + '<label class="f"><span class="lbl">Manager numbers</span><textarea class="mono" data-sc="managerNumbers" rows="2" placeholder="One per line - e.g. your own mobile">' + esc(sc.managerNumbers) + '</textarea><span class="hint">Calls from these numbers get the manager treatment. Never screened out.</span></label>'
      + '<label class="f"><span class="lbl" style="display:flex;justify-content:space-between">Manager PIN (spoken) ' + pinTag + '</span><input type="password" inputmode="numeric" autocomplete="off" class="mono" data-sc="managerPin" value="' + esc(sc.managerPin) + '" placeholder="' + (sc.managerPinSet ? 'Enter a new PIN to replace it - blank keeps the current one' : 'Set a 6-8 digit PIN - blank = manager line stays read-only') + '">'
      + '<span class="hint">Booking changes by voice need this PIN spoken once per call. For your security the saved PIN is never shown back - leave blank to keep the current one.' + (sc.managerPinSet ? ' <button type="button" data-act="remove-pin" class="btn sm" style="margin-top:4px">Remove PIN</button>' : '') + '</span></label>'
      + '<label class="f"><span class="lbl">Default country code for texts</span><input type="text" class="mono" data-sc="defaultCountryCode" value="' + esc(sc.defaultCountryCode) + '" placeholder="e.g. +61 - blank = send numbers exactly as saved"></label>'
      + '<div class="savebtnrow"><button type="button" class="btn dark sm" data-act="save-screening"' + (state.busy.screening || !sc.loaded ? ' disabled' : '') + '>' + (state.busy.screening ? 'Saving...' : 'Save screening') + '</button>' + (sc.loaded ? '' : '<span class="faint">Loading current values...</span>') + '</div>';
    return h + '</div>';
  }
  function cardAdvanced() {
    var o = state.showAdvanced;
    // The glyph is CSS-driven off [open] (see .adv summary::before); state.showAdvanced
    // only persists the open state across re-renders. Toggling needs no render().
    return '<details class="card adv"' + (o ? ' open' : '') + '><summary data-act="toggle-adv">Advanced - AI model &amp; endpoints</summary>'
      + '<div style="margin-top:10px"><p class="hint" style="margin-top:0">The raw AI plumbing. Custom URL fields are used when a lane is set to Custom URL (or left on Built-in with a URL entered).</p>'
      + '<label class="f"><span class="lbl">LLM model</span><input type="text" data-d="model" value="' + esc(d().model) + '" placeholder="e.g. llama3.1:8b (blank = auto)"></label>'
      + '<label class="f"><span class="lbl">Custom LLM endpoint URL</span><input type="text" class="mono" data-d="llm_endpoint" value="' + esc(d().llm_endpoint) + '" placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"></label>'
      + '<label class="f"><span class="lbl">Custom speech-to-text URL</span><input type="text" class="mono" data-d="stt_endpoint" value="' + esc(d().stt_endpoint) + '" placeholder="e.g. http://127.0.0.1:17921/v1/audio/transcriptions"></label>'
      + '<label class="f"><span class="lbl">Custom text-to-speech URL</span><input type="text" class="mono" data-d="tts_endpoint" value="' + esc(d().tts_endpoint) + '" placeholder="e.g. http://127.0.0.1:17922/v1/audio/speech"></label></div></details>';
  }
  function cardSaveBar() {
    var dis = !state.mayWrite || state.busy.save || state.busy.apply;
    return '<div class="savebar"><div class="inner">' + (dirty() ? '<span class="dirty">Unsaved changes</span>' : '<span class="clean">Saved</span>')
      + '<div class="right">' + (dirty() ? '<button type="button" class="btn sm" data-act="discard">Discard</button>' : '')
      + '<button type="button" class="btn" data-act="save"' + (dis || !dirty() ? ' disabled' : '') + '>' + (state.busy.save ? 'Saving...' : 'Save') + '</button>'
      + (state.canSet ? '<button type="button" class="btn primary" data-act="save-apply"' + (dis ? ' disabled' : '') + '>' + (state.busy.apply ? 'Applying...' : 'Save & apply now') + '</button>' : '')
      + '</div></div></div>';
  }

  function render() {
    if (state.draft === null) { $('cards').innerHTML = '<div class="card"><p class="muted">Loading settings...</p></div>'; return; }
    var h = cardRunning();
    if (state.err) h += '<div id="err">' + esc(state.err) + '</div>';
    h += cardBusiness() + cardPersonality() + cardVoice() + cardServices() + cardAudio() + cardWaiting() + cardScreening() + cardAdvanced() + cardSaveBar();
    $('cards').innerHTML = h;
  }

  // ── loaders ──
  function seedFromSettings(res) {
    var s = rec(res.settings);
    if (!state.audio.loaded) state.audio = { loaded:true, sendAudio: boolish(s.sendAudio), audioTranscript: boolish(s.audioTranscript) };
    if (!state.waiting.loaded) state.waiting = { loaded:true, holdAndCallWaiting: boolish(s.holdAndCallWaiting), autoHoldQueue: boolish(s.autoHoldQueue), autoConnectPhone: !(s.autoConnectPhone === false || s.autoConnectPhone === 'false') };
    if (!state.screening.loaded) {
      state.screening.loaded = true;
      state.screening.blockedNumbers = str(s.blockedNumbers);
      state.screening.acceptPattern = str(s.acceptPattern);
      state.screening.rejectPrivate = boolish(s.rejectPrivate);
      state.screening.screenMessage = str(s.screenMessage);
      state.screening.blockedMessage = str(s.blockedMessage);
      state.screening.autoBlockAbuse = !(s.autoBlockAbuse === false || s.autoBlockAbuse === 'false');
      state.screening.managerNumbers = str(s.managerNumbers);
      state.screening.managerPin = '';
      state.screening.managerPinSet = res.managerPinSet === true;
    }
    if (!state.engine.loaded) state.engine = { loaded:true, engine: str(s.ttsEngine), modelDir: str(s.ttsModelDir), customDir:false };
    state.catalog = parseCatalog(res.ttsVoiceCatalog);
    state.running = { greeting: str(s.greeting), persona: str(s.persona), voice: str(s.ttsVoice), model: str(s.aiModel), aiReceptionist: s.aiReceptionist === true, configVersion: typeof res.configVersion === 'number' ? res.configVersion : undefined };
  }
  function refreshRunning() {
    if (!state.canGet) return Promise.resolve();
    state.runningError = null;
    return settingsGet().then(function (res) { if (res) { seedFromSettings(res); state.running || (state.running = null); } else { state.runningError = 'the desktop did not respond'; } }).catch(function (e) { state.running = null; state.runningError = e && e.message ? e.message : 'unavailable'; });
  }
  function loadRecord() {
    return FL.records({ limit: 5 }).then(function (rows) {
      var newest = (rows || [])[0];
      var a = newest ? rec(newest.answers) : {};
      var nd = {}; for (var k in EMPTY) nd[k] = typeof a[k] === 'string' ? a[k] : EMPTY[k];
      nd.reply_mode = nd.reply_mode || 'agent'; nd.active = nd.active || 'yes';
      state.draft = nd; state.saved = JSON.parse(JSON.stringify(nd)); state.recordId = newest ? newest.id : null;
      // Record-side screening fields (whitelist mode + country code).
      state.screening.whitelistOnly = String(a.whitelist_only || '') === 'yes';
      state.screening.defaultCountryCode = typeof a.default_country_code === 'string' ? a.default_country_code : '';
      state.screening.recordLoaded = true;
    }).catch(function () { state.draft = JSON.parse(JSON.stringify(EMPTY)); state.saved = JSON.parse(JSON.stringify(EMPTY)); });
  }
  function applySpeechDefaults() {
    if (state.aiSources === null || !state.draft) return;
    function has(id) { return state.aiSources.some(function (s) { return s.kind === 'service' && s.refId === id; }); }
    var patch = {};
    if (!d().stt_source.trim() && !d().stt_endpoint.trim() && has('aokie-stt')) patch.stt_source = 'service:aokie-stt';
    if (!d().tts_source.trim() && !d().tts_endpoint.trim() && has('aokie-tts')) patch.tts_source = 'service:aokie-tts';
    if (Object.keys(patch).length) { setDraft(patch); state.saved = JSON.parse(JSON.stringify(state.draft)); }
  }

  // ── record writes (create-on-first-save, then partial patches) ──
  // A shared in-flight create guard: concurrent first-saves (e.g. Save audio +
  // Save screening) must NOT each submit and duplicate the singleton. Only the
  // first no-record caller creates; the rest wait then updateRecord. And the
  // create ALWAYS sends the FULL draft (plus this caller's non-draft keys) -
  // create validates required fields and does not merge, so a partial first
  // write could 400.
  var createInFlight = null;
  function writeRecord(answers) {
    if (state.recordId) return FL.updateRecord(state.recordId, answers);
    if (createInFlight) return createInFlight.then(function () { return FL.updateRecord(state.recordId, answers); });
    var full = {}; var cur = d(); for (var k in cur) full[k] = cur[k];
    for (var j in answers) full[j] = answers[j];
    createInFlight = FL.submit(full).then(function (r) { var id = r && r.id; if (id) state.recordId = id; createInFlight = null; return r; }, function (e) { createInFlight = null; throw e; });
    return createInFlight;
  }
  function persistDraft() {
    var full = {}; var cur = d(); for (var k in cur) full[k] = cur[k];
    return writeRecord(full).then(function () { state.saved = JSON.parse(JSON.stringify(state.draft)); return true; });
  }

  // ── save handlers ──
  function saveEngine() {
    state.busy.engine = true; render();
    settingsSet({ ttsEngine: state.engine.engine, ttsModelDir: state.engine.modelDir.trim() })
      .then(function () { FL.toast.success('Speech engine updated'); })
      .catch(function (e) { FL.toast.error(e && e.message ? e.message : 'Could not save the speech engine'); })
      .then(function () { state.busy.engine = false; render(); });
  }
  function saveAudio() {
    state.busy.audio = true; state.err = null;
    // Capture BEFORE the write: a first-save creates the FULL draft (whole
    // record persisted), a later save persists only the two correction keys.
    var wasCreate = !state.recordId;
    render();
    var payload = { sendAudio: state.audio.sendAudio, audioTranscript: state.audio.audioTranscript };
    var p = composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE);
    if ('audioTranscriptEndpoint' in p) payload.audioTranscriptEndpoint = p.audioTranscriptEndpoint;
    settingsSet(payload)
      .then(function () { return writeRecord({ correction_source: d().correction_source.trim(), correction_endpoint: d().correction_endpoint.trim() }); })
      .then(function () {
        // Reflect ONLY what this save persisted into the dirty baseline: on a
        // create the whole draft went in; on an update only the two correction
        // keys - clobbering the whole baseline would silently mark unrelated
        // pending edits (business name, persona, ...) as saved and lose them.
        if (wasCreate) { state.saved = JSON.parse(JSON.stringify(state.draft)); }
        else { state.saved.correction_source = state.draft.correction_source; state.saved.correction_endpoint = state.draft.correction_endpoint; }
        return settingsGet();
      })
      .then(function (res) { if (res) { var s = rec(res.settings); state.audio.sendAudio = boolish(s.sendAudio); state.audio.audioTranscript = boolish(s.audioTranscript); } FL.toast.success('Audio settings saved', 'Applies when the receptionist next reconnects.'); })
      .catch(function (e) { state.err = e && e.message ? e.message : 'save failed'; })
      .then(function () { state.busy.audio = false; render(); });
  }
  function saveWaiting() {
    state.busy.waiting = true; state.err = null; render();
    var w = state.waiting;
    settingsSet({ holdAndCallWaiting: w.holdAndCallWaiting, autoHoldQueue: w.autoHoldQueue, autoConnectPhone: w.autoConnectPhone })
      .then(function () { return settingsGet(); })
      .then(function (res) { if (res) { var s = rec(res.settings); w.holdAndCallWaiting = boolish(s.holdAndCallWaiting); w.autoHoldQueue = boolish(s.autoHoldQueue); w.autoConnectPhone = !(s.autoConnectPhone === false || s.autoConnectPhone === 'false'); } FL.toast.success('Call waiting saved', 'Applies when the receptionist next reconnects.'); })
      .catch(function (e) { state.err = e && e.message ? e.message : 'save failed'; })
      .then(function () { state.busy.waiting = false; render(); });
  }
  function saveScreening() {
    state.busy.screening = true; state.err = null;
    var wasCreate = !state.recordId;
    render();
    var sc = state.screening, newPin = sc.managerPin.trim();
    // managerPin: send ONLY when the operator typed a new one - a blank field
    // means "keep the current PIN", never wipe it (Remove PIN is explicit).
    var payload = { blockedNumbers: sc.blockedNumbers.trim(), acceptPattern: sc.acceptPattern.trim(), rejectPrivate: sc.rejectPrivate, screenMessage: sc.screenMessage.trim(), blockedMessage: sc.blockedMessage.trim(), autoBlockAbuse: sc.autoBlockAbuse, managerNumbers: sc.managerNumbers.trim() };
    if (newPin) payload.managerPin = newPin;
    settingsSet(payload)
      .then(function () { return writeRecord({ whitelist_only: sc.whitelistOnly ? 'yes' : 'no', default_country_code: sc.defaultCountryCode.trim() }); })
      .then(function () {
        // whitelist_only / default_country_code live on state.screening, NOT the
        // draft - so a normal screening save persists NO draft keys and must not
        // touch the dirty baseline. Only a first-save (which creates the whole
        // draft) makes the draft persisted.
        if (wasCreate) state.saved = JSON.parse(JSON.stringify(state.draft));
        return settingsGet();
      })
      .then(function (res) {
        if (res) { var s = rec(res.settings);
          sc.blockedNumbers = typeof s.blockedNumbers === 'string' ? s.blockedNumbers : sc.blockedNumbers;
          sc.acceptPattern = typeof s.acceptPattern === 'string' ? s.acceptPattern : sc.acceptPattern;
          sc.rejectPrivate = boolish(s.rejectPrivate);
          sc.screenMessage = typeof s.screenMessage === 'string' ? s.screenMessage : sc.screenMessage;
          sc.blockedMessage = typeof s.blockedMessage === 'string' ? s.blockedMessage : sc.blockedMessage;
          sc.autoBlockAbuse = !(s.autoBlockAbuse === false || s.autoBlockAbuse === 'false');
          sc.managerNumbers = typeof s.managerNumbers === 'string' ? s.managerNumbers : sc.managerNumbers;
          sc.managerPin = ''; sc.managerPinSet = res.managerPinSet === true;
        }
        FL.toast.success('Call screening saved', 'Applies on the next incoming call.');
      })
      .catch(function (e) { state.err = e && e.message ? e.message : 'save failed'; })
      .then(function () { state.busy.screening = false; render(); });
  }
  function removePin() {
    state.busy.screening = true; state.err = null; render();
    settingsSet({ managerPin: '' })
      .then(function () { state.screening.managerPin = ''; state.screening.managerPinSet = false; FL.toast.success('Manager PIN removed', 'The manager line is read-only until a new PIN is set.'); })
      .catch(function (e) { state.err = e && e.message ? e.message : 'save failed'; })
      .then(function () { state.busy.screening = false; render(); });
  }
  function doSave() {
    state.busy.save = true; state.err = null; render();
    persistDraft().then(function () { FL.toast.success('Settings saved', 'Applied automatically at the next incoming call.'); })
      .catch(function (e) { state.err = e && e.message ? e.message : 'save failed'; })
      .then(function () { state.busy.save = false; render(); });
  }
  function doSaveApply() {
    state.busy.apply = true; state.err = null; render();
    persistDraft().then(function () {
      if (d().active === 'no') { FL.toast.info('Saved (marked inactive)', 'This record is inactive, so it was not pushed to the receptionist.'); return; }
      return settingsSet(composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE)).then(refreshRunning).then(function () { FL.toast.success('Applied to the receptionist', 'The very next call uses this configuration.'); });
    }).catch(function (e) { state.err = e && e.message ? e.message : 'apply failed'; })
      .then(function () { state.busy.apply = false; render(); });
  }

  // ── events ──
  document.addEventListener('input', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    var dk = t.getAttribute('data-d'); if (dk) { var patch = {}; patch[dk] = t.value; setDraft(patch); if (dk === 'business_name' || dk === 'greeting') { var g = $('cards').querySelector('[data-d="greeting"]'); if (g && dk === 'business_name') g.setAttribute('placeholder', str(composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE).greeting)); } updateSaveBar(); return; }
    var sk = t.getAttribute('data-sc'); if (sk) { state.screening[sk] = t.type === 'checkbox' ? t.checked : t.value; return; }
    var ek = t.getAttribute('data-eng'); if (ek === 'modelDir') { state.engine.modelDir = t.value; state.engine.customDir = true; return; }
    var uk = t.getAttribute('data-laneurl'); if (uk) { var pu = {}; pu[uk + '_endpoint'] = t.value; setDraft(pu); updateSaveBar(); return; }
  });
  document.addEventListener('change', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    var dk = t.getAttribute('data-d'); if (dk) { var patch = {}; patch[dk] = t.value; setDraft(patch); updateSaveBar(); return; }
    var sk = t.getAttribute('data-sc'); if (sk && t.type === 'checkbox') { state.screening[sk] = t.checked; return; }
    var lane = t.getAttribute('data-lane'); if (lane) { var pl = {}; pl[lane + '_source'] = t.value; setDraft(pl); render(); return; }
    var wk = t.getAttribute('data-wait'); if (wk) { state.waiting[wk] = t.checked; if (wk === 'holdAndCallWaiting' && !t.checked) state.waiting.autoHoldQueue = false; render(); return; }
    var am = t.getAttribute('data-audio'); if (am === 'mode') { var v = t.value; state.audio.sendAudio = v === 'direct' || v === 'both'; state.audio.audioTranscript = v === 'corrections' || v === 'both'; render(); return; }
    var eng = t.getAttribute('data-eng');
    if (eng === 'engine') { state.engine.engine = t.value; render(); return; }
    if (eng === 'bundle') {
      var val = t.value, bundles = ((state.catalog || []).filter(function (x) { return x.id === 'sherpa'; })[0] || {}).bundles || [];
      if (val === '__custom__') { state.engine.customDir = true; }
      else if (val === '') { state.engine.modelDir = ''; state.engine.customDir = false; setDraft({ voice: '' }); }
      else { var m = bundles.filter(function (b) { return b.dir === val; })[0]; state.engine.modelDir = val; state.engine.customDir = false; setDraft({ voice: m ? m.name : baseName(val) }); }
      render(); return;
    }
  });
  function updateSaveBar() {
    var bar = $('cards').querySelector('.savebar');
    if (bar) { var wrap = document.createElement('div'); wrap.innerHTML = cardSaveBar(); bar.parentNode.replaceChild(wrap.firstChild, bar); }
  }
  document.addEventListener('click', function (e) {
    var t = e.target; while (t && t !== document.body && !(t.getAttribute && (t.getAttribute('data-act') || t.getAttribute('data-unblock')))) t = t.parentElement;
    if (!t || !t.getAttribute) return;
    var ub = t.getAttribute('data-unblock');
    if (ub) { var keep = splitList(state.screening.blockedNumbers).filter(function (x) { return x !== ub; }); state.screening.blockedNumbers = keep.join('\\n'); render(); return; }
    var act = t.getAttribute('data-act');
    if (act === 'refresh-running') { refreshRunning().then(render); }
    else if (act === 'save-engine') saveEngine();
    else if (act === 'save-audio') saveAudio();
    else if (act === 'save-waiting') saveWaiting();
    else if (act === 'save-screening') saveScreening();
    else if (act === 'remove-pin') removePin();
    else if (act === 'save') doSave();
    else if (act === 'save-apply') doSaveApply();
    else if (act === 'discard') { state.draft = JSON.parse(JSON.stringify(state.saved)); render(); }
    else if (act === 'toggle-adv') { state.showAdvanced = !state.showAdvanced; }
  });

  function loadAll() {
    return FL.presence().then(function (p) { state.presence = p || { kind: 'none' }; }).catch(function () {})
      .then(function () { return Promise.all([FL.can('connector.aokie.settings.get'), FL.can('connector.aokie.settings.set')]); })
      .then(function (g) { state.canGet = g[0] === true; state.canSet = g[1] === true; })
      .then(function () { return Promise.all([loadRecord(), FL.aiSources().then(function (a) { state.aiSources = a; }).catch(function () { state.aiSources = null; })]); })
      .then(function () { return FL.currentUser(); }).then(function (u) { state.demo = !!(u && u.email === 'demo@formlogic.local'); }).catch(function () {})
      .then(function () {
        // mayWrite mirrors canEdit/canSubmit: the server is the real gate; the
        // sandbox has no per-form record-perm read, so allow the attempt and let
        // the API refuse. Records() succeeding implies at least view.
        state.mayWrite = true;
        applySpeechDefaults();
      })
      .then(refreshRunning)
      .then(render);
  }

  function wire() { void loadAll(); }
  wire();
})();
`;

/**
 * The customScreen SECTION payload for the Receptionist Settings form (kind
 * 'code'). The screen owns the singleton record itself, so New-record chrome
 * stays off.
 */
export const AOKIE_RECEPTIONIST_SETTINGS_SCREEN = {
  enabled: true,
  allowNewResponses: false,
  kind: 'code' as const,
  title: 'Receptionist Settings',
  html: HTML,
  css: CSS,
  js: JS,
};
