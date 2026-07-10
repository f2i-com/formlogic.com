// Aokie Receptionist for FormLogic (docs/AOKIE_PLUGIN_CONTRACT.md, docs/FORMLOGIC_FLOWS.md §6,
// plan §12). The Aokie phone hardware lives in a FormLogic Desktop plugin; THIS pack is the
// business half: raw call/SMS records written by sandboxed app logic from `aokie.*` events,
// dashboards over those records, starter FormLogic Flows (caller lookup, call summary, SMS
// draft, missed-call follow-up, hardware alert), and two trusted SDK screens (Live Call +
// Device Setup) wired through the permission-gated aokie connector.
//
// Conventions this pack relies on:
//  - Correlation keys / machine timestamps (call_id, started_at, message_id, …) are plain
//    `short_text` fields, NOT `hidden`: the platform treats hidden fields as
//    server-authoritative (anti-tamper — client-supplied values are STRIPPED on submit),
//    so app-logic-written keys must be ordinary writable fields. Verified live: hidden
//    correlation keys silently vanish and call.answered/ended matching breaks.
//  - App-logic scripts reference forms by their runtime DISPLAY NAME ('Calls', 'Messages', …)
//    — the trusted host resolves display names to real form ids after import, since a pack
//    can never know post-import UUIDs. Renaming a nav item therefore renames a logic key.
//  - Flow graphs reference forms as '@pack:<packFormId>' inside node data (form/formId);
//    PackService remaps them to real ids at import time, like binding formIds.
//  - Single-writer rule: app logic is the ONLY writer of raw Calls/Turns/Messages/Hardware
//    Events rows. Flows only ANNOTATE (call summary) or CREATE derived records (follow-up
//    tasks, SMS drafts) — never the raw event mirror, so nothing is double-written.
import type { PackData } from './financeOsPack';

// ── Shared defaults ─────────────────────────────────────────────────────────

const defaultSettings: Record<string, unknown> = {
  presentationMode: 'both',
  defaultPresentationMode: 'focused',
  showProgressBar: true,
  allowBackNavigation: true,
  submitButtonText: 'Submit',
  notifications: { emailNotifications: false },
  isClosed: false,
};

const defaultTheme: Record<string, unknown> = {
  primaryColor: '#0284c7',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── App-logic scripts (sandboxed QuickJS; effects only, host enforces grants) ──────────
// Every script guards on the exact event name and dedupes on the envelope idempotencyKey
// via the host-provided ctx.storage snapshot + a storage.set effect (contract §7).

const LOGIC_CALL_INCOMING = `function run(ctx) {
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.call.incoming') return {};
  var d = ev.data || {};
  var key = 'seen-' + String(ev.idempotencyKey || ('incoming:' + ev.correlationId));
  if (ctx.storage && ctx.storage[key]) return {};
  var phone = String(d.callerPhone || d.from || '');
  // Withheld/unknown caller id: never put a non-number ('unknown') in the
  // phone field - format validation would reject the WHOLE Calls row.
  if (!/^\\+?[0-9][0-9 ()-]{4,}$/.test(phone)) phone = '';
  // Business write FIRST, seen-marker after (audit C-04/FL-001): a failed
  // write must not be marked handled.
  return {
    effects: [
      { type: 'formlogic.submitResponse', formKey: 'Calls', answers: {
        call_id: String(d.callId || ev.correlationId || ''),
        caller_phone: phone,
        caller_name: String(d.callerName || (phone ? '' : 'Unknown caller')),
        status: 'incoming',
        started_at: String(ev.occurredAt || '')
      } },
      { type: 'storage.set', key: key, value: 1 },
      { type: 'ui.toast', level: 'info', message: 'Incoming call' + (phone ? ' from ' + phone : '') }
    ]
  };
}`;

const LOGIC_CALL_ANSWERED = `function run(ctx) {
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.call.answered') return {};
  var d = ev.data || {};
  var callId = String(d.callId || ev.correlationId || '');
  // Lifecycle upsert (audit §8): answered can arrive BEFORE incoming
  // (caller-id grace delays it) or after a failed incoming write - the
  // update must materialise the row, never assume it exists.
  return {
    effects: [
      { type: 'formlogic.updateResponse', formKey: 'Calls', upsert: true,
        match: { field: 'call_id', value: callId },
        answers: { call_id: callId, status: 'answered', answered_at: String(ev.occurredAt || '') } }
    ]
  };
}`;

const LOGIC_CALL_TURN = `function run(ctx) {
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.call.turn.final') return {};
  var d = ev.data || {};
  var key = 'seen-' + String(ev.idempotencyKey || ('turn:' + ev.correlationId + ':' + d.turn));
  if (ctx.storage && ctx.storage[key]) return {};
  var speaker = String(d.speaker || 'caller');
  if (speaker === 'bot') speaker = 'aokie';
  if (['caller', 'aokie', 'operator', 'system'].indexOf(speaker) < 0) speaker = 'system';
  return {
    effects: [
      { type: 'formlogic.submitResponse', formKey: 'Transcript Turns', answers: {
        call_id: String(d.callId || ev.correlationId || ''),
        turn_index: Number(d.turn || 0),
        speaker: speaker,
        text: String(d.text || ''),
        timestamp: String(ev.occurredAt || ''),
        source: 'stt'
      } },
      { type: 'storage.set', key: key, value: 1 }
    ]
  };
}`;

const LOGIC_CALL_ENDED = `function run(ctx) {
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.call.ended') return {};
  var d = ev.data || {};
  var outcome = String(d.outcome || d.status || '');
  var status = (outcome === 'missed' || outcome === 'failed' || outcome === 'rejected')
    ? outcome : 'completed';
  var callId = String(d.callId || ev.correlationId || '');
  // Lifecycle upsert (audit §8): a call whose incoming write failed or
  // arrived out of order still deserves a final record.
  return {
    effects: [
      { type: 'formlogic.updateResponse', formKey: 'Calls', upsert: true,
        match: { field: 'call_id', value: callId },
        answers: {
          call_id: callId,
          status: status,
          ended_at: String(ev.occurredAt || ''),
          duration_seconds: Number(d.durationSeconds || 0)
        } }
    ]
  };
}`;

const LOGIC_SMS_RECEIVED = `function run(ctx) {
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.sms.received') return {};
  var d = ev.data || {};
  var key = 'seen-' + String(ev.idempotencyKey || ('sms:' + ev.correlationId));
  if (ctx.storage && ctx.storage[key]) return {};
  var phone = String(d.from || d.phone || '');
  var thread = { phone: phone, last_message_at: String(ev.occurredAt || ''), status: 'active' };
  if (d.displayName) thread.display_name = String(d.displayName);
  return {
    effects: [
      { type: 'formlogic.updateResponse', formKey: 'SMS Threads', upsert: true,
        match: { field: 'phone', value: phone }, answers: thread },
      { type: 'formlogic.submitResponse', formKey: 'Messages', answers: {
        message_id: String(d.messageId || ev.idempotencyKey || ''),
        phone: phone,
        direction: 'inbound',
        body: String(d.body || ''),
        timestamp: String(ev.occurredAt || ''),
        status: 'received',
        approval_status: 'not_required'
      } },
      { type: 'storage.set', key: key, value: 1 },
      { type: 'ui.toast', level: 'info', message: 'New SMS' + (phone ? ' from ' + phone : '') }
    ]
  };
}`;

const LOGIC_HARDWARE_ERROR = `function run(ctx) {
  var ev = ctx.event || {};
  if (ev.name !== 'aokie.hardware.error') return {};
  var d = ev.data || {};
  var key = 'seen-' + String(ev.idempotencyKey || ('hw:' + ev.correlationId));
  if (ctx.storage && ctx.storage[key]) return {};
  var severity = String(d.severity || 'error');
  if (['info', 'warning', 'error'].indexOf(severity) < 0) severity = 'error';
  return {
    effects: [
      { type: 'formlogic.submitResponse', formKey: 'Device Setup', answers: {
        event_id: String(ev.idempotencyKey || ''),
        event_name: String(d.event || ev.name || ''),
        severity: severity,
        message: String(d.message || ''),
        dongle_id: String(d.dongleId || ''),
        occurred_at: String(ev.occurredAt || ''),
        payload_json: JSON.stringify(d)
      } },
      { type: 'storage.set', key: key, value: 1 },
      { type: 'ui.toast', level: 'error', message: 'Aokie hardware issue: ' + String(d.message || 'see Device Setup') }
    ]
  };
}`;

// ── Flow logic blocks (QuickJS expressions; completion value = node output) ────────────

const FLOW_MATCH_CUSTOMER = `(function () {
  var phone = String(inputs.callerPhone || inputs.from || '');
  var rows = (nodes.customers && nodes.customers.responses) || [];
  var hit = null;
  for (var i = 0; i < rows.length; i++) {
    var a = (rows[i] && rows[i].answers) || {};
    if (phone && String(a.phone || '') === phone) { hit = rows[i]; break; }
  }
  var name = hit ? String((hit.answers || {}).name || '') : '';
  return {
    found: !!hit,
    customerId: hit ? hit.id : null,
    name: name,
    greeting: hit
      ? 'Hi ' + name + ', thanks for calling back. Are you calling about your last booking or something new?'
      : 'Thanks for calling. How can I help you today?'
  };
})()`;

const FLOW_CALL_CONTEXT = `(function () {
  var callId = String(inputs.callId || '');
  var callRows = (nodes.calls && nodes.calls.responses) || [];
  var call = null;
  for (var i = 0; i < callRows.length; i++) {
    var a = (callRows[i] && callRows[i].answers) || {};
    if (callId && String(a.call_id || '') === callId) { call = callRows[i]; break; }
  }
  var turnRows = (nodes.turns && nodes.turns.responses) || [];
  var lines = [];
  for (var j = 0; j < turnRows.length; j++) {
    var t = (turnRows[j] && turnRows[j].answers) || {};
    if (callId && String(t.call_id || '') === callId) {
      lines.push(String(t.speaker || 'caller') + ': ' + String(t.text || ''));
    }
  }
  return { responseId: call ? call.id : null, transcript: lines.join('\\n') };
})()`;

const FLOW_SUMMARY_DECIDE = `(function () {
  var content = String(((nodes.summary || {}).content) || '').trim();
  var summary = content || 'Call ended (no transcript summary available).';
  return {
    responseId: (nodes.context || {}).responseId || null,
    hasCall: !!((nodes.context || {}).responseId),
    callUpdate: { summary: summary },
    followUpRequired: /FOLLOW-UP:\\s*yes/i.test(content),
    followUpTask: {
      summary: 'Follow up after call: ' + summary.slice(0, 140),
      status: 'open',
      priority: 'medium'
    }
  };
})()`;

const FLOW_SMS_DRAFT_BUILD = `(function () {
  var text = String(((nodes.draft || {}).content) || '').trim();
  return {
    hasDraft: !!text,
    draftMessage: {
      phone: String(inputs.from || ''),
      direction: 'outbound',
      body: text,
      status: 'draft',
      is_ai_reply: ['yes'],
      approval_status: 'pending_approval'
    }
  };
})()`;

const FLOW_MISSED_TASK = `(function () {
  var phone = String(inputs.callerPhone || inputs.from || '');
  return {
    task: {
      summary: 'Missed call' + (phone ? ' from ' + phone : '') + ' - call back',
      status: 'open',
      priority: 'high'
    }
  };
})()`;

// After-call actions context: this call's transcript (ordered by turn), the caller
// matched against Customers by phone (digits-only, last-9 suffix so +61… and 04…
// formats match), and today's date so the LLM can resolve "next Tuesday".
const FLOW_AFTER_CALL_CTX = `(function () {
  var callId = String(inputs.callId || '');
  var phone = String(inputs.callerPhone || inputs.from || '');
  var tail = phone.replace(/[^0-9]/g, '').slice(-9);
  var custRows = (nodes.customers && nodes.customers.responses) || [];
  var hit = null;
  for (var i = 0; i < custRows.length; i++) {
    var a = (custRows[i] && custRows[i].answers) || {};
    var d = String(a.phone || '').replace(/[^0-9]/g, '');
    if (tail && d.slice(-9) === tail) { hit = custRows[i]; break; }
  }
  var turnRows = (nodes.turns && nodes.turns.responses) || [];
  var turns = [];
  for (var j = 0; j < turnRows.length; j++) {
    var t = (turnRows[j] && turnRows[j].answers) || {};
    if (callId && String(t.call_id || '') === callId) {
      turns.push({ i: Number(t.turn_index || j), line: String(t.speaker || 'caller') + ': ' + String(t.text || '') });
    }
  }
  turns.sort(function (x, y) { return x.i - y.i; });
  var lines = [];
  for (var k = 0; k < turns.length; k++) lines.push(turns[k].line);
  var now = new Date();
  // LOCAL date for the ISO hint - toISOString() is UTC and reports yesterday
  // during the morning in UTC+ timezones, making 'tomorrow' resolve off by one.
  var isoLocal = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
  return {
    hasTranscript: lines.length > 0,
    transcript: lines.join('\\n'),
    phone: phone,
    customerId: hit ? hit.id : null,
    customerName: hit ? String((hit.answers || {}).name || '') : '',
    today: now.toDateString() + ' (' + isoLocal + ')'
  };
})()`;

// Turn the extractor's JSON into concrete record payloads. Defensive by design:
// fenced/prosy LLM output is trimmed to its outermost {...}; a malformed date or
// time never blocks — the appointment degrades to a follow-up task instead. The
// binding's outputActions perform the actual writes, gated on the has* flags.
const FLOW_AFTER_CALL_PLAN = `(function () {
  var raw = String(((nodes.extract || {}).content) || '').trim();
  var m = raw.match(/\\{[\\s\\S]*\\}/);
  var data = {};
  try { data = JSON.parse(m ? m[0] : raw) || {}; } catch (e) { data = {}; }
  var intent = String(data.intent || 'other').toLowerCase();
  var name = String(data.caller_name || '').trim();
  var service = String(data.service || '').trim();
  var dateStr = String(data.date || '').trim();
  var timeStr = String(data.time || '').trim();
  var summary = String(data.summary || '').trim() || 'Call ended - no summary available.';
  var callback = data.callback_requested === true;
  var validDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(dateStr);
  var validTime = /^\\d{2}:\\d{2}$/.test(timeStr);
  // PACK-002: an impossible or past date must never auto-book. Rebuild the
  // date from its parts (2026-02-31 rolls over and stops matching = not a
  // real calendar date) and compare LOCAL ISO strings for the past check
  // (same local-date recipe as the ctx node - toISOString would be UTC).
  var nowP = new Date();
  var todayIso = nowP.getFullYear() + '-' + ('0' + (nowP.getMonth() + 1)).slice(-2) + '-' + ('0' + nowP.getDate()).slice(-2);
  var realDate = false;
  if (validDate) {
    var dp = dateStr.split('-');
    var dObj = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]));
    realDate = dObj.getFullYear() === Number(dp[0]) && (dObj.getMonth() + 1) === Number(dp[1]) && dObj.getDate() === Number(dp[2]);
  }
  var pastDate = validDate && realDate && dateStr < todayIso;
  var dateProblem = !validDate ? 'the date was unclear on the call'
    : !realDate ? 'the extracted date (' + dateStr + ') is not a real calendar date'
    : pastDate ? 'the extracted date (' + dateStr + ') is in the past'
    : '';
  var ctx = nodes.ctx || {};
  var phone = String(ctx.phone || '');
  var knownId = ctx.customerId || null;
  var caller = name || String(ctx.customerName || '') || (phone ? 'Caller ' + phone : 'Unknown caller');
  var callId = String(inputs.callId || '');
  var wantsBooking = intent === 'appointment';
  // A named service is NOT required - 'an appointment tomorrow at 10' books
  // as service 'Appointment' (verified live: extractor gives service null).
  var hasAppointment = wantsBooking && dateProblem === '';
  var hasOrder = intent === 'order';
  var appointment = {
    service: service || 'Appointment',
    date: dateStr,
    status: 'requested',
    source: 'call',
    notes: 'Booked automatically from call ' + callId + '\\nCaller: ' + caller + (phone ? ' (' + phone + ')' : '') + '\\nSummary: ' + summary
  };
  if (validTime) appointment.time = timeStr;
  if (knownId) appointment.customer_link = knownId;
  var hasCustomerCreate = !knownId && !!name && !!phone && ctx.hasTranscript === true;
  // Audit AK-009/C-16: the receptionist tells callers 'someone will confirm
  // with you' - so EVERY booking intent leaves a human a confirmation task,
  // including the ones that DID create an appointment (status 'requested').
  var needTask = callback || intent === 'message' || wantsBooking;
  var taskSummary = hasAppointment
    ? 'Confirm appointment with ' + caller + (phone ? ' (' + phone + ')' : '') + ' - ' + (service || 'Appointment') + ' on ' + dateStr + (validTime ? ' at ' + timeStr : '') + ' (requested on the call, NOT yet confirmed to the caller)'
    : wantsBooking && !hasAppointment
    ? 'Confirm booking for ' + caller + (service ? ' (' + service + ')' : '') + ' - ' + (dateProblem || 'the date was unclear on the call') + ' (' + summary + ')'
    : intent === 'message'
      ? 'Message from ' + caller + ': ' + summary
      : 'Call back ' + caller + ': ' + summary;
  var order = {
    status: 'new',
    source: 'call',
    notes: 'Order taken from call ' + callId + '\\nCaller: ' + caller + (phone ? ' (' + phone + ')' : '') + '\\nDetails: ' + summary
  };
  if (knownId) order.customer_link = knownId;
  return {
    summaryLine: (hasAppointment ? 'Appointment requested. ' : '') + (hasOrder ? 'Order taken. ' : '') + (hasCustomerCreate ? 'New customer added. ' : '') + (needTask ? 'Follow-up created. ' : '') + summary,
    hasCustomerCreate: hasCustomerCreate,
    customer: {
      name: name || caller,
      phone: phone,
      preferred_service: service,
      status: 'active',
      notes: 'Added automatically from call ' + callId + '. ' + summary
    },
    hasAppointment: hasAppointment,
    appointment: appointment,
    hasOrder: hasOrder,
    order: order,
    hasTask: needTask,
    task: { summary: taskSummary.slice(0, 180), status: 'open', priority: (callback || wantsBooking) ? 'high' : 'medium' }
  };
})()`;

// Live conversation context: gather the transcript turns already stored for this
// call (prior turns) into a compact history string the LLM can condition on, so
// replies remember what was said earlier in the call. The current caller line is
// appended from the input in case its Transcript Turns row hasn't landed yet
// (the app-logic writer and this flow both fire on the same turn.final event).
// Kept in lockstep with the plugin's DEFAULT_AGENT_PERSONA (aokie.com radio.rs).
// The "only promise what actually happens" clause is audit AK-009/C-16: the
// agent once told a live caller it would text a confirmation — nothing sends
// SMS, so the receptionist must describe bookings as requests a person
// confirms, never claim to send anything itself.
const DEFAULT_PERSONA =
  'You are Aokie, a warm, efficient phone receptionist for a small business, speaking out loud on a live phone call. If the caller asks who you are or your name, say you are Aokie, the automated receptionist - never invent a different name for yourself. Reply with ONE short, natural spoken sentence — no lists, markdown, or emoji. Your job: greet the caller, find out their name and how you can help, capture the key details (what they need, and a callback number or time if relevant), and either book them in or take a message. Ask only ONE clear question at a time and keep the conversation moving. IMPORTANT - only promise what actually happens: you take booking REQUESTS and messages for the team to confirm, so say things like I have noted that down and someone will confirm with you - NEVER say you will send a text, SMS, email, or confirmation yourself, and never claim something is booked, sent, or done, because you cannot send messages and bookings are confirmed by a person afterwards.';

const FLOW_LIVE_CONTEXT = `(function () {
  var callId = String(inputs.callId || '');
  var latest = String(inputs.text || '').trim();

  // Receptionist Settings: the newest active config record (user-editable), or a
  // built-in default. This is what makes the receptionist configurable without
  // touching the flow graph — editing the record changes persona + model live.
  var cfgRows = (nodes.settings && nodes.settings.responses) || [];
  var cfg = {};
  for (var c = 0; c < cfgRows.length; c++) {
    var a = (cfgRows[c] && cfgRows[c].answers) || {};
    if (String(a.active || 'yes') !== 'no') { cfg = a; break; }
  }
  var persona = String(cfg.instructions || '').trim() || ${JSON.stringify(DEFAULT_PERSONA)};
  var business = String(cfg.business_name || '').trim();
  if (business) persona = 'You are the phone receptionist for ' + business + '.\\n' + persona;
  var model = String(cfg.model || '').trim();

  var turnRows = (nodes.turns && nodes.turns.responses) || [];
  var picked = [];
  for (var j = 0; j < turnRows.length; j++) {
    var t = (turnRows[j] && turnRows[j].answers) || {};
    if (callId && String(t.call_id || '') === callId) {
      picked.push({ idx: Number(t.turn_index || 0), speaker: String(t.speaker || 'caller'), text: String(t.text || '') });
    }
  }
  picked.sort(function (a, b) { return a.idx - b.idx; });
  var lines = [];
  var sawLatest = false;
  for (var k = 0; k < picked.length; k++) {
    var who = picked[k].speaker === 'aokie' || picked[k].speaker === 'bot' ? 'Receptionist' : 'Caller';
    lines.push(who + ': ' + picked[k].text);
    if (who === 'Caller' && picked[k].text.trim() === latest) sawLatest = true;
  }
  if (latest && !sawLatest) lines.push('Caller: ' + latest);
  return { transcript: lines.join('\\n'), latest: latest, persona: persona, model: model };
})()`;

// Agent config push: read the newest active Receptionist Settings record and shape
// it into what the Aokie plugin's in-plugin voice agent consumes (via settings.set,
// which live-reconfigures the running receptionist). This is what makes the AI
// receptionist configurable from FormLogic — edit the Settings form and the next
// call uses the new persona, greeting, voice and model, no flow-graph or code edits.
//
// aiReceptionist (reply_mode) is the one exception: the plugin only reads it once when
// its radio thread starts, so pushing it here persists to settings.json but does NOT
// change the call currently using the running radio — only the NEXT Aokie reconnect.
// Default-safe: 'agent' or absent/blank (incl. records saved before this field existed)
// → true, matching the deployed settings.json (aiReceptionist: true) today; only the
// exact value 'flow' turns it off.
const FLOW_AGENT_CONFIG = `(function () {
  // formlogic_list_responses returns the array directly on the desktop f2i runner
  // (nodes.settings) but {responses:[...]} in the TS executor — handle both.
  var node = nodes.settings;
  var rows = node && node.responses ? node.responses : (Array.isArray(node) ? node : []);
  var cfg = {};
  for (var i = 0; i < rows.length; i++) {
    var a = (rows[i] && rows[i].answers) || {};
    if (String(a.active || 'yes') !== 'no') { cfg = a; break; }
  }
  var persona = String(cfg.instructions || '').trim() || ${JSON.stringify(DEFAULT_PERSONA)};
  var business = String(cfg.business_name || '').trim();
  if (business) persona = 'You are the phone receptionist for ' + business + '.\\n' + persona;
  var greeting = String(cfg.greeting || '').trim();
  if (!greeting) {
    greeting = business
      ? 'Thank you for calling ' + business + '! How can I help you today?'
      : 'Thanks for calling! How can I help you today?';
  }
  var replyMode = String(cfg.reply_mode || '').trim();
  return {
    persona: persona,
    greeting: greeting,
    voice: String(cfg.voice || '').trim(),
    model: String(cfg.model || '').trim(),
    // AI plumbing, all flow-configurable: blank = the plugin's default behaviour
    // (LLM auto-detect :8080/:11434; built-in on-device STT/TTS engines).
    aiEndpoint: String(cfg.llm_endpoint || '').trim(),
    sttEndpoint: String(cfg.stt_endpoint || '').trim(),
    ttsEndpoint: String(cfg.tts_endpoint || '').trim(),
    aiReceptionist: replyMode !== 'flow'
  };
})()`;

// ── Pack data ───────────────────────────────────────────────────────────────

export const aokieReceptionistPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'aokie-receptionist',
    name: 'Aokie Receptionist',
    description:
      'An AI phone receptionist over FormLogic Desktop: raw call and SMS records land automatically from the Aokie Bluetooth phone bridge, starter FormLogic Flows look up callers, summarise calls and draft SMS replies, and a Live Call screen gives the operator answer / hang-up / speak controls. Runs headless in FormLogic Desktop; open this app anywhere to monitor it.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['receptionist', 'phone', 'aokie', 'desktop', 'flows'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Customers ──────────────────────────────────────────────────────
    {
      packFormId: 'customers',
      title: 'Customers',
      icon: 'Users',
      description: 'A customer the receptionist can recognise by phone number, with preferences and notes.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        { id: 'name', type: 'short_text', label: 'Name', required: true, properties: { placeholder: 'Full name' } },
        { id: 'phone', type: 'phone', label: 'Phone Number', required: true, properties: { placeholder: '+61 400 000 000' } },
        { id: 'email', type: 'email', label: 'Email', required: false, properties: { placeholder: 'you@example.com' } },
        { id: 'preferred_service', type: 'short_text', label: 'Preferred Service', required: false, properties: { placeholder: 'What they usually book or order' } },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: false,
          properties: {
            options: [
              { id: 'active', label: 'Active', value: 'active' },
              { id: 'vip', label: 'VIP', value: 'vip' },
              { id: 'inactive', label: 'Inactive', value: 'inactive' },
              { id: 'blocked', label: 'Blocked', value: 'blocked' },
            ],
          },
        },
        { id: 'last_call_at', type: 'date', label: 'Last Call', required: false, properties: {} },
        { id: 'notes', type: 'long_text', label: 'Notes', required: false, properties: { placeholder: 'Preferences, context for the receptionist…' } },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Customers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customers', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'VIP customers', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customers', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'vip' }] } },
            { id: 'c1', title: 'Status share', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:customers', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c2', title: 'New customers over time', layout: { x: 0, y: 1, w: 6, h: 2 }, kind: 'report', spec: { formId: '@pack:customers', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent customers', layout: { x: 0, y: 3, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:customers', titleField: 'name', subtitleField: 'phone', limit: 6 } },
          ],
        },
      },
    },

    // ── 2. Calls (raw event mirror; Live Call SDK screen) ─────────────────
    {
      packFormId: 'calls',
      title: 'Calls',
      icon: 'PhoneCall',
      description: 'One row per phone call. Created and updated automatically by the app logic from aokie.call.* events; flows add the summary.',
      // Caller PII ages out (audit PRIV-001); business records (customers,
      // appointments, orders) deliberately carry no TTL.
      settings: { ...defaultSettings, retentionDays: 90 },
      theme: { ...defaultTheme },
      fields: [
        { id: 'call_id', type: 'short_text', label: 'Call ID', required: false, properties: {} },
        // NOT required (audit §8): a private/withheld caller id is a valid call —
        // a required phone-format field silently loses the whole Calls row.
        { id: 'caller_phone', type: 'phone', label: 'Caller Phone', required: false, properties: { placeholder: '+61 400 000 000' } },
        { id: 'caller_name', type: 'short_text', label: 'Caller Name', required: false, properties: {} },
        { id: 'customer_link', type: 'linked_record', label: 'Customer', required: false, properties: { targetFormId: '@pack:customers' } },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'incoming', label: 'Incoming', value: 'incoming' },
              { id: 'answered', label: 'Answered', value: 'answered' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'rejected', label: 'Rejected', value: 'rejected' },
              { id: 'missed', label: 'Missed', value: 'missed' },
              { id: 'failed', label: 'Failed', value: 'failed' },
            ],
          },
        },
        { id: 'started_at', type: 'short_text', label: 'Started At', required: false, properties: {} },
        { id: 'answered_at', type: 'short_text', label: 'Answered At', required: false, properties: {} },
        { id: 'ended_at', type: 'short_text', label: 'Ended At', required: false, properties: {} },
        { id: 'duration_seconds', type: 'number', label: 'Duration (seconds)', required: false, properties: { min: 0 } },
        { id: 'summary', type: 'long_text', label: 'Summary', required: false, properties: { placeholder: 'Written by the Call Summary flow after the call ends.' } },
        {
          id: 'intent',
          type: 'dropdown',
          label: 'Intent',
          required: false,
          properties: {
            options: [
              { id: 'booking', label: 'Booking', value: 'booking' },
              { id: 'order', label: 'Order', value: 'order' },
              { id: 'question', label: 'Question', value: 'question' },
              { id: 'message', label: 'Message', value: 'message' },
              { id: 'other', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'sentiment',
          type: 'dropdown',
          label: 'Sentiment',
          required: false,
          properties: {
            options: [
              { id: 'positive', label: 'Positive', value: 'positive' },
              { id: 'neutral', label: 'Neutral', value: 'neutral' },
              { id: 'negative', label: 'Negative', value: 'negative' },
            ],
          },
        },
        {
          id: 'follow_up_required',
          type: 'checkbox',
          label: 'Follow-up',
          required: false,
          properties: { options: [{ id: 'yes', label: 'Follow-up required', value: 'yes' }] },
        },
      ],
      // The Calls section IS the Live Call operator screen (trusted host-rendered SDK
      // screen): current call card, live transcript, answer/hangup/speak, call history.
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'sdk',
        sdkScreen: { screenId: 'aokie-live-call', title: 'Live Call' },
      },
    },

    // ── 3. Transcript Turns ───────────────────────────────────────────────
    {
      packFormId: 'transcript-turns',
      title: 'Transcript Turns',
      icon: 'MessagesSquare',
      description: 'Final transcript turns streamed from the Aokie plugin during a call (one row per aokie.call.turn.final event).',
      settings: { ...defaultSettings, retentionDays: 90 },
      theme: { ...defaultTheme },
      fields: [
        { id: 'call_id', type: 'short_text', label: 'Call ID', required: false, properties: {} },
        { id: 'call_link', type: 'linked_record', label: 'Call', required: false, properties: { targetFormId: '@pack:calls' } },
        { id: 'turn_index', type: 'number', label: 'Turn', required: false, properties: { min: 0, step: 1 } },
        {
          id: 'speaker',
          type: 'dropdown',
          label: 'Speaker',
          required: true,
          properties: {
            options: [
              { id: 'caller', label: 'Caller', value: 'caller' },
              { id: 'aokie', label: 'Aokie', value: 'aokie' },
              { id: 'operator', label: 'Operator', value: 'operator' },
              { id: 'system', label: 'System', value: 'system' },
            ],
          },
        },
        { id: 'text', type: 'long_text', label: 'Text', required: true, properties: {} },
        { id: 'timestamp', type: 'short_text', label: 'Timestamp', required: false, properties: {} },
        { id: 'confidence', type: 'number', label: 'Confidence', required: false, properties: { min: 0, max: 1, step: 0.01 } },
        {
          id: 'source',
          type: 'dropdown',
          label: 'Source',
          required: false,
          properties: {
            options: [
              { id: 'stt', label: 'Speech-to-text', value: 'stt' },
              { id: 'operator', label: 'Operator', value: 'operator' },
              { id: 'flow', label: 'Flow', value: 'flow' },
            ],
          },
        },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          refreshInterval: 30, // live transcript activity without a manual reload
          widgets: [
            { id: 'k1', title: 'Turns logged', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:transcript-turns', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Calls covered', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:transcript-turns', viz: 'kpi', measure: { fn: 'countDistinct', field: 'call_id' } } },
            { id: 'c1', title: 'Speaker share', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:transcript-turns', viz: 'donut', groupBy: { field: 'speaker', bucket: 'none' }, measure: { fn: 'count' }, limit: 4 } },
            { id: 'c2', title: 'Turns over time', layout: { x: 0, y: 1, w: 6, h: 2 }, kind: 'report', spec: { formId: '@pack:transcript-turns', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'day' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 14 } },
            { id: 'l1', title: 'Latest turns', layout: { x: 0, y: 3, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:transcript-turns', titleField: 'text', subtitleField: 'speaker', limit: 6 } },
          ],
        },
      },
    },

    // ── 4. SMS Threads ────────────────────────────────────────────────────
    {
      packFormId: 'sms-threads',
      title: 'SMS Threads',
      icon: 'MessageCircle',
      description: 'One row per phone number the business texts with; upserted automatically when messages arrive.',
      settings: { ...defaultSettings, retentionDays: 90 },
      theme: { ...defaultTheme },
      fields: [
        { id: 'phone', type: 'phone', label: 'Phone Number', required: true, properties: { placeholder: '+61 400 000 000' } },
        { id: 'display_name', type: 'short_text', label: 'Display Name', required: false, properties: {} },
        { id: 'last_message_at', type: 'short_text', label: 'Last Message At', required: false, properties: {} },
        { id: 'unread_count', type: 'number', label: 'Unread', required: false, properties: { min: 0, step: 1 } },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: false,
          properties: {
            options: [
              { id: 'active', label: 'Active', value: 'active' },
              { id: 'archived', label: 'Archived', value: 'archived' },
              { id: 'blocked', label: 'Blocked', value: 'blocked' },
            ],
          },
        },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Threads', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-threads', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Active threads', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-threads', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'active' }] } },
            { id: 'c1', title: 'Thread status', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:sms-threads', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 4 } },
            { id: 'c2', title: 'New threads over time', layout: { x: 0, y: 1, w: 6, h: 2 }, kind: 'report', spec: { formId: '@pack:sms-threads', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent threads', layout: { x: 0, y: 3, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:sms-threads', titleField: 'phone', subtitleField: 'display_name', limit: 6 } },
          ],
        },
      },
    },

    // ── 5. SMS Messages ───────────────────────────────────────────────────
    {
      packFormId: 'sms-messages',
      title: 'SMS Messages',
      icon: 'MessageSquare',
      description: 'Every inbound and outbound SMS. Inbound rows land automatically; AI reply drafts wait for approval before sending.',
      settings: { ...defaultSettings, retentionDays: 90 },
      theme: { ...defaultTheme },
      fields: [
        { id: 'message_id', type: 'short_text', label: 'Message ID', required: false, properties: {} },
        { id: 'thread_link', type: 'linked_record', label: 'Thread', required: false, properties: { targetFormId: '@pack:sms-threads' } },
        { id: 'phone', type: 'phone', label: 'Phone Number', required: true, properties: { placeholder: '+61 400 000 000' } },
        {
          id: 'direction',
          type: 'dropdown',
          label: 'Direction',
          required: true,
          properties: {
            options: [
              { id: 'inbound', label: 'Inbound', value: 'inbound' },
              { id: 'outbound', label: 'Outbound', value: 'outbound' },
            ],
          },
        },
        { id: 'body', type: 'long_text', label: 'Message', required: true, properties: {} },
        { id: 'timestamp', type: 'short_text', label: 'Timestamp', required: false, properties: {} },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'received', label: 'Received', value: 'received' },
              { id: 'draft', label: 'Draft', value: 'draft' },
              { id: 'queued', label: 'Queued', value: 'queued' },
              { id: 'sent', label: 'Sent', value: 'sent' },
              { id: 'failed', label: 'Failed', value: 'failed' },
            ],
          },
        },
        {
          id: 'is_ai_reply',
          type: 'checkbox',
          label: 'AI Reply',
          required: false,
          properties: { options: [{ id: 'yes', label: 'Drafted by the AI receptionist', value: 'yes' }] },
        },
        {
          id: 'approval_status',
          type: 'dropdown',
          label: 'Approval',
          required: false,
          properties: {
            options: [
              { id: 'not_required', label: 'Not required', value: 'not_required' },
              { id: 'pending_approval', label: 'Pending approval', value: 'pending_approval' },
              { id: 'approved', label: 'Approved', value: 'approved' },
              { id: 'rejected', label: 'Rejected', value: 'rejected' },
            ],
          },
        },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Messages', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Inbound', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'direction', op: 'eq', value: 'inbound' }] } },
            { id: 'k3', title: 'Pending approvals', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'approval_status', op: 'eq', value: 'pending_approval' }] } },
            { id: 'k4', title: 'AI drafts', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'is_ai_reply', op: 'has', value: 'yes' }] } },
            { id: 'c1', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'c2', title: 'Messages over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'day' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 14 } },
            { id: 'l1', title: 'Latest messages', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:sms-messages', titleField: 'body', subtitleField: 'phone', limit: 6 } },
          ],
        },
      },
    },

    // ── 6. Appointments ───────────────────────────────────────────────────
    {
      packFormId: 'appointments',
      title: 'Appointments',
      icon: 'CalendarClock',
      description: 'Bookings taken over the phone, by SMS, manually, or created by a flow.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        { id: 'customer_link', type: 'linked_record', label: 'Customer', required: false, properties: { targetFormId: '@pack:customers' } },
        { id: 'service', type: 'short_text', label: 'Service', required: true, properties: { placeholder: 'What is being booked' } },
        { id: 'date', type: 'date', label: 'Date', required: true, properties: {} },
        { id: 'time', type: 'time', label: 'Time', required: false, properties: {} },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'requested', label: 'Requested', value: 'requested' },
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
              { id: 'no-show', label: 'No-show', value: 'no-show' },
            ],
          },
        },
        {
          id: 'source',
          type: 'dropdown',
          label: 'Source',
          required: false,
          properties: {
            options: [
              { id: 'call', label: 'Call', value: 'call' },
              { id: 'sms', label: 'SMS', value: 'sms' },
              { id: 'manual', label: 'Manual', value: 'manual' },
              { id: 'flow', label: 'Flow', value: 'flow' },
            ],
          },
        },
        { id: 'notes', type: 'long_text', label: 'Notes', required: false, properties: {} },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Appointments', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Confirmed', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'confirmed' }] } },
            { id: 'c1', title: 'By source', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'donut', groupBy: { field: 'source', bucket: 'none' }, measure: { fn: 'count' }, limit: 4 } },
            { id: 'c2', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 2 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'c3', title: 'Bookings by month', layout: { x: 0, y: 3, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'area', groupBy: { field: 'date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Upcoming & recent', layout: { x: 6, y: 3, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:appointments', titleField: 'service', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },

    // ── 7. Orders ─────────────────────────────────────────────────────────
    {
      packFormId: 'orders',
      title: 'Orders',
      icon: 'ShoppingBag',
      description: 'Orders captured by the receptionist over the phone or by SMS.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        { id: 'customer_link', type: 'linked_record', label: 'Customer', required: false, properties: { targetFormId: '@pack:customers' } },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'new', label: 'New', value: 'new' },
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'ready', label: 'Ready', value: 'ready' },
              { id: 'delivered', label: 'Delivered', value: 'delivered' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
        {
          id: 'source',
          type: 'dropdown',
          label: 'Source',
          required: false,
          properties: {
            options: [
              { id: 'call', label: 'Call', value: 'call' },
              { id: 'sms', label: 'SMS', value: 'sms' },
              { id: 'manual', label: 'Manual', value: 'manual' },
              { id: 'flow', label: 'Flow', value: 'flow' },
            ],
          },
        },
        { id: 'total', type: 'number', label: 'Total ($)', required: false, properties: { min: 0, placeholder: '0.00' } },
        { id: 'notes', type: 'long_text', label: 'Order Details', required: false, properties: {} },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Orders', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Revenue', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'kpi', measure: { fn: 'sum', field: 'total' } } },
            { id: 'k3', title: 'Avg order', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'kpi', measure: { fn: 'avg', field: 'total' } } },
            { id: 'k4', title: 'Open orders', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'new' }] } },
            { id: 'c1', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'c2', title: 'Revenue over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent orders', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:orders', titleField: 'notes', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },

    // ── 8. Follow-up Tasks ────────────────────────────────────────────────
    {
      packFormId: 'follow-up-tasks',
      title: 'Follow-up Tasks',
      icon: 'ClipboardCheck',
      description: 'Callbacks and follow-ups — created by the receptionist or automatically by the missed-call and call-summary flows.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        { id: 'customer_link', type: 'linked_record', label: 'Customer', required: false, properties: { targetFormId: '@pack:customers' } },
        { id: 'call_link', type: 'linked_record', label: 'Call', required: false, properties: { targetFormId: '@pack:calls' } },
        { id: 'summary', type: 'short_text', label: 'Task', required: true, properties: { placeholder: 'What needs to happen' } },
        { id: 'due_at', type: 'date', label: 'Due', required: false, properties: {} },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'open', label: 'Open', value: 'open' },
              { id: 'in_progress', label: 'In progress', value: 'in_progress' },
              { id: 'done', label: 'Done', value: 'done' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
        { id: 'assignee', type: 'short_text', label: 'Assignee', required: false, properties: {} },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: false,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'urgent', label: 'Urgent', value: 'urgent' },
            ],
          },
        },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Open tasks', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:follow-up-tasks', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'open' }] } },
            { id: 'k2', title: 'Done', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:follow-up-tasks', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'done' }] } },
            { id: 'c1', title: 'By priority', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:follow-up-tasks', viz: 'donut', groupBy: { field: 'priority', bucket: 'none' }, measure: { fn: 'count' }, limit: 4 } },
            { id: 'c2', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 2 }, kind: 'report', spec: { formId: '@pack:follow-up-tasks', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 5 } },
            { id: 'l1', title: 'Latest tasks', layout: { x: 0, y: 3, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:follow-up-tasks', titleField: 'summary', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },

    // ── 10. Hardware Events (Device Setup SDK screen) ─────────────────────
    {
      packFormId: 'hardware-events',
      title: 'Hardware Events',
      icon: 'Bluetooth',
      description: 'Dongle/phone bridge problems recorded automatically from aokie.hardware.error events. The section screen is the Device Setup console.',
      settings: { ...defaultSettings, retentionDays: 90 },
      theme: { ...defaultTheme },
      fields: [
        { id: 'event_id', type: 'short_text', label: 'Event ID', required: false, properties: {} },
        { id: 'event_name', type: 'short_text', label: 'Event', required: true, properties: { placeholder: 'aokie.hardware.error' } },
        {
          id: 'severity',
          type: 'dropdown',
          label: 'Severity',
          required: true,
          properties: {
            options: [
              { id: 'info', label: 'Info', value: 'info' },
              { id: 'warning', label: 'Warning', value: 'warning' },
              { id: 'error', label: 'Error', value: 'error' },
            ],
          },
        },
        { id: 'message', type: 'long_text', label: 'Message', required: true, properties: {} },
        { id: 'dongle_id', type: 'short_text', label: 'Dongle', required: false, properties: {} },
        { id: 'occurred_at', type: 'short_text', label: 'Occurred At', required: false, properties: {} },
        { id: 'payload_json', type: 'long_text', label: 'Raw Payload', required: false, properties: {} },
      ],
      // The Hardware Events section IS the Device Setup console (desktop pairing, dongle
      // table + driver install, phone status, recent hardware events).
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'sdk',
        sdkScreen: { screenId: 'aokie-pairing', title: 'Device Setup' },
      },
    },

    // ── 11. Receptionist Settings (user-editable AI config the live flow reads) ──
    // One record configures how the AI receptionist talks and which model it uses.
    // The `live-reply` flow reads the newest record at call time, so editing this
    // record changes the receptionist's behaviour live — no flow-graph editing.
    // Empty/absent → the flow falls back to a sensible built-in persona.
    {
      packFormId: 'receptionist-settings',
      title: 'Receptionist Settings',
      icon: 'Settings',
      description:
        'Configure your AI receptionist: its business name, how it should talk (persona/instructions) and which local model to use. The live call flow reads the newest record, so persona/greeting/voice/model changes take effect on the next caller turn. Reply mode is the one exception — see its own field description below.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        { id: 'business_name', type: 'short_text', label: 'Business name', required: false, properties: { placeholder: 'e.g. Bright Smile Dental' } },
        {
          id: 'instructions',
          type: 'long_text',
          label: 'How should the receptionist talk & behave?',
          required: false,
          properties: {
            placeholder:
              'e.g. Be warm and concise. Offer to book appointments Mon–Fri 9–5. If asked about prices, give the standard checkup price of $90 and offer to book.',
          },
        },
        {
          id: 'greeting',
          type: 'short_text',
          label: 'Greeting (spoken first, blank = friendly default)',
          required: false,
          properties: { placeholder: 'e.g. Thanks for calling Bright Smile Dental! How can I help?' },
        },
        { id: 'model', type: 'short_text', label: 'LLM model (blank = auto-detect)', required: false, properties: { placeholder: 'e.g. llama3.1:8b' } },
        {
          id: 'llm_endpoint',
          type: 'short_text',
          label: 'LLM endpoint (blank = auto-detect :8080 / :11434)',
          required: false,
          properties: { placeholder: 'e.g. http://127.0.0.1:8080/v1/chat/completions' },
        },
        {
          id: 'stt_endpoint',
          type: 'short_text',
          label: 'Speech-to-text endpoint (blank = built-in engine)',
          required: false,
          properties: { placeholder: 'e.g. http://127.0.0.1:17920/v1/audio/transcriptions (Aokie Voice service)' },
        },
        {
          id: 'tts_endpoint',
          type: 'short_text',
          label: 'Text-to-speech endpoint (blank = built-in engine)',
          required: false,
          properties: { placeholder: 'e.g. http://127.0.0.1:17920/v1/audio/speech (Aokie Voice service)' },
        },
        {
          id: 'voice',
          type: 'dropdown',
          label: 'Voice (blank = default)',
          required: false,
          properties: {
            options: [
              { id: 'default', label: 'Default', value: '' },
              { id: 'alba', label: 'Alba', value: 'alba' },
              { id: 'cosette', label: 'Cosette', value: 'cosette' },
              { id: 'eponine', label: 'Eponine', value: 'eponine' },
              { id: 'fantine', label: 'Fantine', value: 'fantine' },
              { id: 'javert', label: 'Javert', value: 'javert' },
              { id: 'jean', label: 'Jean', value: 'jean' },
              { id: 'marius', label: 'Marius', value: 'marius' },
            ],
          },
        },
        {
          id: 'reply_mode',
          type: 'dropdown',
          label: 'Reply mode',
          required: false,
          // Blank/unanswered (and any record from before this field existed) must resolve to
          // 'agent' — the live settings.json today has aiReceptionist: true, so a new field
          // must never silently flip an existing deployment into flow mode. 'agent' is the
          // first option for the same reason: it's the safe default this field always falls
          // back to. Unlike persona/greeting/voice/model below, this one is NOT live-reconfigurable
          // mid-call — see the description for why.
          description:
            "Which side answers the caller: the built-in in-plugin AI agent, or this app's \"Live Reply\" flow. Unlike the fields above, this only takes effect the next time Aokie reconnects — not on the current or next call — because the plugin reads it once when it starts, not per call.",
          properties: {
            options: [
              { id: 'agent', label: 'Built-in AI agent (fast, in-app)', value: 'agent' },
              { id: 'flow', label: 'Custom flow (edit the Live Reply flow)', value: 'flow' },
            ],
          },
        },
        { id: 'active', type: 'dropdown', label: 'Active', required: false, properties: { options: [{ id: 'yes', label: 'Yes', value: 'yes' }, { id: 'no', label: 'No', value: 'no' }] } },
      ],
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 't1', title: 'AI Receptionist configuration', layout: { x: 0, y: 0, w: 12, h: 1 }, kind: 'text', text: { body: 'Add or edit a record to change how your AI receptionist talks and which model it uses. The live call flow reads the newest record on each caller turn — no flow editing needed. Leave it empty to use the built-in default persona. Reply mode is the exception: it only applies on the next Aokie reconnect, not the current or next call.' } },
            { id: 'l1', title: 'Current settings', layout: { x: 0, y: 1, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:receptionist-settings', titleField: 'business_name', subtitleField: 'model', metaField: 'active', limit: 5 } },
          ],
        },
      },
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'aokie-receptionist',
      name: 'Aokie Receptionist',
      description:
        'AI phone receptionist over FormLogic Desktop: live call console, automatic call/SMS records, caller lookup, call summaries, SMS reply drafts and follow-up tasks — with the Aokie Bluetooth phone bridge doing the hardware work. Runs headless in FormLogic Desktop; open this app anywhere to monitor it.',
      settings: { icon: 'PhoneCall', appKind: 'staff' },
      theme: {
        primaryColor: '#0ea5e9',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        // Display names double as app-logic form keys — see the header note.
        { packFormId: 'calls', displayName: 'Calls', sortOrder: 1, isVisible: true },
        { packFormId: 'customers', displayName: 'Customers', sortOrder: 2, isVisible: true },
        { packFormId: 'sms-messages', displayName: 'Messages', sortOrder: 3, isVisible: true },
        { packFormId: 'sms-threads', displayName: 'SMS Threads', sortOrder: 4, isVisible: true },
        { packFormId: 'appointments', displayName: 'Appointments', sortOrder: 5, isVisible: true },
        { packFormId: 'orders', displayName: 'Orders', sortOrder: 6, isVisible: true },
        { packFormId: 'follow-up-tasks', displayName: 'Follow-ups', sortOrder: 7, isVisible: true },
        { packFormId: 'transcript-turns', displayName: 'Transcript Turns', sortOrder: 8, isVisible: true },
        { packFormId: 'hardware-events', displayName: 'Device Setup', sortOrder: 10, isVisible: true },
        { packFormId: 'receptionist-settings', displayName: 'Receptionist Settings', sortOrder: 11, isVisible: true },
      ],

      // App home: the receptionist's day at a glance.
      customScreen: {
        enabled: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          // Auto-refresh so calls appear on the home screen as they happen without
          // a manual reload (the widget dashboard re-runs its reports every 30s).
          refreshInterval: 30,
          widgets: [
            { id: 'k1', title: "Today's calls", layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: '__submitted_at', op: 'today' }] } },
            { id: 'k2', title: 'Missed calls', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'missed' }, { field: '__submitted_at', op: 'today' }] } },
            { id: 'k3', title: 'Bookings', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Orders', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k5', title: 'Avg call (sec)', layout: { x: 0, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'kpi', measure: { fn: 'avg', field: 'duration_seconds' } } },
            { id: 'k6', title: 'Open follow-ups', layout: { x: 3, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:follow-up-tasks', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'open' }] } },
            { id: 'k7', title: 'Pending SMS approvals', layout: { x: 6, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'approval_status', op: 'eq', value: 'pending_approval' }] } },
            { id: 'k8', title: 'Customers', layout: { x: 9, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customers', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'c1', title: 'Calls by status', layout: { x: 0, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'c2', title: 'Calls over time', layout: { x: 6, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'day' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 14 } },
            { id: 'l1', title: 'Recent calls', layout: { x: 0, y: 5, w: 4, h: 3 }, kind: 'list', list: { formId: '@pack:calls', titleField: 'caller_phone', subtitleField: 'status', limit: 6 } },
            { id: 'ac1', title: 'Recent activity', layout: { x: 4, y: 5, w: 4, h: 3 }, kind: 'activity' },
            { id: 'c3', title: 'Call intent share', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'donut', groupBy: { field: 'intent', bucket: 'none' }, measure: { fn: 'count' }, limit: 5 } },
            { id: 'act1', title: 'Quick actions', layout: { x: 0, y: 8, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
      },

      // Sandboxed QuickJS app logic: mirrors raw aokie.* events into records. Strict
      // permissions — every effect maps to a grant below; the bundle-level grants also
      // define the connector capability surface the SDK screens may use (connectorGrants).
      customLogic: {
        version: 1,
        runtime: 'quickjs',
        strictPermissions: true,
        permissions: [
          'formlogic.responses.write',
          'storage.local',
          'ui.toast',
          'flow.*.run',
          // Aokie connector surface used by the Live Call + Device Setup screens and any
          // future logic (AOKIE_PLUGIN_CONTRACT.md §2 MVP commands, minus settings.*).
          'connector.aokie.dongle.list',
          'connector.aokie.dongle.getPreferred',
          'connector.aokie.dongle.setPreferred',
          'connector.aokie.dongle.installDriver',
          'connector.aokie.dongle.diagnostics',
          'connector.aokie.phone.status',
          'connector.aokie.phone.startPairing',
          'connector.aokie.phone.stopPairing',
          'connector.aokie.phone.listPaired',
          'connector.aokie.call.current',
          'connector.aokie.call.answer',
          'connector.aokie.call.reject',
          'connector.aokie.call.hangup',
          'connector.aokie.call.operatorSpeak',
          'connector.aokie.sms.threads',
          'connector.aokie.sms.thread',
          'connector.aokie.sms.send',
        ],
        scripts: [
          { id: 'aokie-call-incoming', hook: 'onConnectorEvent', runtime: 'quickjs', description: 'Log a Calls row the moment a call rings (deduped on the event idempotencyKey).', source: LOGIC_CALL_INCOMING },
          { id: 'aokie-call-answered', hook: 'onConnectorEvent', runtime: 'quickjs', description: 'Mark the Calls row answered.', source: LOGIC_CALL_ANSWERED },
          { id: 'aokie-call-turn', hook: 'onConnectorEvent', runtime: 'quickjs', description: 'Store each final transcript turn.', source: LOGIC_CALL_TURN },
          { id: 'aokie-call-ended', hook: 'onConnectorEvent', runtime: 'quickjs', description: 'Finalise the Calls row (status / ended_at / duration).', source: LOGIC_CALL_ENDED },
          { id: 'aokie-sms-received', hook: 'onConnectorEvent', runtime: 'quickjs', description: 'Upsert the SMS thread and store the inbound message.', source: LOGIC_SMS_RECEIVED },
          { id: 'aokie-hardware-error', hook: 'onConnectorEvent', runtime: 'quickjs', description: 'Record hardware problems (single writer — the hardware-error-alert flow only toasts).', source: LOGIC_HARDWARE_ERROR },
        ],
      },

      // Roles (plan §12.5/§12.6). Owner is created implicitly with every permission.
      // NOTE: connector.aokie.* / flow.*.run entries are declarative capability intent —
      // the platform's role storage enforces form-level grants (unknown permission strings
      // are dropped on import); connector commands are gated by the app's customLogic
      // grant surface, and the SDK screens additionally disable operator actions for
      // roles that cannot write to the Calls form.
      roles: [
        {
          name: 'Receptionist',
          description: 'Front-desk staff: operate calls, send approved SMS, manage customers, bookings, orders and follow-ups.',
          permissions: [
            { packFormId: 'calls', permission: 'submit_responses' },
            { packFormId: 'calls', permission: 'view_all_responses' },
            { packFormId: 'calls', permission: 'edit_responses' },
            { packFormId: 'transcript-turns', permission: 'submit_responses' },
            { packFormId: 'transcript-turns', permission: 'view_all_responses' },
            { packFormId: 'sms-threads', permission: 'submit_responses' },
            { packFormId: 'sms-threads', permission: 'view_all_responses' },
            { packFormId: 'sms-threads', permission: 'edit_responses' },
            { packFormId: 'sms-messages', permission: 'submit_responses' },
            { packFormId: 'sms-messages', permission: 'view_all_responses' },
            { packFormId: 'sms-messages', permission: 'edit_responses' },
            { packFormId: 'customers', permission: 'submit_responses' },
            { packFormId: 'customers', permission: 'view_all_responses' },
            { packFormId: 'customers', permission: 'edit_responses' },
            { packFormId: 'appointments', permission: 'submit_responses' },
            { packFormId: 'appointments', permission: 'view_all_responses' },
            { packFormId: 'appointments', permission: 'edit_responses' },
            { packFormId: 'orders', permission: 'submit_responses' },
            { packFormId: 'orders', permission: 'view_all_responses' },
            { packFormId: 'orders', permission: 'edit_responses' },
            { packFormId: 'follow-up-tasks', permission: 'submit_responses' },
            { packFormId: 'follow-up-tasks', permission: 'view_all_responses' },
            { packFormId: 'follow-up-tasks', permission: 'edit_responses' },
            { packFormId: 'hardware-events', permission: 'submit_responses' },
            { packFormId: 'hardware-events', permission: 'view_all_responses' },
            // Declarative connector/flow intent (plan §12.6) — see the note above.
            { packFormId: null, permission: 'connector.aokie.call.current' },
            { packFormId: null, permission: 'connector.aokie.call.answer' },
            { packFormId: null, permission: 'connector.aokie.call.reject' },
            { packFormId: null, permission: 'connector.aokie.call.hangup' },
            { packFormId: null, permission: 'connector.aokie.call.operatorSpeak' },
            { packFormId: null, permission: 'connector.aokie.sms.threads' },
            { packFormId: null, permission: 'connector.aokie.sms.send' },
            { packFormId: null, permission: 'connector.aokie.phone.status' },
            { packFormId: null, permission: 'connector.aokie.dongle.list' },
            { packFormId: null, permission: 'flow.*.run' },
          ],
        },
        {
          name: 'Viewer',
          description: 'Managers/observers: dashboards, calls and messages read-only. No hardware control, no flow editing.',
          permissions: [
            { packFormId: 'calls', permission: 'view_all_responses' },
            { packFormId: 'transcript-turns', permission: 'view_all_responses' },
            { packFormId: 'sms-threads', permission: 'view_all_responses' },
            { packFormId: 'sms-messages', permission: 'view_all_responses' },
            { packFormId: 'customers', permission: 'view_all_responses' },
            { packFormId: 'appointments', permission: 'view_all_responses' },
            { packFormId: 'orders', permission: 'view_all_responses' },
            { packFormId: 'follow-up-tasks', permission: 'view_all_responses' },
            { packFormId: 'hardware-events', permission: 'view_all_responses' },
          ],
        },
      ],

      reports: [
        {
          reportId: 'calls-by-status',
          kind: 'chart' as const,
          name: 'Calls by status',
          description: 'Answered vs missed vs failed call counts.',
          spec: { formId: '@pack:calls', viz: 'bar' as const, groupBy: { field: 'status' }, measure: { fn: 'count' as const } },
        },
        {
          reportId: 'calls-over-time',
          kind: 'chart' as const,
          name: 'Calls over time',
          description: 'Daily call volume.',
          spec: { formId: '@pack:calls', viz: 'line' as const, groupBy: { field: '__submitted_at', bucket: 'day' as const }, measure: { fn: 'count' as const } },
        },
        {
          reportId: 'order-revenue',
          kind: 'chart' as const,
          name: 'Order revenue',
          description: 'Total revenue captured through receptionist orders.',
          spec: { formId: '@pack:orders', viz: 'kpi' as const, measure: { fn: 'sum' as const, field: 'total' } },
        },
        {
          reportId: 'follow-ups-by-status',
          kind: 'chart' as const,
          name: 'Follow-ups by status',
          description: 'Open vs done follow-up tasks.',
          spec: { formId: '@pack:follow-up-tasks', viz: 'bar' as const, groupBy: { field: 'status' }, measure: { fn: 'count' as const } },
        },
        {
          reportId: 'receptionist-overview',
          kind: 'document' as const,
          name: 'Receptionist overview',
          description: 'Call volume, outcomes and follow-up workload at a glance.',
          blocks: [
            {
              kind: 'text' as const,
              title: 'Receptionist performance overview',
              body: 'This report summarises phone traffic handled by the Aokie receptionist: call volume and outcomes, revenue captured through phone orders, and the follow-up workload the calls generate.',
            },
            { kind: 'report' as const, reportId: 'calls-by-status', caption: 'Call outcomes.' },
            { kind: 'report' as const, reportId: 'calls-over-time', caption: 'Daily call volume.' },
            { kind: 'report' as const, reportId: 'order-revenue', caption: 'Revenue captured on the phone.' },
            { kind: 'report' as const, reportId: 'follow-ups-by-status', caption: 'Follow-up workload.' },
          ],
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // STARTER FLOWS (docs/FORMLOGIC_FLOWS.md §6; v0 node set only). Node-level
  // '@pack:' form refs are remapped to real ids by PackService at import.
  // ────────────────────────────────────────────────────────────────────────
  flows: [
    {
      name: 'Incoming Caller Lookup',
      slug: 'incoming-caller-lookup',
      description:
        'Sync live-call decision (2-4s budget): match the caller phone against Customers and produce a personalised greeting. Falls back to the binding fallbackReply on timeout.',
      nodeCapabilities: ['formlogic.responses.read'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'callerPhone', example: '+61400000000' }, { name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }] } },
          { id: 'customers', type: 'formlogic_list_responses', data: { form: '@pack:customers', return: 'all', limit: 200 } },
          { id: 'match', type: 'logic_block', data: { expr: FLOW_MATCH_CUSTOMER } },
          {
            id: 'out',
            type: 'output',
            data: { value: { greeting: '$nodes.match.greeting', found: '$nodes.match.found', customerId: '$nodes.match.customerId', name: '$nodes.match.name' } },
          },
        ],
        edges: [
          { source: 'in', target: 'customers' },
          { source: 'customers', target: 'match' },
          { source: 'match', target: 'out' },
        ],
      },
    },
    {
      name: 'Configure Receptionist',
      slug: 'configure-receptionist',
      description:
        "On each incoming call, read the newest Receptionist Settings record and push its persona, greeting, voice, model and reply mode to the Aokie plugin (settings.set). persona/greeting/voice/model live-reconfigure the in-plugin AI receptionist immediately, so the next call uses the new config, no flow-graph or code changes. Reply mode (aiReceptionist — built-in agent vs. this app's own Live Reply flow) is different: the plugin only reads it once when its radio starts, so this push persists the choice but only takes effect on the NEXT Aokie reconnect, not the current or next call. Safe + idempotent (settings.set just updates config), so it never double-answers the caller.",
      nodeCapabilities: ['formlogic.responses.read', 'connector.aokie.settings.set'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }] } },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'cfg', type: 'logic_block', data: { expr: FLOW_AGENT_CONFIG } },
          {
            id: 'push',
            type: 'connector_request',
            data: {
              connectorId: 'aokie',
              command: 'settings.set',
              // Keys the plugin maps to the live voice agent (persona/greeting/voice/model
              // live-reconfigure immediately). aiReceptionist is the odd one out: the plugin
              // only reads it once at radio start, so this persists to settings.json but
              // only takes effect on the next Aokie reconnect (see the flow description).
              payload: {
                persona: '$nodes.cfg.persona',
                greeting: '$nodes.cfg.greeting',
                ttsVoice: '$nodes.cfg.voice',
                aiModel: '$nodes.cfg.model',
                // AI plumbing, also live-reconfigured: which LLM endpoint the agent
                // streams from, and which speech engines it uses (blank = LLM
                // auto-detect / built-in on-device STT+TTS; set the Aokie Voice
                // service URLs to share the desktop's speech service).
                aiEndpoint: '$nodes.cfg.aiEndpoint',
                sttEndpoint: '$nodes.cfg.sttEndpoint',
                ttsEndpoint: '$nodes.cfg.ttsEndpoint',
                aiReceptionist: '$nodes.cfg.aiReceptionist',
              },
            },
          },
          { id: 'out', type: 'output', data: { value: { persona: '$nodes.cfg.persona', greeting: '$nodes.cfg.greeting' } } },
        ],
        edges: [
          { source: 'in', target: 'settings' },
          { source: 'settings', target: 'cfg' },
          { source: 'cfg', target: 'push' },
          { source: 'push', target: 'out' },
        ],
      },
    },
    {
      name: 'Call Summary + Follow-up',
      slug: 'call-summary-follow-up',
      description:
        'Async after aokie.call.ended: summarise the transcript turns with the local LLM, write the summary onto the Calls row, and raise a Follow-up Task when the model asks for one. Raw status/duration updates are done by the app logic, not this flow.',
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read', 'formlogic.responses.write'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'callId', example: 'call_123' }] } },
          { id: 'calls', type: 'formlogic_list_responses', data: { form: '@pack:calls', return: 'all', limit: 200 } },
          { id: 'turns', type: 'formlogic_list_responses', data: { form: '@pack:transcript-turns', return: 'all', limit: 200 } },
          { id: 'context', type: 'logic_block', data: { expr: FLOW_CALL_CONTEXT } },
          {
            id: 'summary',
            type: 'llm_chat',
            data: {
              system: 'You are the note-taker for a small-business phone receptionist. Be brief and factual.',
              prompt:
                'Summarise this phone call in at most two sentences. Then on a new line write "FOLLOW-UP: yes" if the business must contact the caller again, otherwise "FOLLOW-UP: no".\n\nTranscript:\n{{nodes.context.transcript}}',
              maxTokens: 220,
            },
          },
          { id: 'decide', type: 'logic_block', data: { expr: FLOW_SUMMARY_DECIDE } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                responseId: '$nodes.decide.responseId',
                hasCall: '$nodes.decide.hasCall',
                callUpdate: '$nodes.decide.callUpdate',
                followUpRequired: '$nodes.decide.followUpRequired',
                followUpTask: '$nodes.decide.followUpTask',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'calls' },
          { source: 'calls', target: 'turns' },
          { source: 'turns', target: 'context' },
          { source: 'context', target: 'summary' },
          { source: 'summary', target: 'decide' },
          { source: 'decide', target: 'out' },
        ],
      },
    },
    {
      name: 'SMS Auto Reply Draft',
      slug: 'sms-auto-reply-draft',
      description:
        'Async after aokie.sms.received: draft a reply with the local LLM and store it as an outbound Messages row with approval_status pending_approval — a human approves before anything is sent.',
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.write'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'from', example: '+61400000000' }, { name: 'body', example: 'Are you open Sunday?' }] } },
          {
            id: 'draft',
            type: 'llm_chat',
            data: {
              system: 'You draft short, friendly SMS replies for a small-business receptionist. Reply with the SMS text only — no preamble.',
              prompt: 'Draft a reply to this SMS from {{inputs.from}}:\n\n{{inputs.body}}',
              maxTokens: 120,
            },
          },
          { id: 'build', type: 'logic_block', data: { expr: FLOW_SMS_DRAFT_BUILD } },
          { id: 'out', type: 'output', data: { value: { hasDraft: '$nodes.build.hasDraft', draftMessage: '$nodes.build.draftMessage' } } },
        ],
        edges: [
          { source: 'in', target: 'draft' },
          { source: 'draft', target: 'build' },
          { source: 'build', target: 'out' },
        ],
      },
    },
    {
      name: 'Live Reply',
      slug: 'live-reply',
      description:
        'The real-time receptionist: on each final caller turn, read the Receptionist Settings config + the call so far, ask the local LLM for one short spoken reply, and speak it back down the line with aokie_speak (call.operatorSpeak). The persona + model come from the newest Receptionist Settings record (editable, no flow-graph changes) with a built-in default. Gated to caller turns so Aokie never answers itself.',
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read', 'connector.aokie.call.operatorSpeak'],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'text', example: 'Are you open on Sunday?' }] },
          },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'turns', type: 'formlogic_list_responses', data: { form: '@pack:transcript-turns', return: 'all', limit: 200 } },
          { id: 'context', type: 'logic_block', data: { expr: FLOW_LIVE_CONTEXT } },
          {
            id: 'reply',
            type: 'llm_chat',
            data: {
              // Persona + model come from the Receptionist Settings record via the
              // context node (templated), so editing that record reconfigures the AI.
              // Empty model = auto-use whatever the desktop's running LLM has loaded.
              system: '{{nodes.context.persona}}',
              prompt: 'Call so far:\n{{nodes.context.transcript}}\n\nReply to the caller now:',
              model: '{{nodes.context.model}}',
              maxTokens: 90,
              temperature: 0.5,
              // Qwen3 (and other reasoning models) otherwise burn the token budget
              // on a hidden <think> block and return an empty reply — disable it for
              // fast, direct spoken answers. Ignored by models without a thinking mode.
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
            },
          },
          { id: 'say', type: 'aokie_speak', data: { textFrom: '$nodes.reply.content' } },
          { id: 'out', type: 'output', data: { value: { spoken: '$nodes.reply.content' } } },
        ],
        edges: [
          { source: 'in', target: 'settings' },
          { source: 'settings', target: 'turns' },
          { source: 'turns', target: 'context' },
          { source: 'context', target: 'reply' },
          { source: 'reply', target: 'say' },
          { source: 'say', target: 'out' },
        ],
      },
    },
    {
      name: 'After-Call Actions (Auto-Book)',
      slug: 'after-call-actions',
      description:
        'The automation that makes it a real receptionist: async after aokie.call.ended, read this call\'s transcript turns, have the local LLM extract structured intent (who called, what they want, and the agreed date/time), then — via the binding\'s guarded output actions — add the caller to Customers if new, create a requested Appointment when a slot was agreed, log an Order when they ordered, and raise a Follow-up Task when a human needs to confirm (unclear time, message taken, or callback asked). Malformed model output degrades to a follow-up task, never a bad record.',
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read'],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }, { name: 'callerPhone', example: '+61400000000' }] },
          },
          { id: 'customers', type: 'formlogic_list_responses', data: { form: '@pack:customers', return: 'all', limit: 200 } },
          { id: 'turns', type: 'formlogic_list_responses', data: { form: '@pack:transcript-turns', return: 'all', limit: 200 } },
          { id: 'ctx', type: 'logic_block', data: { expr: FLOW_AFTER_CALL_CTX } },
          {
            id: 'extract',
            type: 'llm_chat',
            data: {
              system:
                'You extract structured booking data from phone-call transcripts for a small business. Reply with ONLY one JSON object — no prose, no markdown fences.',
              prompt:
                'Today is {{nodes.ctx.today}}. The caller\'s phone number is {{nodes.ctx.phone}}.\n\nTranscript:\n{{nodes.ctx.transcript}}\n\nReturn ONLY this JSON:\n{"intent": "appointment" | "order" | "message" | "question" | "other", "caller_name": string or null, "service": string or null, "date": "YYYY-MM-DD" or null, "time": "HH:MM" or null, "summary": "one factual sentence", "callback_requested": true or false}\n\nRules: set date/time ONLY if the caller agreed to a specific slot; resolve relative dates ("tomorrow", "next Tuesday") from today\'s date; use 24-hour time; use null when unsure — never guess.',
              maxTokens: 300,
              temperature: 0,
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
            },
          },
          { id: 'plan', type: 'logic_block', data: { expr: FLOW_AFTER_CALL_PLAN } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                summaryLine: '$nodes.plan.summaryLine',
                hasCustomerCreate: '$nodes.plan.hasCustomerCreate',
                customer: '$nodes.plan.customer',
                hasAppointment: '$nodes.plan.hasAppointment',
                appointment: '$nodes.plan.appointment',
                hasOrder: '$nodes.plan.hasOrder',
                order: '$nodes.plan.order',
                hasTask: '$nodes.plan.hasTask',
                task: '$nodes.plan.task',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'customers' },
          { source: 'customers', target: 'turns' },
          { source: 'turns', target: 'ctx' },
          { source: 'ctx', target: 'extract' },
          { source: 'extract', target: 'plan' },
          { source: 'plan', target: 'out' },
        ],
      },
    },
    {
      name: 'Missed Call Follow-up',
      slug: 'missed-call-follow-up',
      description:
        'Async after a missed aokie.call.ended (binding condition gates on the missed outcome): raise a high-priority call-back task. Pure — no models, no hardware.',
      nodeCapabilities: ['formlogic.responses.write'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'callerPhone', example: '+61400000000' }, { name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }] } },
          { id: 'task', type: 'logic_block', data: { expr: FLOW_MISSED_TASK } },
          { id: 'out', type: 'output', data: { value: { task: '$nodes.task.task' } } },
        ],
        edges: [
          { source: 'in', target: 'task' },
          { source: 'task', target: 'out' },
        ],
      },
    },
    {
      name: 'Hardware Error Alert',
      slug: 'hardware-error-alert',
      description:
        'Background on aokie.hardware.error: surface a toast. The Hardware Events record itself is written by the app logic (single-writer rule) — this flow deliberately writes nothing.',
      nodeCapabilities: [],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'message', example: 'Bluetooth dongle disconnected' }, { name: 'dongleId', example: 'dongle_1' }] } },
          { id: 'note', type: 'template', data: { template: 'Aokie hardware issue: {{$inputs.message}}' } },
          { id: 'out', type: 'output' },
        ],
        edges: [
          { source: 'in', target: 'note' },
          { source: 'note', target: 'out' },
        ],
      },
    },
  ],

  flowBindings: [
    {
      flow: 'configure-receptionist',
      event: 'aokie.call.incoming',
      connectorId: 'aokie',
      // sync + first (sortOrder 0) so the plugin is reconfigured from the Settings
      // form before it plays the greeting / takes the first turn on this call.
      mode: 'sync',
      timeoutMs: 3000,
      inputMap: { callId: '$event.data.callId', from: '$event.data.from' },
      // Runs first (sortOrder 0), before anything has spoken to the caller yet - if it fails or
      // times out, the plugin keeps its last-known config (safe, log_and_continue), but per
      // docs/FORMLOGIC_FLOWS.md §"sync bindings... should use fallbackPolicy.fallbackReply" a
      // live-call sync binding still needs a spoken fallback so the caller is never left in
      // silence if the whole chain stalls here.
      fallbackPolicy: { onError: 'log_and_continue', fallbackReply: 'Thanks for calling! How can I help you today?' },
      sortOrder: 0,
    },
    {
      flow: 'incoming-caller-lookup',
      event: 'aokie.call.incoming',
      connectorId: 'aokie',
      mode: 'sync',
      timeoutMs: 3000,
      inputMap: {
        callId: '$event.data.callId',
        callerPhone: '$event.data.callerPhone',
        from: '$event.data.from',
      },
      outputActions: [
        { type: 'formlogic.toast', message: 'Caller greeting: {{result.greeting}}' },
      ],
      fallbackPolicy: {
        onError: 'log_and_continue',
        fallbackReply: 'Thanks for calling! One moment while I pull up your details.',
      },
      sortOrder: 1,
    },
    {
      flow: 'call-summary-follow-up',
      event: 'aokie.call.ended',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 60000,
      condition: { type: 'expression', expr: "event && event.data ? Number(event.data.durationSeconds || 0) > 5 : false" },
      inputMap: { callId: '$event.data.callId' },
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:calls', when: '$result.hasCall', responseId: '$result.responseId', answers: '$result.callUpdate' },
        { type: 'formlogic.submitResponse', form: '@pack:follow-up-tasks', when: '$result.followUpRequired', answers: '$result.followUpTask' },
      ],
      retryPolicy: { maxAttempts: 2, backoff: 'exponential' },
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 2,
    },
    {
      flow: 'sms-auto-reply-draft',
      event: 'aokie.sms.received',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 30000,
      inputMap: { from: '$event.data.from', body: '$event.data.body' },
      outputActions: [
        { type: 'formlogic.submitResponse', form: '@pack:sms-messages', when: '$result.hasDraft', answers: '$result.draftMessage' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 3,
    },
    {
      flow: 'after-call-actions',
      event: 'aokie.call.ended',
      connectorId: 'aokie',
      mode: 'async',
      // Generous budget: reads two forms + one local-LLM extraction. Async, so it
      // never delays the caller — it runs after hang-up.
      timeoutMs: 90000,
      // Only real conversations: skip missed calls and sub-5s pocket dials (the
      // missed-call binding below owns the missed path).
      condition: {
        type: 'expression',
        expr: "event && event.data ? (Number(event.data.durationSeconds || 0) > 5 && String(event.data.outcome || '') !== 'missed' && String(event.data.status || '') !== 'missed') : false",
      },
      inputMap: { callId: '$event.data.callId', from: '$event.data.from', callerPhone: '$event.data.callerPhone' },
      outputActions: [
        { type: 'formlogic.submitResponse', form: '@pack:customers', when: '$result.hasCustomerCreate', answers: '$result.customer' },
        { type: 'formlogic.submitResponse', form: '@pack:appointments', when: '$result.hasAppointment', answers: '$result.appointment' },
        { type: 'formlogic.submitResponse', form: '@pack:orders', when: '$result.hasOrder', answers: '$result.order' },
        { type: 'formlogic.submitResponse', form: '@pack:follow-up-tasks', when: '$result.hasTask', answers: '$result.task' },
        { type: 'formlogic.toast', message: 'After-call: {{result.summaryLine}}' },
      ],
      retryPolicy: { maxAttempts: 2, backoff: 'exponential' },
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 7,
    },
    {
      flow: 'missed-call-follow-up',
      event: 'aokie.call.ended',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 15000,
      condition: {
        type: 'expression',
        expr: "event && event.data ? (String(event.data.outcome || '') === 'missed' || String(event.data.status || '') === 'missed') : false",
      },
      inputMap: { callId: '$event.data.callId', callerPhone: '$event.data.callerPhone', from: '$event.data.from' },
      outputActions: [
        { type: 'formlogic.submitResponse', form: '@pack:follow-up-tasks', answers: '$result.task' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 4,
    },
    {
      flow: 'hardware-error-alert',
      event: 'aokie.hardware.error',
      connectorId: 'aokie',
      mode: 'background',
      timeoutMs: 10000,
      inputMap: { message: '$event.data.message', dongleId: '$event.data.dongleId' },
      outputActions: [
        { type: 'formlogic.toast', message: 'Aokie hardware issue: {{event.data.message}}' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 5,
    },
    {
      flow: 'live-reply',
      event: 'aokie.call.turn.final',
      connectorId: 'aokie',
      // async, not sync: an LLM reply can exceed the 2–4s live-call sync budget,
      // and the half-duplex plugin already mutes its mic while Aokie speaks the
      // reply, so turns stay ordered without blocking the event loop.
      mode: 'async',
      timeoutMs: 15000,
      // Only reply to the CALLER's turns — Aokie's own 'bot' turns also emit
      // turn.final (for the transcript), and answering them would loop forever.
      condition: {
        type: 'expression',
        expr: "event && event.data ? String(event.data.speaker || 'caller') === 'caller' : false",
      },
      inputMap: { callId: '$event.data.callId', text: '$event.data.text' },
      fallbackPolicy: {
        onError: 'log_and_continue',
        fallbackReply: "Sorry, I didn't catch that — could you say it again?",
      },
      sortOrder: 6,
    },
  ],
};
