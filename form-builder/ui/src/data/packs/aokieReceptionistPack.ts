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
//    Events rows — where "raw" means INBOUND event mirrors. Flows only ANNOTATE (call
//    summary) or CREATE derived records (follow-up tasks, SMS drafts, and the outbound
//    Messages rows for texts the SMS follow-up loop itself sends), so nothing is
//    double-written.
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
      { type: 'formlogic.submitResponse', formKey: 'calls', answers: {
        call_id: String(d.callId || ev.correlationId || ''),
        caller_phone: phone,
        // Never store a placeholder name: with instant auto-answer the
        // caller id (+CLIP) usually lands AFTER this event, and a literal
        // 'Unknown caller' string would shadow the phone number in every
        // display fallback once call.ended backfills it below.
        caller_name: String(d.callerName || ''),
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
      { type: 'formlogic.updateResponse', formKey: 'calls', upsert: true,
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
  // transcript-turns.text is required: a blank/whitespace final turn (a silence or
  // noise STT finalization, or an empty bot turn) would be REJECTED by the validator
  // and lost. Such a turn carries no content, so skip the write entirely (a no-op is
  // idempotent — a redelivery re-skips) rather than emitting a doomed submission.
  var text = String(d.text || '').trim();
  if (text === '') return {};
  var speaker = String(d.speaker || 'caller');
  if (speaker === 'bot') speaker = 'aokie';
  if (['caller', 'aokie', 'operator', 'system'].indexOf(speaker) < 0) speaker = 'system';
  return {
    effects: [
      { type: 'formlogic.submitResponse', formKey: 'transcript-turns', answers: {
        call_id: String(d.callId || ev.correlationId || ''),
        turn_index: Number(d.turn || 0),
        speaker: speaker,
        text: text,
        // The payload's at is the SPEECH-START stamp (bot turns are emitted
        // when the reply finishes; overlap caller turns are back-dated) —
        // sorting by it reads in true conversation order. Envelope time is
        // the fallback for older plugins.
        timestamp: String(d.at || ev.occurredAt || ''),
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
  var status = (outcome === 'missed' || outcome === 'failed' || outcome === 'rejected' || outcome === 'terminated_abuse' || outcome === 'no_answer')
    ? outcome : 'completed';
  var callId = String(d.callId || ev.correlationId || '');
  // Lifecycle upsert (audit §8): a call whose incoming write failed or
  // arrived out of order still deserves a final record.
  var answers = {
    call_id: callId,
    status: status,
    ended_at: String(ev.occurredAt || ''),
    duration_seconds: Number(d.durationSeconds || 0)
  };
  // Phase 2: outbound calls have no call.incoming, so this upsert CREATES
  // their row - record the direction (blank = inbound, the legacy default).
  if (String(d.direction || '') === 'outbound') answers.direction = 'outbound';
  // Caller-id backfill: with instant auto-answer the +CLIP number usually
  // arrives AFTER call.incoming was recorded (the row got caller_phone ''),
  // but call.ended carries it — write it now so the record and the
  // customer_link match stop reading as an unknown caller. Same phone-format
  // guard as the incoming script (a non-number must not fail the row).
  var phone = String(d.callerPhone || d.from || '');
  if (/^\\+?[0-9][0-9 ()-]{4,}$/.test(phone)) answers.caller_phone = phone;
  return {
    effects: [
      { type: 'formlogic.updateResponse', formKey: 'calls', upsert: true,
        match: { field: 'call_id', value: callId },
        answers: answers }
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
      { type: 'formlogic.updateResponse', formKey: 'sms-threads', upsert: true,
        match: { field: 'phone', value: phone }, answers: thread },
      { type: 'formlogic.submitResponse', formKey: 'sms-messages', answers: {
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
      { type: 'formlogic.submitResponse', formKey: 'hardware-events', answers: {
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
  // The customers node pre-filters with the phone_eq op (digits-only last-9
  // suffix, matched in the DATABASE - so '+61 400 000 000' matches
  // '+61400000000' and the lookup works at any customer count, no 200-row
  // scan). Whatever came back IS the match set; take the first.
  var custNode = nodes.customers || {};
  var hit = custNode.first || ((custNode.responses || [])[0] || null);
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
  // The FOLLOW-UP marker line is flow plumbing, not prose - strip it from
  // what lands on the Calls record (seen live: 'FOLLOW-UP: no' in the summary).
  var summary = content.replace(/\\n?\\s*FOLLOW-UP:\\s*(yes|no)\\s*$/i, '').trim()
    || 'Call ended (no transcript summary available).';
  return {
    responseId: (nodes.context || {}).responseId || null,
    hasCall: !!((nodes.context || {}).responseId),
    callUpdate: { summary: summary },
    followUpRequired: /FOLLOW-UP:\\s*yes/i.test(content),
    followUpTask: {
      summary: 'Follow up after call: ' + summary.slice(0, 450),
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

// Missed-call callback queue (Phase 2, call-policy spec): every missed call
// still raises the task; when the caller is DIALABLE the task is queued as an
// automatic callback and the binding fires call.dial with a records-composed
// opening line. The plugin's guardrails (outboundEnabled kill switch OFF by
// default, quiet hours, daily cap) refuse the dial typed — the task then just
// stays 'queued', visibly pending for a human. The callback call's own
// call.ended (direction outbound) transitions the task via the
// outbound-callback-result flow: reached / sms_sent / needs_human.
const FLOW_MISSED_TASK = `(function () {
  var phone = String(inputs.callerPhone || inputs.from || '');
  var realPhone = /^\\+?[0-9][0-9 ()-]{4,}$/.test(phone);
  var custNode = nodes.customers || {};
  var hit = custNode.first || ((custNode.responses || [])[0] || null);
  var ca = (hit && hit.answers) || {};
  var blocked = String(ca.status || '').toLowerCase() === 'blocked';
  var name = String(ca.name || '').trim();
  var first = name.split(/\\s+/)[0] || '';
  // One callback per number at a time: an open task already queued/dialed
  // for this phone means a second missed call must not mint a second dial.
  var tRows = (nodes.tasks && nodes.tasks.responses) || [];
  var pending = false;
  for (var t = 0; t < tRows.length; t++) {
    var ta = (tRows[t] && tRows[t].answers) || {};
    var st = String(ta.status || '');
    if ((st === 'open' || st === 'in_progress') && String(ta.callback_state || '') === 'queued') {
      pending = true;
      break;
    }
  }
  var sNode = nodes.settings;
  var sRows = sNode && sNode.responses ? sNode.responses : (Array.isArray(sNode) ? sNode : []);
  var cfg = {};
  for (var i = 0; i < sRows.length; i++) {
    var sa = (sRows[i] && sRows[i].answers) || {};
    if (String(sa.active || 'yes') !== 'no') { cfg = sa; break; }
  }
  var business = String(cfg.business_name || '').trim();
  // Outbound dial target rides defaultCountryCode like every other outbound
  // number (0412... -> +61412...); records keep the observed format.
  var cc = String(cfg.default_country_code || '').replace(/\\s+/g, '');
  if (/^\\d{1,3}$/.test(cc)) cc = '+' + cc;
  if (!/^\\+\\d{1,3}$/.test(cc)) cc = '';
  var digits = phone.replace(/[\\s()-]/g, '');
  var dialNumber = (cc && /^0\\d{5,14}$/.test(digits)) ? cc + digits.slice(1) : phone;
  // Callback only for numbers that CALLED US (by construction here), are
  // real (never withheld ids) and are not blocked customers.
  var wantsCallback = realPhone && !blocked && !pending;
  var opening = 'Hi' + (first ? ' ' + first : '') + "! It's " + (business || 'the receptionist')
    + ' - sorry, we just missed your call. How can I help you?';
  opening = opening.replace(/[^\\x20-\\x7E]/g, '').slice(0, 480);
  var purpose = 'You are RETURNING a missed call: ' + (name || 'this caller') + ' (' + phone + ') just rang '
    + (business || 'the business') + ' and nobody picked up, so you are calling them straight back. Ask how you can help and handle it as usual.';
  var task = {
    summary: 'Missed call' + (phone ? ' from ' + (name ? name + ' (' + phone + ')' : phone) : '')
      + (wantsCallback ? ' - calling back automatically' : ' - call back'),
    status: 'open',
    priority: 'high',
    phone: realPhone ? phone : '',
    call_id: String(inputs.callId || ''),
    callback_state: wantsCallback ? 'queued' : ''
  };
  if (hit) task.customer_link = hit.id;
  return {
    wantsCallback: wantsCallback,
    dial: { number: dialNumber, openingLine: opening, purpose: purpose },
    task: task
  };
})()`;

// Callback-result handler (Phase 2): the callback call's own aokie.call.ended
// (direction outbound) transitions the queued task. Reached -> done; not
// reached -> sms_capable customers get a records-composed apology text
// (replies ride the existing human-approval draft path - deliberately NOT the
// booking confirmation loop), landlines/blocked go straight to a human. A
// manual test dial with no queued task is a clean no-op.
const FLOW_CALLBACK_RESULT = `(function () {
  var phone = String(inputs.to || '');
  var outcome = String(inputs.outcome || '');
  var out = { hasTaskUpdate: false, hasSms: false, summaryLine: '' };
  var tRows = (nodes.tasks && nodes.tasks.responses) || [];
  var task = null;
  for (var t = 0; t < tRows.length; t++) {
    var ta = (tRows[t] && tRows[t].answers) || {};
    var st = String(ta.status || '');
    if ((st === 'open' || st === 'in_progress') && String(ta.callback_state || '') === 'queued') {
      task = tRows[t];
      break;
    }
  }
  if (!task) {
    out.summaryLine = 'Outbound call ended (' + (outcome || 'unknown') + ') - no pending callback for this number.';
    return out;
  }
  var taskA = task.answers || {};
  var oldSummary = String(taskA.summary || '').slice(0, 380);
  if (outcome === 'completed') {
    out.hasTaskUpdate = true;
    out.taskId = task.id;
    out.taskUpdate = { status: 'done', callback_state: 'reached', summary: (oldSummary + ' [called back - reached them]').slice(0, 500) };
    out.summaryLine = 'Callback reached the caller - task closed.';
    return out;
  }
  // no_answer / failed / anything else un-reached: apologise by text when the
  // customer can receive SMS; otherwise a human rings them.
  var custNode = nodes.customers || {};
  var hit = custNode.first || ((custNode.responses || [])[0] || null);
  var ca = (hit && hit.answers) || {};
  var smsCapable = String(ca.sms_capable || 'yes') !== 'no' && String(ca.status || '').toLowerCase() !== 'blocked';
  var realPhone = /^\\+?[0-9][0-9 ()-]{4,}$/.test(phone);
  var sNode = nodes.settings;
  var sRows = sNode && sNode.responses ? sNode.responses : (Array.isArray(sNode) ? sNode : []);
  var cfg = {};
  for (var i = 0; i < sRows.length; i++) {
    var sa = (sRows[i] && sRows[i].answers) || {};
    if (String(sa.active || 'yes') !== 'no') { cfg = sa; break; }
  }
  var business = String(cfg.business_name || '').trim();
  if (smsCapable && realPhone) {
    var first = String(ca.name || '').trim().split(/\\s+/)[0] || '';
    var body = 'Hi' + (first ? ' ' + first : '') + "! It's " + (business || 'the team')
      + ' - sorry we missed your call, and we could not reach you back just now. Reply here or call us again and we will help you out.';
    body = body.replace(/[^\\x20-\\x7E]/g, '').slice(0, 440);
    var cc = String(cfg.default_country_code || '').replace(/\\s+/g, '');
    if (/^\\d{1,3}$/.test(cc)) cc = '+' + cc;
    if (!/^\\+\\d{1,3}$/.test(cc)) cc = '';
    var digits = phone.replace(/[\\s()-]/g, '');
    out.hasSms = true;
    out.sms = { to: (cc && /^0\\d{5,14}$/.test(digits)) ? cc + digits.slice(1) : phone, body: body };
    out.smsMessage = {
      message_id: 'smscb_' + String(inputs.callId || task.id),
      phone: phone,
      direction: 'outbound',
      body: body,
      timestamp: new Date().toISOString(),
      status: 'queued',
      is_ai_reply: ['yes'],
      approval_status: 'not_required'
    };
    out.hasTaskUpdate = true;
    out.taskId = task.id;
    out.taskUpdate = { callback_state: 'sms_sent', priority: 'high', summary: (oldSummary + ' [callback not answered - apology text sent]').slice(0, 500) };
    out.summaryLine = 'Callback not answered - apology SMS sent, task stays open.';
    return out;
  }
  out.hasTaskUpdate = true;
  out.taskId = task.id;
  out.taskUpdate = { callback_state: 'needs_human', priority: 'urgent', summary: (oldSummary + ' [callback not answered - cannot text this customer, please ring them]').slice(0, 500) };
  out.summaryLine = 'Callback not answered and the customer cannot receive SMS - flagged for a human.';
  return out;
})()`;

// After-call actions context: this call's transcript (ordered by turn), the caller
// matched against Customers by phone (digits-only, last-9 suffix so +61… and 04…
// formats match), and today's date so the LLM can resolve "next Tuesday".
const FLOW_AFTER_CALL_CTX = `(function () {
  var callId = String(inputs.callId || '');
  var phone = String(inputs.callerPhone || inputs.from || '');
  // The customers node pre-filters with the phone_eq op (digits-only last-9
  // suffix, matched in the DATABASE) - no client-side scan, no 200-row cap.
  var custNode = nodes.customers || {};
  var hit = custNode.first || ((custNode.responses || [])[0] || null);
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
  // Schema validation (audit AOK-FLOW-002): the extractor's output is MODEL
  // text - every field is whitelisted/coerced/capped before it can drive an
  // action. An unknown intent degrades to 'other' (no automatic action).
  var intent = String(data.intent || 'other').toLowerCase();
  if (['appointment', 'order', 'message', 'other'].indexOf(intent) === -1) intent = 'other';
  var name = String(data.caller_name || '').trim().slice(0, 200);
  var service = String(data.service || '').trim().slice(0, 200);
  var summary = (String(data.summary || '').trim() || 'Call ended - no summary available.').slice(0, 800);
  var callback = data.callback_requested === true;
  var nowP = new Date();
  var todayIso = nowP.getFullYear() + '-' + ('0' + (nowP.getMonth() + 1)).slice(-2) + '-' + ('0' + nowP.getDate()).slice(-2);
  // Time must be a REAL clock time, not just HH:MM-shaped (audit sweep):
  // bound hours <= 23 and minutes <= 59; an out-of-range time is simply
  // dropped (the appointment books date-only).
  function timeOk(t) {
    return /^\\d{2}:\\d{2}$/.test(t) && Number(t.slice(0, 2)) <= 23 && Number(t.slice(3, 5)) <= 59;
  }
  // PACK-002: an impossible or past date must never auto-book. Rebuild the
  // date from its parts (2026-02-31 rolls over and stops matching = not a
  // real calendar date) and compare LOCAL ISO strings for the past check
  // (same local-date recipe as the ctx node - toISOString would be UTC).
  function dateProblemOf(d) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return 'the date was unclear on the call';
    var dp = d.split('-');
    var dObj = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]));
    var real = dObj.getFullYear() === Number(dp[0]) && (dObj.getMonth() + 1) === Number(dp[1]) && dObj.getDate() === Number(dp[2]);
    if (!real) return 'the extracted date (' + d + ') is not a real calendar date';
    if (d < todayIso) return 'the extracted date (' + d + ') is in the past';
    return '';
  }
  // MULTI-BOOKING (live report 2026-07-13): one call can agree on SEVERAL
  // appointments - the extractor returns an appointments ARRAY (each entry
  // validated independently, capped at 3); the legacy singular date/time
  // fields remain the fallback for older model output shapes.
  var rawList = Array.isArray(data.appointments) ? data.appointments : [];
  if (!rawList.length && (data.date || data.time)) {
    rawList = [{ service: data.service, date: data.date, time: data.time }];
  }
  var entries = [];
  var dateProblem = rawList.length ? '' : 'the date was unclear on the call';
  for (var e0 = 0; e0 < rawList.length && entries.length < 3; e0++) {
    var it = rawList[e0] || {};
    var eService = String(it.service || '').trim().slice(0, 200);
    var eDate = String(it.date || '').trim().slice(0, 10);
    var eTime = String(it.time || '').trim().slice(0, 5);
    var dv = dateProblemOf(eDate);
    if (dv) { if (!dateProblem) dateProblem = dv; continue; }
    if (!timeOk(eTime)) eTime = '';
    var dup = false;
    for (var d0 = 0; d0 < entries.length; d0++) {
      if (entries[d0].date === eDate && entries[d0].time === eTime) dup = true;
    }
    if (!dup) entries.push({ service: eService, date: eDate, time: eTime });
  }
  entries.sort(function (x, y) { var xa = x.date + ' ' + x.time, yb = y.date + ' ' + y.time; return xa < yb ? -1 : xa > yb ? 1 : 0; });
  var ctx = nodes.ctx || {};
  var phone = String(ctx.phone || '');
  var knownId = ctx.customerId || null;
  var caller = name || String(ctx.customerName || '') || (phone ? 'Caller ' + phone : 'Unknown caller');
  var callId = String(inputs.callId || '');
  var wantsBooking = intent === 'appointment';
  // Existing appointments for this phone (appts node, phone_eq): (a) a
  // caller RE-CONFIRMING a booking already on record must not duplicate it;
  // (b) still-pending ('requested') bookings from earlier calls FOLD into
  // this loop's confirmation text, so the caller gets ONE thread covering
  // everything instead of parallel competing loops.
  var exRows = ((nodes.appts && nodes.appts.responses) || []);
  var existingUpcoming = [];
  for (var x0 = 0; x0 < exRows.length; x0++) {
    var xa = (exRows[x0] && exRows[x0].answers) || {};
    var xst = String(xa.status || '');
    var xd = String(xa.date || '');
    if ((xst === 'requested' || xst === 'confirmed') && /^\\d{4}-\\d{2}-\\d{2}$/.test(xd) && xd >= todayIso) {
      existingUpcoming.push({ date: xd, time: String(xa.time || ''), service: String(xa.service || 'Appointment'), status: xst });
    }
  }
  var created = [];
  var skippedExisting = 0;
  for (var c0 = 0; c0 < entries.length; c0++) {
    var en = entries[c0];
    var dupEx = false;
    for (var c1 = 0; c1 < existingUpcoming.length; c1++) {
      var ex0 = existingUpcoming[c1];
      if (ex0.date === en.date && (ex0.time === en.time || ex0.time === '' || en.time === '')) dupEx = true;
    }
    if (dupEx) { skippedExisting++; } else { created.push(en); }
  }
  // A named service is NOT required - 'an appointment tomorrow at 10' books
  // as service 'Appointment' (verified live: extractor gives service null).
  var hasAppointment = wantsBooking && created.length > 0;
  var hasOrder = intent === 'order';
  var appointments = [];
  for (var a0 = 0; a0 < created.length; a0++) {
    var ap = {
      service: created[a0].service || service || 'Appointment',
      date: created[a0].date,
      status: 'requested',
      source: 'call',
      notes: 'Booked automatically from call ' + callId + '\\nCaller: ' + caller + (phone ? ' (' + phone + ')' : '') + '\\nSummary: ' + summary
    };
    if (created[a0].time) ap.time = created[a0].time;
    if (knownId) ap.customer_link = knownId;
    appointments.push(ap);
  }
  // Back-compat locals for the single-booking composition below.
  var dateStr = created.length ? created[0].date : '';
  var timeStr = created.length ? created[0].time : '';
  var validTime = timeStr !== '';
  var appointment = appointments[0] || {};
  // Only auto-create a Customer with a PHONE-FORMAT number (audit sweep): a
  // withheld/sentinel caller id ('unknown', 'Private') would otherwise be
  // written to the required phone-format field and silently reject the whole
  // Customers row on the async binding - same guard LOGIC_CALL_INCOMING uses.
  var custPhone = /^\\+?[0-9][0-9 ()-]{4,}$/.test(phone) ? phone : '';
  // SMS-loop correlation handles: the conversation flow finds these appointments
  // by the texter's number (phone_eq) and ties them to its task via call_id.
  for (var p0 = 0; p0 < appointments.length; p0++) {
    appointments[p0].phone = custPhone;
    appointments[p0].call_id = callId;
  }
  var hasCustomerCreate = !knownId && !!name && !!custPhone && ctx.hasTranscript === true;
  // Audit AK-009/C-16: the receptionist tells callers 'someone will confirm
  // with you' - so EVERY booking intent leaves a human a confirmation task,
  // including the ones that DID create an appointment (status 'requested').
  var needTask = callback || intent === 'message' || wantsBooking;
  var createdLabels = [];
  for (var l0 = 0; l0 < created.length; l0++) {
    createdLabels.push((created[l0].service || service || 'Appointment') + ' on ' + created[l0].date + (created[l0].time ? ' at ' + created[l0].time : ''));
  }
  var taskSummary = hasAppointment
    ? 'Confirm appointment' + (created.length > 1 ? 's' : '') + ' with ' + caller + (phone ? ' (' + phone + ')' : '') + ' - ' + createdLabels.join(' and ') + ' (requested on the call, NOT yet confirmed to the caller)'
    : wantsBooking && skippedExisting > 0
    ? 'Confirm booking with ' + caller + (phone ? ' (' + phone + ')' : '') + ' - the caller re-confirmed existing booking(s) already on record (' + summary + ')'
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
  // Calls-row enrichment: fills the Intent / Sentiment / Follow-up fields on the
  // existing Calls record (found by call_id), which power the home 'Call intent
  // share' donut and the Follow-up column. The Intent FIELD uses 'booking' where
  // the extractor/action logic say 'appointment', and keeps 'question' (which the
  // action logic above collapses to 'other').
  var displayIntent = String(data.intent || 'other').toLowerCase();
  if (displayIntent === 'appointment') displayIntent = 'booking';
  if (['booking', 'order', 'question', 'message', 'other'].indexOf(displayIntent) === -1) displayIntent = 'other';
  var sentiment = String(data.sentiment || 'neutral').toLowerCase();
  if (['positive', 'neutral', 'negative'].indexOf(sentiment) === -1) sentiment = 'neutral';
  var callRows = (nodes.calls && nodes.calls.responses) || [];
  var callResponseId = callRows.length ? callRows[0].id : null;
  // SMS follow-up kickoff (feature 2026-07-13): a booking-intent task whose caller
  // number is real gets an automated confirmation text; the sms-followup-conversation
  // flow then drives the reply loop (confirm / reschedule / cancel) and closes the
  // task. sms_state 'active' is the switch that flow — and the draft flow's
  // deference gate — looks for; non-booking tasks stay human-only.
  var pendingRequested = 0;
  for (var pr = 0; pr < existingUpcoming.length; pr++) {
    if (existingUpcoming[pr].status === 'requested') pendingRequested++;
  }
  // No SMS when the call only RE-confirmed bookings that are already
  // confirmed on record - there is nothing left to ask the caller.
  var wantsSmsBase = wantsBooking && custPhone !== ''
    && !(created.length === 0 && skippedExisting > 0 && pendingRequested === 0);
  // PHASE 0.5 sms_capable gate (call-policy spec): a customer marked 'No'
  // for SMS (landline) - or blocked - never gets an automated text; the
  // follow-up task tells a human to CALL instead. Unknown numbers (no
  // Customer record) default to texting, exactly as before.
  var custRow0 = ((nodes.customers || {}).first) || (((nodes.customers || {}).responses || [])[0] || null);
  var custA0 = (custRow0 && custRow0.answers) || {};
  var smsCapable = String(custA0.sms_capable || 'yes') !== 'no';
  var custBlocked = String(custA0.status || '').toLowerCase() === 'blocked';
  var wantsSms = wantsSmsBase && smsCapable && !custBlocked;
  var smsSuppressed = wantsSmsBase && !wantsSms;
  if (smsSuppressed && !custBlocked) {
    taskSummary = taskSummary + ' [customer cannot receive SMS - call them to confirm]';
  }
  var task = { summary: taskSummary.slice(0, 500), status: 'open', priority: (callback || wantsBooking) ? 'high' : 'medium', phone: custPhone, call_id: callId };
  if (knownId) task.customer_link = knownId;
  if (callResponseId) task.call_link = callResponseId;
  if (wantsSms) { task.sms_state = 'active'; task.sms_exchanges = 1; }
  // ONE SMS loop per phone (live report 2026-07-13): a second call while an
  // earlier confirmation loop was still active used to leave TWO competing
  // active tasks for the same number - a YES was ambiguous. The new loop
  // ABSORBS the old one: the prior active task closes as superseded (its
  // pending appointments fold into this kickoff's listing below), so the
  // customer always has exactly one confirmation thread.
  var tRows = ((nodes.tasks && nodes.tasks.responses) || []);
  var prior = null;
  for (var pt = 0; pt < tRows.length; pt++) {
    var pa = (tRows[pt] && tRows[pt].answers) || {};
    var pst = String(pa.status || '');
    if ((pst === 'open' || pst === 'in_progress') && String(pa.sms_state || '') === 'active') { prior = tRows[pt]; break; }
  }
  var hasPriorTaskClose = wantsSms && !!prior;
  var priorTaskUpdate = null;
  if (hasPriorTaskClose) {
    var priorSummary = String(((prior.answers || {}).summary) || '').slice(0, 420);
    priorTaskUpdate = {
      status: 'done',
      sms_state: 'done',
      summary: priorSummary + ' [superseded by the follow-up from call ' + callId + ']'
    };
  }
  // Business name for the kickoff text (same active-first read as the other flows;
  // tolerant of both list-node shapes).
  var sNode = nodes.settings;
  var sRows = sNode && sNode.responses ? sNode.responses : (Array.isArray(sNode) ? sNode : []);
  var cfgRow = {};
  for (var sI = 0; sI < sRows.length; sI++) {
    var sA = (sRows[sI] && sRows[sI].answers) || {};
    if (String(sA.active || 'yes') !== 'no') { cfgRow = sA; break; }
  }
  var business = String(cfgRow.business_name || '').trim();
  // PHASE 0.5 defaultCountryCode: texts to a locally-typed number (leading
  // 0) go out as +CC…; a bare '61' is tolerated as '+61'; anything else
  // disables normalization. RECOGNITION stays digits-only last-9-suffix
  // everywhere, so records never need re-keying.
  var cc = String(cfgRow.default_country_code || '').replace(/\\s+/g, '');
  if (/^\\d{1,3}$/.test(cc)) cc = '+' + cc;
  if (!/^\\+\\d{1,3}$/.test(cc)) cc = '';
  function normOutbound(p) {
    var t = String(p || '').replace(/[\\s()-]/g, '');
    return (cc && /^0\\d{5,14}$/.test(t)) ? cc + t.slice(1) : String(p || '');
  }
  function humanWhen(dStr, tStr) {
    var label = dStr;
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(dStr)) {
      var hp = dStr.split('-');
      label = new Date(Number(hp[0]), Number(hp[1]) - 1, Number(hp[2])).toDateString();
    }
    if (/^\\d{2}:\\d{2}$/.test(tStr)) {
      var hh = Number(tStr.slice(0, 2));
      var h12 = hh % 12 === 0 ? 12 : hh % 12;
      label += ' at ' + h12 + (tStr.slice(3, 5) === '00' ? '' : ':' + tStr.slice(3, 5)) + ' ' + (hh >= 12 ? 'PM' : 'AM');
    }
    return label;
  }
  var first = (name || String(ctx.customerName || '')).split(/\\s+/)[0] || '';
  var intro = 'Hi' + (first ? ' ' + first : '') + "! It's " + (business || 'the team') + ' - following up on your call.';
  // The kickoff lists EVERY booking this loop now covers: the ones created
  // from this call PLUS any still-unconfirmed ('requested') bookings already
  // on record for this number - one thread, one YES, everything confirmed.
  var loopBookings = [];
  for (var lb = 0; lb < created.length; lb++) loopBookings.push({ service: created[lb].service || service || 'an appointment', date: created[lb].date, time: created[lb].time });
  for (var le = 0; le < existingUpcoming.length; le++) {
    var exl = existingUpcoming[le];
    if (exl.status !== 'requested') continue;
    var dupL = false;
    for (var lc = 0; lc < loopBookings.length; lc++) {
      if (loopBookings[lc].date === exl.date && (loopBookings[lc].time === exl.time || loopBookings[lc].time === '' || exl.time === '')) dupL = true;
    }
    if (!dupL) loopBookings.push({ service: exl.service || 'an appointment', date: exl.date, time: exl.time });
  }
  loopBookings.sort(function (x, y) { var xa = x.date + ' ' + x.time, yb = y.date + ' ' + y.time; return xa < yb ? -1 : xa > yb ? 1 : 0; });
  if (loopBookings.length > 4) loopBookings = loopBookings.slice(0, 4);
  var bookingLabels = [];
  for (var bl = 0; bl < loopBookings.length; bl++) {
    bookingLabels.push(loopBookings[bl].service + ' on ' + humanWhen(loopBookings[bl].date, loopBookings[bl].time));
  }
  var confirmWord = loopBookings.length === 2 ? ' both' : loopBookings.length > 2 ? ' them all' : '';
  var kickBody = bookingLabels.length
    ? intro + ' We have your booking request' + (bookingLabels.length > 1 ? 's' : '') + ': ' + bookingLabels.join(' and ') + '. Reply YES to confirm' + confirmWord + ', or text a better day and time. Reply STOP to opt out.'
    : intro + ' We could not pin down a day and time' + (service ? ' for your ' + service : '') + '. What suits you best? Text back a day and time and we will pencil you in. Reply STOP to opt out.';
  // Plain ASCII only: keeps the SMS in the single-charset GSM envelope and clear
  // of bMessage encoding surprises. 440 chars ≈ 3 segments.
  kickBody = kickBody.replace(/[^\\x20-\\x7E]/g, '').slice(0, 440);
  return {
    summaryLine: (hasAppointment ? (created.length > 1 ? created.length + ' appointments requested. ' : 'Appointment requested. ') : '') + (skippedExisting > 0 ? skippedExisting + ' already on record (not duplicated). ' : '') + (hasOrder ? 'Order taken. ' : '') + (hasCustomerCreate ? 'New customer added. ' : '') + (needTask ? 'Follow-up created. ' : '') + (hasPriorTaskClose ? 'Earlier SMS loop folded in. ' : '') + (wantsSms ? 'Confirmation SMS sent. ' : '') + (smsSuppressed ? (custBlocked ? 'SMS skipped (customer is blocked). ' : 'SMS skipped (customer cannot receive SMS) - call to confirm. ') : '') + summary,
    hasCall: !!callResponseId,
    callResponseId: callResponseId,
    callUpdate: { intent: displayIntent, sentiment: sentiment, follow_up_required: needTask ? ['yes'] : [] },
    hasCustomerCreate: hasCustomerCreate,
    customer: {
      name: name || caller,
      phone: custPhone,
      preferred_service: service,
      status: 'active',
      notes: 'Added automatically from call ' + callId + '. ' + summary
    },
    hasAppointment: hasAppointment,
    appointment: appointment,
    hasAppointment2: appointments.length > 1,
    appointment2: appointments[1] || {},
    hasAppointment3: appointments.length > 2,
    appointment3: appointments[2] || {},
    hasOrder: hasOrder,
    order: order,
    hasTask: needTask,
    task: task,
    hasPriorTaskClose: hasPriorTaskClose,
    priorTaskId: prior ? prior.id : null,
    priorTaskUpdate: priorTaskUpdate,
    hasKickoffSms: wantsSms,
    kickoffSms: { to: normOutbound(custPhone), body: kickBody },
    kickoffMessage: {
      message_id: 'smskick_' + callId,
      phone: custPhone,
      direction: 'outbound',
      body: kickBody,
      timestamp: new Date().toISOString(),
      status: 'queued',
      is_ai_reply: ['yes'],
      approval_status: 'not_required'
    }
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
export const DEFAULT_PERSONA =
  'You are Aokie, a warm, efficient phone receptionist for a small business, speaking out loud on a live phone call. If the caller asks who you are or your name, say you are Aokie, the automated receptionist - never invent a different name for yourself. Reply with ONE short, natural spoken sentence — no lists, markdown, or emoji. Your job: greet the caller, find out their name and how you can help, capture the key details (what they need, and a callback number or time if relevant), and either book them in or take a message. Ask only ONE clear question at a time and keep the conversation moving. IMPORTANT - only promise what actually happens: you take booking REQUESTS and messages for the team to confirm, so say things like I have noted that down and someone will confirm with you - NEVER say you will send a text, SMS, email, or confirmation yourself, and never claim something is booked, sent, or done, because you cannot send messages and bookings are confirmed by a person afterwards.';

// BUSINESS INFO grounding (live report 2026-07-13: the agent invented an
// entire menu — "shark steaks, barnacle burgers, spicy krill sauce").
// Identical JS appended to the persona in EVERY flow that composes it
// (live-reply context, configure-receptionist, personalize-caller) — and
// mirrored in the console's buildAgentPayload. They must never disagree.
const BUSINESS_INFO_BLOCK_JS = `
  var info = String(cfg.business_info || '').trim().slice(0, 4000);
  if (info) {
    persona += '\\n\\nBUSINESS INFO - the ONLY facts about the business you may share:\\n' + info
      + '\\nAnswer questions about services, menu, prices, opening hours or policies ONLY from this info, quoting details exactly. If something is not covered here, say you will have the team confirm it - NEVER invent business details.';
  }`;

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
${BUSINESS_INFO_BLOCK_JS}
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
${BUSINESS_INFO_BLOCK_JS}
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

// Personalize the LIVE call the moment the caller's number is known
// (aokie.call.caller_id — with instant auto-answer, caller ID lands ~1s after
// pickup, usually BEFORE the greeting plays). Match the number against
// Customers (same digits-only last-9 rule as the after-call context) and push
// a by-name greeting plus a KNOWN-CALLER persona block, so the AI greets
// "Hi Lance!" and never re-asks for a name/number it already has. A no-match
// returns the SAME base config the Configure Receptionist flow pushed —
// re-sending it is an idempotent no-op, never a downgrade.
// Mid-call LIVE LOOKUP (2026-07-14, guide P1-16): the Aokie plugin invokes
// this over flow.run while the agent is ON THE CALL - it replied
// [[LOOKUP: question]] and answers from this digest. READ-ONLY and
// deterministic: no LLM here, no writes; the agent's own model does the
// reasoning. Privacy: whole-calendar entries expose TIMES ONLY; the caller's
// OWN bookings (phone match) may carry service + status.
const FLOW_LOOKUP_WINDOW = `(function () {
  var nowD = new Date();
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  return { todayIso: iso(nowD), horizonIso: iso(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + 90)) };
})()`;
const FLOW_BUSINESS_LOOKUP = `(function () {
  var out = { digest: '' };
  var nowD = new Date();
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  var todayIso = iso(nowD);
  var horizonIso = iso(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + 90));
  var DAYFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONFULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dayLabel(dStr) {
    var hp = dStr.split('-');
    var dt = new Date(Number(hp[0]), Number(hp[1]) - 1, Number(hp[2]));
    var label = DAYFULL[dt.getDay()] + ' ' + dt.getDate() + ' ' + MONFULL[dt.getMonth()];
    if (dt.getFullYear() !== nowD.getFullYear()) label += ' ' + dt.getFullYear();
    return label;
  }
  function t12(tStr) {
    if (!/^\\d{2}:\\d{2}$/.test(tStr)) return '';
    var th = Number(tStr.slice(0, 2));
    var h = th % 12 === 0 ? 12 : th % 12;
    return h + (tStr.slice(3, 5) === '00' ? '' : ':' + tStr.slice(3, 5)) + ' ' + (th >= 12 ? 'PM' : 'AM');
  }
  var digitsIn = String(inputs.from || '').replace(/\\D+/g, '').slice(-9);
  // Phase 3 manager line: the flag comes from the PLUGIN's caller-id match
  // against managerNumbers (its flow.run input) - never from caller words.
  // Managers get customer NAMES on occupancy slots; everyone else keeps the
  // privacy lock (times only). The customers node only runs on manager
  // calls (condition-gated), so nodes.customers is null otherwise.
  var manager = inputs.manager === true;
  var nameBy = {};
  if (manager) {
    var cRows = (nodes.customers && nodes.customers.responses) || [];
    for (var nc = 0; nc < cRows.length; nc++) {
      var cAns = (cRows[nc] && cRows[nc].answers) || {};
      var cd = String(cAns.phone || '').replace(/\\D+/g, '').slice(-9);
      if (cd.length >= 6 && cAns.name) nameBy[cd] = String(cAns.name);
    }
  }
  var nmDT = {};
  var occUN = {};
  function slot(d0, tRaw0) {
    var l0 = t12(tRaw0);
    if (!manager) return l0;
    var nm0 = nmDT[d0 + '|' + tRaw0];
    return nm0 ? l0 + ' (' + nm0 + ')' : l0;
  }
  var rows = (nodes.appts && nodes.appts.responses) || [];
  var occT = {};
  var occU = {};
  var mineBy = {};
  var mineSay = {};
  var mineU = {};
  var mine = [];
  for (var i = 0; i < rows.length; i++) {
    var a = (rows[i] && rows[i].answers) || {};
    var st = String(a.status || '');
    var d = String(a.date || '');
    if (!(st === 'requested' || st === 'confirmed')) continue;
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d) || d < todayIso || d > horizonIso) continue;
    var tRaw = String(a.time || '');
    var tv = t12(tRaw);
    if (tv) { if (!occT[d]) occT[d] = []; occT[d].push(tRaw); }
    else { occU[d] = (occU[d] || 0) + 1; }
    var rowDigits = String(a.phone || '').replace(/\\D+/g, '').slice(-9);
    if (manager && !(digitsIn.length >= 6 && rowDigits === digitsIn)) {
      var nm = nameBy[rowDigits] || '';
      if (nm) {
        if (tv) { var kdt = d + '|' + tRaw; nmDT[kdt] = nmDT[kdt] ? nmDT[kdt] + ' & ' + nm : nm; }
        else { if (!occUN[d]) occUN[d] = []; occUN[d].push(nm); }
      }
    }
    if (digitsIn.length >= 6 && rowDigits === digitsIn) {
      var desc = String(a.service || 'appointment') + ' (' + st + (tv ? ', ' + tv : ', time not yet set') + ')';
      if (!mineBy[d]) { mineBy[d] = []; mineSay[d] = []; }
      mineBy[d].push(desc);
      mineSay[d].push('a ' + st + ' ' + String(a.service || 'appointment') + (tv ? ' at ' + tv : ' with no time set yet'));
      if (!tv) mineU[d] = (mineU[d] || 0) + 1;
      mine.push(dayLabel(d) + ': ' + desc);
    }
  }
  var seenD = {};
  var dates = [];
  for (var od in occT) { if (!seenD[od]) { seenD[od] = 1; dates.push(od); } }
  for (var ou in occU) { if (!seenD[ou]) { seenD[ou] = 1; dates.push(ou); } }
  dates.sort();
  var lines = [];
  for (var j = 0; j < dates.length; j++) {
    var dj = dates[j];
    var parts = [];
    if (occT[dj]) {
      var ts = occT[dj].slice().sort();
      var lab = [];
      for (var k = 0; k < ts.length; k++) lab.push(slot(dj, ts[k]));
      parts.push('booked at ' + lab.join(', '));
    }
    if (occU[dj]) parts.push(occU[dj] + ' booking' + (occU[dj] > 1 ? 's' : '') + ' with no set time' + (manager && occUN[dj] ? ' (' + occUN[dj].join(', ') + ')' : ''));
    lines.push('- ' + dayLabel(dj) + ': ' + parts.join(' + '));
  }
  // DIRECT ANSWERS: parse dates out of the QUESTION and answer them
  // deterministically - the 9B agent proved it cannot be trusted to do
  // window/absence inference over the digest (live call 1defd805: window
  // through October, August 1 listed, and it still said 'not in our current
  // booking window'). The agent is told to write YYYY-MM-DD dates into the
  // lookup question; prose 'August 1' / '1st of August' is caught as backup.
  var q = String(inputs.question || '');
  var want = [];
  var seenW = {};
  function addDate(dIso) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(dIso) || seenW[dIso]) return;
    seenW[dIso] = 1;
    if (want.length < 3) want.push(dIso);
  }
  function proseDate(dayNum, monName) {
    var mi = -1;
    for (var pm = 0; pm < 12; pm++) { if (MONFULL[pm].toLowerCase() === String(monName).toLowerCase()) { mi = pm; break; } }
    if (mi < 0 || dayNum < 1 || dayNum > 31) return;
    var cand = new Date(nowD.getFullYear(), mi, dayNum);
    if (iso(cand) < todayIso) cand = new Date(nowD.getFullYear() + 1, mi, dayNum);
    if (cand.getDate() !== dayNum) return;
    addDate(iso(cand));
  }
  function parseDates(s) {
    var isoHits = s.match(/\\d{4}-\\d{2}-\\d{2}/g) || [];
    for (var qi = 0; qi < isoHits.length; qi++) addDate(isoHits[qi]);
    var reDM = /(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)/gi;
    var reMD = /(January|February|March|April|May|June|July|August|September|October|November|December)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?/gi;
    var mm;
    while ((mm = reDM.exec(s))) proseDate(Number(mm[1]), mm[2]);
    while ((mm = reMD.exec(s))) proseDate(Number(mm[2]), mm[1]);
  }
  // Ranges FIRST ('2026-08-11 to 2026-08-17', live call 372836dc: the model
  // asked a week range for 'the second week of August' and the old
  // single-date path answered only the ENDPOINTS - Tuesday and Monday -
  // never the Wednesday the caller asked about). Endpoints are consumed so
  // the single-date path does not double-answer them.
  var ranges = [];
  var reRange = /(\\d{4}-\\d{2}-\\d{2})\\s*(?:to|through|until|-)\\s*(\\d{4}-\\d{2}-\\d{2})/gi;
  var rm;
  while ((rm = reRange.exec(q))) {
    if (rm[1] <= rm[2]) { ranges.push([rm[1], rm[2]]); seenW[rm[1]] = 1; seenW[rm[2]] = 1; }
  }
  parseDates(q);
  // STT writes spoken ordinals as WORDS ('twenty first of August', call
  // c01b7dcf) - normalize them to digits and parse again. Compound forms
  // sort longest-first so 'twenty first' never collapses to 'first'.
  var ORD = { 'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5, 'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10, 'eleventh': 11, 'twelfth': 12, 'thirteenth': 13, 'fourteenth': 14, 'fifteenth': 15, 'sixteenth': 16, 'seventeenth': 17, 'eighteenth': 18, 'nineteenth': 19, 'twentieth': 20, 'twenty first': 21, 'twenty-first': 21, 'twenty second': 22, 'twenty-second': 22, 'twenty third': 23, 'twenty-third': 23, 'twenty fourth': 24, 'twenty-fourth': 24, 'twenty fifth': 25, 'twenty-fifth': 25, 'twenty sixth': 26, 'twenty-sixth': 26, 'twenty seventh': 27, 'twenty-seventh': 27, 'twenty eighth': 28, 'twenty-eighth': 28, 'twenty ninth': 29, 'twenty-ninth': 29, 'thirtieth': 30, 'thirty first': 31, 'thirty-first': 31 };
  var ordKeys = [];
  for (var okk in ORD) ordKeys.push(okk);
  ordKeys.sort(function (a, b) { return b.length - a.length; });
  var qNorm = ' ' + q.toLowerCase() + ' ';
  for (var oi = 0; oi < ordKeys.length; oi++) {
    qNorm = qNorm.split(ordKeys[oi]).join(String(ORD[ordKeys[oi]]));
  }
  parseDates(qNorm);
  var direct = [];
  var say = [];
  var offer = false;
  for (var rg = 0; rg < ranges.length && rg < 2; rg++) {
    var rs = ranges[rg][0];
    var re = ranges[rg][1];
    var hp0 = rs.split('-');
    var cur = new Date(Number(hp0[0]), Number(hp0[1]) - 1, Number(hp0[2]));
    var takenR = [];
    var ownIn = [];
    var openCount = 0;
    var total = 0;
    var clipped = false;
    var pastAny = false;
    while (total < 14) {
      var di = iso(cur);
      if (di > re) break;
      if (di > horizonIso) { clipped = true; break; }
      if (di < todayIso) { pastAny = true; }
      else {
        total++;
        var parts2 = [];
        if (occT[di]) { var st2 = occT[di].slice().sort(); var lb = []; for (var k2 = 0; k2 < st2.length; k2++) lb.push(slot(di, st2[k2])); parts2.push('booked at ' + lb.join(', ')); }
        var oU = (occU[di] || 0) - (mineU[di] || 0);
        if (oU > 0) parts2.push(oU + ' booking' + (oU > 1 ? 's' : '') + ' with no set time');
        if (mineBy[di]) ownIn.push('on ' + dayLabel(di) + ' you already have ' + mineSay[di].join(' and '));
        if (parts2.length) takenR.push(dayLabel(di) + ': ' + parts2.join(' + '));
        else openCount++;
      }
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    if (total === 0 && !clipped) continue;
    var bits2 = [];
    if (takenR.length) bits2.push('days with bookings - ' + takenR.join('; '));
    if (ownIn.length) bits2.push('this caller ALREADY has bookings in this span (' + ownIn.join('; ') + ') - mention it');
    bits2.push(openCount > 0 ? openCount + ' day' + (openCount > 1 ? 's' : '') + ' fully open - offer to put a booking request in' : 'no fully open days in this span');
    if (clipped) bits2.push('dates past ' + dayLabel(horizonIso) + ' are beyond the calendar view - the team will confirm those');
    direct.push('DIRECT ANSWER for ' + dayLabel(rs) + ' through ' + dayLabel(re) + ': ' + bits2.join('. ') + '.');
    var sBits = [];
    if (ownIn.length) sBits.push('Just so you know, ' + ownIn.join(' and ') + '.');
    if (takenR.length === 0 && openCount > 0) {
      sBits.push('Everything from ' + dayLabel(rs) + ' through ' + dayLabel(re) + ' looks open.');
    } else {
      if (takenR.length) sBits.push('In that span - ' + takenR.join('; ') + '.');
      if (openCount > 0) sBits.push('The other ' + (openCount > 1 ? openCount + ' days look' : 'day looks') + ' open.');
    }
    if (pastAny && openCount === 0 && takenR.length === 0 && !clipped) sBits.push('Those dates have already passed.');
    if (clipped) sBits.push('Some of those dates are past our calendar view - the team will confirm those.');
    if (sBits.length) say.push(sBits.join(' '));
    if (openCount > 0) offer = true;
  }
  for (var w = 0; w < want.length; w++) {
    var wd = want[w];
    var wl = dayLabel(wd);
    if (wd > horizonIso) {
      direct.push('DIRECT ANSWER for ' + wl + ': beyond the calendar view (which ends ' + dayLabel(horizonIso) + ') - say the team will confirm availability for that date.');
      say.push('For ' + wl + ', our calendar view does not reach that far yet, so I will have the team confirm that one.');
      continue;
    }
    if (wd < todayIso) {
      direct.push('DIRECT ANSWER for ' + wl + ': that date has already passed.');
      say.push(wl + ' has already passed.');
      continue;
    }
    var bits = [];
    var segs = [];
    if (mineBy[wd]) {
      bits.push('this caller ALREADY has: ' + mineBy[wd].join('; ') + ' - mention it');
      say.push('For ' + wl + ', you already have ' + mineSay[wd].join(' and ') + ' on record.');
    }
    var takenLab = [];
    if (occT[wd]) { var srt = occT[wd].slice().sort(); for (var ot = 0; ot < srt.length; ot++) takenLab.push(slot(wd, srt[ot])); }
    var othersU = (occU[wd] || 0) - (mineU[wd] || 0);
    if (takenLab.length) { bits.push('times already booked that day: ' + takenLab.join(', ')); segs.push('times already taken are ' + takenLab.join(', ')); }
    if (othersU > 0) { bits.push(othersU + ' other booking' + (othersU > 1 ? 's' : '') + ' with no set time that day'); }
    if (!takenLab.length && !othersU && !mineBy[wd]) {
      bits.push('NO bookings that day at all - it looks OPEN; offer to put a booking request in');
      say.push(wl + ' looks open.');
      offer = true;
    } else {
      bits.push('other times look open - offer to put a booking request in');
      if (segs.length) say.push('For ' + wl + ', ' + segs.join('; ') + ' - other times look open.');
      else if (!mineBy[wd]) say.push(wl + ' looks mostly open.');
      offer = true;
    }
    direct.push('DIRECT ANSWER for ' + wl + ': ' + bits.join('. ') + '.');
  }
  if (say.length) {
    out.spoken = say.join(' ') + (offer ? ' Would you like me to put a booking request in?' : '');
  }
  out.digest = 'DATA as of ' + todayIso + ' (question: "' + q.slice(0, 200) + '")'
    + (direct.length ? '\\n' + direct.join('\\n') : '')
    + '\\nCALLER OWN BOOKINGS:' + (mine.length ? '\\n- ' + mine.join('\\n- ') : ' none on record')
    + '\\nCALENDAR OCCUPANCY, window ' + todayIso + ' through ' + horizonIso + (manager ? ' (times TAKEN - customer names included: this caller is the MANAGER):' : ' (times TAKEN, all customers - never name them):')
    + (lines.length ? '\\n' + lines.join('\\n') : '\\n- no bookings')
    + '\\nAny date INSIDE this window that is not listed above has NO bookings: state plainly that it looks open and offer to put a booking request in. Only dates AFTER ' + horizonIso + ' are outside the view - for those say the calendar view does not reach that far and the team will confirm. New bookings are requests the team confirms.'
    + (direct.length ? ' A DIRECT ANSWER line above is AUTHORITATIVE for its date - answer the caller from it.' : '');
  return out;
})()`;

// Phase 3 slice 2 — manager write tools. The ctx block composes the LLM's
// structuring context FROM RECORDS (numbered upcoming bookings with customer
// names — the caller already proved manager: caller-id match + spoken PIN in
// the plugin, both before this flow ever runs). The model only STRUCTURES;
// it never composes the spoken outcome and never decides what is written.
const FLOW_MANAGER_CTX = `(function () {
  var request = String(inputs.request || '').replace(/[^\\x20-\\x7E]/g, ' ').trim().slice(0, 500);
  var sNode = nodes.settings;
  var sRows = sNode && sNode.responses ? sNode.responses : (Array.isArray(sNode) ? sNode : []);
  var cfg = {};
  for (var i = 0; i < sRows.length; i++) {
    var sa = (sRows[i] && sRows[i].answers) || {};
    if (String(sa.active || 'yes') !== 'no') { cfg = sa; break; }
  }
  var model = String(cfg.model || '').trim();
  var nowT = new Date();
  var todayIso = nowT.getFullYear() + '-' + ('0' + (nowT.getMonth() + 1)).slice(-2) + '-' + ('0' + nowT.getDate()).slice(-2);
  // Customer names by phone digits (last-9 suffix, same rule as everywhere).
  var nameBy = {};
  var cRows = (nodes.customers && nodes.customers.responses) || [];
  for (var nc = 0; nc < cRows.length; nc++) {
    var cAns = (cRows[nc] && cRows[nc].answers) || {};
    var cd = String(cAns.phone || '').replace(/\\D+/g, '').slice(-9);
    if (cd.length >= 6 && cAns.name) nameBy[cd] = String(cAns.name);
  }
  // Every live upcoming booking (the appts node is already DB-windowed
  // today..horizon); sorted, capped, each with its REAL record id so the
  // plan block can match the model's chosen target back to a record.
  var rows = (nodes.appts && nodes.appts.responses) || [];
  var appts = [];
  for (var r = 0; r < rows.length; r++) {
    var a = (rows[r] && rows[r].answers) || {};
    var st = String(a.status || '');
    var d = String(a.date || '');
    if (st === 'cancelled') continue;
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d) || d < todayIso) continue;
    var digits = String(a.phone || '').replace(/\\D+/g, '').slice(-9);
    appts.push({
      id: rows[r].id,
      date: d,
      time: String(a.time || ''),
      service: String(a.service || 'Appointment'),
      status: st || 'requested',
      name: nameBy[digits] || String(a.customer_name || '').trim(),
      notes: String(a.notes || ''),
    });
  }
  appts.sort(function (x, y) { var xa = x.date + ' ' + x.time, yb = y.date + ' ' + y.time; return xa < yb ? -1 : xa > yb ? 1 : 0; });
  if (appts.length > 40) appts = appts.slice(0, 40);
  var lines = [];
  for (var l = 0; l < appts.length; l++) {
    var ap = appts[l];
    lines.push('- ' + ap.date + (ap.time ? ' ' + ap.time : ' (no time set)') + ' ' + ap.service + ' (' + ap.status + ')' + (ap.name ? ' for ' + ap.name : ''));
  }
  var llmContext = 'MANAGER REQUEST: "' + request + '"\\n\\nUPCOMING BOOKINGS (date time service (status) for name):\\n'
    + (lines.length ? lines.join('\\n') : '- none on the calendar');
  return { hasRequest: request.length > 0, request: request, model: model, today: todayIso, llmContext: llmContext, appts: appts };
})()`;

// Validates the model's structured verdict against real records and composes
// the spoken outcome FROM those records. Every invalid/ambiguous path returns
// ok:false with an honest spoken question — the plugin speaks it and nothing
// is written. The flow itself writes NOTHING either way: the plugin emits
// aokie.manager.action and the manager-action-apply binding owns the write.
const FLOW_MANAGER_PLAN = `(function () {
  var c = nodes.ctx || {};
  var out = { ok: false, spoken: '', summary: '', hasUpdate: false, updateId: '', update: {}, hasBlock: false, blockNumber: '' };
  if (c.hasRequest !== true) {
    out.spoken = 'I did not catch the change you want - say it again?';
    return out;
  }
  var raw = String(((nodes.decide || {}).content) || '').trim();
  var m = raw.match(/\\{[\\s\\S]*\\}/);
  var data = {};
  try { data = JSON.parse(m ? m[0] : raw) || {}; } catch (e) { data = {}; }
  var action = String(data.action || 'none').toLowerCase();
  if (['confirm', 'cancel', 'move', 'block', 'none'].indexOf(action) === -1) action = 'none';
  if (action === 'none') {
    out.spoken = 'I could not map that to a change. You can confirm, move or cancel a booking, or block a number - say it again with the full date?';
    return out;
  }
  if (action === 'block') {
    var num = String(data.block_number || '').replace(/[^0-9+]/g, '');
    if (num.replace(/\\D+/g, '').length < 6) {
      out.spoken = 'Which number should I block? Say the full number.';
      return out;
    }
    out.ok = true;
    out.hasBlock = true;
    out.blockNumber = num;
    out.summary = 'Manager blocked ' + num + '.';
    out.spoken = 'Done - that number is now blocked.';
    return out;
  }
  var DAYFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONFULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var nowD = new Date();
  function dayLabel(dStr) {
    var hp = dStr.split('-');
    var dt = new Date(Number(hp[0]), Number(hp[1]) - 1, Number(hp[2]));
    var label = DAYFULL[dt.getDay()] + ' ' + dt.getDate() + ' ' + MONFULL[dt.getMonth()];
    if (dt.getFullYear() !== nowD.getFullYear()) label += ' ' + dt.getFullYear();
    return label;
  }
  function t12(tStr) {
    if (!/^\\d{2}:\\d{2}$/.test(tStr)) return '';
    var th = Number(tStr.slice(0, 2));
    var h = th % 12 === 0 ? 12 : th % 12;
    return h + (tStr.slice(3, 5) === '00' ? '' : ':' + tStr.slice(3, 5)) + ' ' + (th >= 12 ? 'PM' : 'AM');
  }
  function realIso(dStr) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(dStr)) return false;
    var dp = dStr.split('-');
    var dObj = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]));
    return dObj.getFullYear() === Number(dp[0]) && (dObj.getMonth() + 1) === Number(dp[1]) && dObj.getDate() === Number(dp[2]);
  }
  function validClock(tStr) {
    return /^\\d{2}:\\d{2}$/.test(tStr) && Number(tStr.slice(0, 2)) <= 23 && Number(tStr.slice(3, 5)) <= 59;
  }
  function apptLabel(ap) {
    return ap.service + ' on ' + dayLabel(ap.date) + (ap.time && t12(ap.time) ? ' at ' + t12(ap.time) : '') + (ap.name ? ' for ' + ap.name : '');
  }
  // Which booking? The date is REQUIRED (the model is told to fill it from
  // the list); time and name only narrow when the day has several.
  var targetDate = String(data.target_date || '').trim().slice(0, 10);
  var targetTime = String(data.target_time || '').trim().slice(0, 5);
  var targetName = String(data.target_name || '').trim().toLowerCase();
  if (!realIso(targetDate)) {
    out.spoken = 'Which date is that booking on? Say the change again with the full date.';
    return out;
  }
  var appts = Array.isArray(c.appts) ? c.appts : [];
  var cands = [];
  for (var q = 0; q < appts.length; q++) {
    if (String(appts[q].date || '') === targetDate) cands.push(appts[q]);
  }
  if (!cands.length) {
    out.spoken = 'I do not see any booking on ' + dayLabel(targetDate) + '.';
    return out;
  }
  if (cands.length > 1 && validClock(targetTime)) {
    var byTime = [];
    for (var qt = 0; qt < cands.length; qt++) { if (String(cands[qt].time || '') === targetTime) byTime.push(cands[qt]); }
    if (byTime.length) cands = byTime;
  }
  if (cands.length > 1 && targetName) {
    var byName = [];
    for (var qn = 0; qn < cands.length; qn++) { if (String(cands[qn].name || '').toLowerCase().indexOf(targetName) !== -1) byName.push(cands[qn]); }
    if (byName.length) cands = byName;
  }
  if (cands.length > 1) {
    var labels = [];
    for (var ql = 0; ql < cands.length && ql < 3; ql++) labels.push(apptLabel(cands[ql]));
    out.spoken = 'That day has more than one booking - which one do you mean: ' + labels.join(', or ') + '?';
    return out;
  }
  var target = cands[0];
  // Interaction log line on the appointment's notes (same audit-trail rule
  // as the SMS loop: updates patch-merge whole answers, so append).
  function noteWith(outcome) {
    var hh12 = nowD.getHours() % 12 === 0 ? 12 : nowD.getHours() % 12;
    var mm = ('0' + nowD.getMinutes()).slice(-2);
    var stamp = nowD.toDateString() + ' ' + hh12 + ':' + mm + ' ' + (nowD.getHours() >= 12 ? 'PM' : 'AM');
    var existing = String(target.notes || '');
    if (existing.length > 7600) existing = existing.slice(0, 7600);
    return (existing ? existing + '\\n' : '') + 'Manager line (' + stamp + '): "' + String(c.request || '') + '" - ' + outcome;
  }
  if (action === 'confirm') {
    out.ok = true;
    out.hasUpdate = true;
    out.updateId = target.id;
    out.update = { status: 'confirmed', notes: noteWith('CONFIRMED by the manager') };
    out.summary = 'Manager confirmed ' + apptLabel(target) + '.';
    out.spoken = 'Done - ' + apptLabel(target) + ' is confirmed.';
    return out;
  }
  if (action === 'cancel') {
    out.ok = true;
    out.hasUpdate = true;
    out.updateId = target.id;
    out.update = { status: 'cancelled', notes: noteWith('CANCELLED by the manager') };
    out.summary = 'Manager cancelled ' + apptLabel(target) + '.';
    out.spoken = 'Done - ' + apptLabel(target) + ' is cancelled.';
    return out;
  }
  // move: at least one of new_date / new_time, both re-validated. The date
  // must be real-calendar and not in the past - the model resolved any
  // relative wording against today, but the guard never trusts it.
  var newDate = String(data.new_date || '').trim().slice(0, 10);
  var newTime = String(data.new_time || '').trim().slice(0, 5);
  var todayIso = String(c.today || '');
  var useDate = realIso(newDate) && newDate >= todayIso;
  var useTime = validClock(newTime);
  if (!useDate && !useTime) {
    out.spoken = 'Where should I move it to? Say the new day or time.';
    return out;
  }
  var movedDate = useDate ? newDate : target.date;
  var movedTime = useTime ? newTime : String(target.time || '');
  out.ok = true;
  out.hasUpdate = true;
  out.updateId = target.id;
  out.update = { date: movedDate, time: movedTime, notes: noteWith('MOVED to ' + movedDate + (movedTime ? ' ' + movedTime : '') + ' by the manager') };
  out.summary = 'Manager moved ' + apptLabel(target) + ' to ' + movedDate + (movedTime ? ' ' + movedTime : '') + '.';
  out.spoken = 'Done - ' + target.service + (target.name ? ' for ' + target.name : '') + ' is moved to ' + dayLabel(movedDate) + (movedTime && t12(movedTime) ? ' at ' + t12(movedTime) : '') + '.';
  return out;
})()`;

// The write half rides the durable plane: aokie.manager.action -> this
// pass-through -> the binding's guarded updateResponse. Deliberately thin -
// validation already happened in manager-action-plan; this only refuses a
// malformed event so the update can never be a non-object.
const FLOW_MANAGER_APPLY = `(function () {
  var id = String(inputs.updateId || '');
  var upd = (inputs.update && typeof inputs.update === 'object' && !Array.isArray(inputs.update)) ? inputs.update : null;
  var ok = inputs.hasUpdate === true && id.length > 0 && upd !== null;
  return {
    hasUpdate: ok === true,
    updateId: id,
    update: upd || {},
    summaryLine: String(inputs.summary || 'Manager change applied.'),
  };
})()`;
const FLOW_PERSONALIZE_CALLER = `(function () {
  var phone = String(inputs.from || '');
  // The customers node pre-filters with the phone_eq op (digits-only last-9
  // suffix, matched in the DATABASE) - no client-side scan, no 200-row cap.
  var custNode = nodes.customers || {};
  var hit = custNode.first || ((custNode.responses || [])[0] || null);
  // Base config: SAME composition as the Configure Receptionist flow.
  var sNode = nodes.settings;
  var sRows = sNode && sNode.responses ? sNode.responses : (Array.isArray(sNode) ? sNode : []);
  var cfg = {};
  for (var j = 0; j < sRows.length; j++) {
    var sa = (sRows[j] && sRows[j].answers) || {};
    if (String(sa.active || 'yes') !== 'no') { cfg = sa; break; }
  }
  // PHASE 0.5 record-driven screening (call-policy spec): a customer whose
  // profile Status is 'blocked' is rejected outright, and whitelist mode
  // rejects any caller with NO Customer record. The flow's gate node routes
  // reject -> connector call.reject (an immediate hangup on post-answer-id
  // phones - acceptable per spec) and SKIPS the configureAgent push. Note
  // callers who WITHHOLD their id never mint an aokie.call.caller_id event,
  // so this flow cannot see them - the plugin-level rejectPrivate setting is
  // the tool for those.
  var custStatus = hit ? String(((hit.answers || {}).status || '')).trim().toLowerCase() : '';
  var blockedCustomer = custStatus === 'blocked';
  var whitelistOnly = String(cfg.whitelist_only || '') === 'yes';
  var reject = blockedCustomer || (whitelistOnly && !hit);
  var rejectReason = blockedCustomer ? 'blocked_customer' : (reject ? 'not_whitelisted' : '');
  var persona = String(cfg.instructions || '').trim() || ${JSON.stringify(DEFAULT_PERSONA)};
  var business = String(cfg.business_name || '').trim();
  if (business) persona = 'You are the phone receptionist for ' + business + '.\\n' + persona;
${BUSINESS_INFO_BLOCK_JS}
  var greeting = String(cfg.greeting || '').trim();
  if (!greeting) {
    greeting = business
      ? 'Thank you for calling ' + business + '! How can I help you today?'
      : 'Thanks for calling! How can I help you today?';
  }
  // BOOKINGS ON RECORD (live report 2026-07-13): the agent used to answer
  // calendar questions from thin air - a caller asking 'is my appointment
  // Thursday at 10?' was told about an invented 'Sunday July 12th'. Ground
  // the model in the caller's ACTUAL upcoming appointments (phone_eq node,
  // DB-pushed) so it answers from records and never confabulates a diary.
  var nowD = new Date();
  var todayIso = nowD.getFullYear() + '-' + ('0' + (nowD.getMonth() + 1)).slice(-2) + '-' + ('0' + nowD.getDate()).slice(-2);
  var aRows = (nodes.appointments && nodes.appointments.responses) || [];
  var upcoming = [];
  for (var u = 0; u < aRows.length; u++) {
    var ua = (aRows[u] && aRows[u].answers) || {};
    var ust = String(ua.status || '');
    var ud = String(ua.date || '');
    if ((ust === 'requested' || ust === 'confirmed') && /^\\d{4}-\\d{2}-\\d{2}$/.test(ud) && ud >= todayIso) {
      upcoming.push({ date: ud, time: String(ua.time || ''), service: String(ua.service || 'Appointment'), status: ust });
    }
  }
  upcoming.sort(function (x, y) { var a = x.date + ' ' + x.time, b = y.date + ' ' + y.time; return a < b ? -1 : a > b ? 1 : 0; });
  if (upcoming.length > 5) upcoming = upcoming.slice(0, 5);
  var DAYFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONFULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function humanWhenP(dStr, tStr) {
    // Spoken-friendly label (live report 2026-07-14: toDateString()'s
    // "Tue Jul 14 2026" was voiced as garbled numbers): full weekday + day +
    // full month, year only when it isn't this year - the model's
    // copy-dates-EXACTLY rule then reproduces speakable text.
    var hp = dStr.split('-');
    var dt = new Date(Number(hp[0]), Number(hp[1]) - 1, Number(hp[2]));
    var label = DAYFULL[dt.getDay()] + ' ' + dt.getDate() + ' ' + MONFULL[dt.getMonth()];
    if (dt.getFullYear() !== new Date().getFullYear()) label += ' ' + dt.getFullYear();
    if (/^\\d{2}:\\d{2}$/.test(tStr)) {
      var hh = Number(tStr.slice(0, 2));
      var h12 = hh % 12 === 0 ? 12 : hh % 12;
      label += ' at ' + h12 + (tStr.slice(3, 5) === '00' ? '' : ':' + tStr.slice(3, 5)) + ' ' + (hh >= 12 ? 'PM' : 'AM');
    }
    return label;
  }
  var calBlock = '';
  if (upcoming.length) {
    var calLines = [];
    for (var c = 0; c < upcoming.length; c++) {
      calLines.push('- ' + humanWhenP(upcoming[c].date, upcoming[c].time) + ': ' + upcoming[c].service + ' (' + upcoming[c].status + ')');
    }
    calBlock = '\\n\\nBOOKINGS ON RECORD for this caller (today is ' + todayIso + '):\\n' + calLines.join('\\n')
      + '\\nAnswer questions about their bookings ONLY from this list - never invent or guess dates. requested = awaiting confirmation, confirmed = locked in.'
      + '\\nThis list is the ONLY source of booking dates. Anything about bookings or dates in the customer notes is OLD HISTORY, never a current booking.'
      + '\\nIf they want to change or cancel one, or book another, note the details clearly; the booking is updated after the call and confirmed by text.';
  } else {
    // No upcoming rows: say so explicitly - an empty block left the model
    // free to dredge old dates out of the customer notes (live report
    // 2026-07-14: a long-past 'Sunday July 12th' resurfaced as a booking).
    calBlock = '\\n\\nBOOKINGS ON RECORD for this caller (today is ' + todayIso + '): none upcoming.'
      + '\\nIf they ask about a booking, say you do not see one coming up and offer to take a new request. Never treat dates from the customer notes as bookings.';
  }
  // CALENDAR OCCUPANCY (2026-07-14 live business data): the WHOLE calendar's
  // next 7 days, times only - the agent can say whether a slot is taken
  // without ever seeing (or leaking) another customer's name or number.
  var horizon = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + 7);
  var horizonIso = horizon.getFullYear() + '-' + ('0' + (horizon.getMonth() + 1)).slice(-2) + '-' + ('0' + horizon.getDate()).slice(-2);
  function t12(tStr) {
    if (!/^\\d{2}:\\d{2}$/.test(tStr)) return tStr || '?';
    var th = Number(tStr.slice(0, 2));
    var t12h = th % 12 === 0 ? 12 : th % 12;
    return t12h + (tStr.slice(3, 5) === '00' ? '' : ':' + tStr.slice(3, 5)) + ' ' + (th >= 12 ? 'PM' : 'AM');
  }
  var occRows = (nodes.allappts && nodes.allappts.responses) || [];
  var occ = {};
  for (var q2 = 0; q2 < occRows.length; q2++) {
    var oa = (occRows[q2] && occRows[q2].answers) || {};
    var ost = String(oa.status || '');
    var od = String(oa.date || '');
    if ((ost === 'requested' || ost === 'confirmed') && /^\\d{4}-\\d{2}-\\d{2}$/.test(od) && od >= todayIso && od <= horizonIso) {
      if (!occ[od]) occ[od] = [];
      occ[od].push(String(oa.time || ''));
    }
  }
  var occDates = Object.keys(occ).sort();
  var occLines = [];
  for (var q3 = 0; q3 < occDates.length; q3++) {
    var times = occ[occDates[q3]].sort();
    var labels = [];
    for (var q4 = 0; q4 < times.length; q4++) labels.push(t12(times[q4]));
    occLines.push('- ' + humanWhenP(occDates[q3], '') + ': booked at ' + labels.join(', '));
  }
  var occBlock = '\\n\\nCALENDAR OCCUPANCY (next 7 days, ALL customers; these times are already TAKEN):\\n'
    + (occLines.length ? occLines.join('\\n') : '- no bookings in the next 7 days')
    + '\\nDays not listed IN THIS 7-DAY WINDOW have no bookings yet. This list covers ONLY the next 7 days: for ANY date beyond it, run a live lookup ([[LOOKUP: ...]]) instead of guessing or deferring to the team. NEVER mention or hint at other customers. All new bookings are requests the team confirms.';
  if (!hit) return { found: false, name: '', reject: reject, rejectReason: rejectReason, persona: persona + calBlock + occBlock, greeting: greeting };
  var ca = (hit.answers || {});
  var name = String(ca.name || '').trim();
  var first = name.split(/\\s+/)[0] || name;
  var details = [];
  if (String(ca.preferred_service || '').trim()) details.push('Usually books: ' + String(ca.preferred_service).trim());
  if (String(ca.status || '').trim()) details.push('Customer status: ' + String(ca.status).trim());
  var notes = String(ca.notes || '').trim().slice(0, 400);
  if (notes) details.push('Notes: ' + notes);
  var known = '\\n\\nKNOWN CALLER (matched by caller ID): ' + (name || 'a saved customer') + ', calling from ' + phone + '.'
    + (details.length ? '\\n' + details.join('\\n') : '')
    + '\\nGreet them by their first name and use this context naturally.'
    + '\\nDo NOT ask for their name or phone number - you already have both from caller ID. Only note a DIFFERENT callback number if they offer one.'
    + '\\nIf they say they are someone else calling from this phone, treat them as a new caller and ask for their details as usual.';
  // A CUSTOM greeting is the owner's crafted voice - keep it for known
  // callers too (prefixed with their name) instead of replacing it with a
  // generic line. Only fall back to the generic personalised greeting when
  // no custom greeting is configured.
  var custom = String(cfg.greeting || '').trim();
  var g = first
    ? (custom
        ? 'Hi ' + first + '! ' + custom
        : (business
            ? 'Hi ' + first + '! Thanks for calling ' + business + '. How can I help you today?'
            : 'Hi ' + first + '! How can I help you today?'))
    : greeting;
  return { found: true, name: name, reject: reject, rejectReason: rejectReason, persona: persona + known + calBlock + occBlock, greeting: g };
})()`;

// SMS follow-up conversation context (feature 2026-07-13): an inbound text is
// matched to its open SMS-managed follow-up task by the sender's number
// (phone_eq, DB-pushed), the appointment that task is about is found via the
// shared call_id, and the thread history is assembled for the LLM. Deterministic
// verdicts happen HERE, before any model runs: STOP always wins (opt-out), a
// plain YES with an existing appointment confirms without an LLM call, and the
// hard exchange cap (6 outbound texts per task) hands off to a human — so the
// loop can never run away. verdict 'llm' is the only path that reaches the model
// (the flow's condition node gates it), and 'none' means this sender has no
// active SMS follow-up at all — the approval-draft flow owns the reply instead.
const FLOW_SMS_CONVO_CTX = `(function () {
  var from = String(inputs.from || '');
  var body = String(inputs.body || '').trim();
  var sNode = nodes.settings;
  var sRows = sNode && sNode.responses ? sNode.responses : (Array.isArray(sNode) ? sNode : []);
  var cfg = {};
  for (var i = 0; i < sRows.length; i++) {
    var sa = (sRows[i] && sRows[i].answers) || {};
    if (String(sa.active || 'yes') !== 'no') { cfg = sa; break; }
  }
  var business = String(cfg.business_name || '').trim();
  var model = String(cfg.model || '').trim();
  // Newest open task in the SMS loop for this sender (rows arrive newest-first).
  var tRows = (nodes.tasks && nodes.tasks.responses) || [];
  var task = null;
  for (var t = 0; t < tRows.length; t++) {
    var ta = (tRows[t] && tRows[t].answers) || {};
    var st = String(ta.status || '');
    if ((st === 'open' || st === 'in_progress') && String(ta.sms_state || '') === 'active') { task = tRows[t]; break; }
  }
  if (!task) return { verdict: 'none', hasTask: false };
  var ta2 = task.answers || {};
  var callId = String(ta2.call_id || '');
  var exchanges = Number(ta2.sms_exchanges || 0);
  // The appointments this LOOP covers (multi-booking, 2026-07-13; cap 3): the
  // task's own call first, then any other still-pending ('requested')
  // upcoming booking for this number - the kickoff listed them together, so
  // a YES must confirm them ALL, and a change must say WHICH one.
  var aRows = (nodes.appointments && nodes.appointments.responses) || [];
  var nowT = new Date();
  var todayIso0 = nowT.getFullYear() + '-' + ('0' + (nowT.getMonth() + 1)).slice(-2) + '-' + ('0' + nowT.getDate()).slice(-2);
  var loopAppts = [];
  function pushAppt(row) {
    if (!row || loopAppts.length >= 3) return;
    for (var q = 0; q < loopAppts.length; q++) { if (loopAppts[q].id === row.id) return; }
    var ax = (row.answers || {});
    loopAppts.push({
      id: row.id,
      date: String(ax.date || ''),
      time: String(ax.time || ''),
      service: String(ax.service || 'Appointment'),
      status: String(ax.status || 'requested'),
      notes: String(ax.notes || '')
    });
  }
  for (var a = 0; a < aRows.length; a++) {
    var aa = (aRows[a] && aRows[a].answers) || {};
    if (callId && String(aa.call_id || '') === callId && String(aa.status || '') !== 'cancelled') pushAppt(aRows[a]);
  }
  for (var a1 = 0; a1 < aRows.length; a1++) {
    var ap1 = (aRows[a1] && aRows[a1].answers) || {};
    var d1 = String(ap1.date || '');
    if (String(ap1.status || '') === 'requested' && /^\\d{4}-\\d{2}-\\d{2}$/.test(d1) && d1 >= todayIso0) pushAppt(aRows[a1]);
  }
  if (!loopAppts.length) {
    for (var a2 = 0; a2 < aRows.length; a2++) {
      var ab = (aRows[a2] && aRows[a2].answers) || {};
      var stt = String(ab.status || '');
      if (stt === 'requested' || stt === 'confirmed') { pushAppt(aRows[a2]); break; }
    }
  }
  loopAppts.sort(function (x, y) { var xa = x.date + ' ' + x.time, yb = y.date + ' ' + y.time; return xa < yb ? -1 : xa > yb ? 1 : 0; });
  var appt = loopAppts.length ? loopAppts[0] : null;
  var apptA = appt;
  // Deterministic verdicts — STOP always wins, even past the cap.
  // PHASE 0.5: a sender whose Customer record says sms_capable 'no' (or
  // Status 'blocked') stops the loop — verdict 'no_sms' skips the LLM and
  // the plan hands the task to a human instead of texting.
  var cRow = ((nodes.customers || {}).first) || (((nodes.customers || {}).responses || [])[0] || null);
  var cAns = (cRow && cRow.answers) || {};
  var noSms = String(cAns.sms_capable || 'yes') === 'no' || String(cAns.status || '').toLowerCase() === 'blocked';
  var lower = body.toLowerCase().replace(/[\\s.!,]+$/, '');
  var stop = lower === 'stop' || lower === 'unsubscribe' || lower === 'opt out' || lower === 'optout';
  var yes = /^(yes|yep|yeah|y|confirm|confirmed|ok|okay|sounds good|perfect|great)$/.test(lower);
  var verdict = stop ? 'stop' : (noSms ? 'no_sms' : (exchanges >= 6 ? 'cap' : ((yes && appt) ? 'yes' : 'llm')));
  // Thread history, oldest → newest, capped at the last 12 messages. The inbound
  // row for THIS text is already stored (app logic runs before bindings), so the
  // prompt marks the newest message explicitly instead of appending it again.
  var mRows = (nodes.messages && nodes.messages.responses) || [];
  var hist = [];
  for (var m = 0; m < mRows.length; m++) {
    var ma = (mRows[m] && mRows[m].answers) || {};
    hist.push({
      at: String(ma.timestamp || (mRows[m] && mRows[m].submittedAt) || ''),
      who: String(ma.direction || '') === 'outbound' ? 'Business' : 'Customer',
      text: String(ma.body || '')
    });
  }
  hist.sort(function (x, y) { return x.at < y.at ? -1 : x.at > y.at ? 1 : 0; });
  var lines = [];
  for (var h = (hist.length > 12 ? hist.length - 12 : 0); h < hist.length; h++) {
    lines.push(hist[h].who + ': ' + hist[h].text);
  }
  var now = new Date();
  var isoLocal = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
  var apptLines = [];
  for (var al = 0; al < loopAppts.length; al++) {
    var la = loopAppts[al];
    apptLines.push((al + 1) + '. ' + la.service + ' on ' + (la.date || '?') + (la.time ? ' at ' + la.time : '') + ' (status: ' + (la.status || 'requested') + ')');
  }
  var llmContext = (business ? 'Business: ' + business + '\\n' : '')
    + 'Open follow-up task: ' + String(ta2.summary || '') + '\\n'
    + (apptLines.length
      ? 'Current booking request' + (apptLines.length > 1 ? 's' : '') + ':\\n' + apptLines.join('\\n') + '\\n'
      : 'No appointment exists yet - the customer still needs to pick a day and time.\\n')
    + '\\nSMS conversation so far (oldest first):\\n' + lines.join('\\n')
    + '\\n\\nThe customer\\'s NEW message (respond to this): "' + body + '"';
  return {
    verdict: verdict,
    hasTask: true,
    taskId: task.id,
    taskCallId: callId,
    taskCustomer: String(ta2.customer_link || ''),
    exchanges: exchanges,
    apptId: appt ? appt.id : null,
    apptDate: apptA ? String(apptA.date || '') : '',
    apptTime: apptA ? String(apptA.time || '') : '',
    apptService: apptA ? String(apptA.service || 'Appointment') : '',
    // Existing notes ride along so the plan can APPEND the interaction
    // log line (updateResponse patch-merges whole answers - writing
    // notes without the old content would erase the booking history).
    apptNotes: apptA ? String(apptA.notes || '') : '',
    // EVERY appointment this loop covers (cap 3) - the plan confirms them
    // all on YES and targets one by date for a change/cancel.
    appts: loopAppts,
    business: business,
    model: model,
    today: now.toDateString() + ' (' + isoLocal + ')',
    llmContext: llmContext,
    phone: from,
    // PHASE 0.5 defaultCountryCode, validated here once (same rule as the
    // after-call plan): the plan block normalizes the reply's 'to' with it.
    cc: (function () {
      var c0 = String(cfg.default_country_code || '').replace(/\\s+/g, '');
      if (/^\\d{1,3}$/.test(c0)) c0 = '+' + c0;
      return /^\\+\\d{1,3}$/.test(c0) ? c0 : '';
    })()
  };
})()`;

// Turn the conversation LLM's JSON (or a deterministic ctx verdict) into concrete
// writes + one reply. Same defensive posture as FLOW_AFTER_CALL_PLAN: every model
// field is whitelisted/validated, an unknown action degrades to a human handoff,
// and a malformed date can never move a booking. Confirm/reschedule/cancel replies
// are COMPOSED here (never model text) so the SMS can't promise something the
// records don't say; the model's own words are used only for clarifying questions.
const FLOW_SMS_CONVO_PLAN = `(function () {
  var c = nodes.ctx || {};
  var verdict = String(c.verdict || 'none');
  var out = { hasReply: false, hasTaskUpdate: false, hasApptUpdate: false, hasApptUpdate2: false, hasApptUpdate3: false, hasApptCreate: false, summaryLine: '' };
  if (verdict === 'none' || c.hasTask !== true) {
    out.summaryLine = 'No active SMS follow-up for this sender - left to the approval-draft path.';
    return out;
  }
  var phone = String(c.phone || '');
  var taskId = c.taskId;
  var exchanges = Number(c.exchanges || 0);
  if (verdict === 'stop') {
    out.hasTaskUpdate = true;
    out.taskId = taskId;
    out.taskUpdate = { sms_state: 'opted_out', priority: 'high' };
    out.summaryLine = 'Customer texted STOP - opted out, task flagged for a human.';
    return out;
  }
  if (verdict === 'cap') {
    out.hasTaskUpdate = true;
    out.taskId = taskId;
    out.taskUpdate = { sms_state: 'handoff', priority: 'high' };
    out.summaryLine = 'SMS exchange limit reached - task handed to a human.';
    return out;
  }
  if (verdict === 'no_sms') {
    // PHASE 0.5: the customer's profile says they cannot receive SMS (or is
    // blocked) - never text them; the task goes to a human, who calls back.
    out.hasTaskUpdate = true;
    out.taskId = taskId;
    out.taskUpdate = { sms_state: 'handoff', priority: 'high' };
    out.summaryLine = 'Customer is marked not SMS-capable or blocked - loop stopped, task handed to a human.';
    return out;
  }
  function humanWhen(dStr, tStr) {
    var label = dStr;
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(dStr)) {
      var hp = dStr.split('-');
      label = new Date(Number(hp[0]), Number(hp[1]) - 1, Number(hp[2])).toDateString();
    }
    if (/^\\d{2}:\\d{2}$/.test(tStr)) {
      var hh = Number(tStr.slice(0, 2));
      var h12 = hh % 12 === 0 ? 12 : hh % 12;
      label += ' at ' + h12 + (tStr.slice(3, 5) === '00' ? '' : ':' + tStr.slice(3, 5)) + ' ' + (hh >= 12 ? 'PM' : 'AM');
    }
    return label;
  }
  // Interaction log line for the appointment's notes: the customer's own
  // words + what was done, timestamped - appended to the EXISTING notes
  // (updates patch-merge whole answers, so the old content must ride
  // along). Growth is bounded by the 6-exchange cap; the 8000-char guard
  // keeps a pathological thread from ever failing the write.
  function apptNoteWith(outcome, existingNotes) {
    var nowN = new Date();
    var hh12 = nowN.getHours() % 12 === 0 ? 12 : nowN.getHours() % 12;
    var mm = ('0' + nowN.getMinutes()).slice(-2);
    var stamp = nowN.toDateString() + ' ' + hh12 + ':' + mm + ' ' + (nowN.getHours() >= 12 ? 'PM' : 'AM');
    var said = String(inputs.body || '').replace(/[^\\x20-\\x7E]/g, '').slice(0, 160).trim();
    var line = 'SMS follow-up (' + stamp + '): customer texted "' + said + '" - ' + outcome;
    var existing = String(existingNotes === undefined ? (c.apptNotes || '') : existingNotes);
    if (existing.length > 7600) existing = existing.slice(0, 7600);
    return (existing ? existing + '\\n' : '') + line;
  }
  // Every appointment this loop covers (multi-booking; c.appts is the new
  // shape, the singular c.appt* fields remain as the first entry).
  var appts = Array.isArray(c.appts) ? c.appts.slice(0, 3) : [];
  if (!appts.length && c.apptId) {
    appts = [{ id: c.apptId, date: String(c.apptDate || ''), time: String(c.apptTime || ''), service: String(c.apptService || 'Appointment'), status: 'requested', notes: String(c.apptNotes || '') }];
  }
  function apptLabel(a) { return String(a.service || 'Appointment') + ' on ' + humanWhen(String(a.date || ''), String(a.time || '')); }
  var action = 'confirm';
  var dateStr = '';
  var timeStr = '';
  var service = '';
  var targetDate = '';
  var reply = '';
  if (verdict !== 'yes') {
    var raw = String(((nodes.decide || {}).content) || '').trim();
    var m = raw.match(/\\{[\\s\\S]*\\}/);
    var data = {};
    try { data = JSON.parse(m ? m[0] : raw) || {}; } catch (e) { data = {}; }
    action = String(data.action || 'handoff').toLowerCase();
    if (['confirm', 'reschedule', 'cancel', 'ask', 'handoff'].indexOf(action) === -1) action = 'handoff';
    dateStr = String(data.date || '').trim().slice(0, 10);
    timeStr = String(data.time || '').trim().slice(0, 5);
    service = String(data.service || '').trim().slice(0, 200);
    targetDate = String(data.target_date || '').trim().slice(0, 10);
    reply = String(data.reply || '').trim();
  }
  // Which existing booking is the customer talking about? Unambiguous with
  // one; with several, the model must name it by date (target_date). No
  // match = null - the caller is ASKED instead of a record being guessed at.
  function targetAppt() {
    if (appts.length <= 1) return appts[0] || null;
    for (var tq = 0; tq < appts.length; tq++) {
      if (targetDate && String(appts[tq].date || '') === targetDate) return appts[tq];
    }
    return null;
  }
  function apptChoices() {
    var labels = [];
    for (var ch = 0; ch < appts.length; ch++) labels.push(apptLabel(appts[ch]));
    return labels.join(' or ');
  }
  // Date/time guards (same rules as the after-call extractor): a usable date is
  // real-calendar and not in the past; a usable time is a real clock time.
  var validTime = /^\\d{2}:\\d{2}$/.test(timeStr)
    && Number(timeStr.slice(0, 2)) <= 23 && Number(timeStr.slice(3, 5)) <= 59;
  var validDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(dateStr);
  var nowP = new Date();
  var todayIso = nowP.getFullYear() + '-' + ('0' + (nowP.getMonth() + 1)).slice(-2) + '-' + ('0' + nowP.getDate()).slice(-2);
  var realDate = false;
  if (validDate) {
    var dp = dateStr.split('-');
    var dObj = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]));
    realDate = dObj.getFullYear() === Number(dp[0]) && (dObj.getMonth() + 1) === Number(dp[1]) && dObj.getDate() === Number(dp[2]);
  }
  var usableDate = validDate && realDate && dateStr >= todayIso;
  // Degrade impossible actions instead of guessing.
  var newExchanges = exchanges + 1;
  var taskUpdate = { sms_exchanges: newExchanges };
  // Appointment writes, in order (up to three gated update actions).
  var apptWrites = [];
  // COMPOUND decisions (live report 2026-07-13: "Yes to Thursday 10am and
  // 6pm for Sunday" confirmed BOTH at 10 - the single-action decision
  // dropped the time change). The model may return an "actions" ARRAY, one
  // entry per booking; validated per item, one write per booking (first
  // claim wins), a target-less confirm covers every unclaimed booking, and
  // an item that cannot be matched to a booking is DROPPED, never guessed.
  function usableDateOf(d) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return false;
    var dp2 = d.split('-');
    var o2 = new Date(Number(dp2[0]), Number(dp2[1]) - 1, Number(dp2[2]));
    var real2 = o2.getFullYear() === Number(dp2[0]) && (o2.getMonth() + 1) === Number(dp2[1]) && o2.getDate() === Number(dp2[2]);
    return real2 && d >= todayIso;
  }
  function timeOkOf(t) {
    return /^\\d{2}:\\d{2}$/.test(t) && Number(t.slice(0, 2)) <= 23 && Number(t.slice(3, 5)) <= 59;
  }
  var compoundApplied = false;
  var acts = (verdict !== 'yes' && typeof data === 'object' && data && Array.isArray(data.actions)) ? data.actions.slice(0, 3) : [];
  if (acts.length >= 2 && appts.length) {
    var claimed = {};
    var pending = [];
    for (var ci = 0; ci < acts.length; ci++) {
      var itA = acts[ci] || {};
      var actA = String(itA.action || '').toLowerCase();
      if (['confirm', 'reschedule', 'cancel'].indexOf(actA) === -1) continue;
      pending.push({
        act: actA,
        td: String(itA.target_date || '').trim().slice(0, 10),
        d: String(itA.date || '').trim().slice(0, 10),
        t: String(itA.time || '').trim().slice(0, 5)
      });
    }
    var plan = [];
    var deferredConfirm = false;
    for (var pi = 0; pi < pending.length; pi++) {
      var itm = pending[pi];
      var tgt = null;
      for (var ai = 0; ai < appts.length; ai++) {
        var cand = appts[ai];
        if (claimed[cand.id]) continue;
        if (itm.td && String(cand.date || '') === itm.td) { tgt = cand; break; }
        // A reschedule naming no target but keeping the same date is a
        // time change on that date's booking ("6pm for Sunday").
        if (!itm.td && itm.act === 'reschedule' && itm.d && String(cand.date || '') === itm.d) { tgt = cand; break; }
      }
      if (!tgt) {
        if (itm.act === 'confirm') deferredConfirm = true;
        continue;
      }
      claimed[tgt.id] = true;
      plan.push({ appt: tgt, act: itm.act, d: itm.d, t: itm.t });
    }
    if (deferredConfirm) {
      for (var ui = 0; ui < appts.length; ui++) {
        if (claimed[appts[ui].id]) continue;
        claimed[appts[ui].id] = true;
        plan.push({ appt: appts[ui], act: 'confirm', d: '', t: '' });
      }
    }
    if (plan.length >= 2) {
      compoundApplied = true;
      var segsC = [];
      var segsR = [];
      var segsX = [];
      var anyRequested = false;
      for (var cw = 0; cw < plan.length && apptWrites.length < 3; cw++) {
        var w = plan[cw];
        if (w.act === 'confirm') {
          apptWrites.push({ id: w.appt.id, update: { status: 'confirmed', notes: apptNoteWith('appointment CONFIRMED for ' + humanWhen(String(w.appt.date || ''), String(w.appt.time || '')) + '.', w.appt.notes) } });
          segsC.push(apptLabel(w.appt));
        } else if (w.act === 'reschedule') {
          var okD = usableDateOf(w.d);
          var okT = timeOkOf(w.t);
          if (!okD && !okT) continue; // nothing usable changed - drop the item
          var newD = okD ? w.d : String(w.appt.date || '');
          var whenN = humanWhen(newD, okT ? w.t : String(w.appt.time || ''));
          var uR = { date: newD, status: 'requested', notes: apptNoteWith('moved to ' + whenN + ', awaiting their YES.', w.appt.notes) };
          if (okT) uR.time = w.t;
          apptWrites.push({ id: w.appt.id, update: uR });
          segsR.push(whenN);
          anyRequested = true;
        } else {
          apptWrites.push({ id: w.appt.id, update: { status: 'cancelled', notes: apptNoteWith('appointment CANCELLED at their request.', w.appt.notes) } });
          segsX.push(apptLabel(w.appt));
        }
      }
      var parts = [];
      if (segsC.length) parts.push('Perfect - you are confirmed: ' + segsC.join(' and ') + '.');
      if (segsR.length) parts.push('I have you down for ' + segsR.join(' and ') + ' - reply YES to lock that in.');
      if (segsX.length) parts.push('Cancelled: ' + segsX.join(' and ') + '.');
      reply = parts.join(' ');
      if (!anyRequested) {
        // Everything settled (confirmed/cancelled) - the loop closes.
        taskUpdate.status = 'done';
        taskUpdate.sms_state = 'done';
      }
      out.summaryLine = 'Compound SMS decision: ' + segsC.length + ' confirmed, ' + segsR.length + ' moved, ' + segsX.length + ' cancelled' + (anyRequested ? ' - awaiting a YES.' : ' - task closed.');
    }
  }
  if (!compoundApplied) {
  // Degrade impossible actions instead of guessing.
  if (action === 'confirm' && !appts.length) action = 'ask';
  if (action === 'reschedule' && !usableDate) action = 'ask';
  if (action === 'cancel' && !appts.length) action = 'handoff';
  if (action === 'confirm') {
    // A YES confirms EVERY booking in the loop - the kickoff listed them all.
    var confirmedLabels = [];
    for (var cf = 0; cf < appts.length; cf++) {
      var ca = appts[cf];
      var upd = { status: 'confirmed', notes: apptNoteWith('appointment CONFIRMED for ' + humanWhen(String(ca.date || ''), String(ca.time || '')) + '.', ca.notes) };
      if (appts.length === 1) {
        // A new date/time on a confirm applies only when it is unambiguous.
        if (usableDate) upd.date = dateStr;
        if (validTime) upd.time = timeStr;
        confirmedLabels.push(String(ca.service || 'Appointment') + ' on ' + humanWhen(usableDate ? dateStr : String(ca.date || ''), validTime ? timeStr : String(ca.time || '')));
      } else {
        confirmedLabels.push(apptLabel(ca));
      }
      apptWrites.push({ id: ca.id, update: upd });
    }
    reply = 'Perfect - you are confirmed: ' + confirmedLabels.join(' and ') + '. See you then!';
    taskUpdate.status = 'done';
    taskUpdate.sms_state = 'done';
    out.summaryLine = (appts.length > 1 ? appts.length + ' appointments' : 'Appointment') + ' confirmed by SMS - task closed.';
  } else if (action === 'reschedule') {
    var whenR = humanWhen(dateStr, validTime ? timeStr : '');
    var tgtR = targetAppt();
    if (appts.length > 1 && !tgtR) {
      // Several bookings and the model did not say WHICH - never guess a
      // record; ask, with the choices composed from the records.
      action = 'ask';
      reply = 'Which booking would you like to change - ' + apptChoices() + '? Text the one you mean and the new day and time.';
      out.summaryLine = 'Asked which of the ' + appts.length + ' bookings to change.';
    } else if (tgtR) {
      var updR = { date: dateStr, status: 'requested', notes: apptNoteWith('moved to ' + whenR + ', awaiting their YES.', tgtR.notes) };
      if (validTime) updR.time = timeStr;
      apptWrites.push({ id: tgtR.id, update: updR });
      reply = 'Got it - I have you down for ' + whenR + '. Reply YES to confirm and we will lock it in.';
      out.summaryLine = 'Appointment moved to ' + dateStr + (validTime ? ' ' + timeStr : '') + ' by SMS - awaiting a YES.';
    } else {
      out.hasApptCreate = true;
      var newAppt = {
        service: service || String(c.apptService || '') || 'Appointment',
        date: dateStr,
        status: 'requested',
        source: 'sms',
        phone: phone,
        call_id: String(c.taskCallId || ''),
        notes: 'Scheduled over SMS follow-up (task ' + String(taskId || '') + ').\\n' + apptNoteWith('booked for ' + whenR + ', awaiting their YES.', '')
      };
      if (validTime) newAppt.time = timeStr;
      if (String(c.taskCustomer || '')) newAppt.customer_link = String(c.taskCustomer);
      out.newAppointment = newAppt;
      reply = 'Got it - I have you down for ' + whenR + '. Reply YES to confirm and we will lock it in.';
      out.summaryLine = 'Appointment booked for ' + dateStr + (validTime ? ' ' + timeStr : '') + ' by SMS - awaiting a YES.';
    }
  } else if (action === 'cancel') {
    var tgtC = targetAppt();
    if (appts.length > 1 && !tgtC) {
      action = 'ask';
      reply = 'Which booking would you like to cancel - ' + apptChoices() + '?';
      out.summaryLine = 'Asked which of the ' + appts.length + ' bookings to cancel.';
    } else if (tgtC) {
      apptWrites.push({ id: tgtC.id, update: { status: 'cancelled', notes: apptNoteWith('appointment CANCELLED at their request.', tgtC.notes) } });
      var remaining = [];
      for (var rm = 0; rm < appts.length; rm++) { if (appts[rm].id !== tgtC.id) remaining.push(appts[rm]); }
      if (remaining.length) {
        var remLabels = [];
        for (var rl = 0; rl < remaining.length; rl++) remLabels.push(apptLabel(remaining[rl]));
        reply = 'No problem - ' + apptLabel(tgtC) + ' is cancelled. You still have: ' + remLabels.join(' and ') + '. Reply YES to confirm.';
        out.summaryLine = 'One booking cancelled by SMS - ' + remaining.length + ' still awaiting confirmation.';
        // The loop stays open for the remaining bookings.
      } else {
        reply = 'No problem - that booking request is cancelled. Text us any time if you would like to rebook.';
        taskUpdate.status = 'done';
        taskUpdate.sms_state = 'done';
        out.summaryLine = 'Booking cancelled by SMS - task closed.';
      }
    }
  }
  if (action === 'ask') {
    reply = reply || 'Sorry - what day and time suit you best?';
    // Log the clarifying exchange on the appointment too (notes-only
    // update - no status/date change), so the record tells the whole
    // conversation story, not just its final state.
    if (appts.length && !apptWrites.length) {
      apptWrites.push({ id: appts[0].id, update: { notes: apptNoteWith('asked them: "' + reply.slice(0, 120) + '"', appts[0].notes) } });
    }
    if (!out.summaryLine) out.summaryLine = 'Asked the customer a clarifying question by SMS.';
  } else if (action === 'handoff') {
    reply = 'Thanks - someone from the team will be in touch shortly to sort this out.';
    taskUpdate.sms_state = 'handoff';
    taskUpdate.priority = 'high';
    if (appts.length) {
      apptWrites.push({ id: appts[0].id, update: { notes: apptNoteWith('handed to a human to sort out.', appts[0].notes) } });
    }
    out.summaryLine = 'SMS conversation handed to a human.';
  }
  } // end !compoundApplied (legacy single-action path)
  if (apptWrites.length) {
    out.hasApptUpdate = true;
    out.apptResponseId = apptWrites[0].id;
    out.apptUpdate = apptWrites[0].update;
  }
  if (apptWrites.length > 1) {
    out.hasApptUpdate2 = true;
    out.apptResponseId2 = apptWrites[1].id;
    out.apptUpdate2 = apptWrites[1].update;
  }
  if (apptWrites.length > 2) {
    out.hasApptUpdate3 = true;
    out.apptResponseId3 = apptWrites[2].id;
    out.apptUpdate3 = apptWrites[2].update;
  }
  // Plain ASCII only (GSM-charset envelope), capped well inside the server's limits.
  reply = reply.replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201C\\u201D]/g, '"').replace(/[\\u2013\\u2014]/g, '-').replace(/[^\\x20-\\x7E\\n]/g, '').slice(0, 440).trim();
  if (!reply) reply = 'Thanks for your message - someone from the team will be in touch shortly.';
  out.hasTaskUpdate = true;
  out.taskId = taskId;
  out.taskUpdate = taskUpdate;
  out.hasReply = true;
  // PHASE 0.5 defaultCountryCode (validated in ctx): a locally-typed 0-prefix
  // number goes out as +CC…; the Messages row keeps the number as observed.
  var ccP = String(c.cc || '');
  var toT = phone.replace(/[\\s()-]/g, '');
  out.reply = { to: (ccP && /^0\\d{5,14}$/.test(toT)) ? ccP + toT.slice(1) : phone, body: reply };
  out.outboundMessage = {
    message_id: 'smsflow_' + String(taskId || phone.replace(/[^0-9]/g, '')) + '_' + newExchanges,
    phone: phone,
    direction: 'outbound',
    body: reply,
    timestamp: new Date().toISOString(),
    status: 'queued',
    is_ai_reply: ['yes'],
    approval_status: 'not_required'
  };
  return out;
})()`;

// Delivery-status annotation (feature 2026-07-13): the phone acks every
// outbound SMS asynchronously (aokie.sms.sent when the PUT is accepted,
// aokie.sms.failed when the radio abandons a send). The ack payload's
// messageId is minted by the plugin and never matches our Messages rows,
// so the newest QUEUED outbound row for the recipient is the correlation
// — sends to one number are serialized through the per-task conversation
// loop, so newest-queued-first is reliable in practice.
const FLOW_SMS_DELIVERY = `(function () {
  var outcome = String(inputs.outcome || 'sent');
  if (outcome !== 'sent' && outcome !== 'failed') outcome = 'sent';
  var rows = (nodes.messages && nodes.messages.responses) || [];
  for (var i = 0; i < rows.length; i++) {
    var a = (rows[i] && rows[i].answers) || {};
    if (String(a.direction || '') === 'outbound' && String(a.status || '') === 'queued') {
      return {
        hasUpdate: true,
        responseId: rows[i].id,
        update: { status: outcome },
        summaryLine: 'Outbound SMS to ' + String(a.phone || '') + ' marked ' + outcome + '.'
      };
    }
  }
  return { hasUpdate: false, summaryLine: 'No queued outbound SMS row matched the ' + outcome + ' ack.' };
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
        {
          // PHASE 0.5 (call-policy spec): landlines take calls fine but can't
          // receive SMS — 'No' stops every automated text (kickoff + reply
          // loop) so the follow-up task tells a human to CALL instead. Blank
          // counts as Yes (mobiles are the common case; nothing changes for
          // existing records).
          id: 'sms_capable',
          type: 'dropdown',
          label: 'Can receive SMS',
          required: false,
          description:
            "Set to No for landlines: the receptionist then never texts this customer — booking confirmations become call-back tasks for the team instead. Blank counts as Yes.",
          properties: { options: [{ id: 'yes', label: 'Yes', value: 'yes' }, { id: 'no', label: 'No (landline)', value: 'no' }] },
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
        // matchField: a customer's record page also lists calls whose caller phone equals the
        // customer's phone (on top of the explicit link the caller-lookup flow writes) — so call
        // history is browsable per customer, each row opening the call + its transcript.
        { id: 'customer_link', type: 'linked_record', label: 'Customer', required: false, properties: { targetFormId: '@pack:customers', matchField: 'caller_phone', targetMatchField: 'phone', relatedAllowAdd: false, relatedPageSize: 10 } },
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
              // Phase 1 abuse handling: the agent flagged the caller and the
              // plugin ended the call by policy — its own status so the audit
              // trail never reads as an ordinary completion.
              { id: 'terminated_abuse', label: 'Ended (abusive caller)', value: 'terminated_abuse' },
              // Phase 2 outbound: we dialed, the remote alerted, nobody
              // picked up (never used for inbound calls — those are missed).
              { id: 'no_answer', label: 'No answer (outbound)', value: 'no_answer' },
            ],
          },
        },
        // Phase 2: which way the call went. Blank = inbound (every record
        // from before this field existed is an inbound call).
        {
          id: 'direction',
          type: 'dropdown',
          label: 'Direction',
          required: false,
          properties: {
            options: [
              { id: 'inbound', label: 'Inbound', value: 'inbound' },
              { id: 'outbound', label: 'Outbound (receptionist called)', value: 'outbound' },
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
      // No "New Call" button: call records are written exclusively by the flow/app
      // logic from live call events — a hand-typed call row would just be wrong data.
      customScreen: {
        enabled: true,
        allowNewResponses: false,
        kind: 'sdk',
        sdkScreen: { screenId: 'aokie-live-call', title: 'Live Call' },
        // Individual call records render their transcript as chat bubbles; the widget consumes
        // the call_link related group so the raw Transcript Turns grid isn't shown twice.
        // consumesRelated is packFormId-qualified: follow-up-tasks ALSO link here through a
        // field named call_link, and that group must stay visible in the related panel.
        recordScreen: { kind: 'sdk', screenId: 'aokie-call-transcript', title: 'Transcript', consumesRelated: ['transcript-turns.call_link'] },
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
        // matchField: turns are written by app logic that never knows the Calls row id, so the
        // relationship joins on the shared call_id key (read-side; see RelatedRecords helper).
        { id: 'call_link', type: 'linked_record', label: 'Call', required: false, properties: { targetFormId: '@pack:calls', matchField: 'call_id', targetMatchField: 'call_id', relatedPageSize: 20, relatedAllowAdd: false, relatedColumnFieldIds: ['speaker', 'text', 'turn_index'] } },
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
      description: 'Every inbound and outbound SMS. Inbound rows land automatically; AI reply drafts wait for approval before sending, while booking-confirmation texts from the SMS follow-up loop send automatically and are logged here.',
      settings: { ...defaultSettings, retentionDays: 90 },
      theme: { ...defaultTheme },
      fields: [
        { id: 'message_id', type: 'short_text', label: 'Message ID', required: false, properties: {} },
        // matchField: messages are written by app logic that never knows the thread's row id, so
        // the relationship joins on the shared phone key (read-side; see RelatedRecords helper).
        { id: 'thread_link', type: 'linked_record', label: 'Thread', required: false, properties: { targetFormId: '@pack:sms-threads', matchField: 'phone', targetMatchField: 'phone', relatedPageSize: 10, relatedAllowAdd: false, relatedColumnFieldIds: ['body', 'direction', 'status'] } },
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
        // phone + call_id: correlation handles for the SMS follow-up loop — the
        // sms-followup-conversation flow finds this appointment by the texter's
        // number (phone_eq) and matches it to its task via the shared call_id.
        { id: 'phone', type: 'phone', label: 'Phone', required: false, properties: { placeholder: '+61 400 000 000' } },
        { id: 'call_id', type: 'short_text', label: 'Call ID', required: false, properties: {} },
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
      description: 'Callbacks and follow-ups — created by the receptionist or automatically by the after-call flows. Booking-confirmation tasks are worked by the SMS follow-up loop (see the SMS follow-up field): the bot texts the customer, updates the booking from their replies, and closes the task — or hands it back to a human.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        { id: 'customer_link', type: 'linked_record', label: 'Customer', required: false, properties: { targetFormId: '@pack:customers' } },
        { id: 'call_link', type: 'linked_record', label: 'Call', required: false, properties: { targetFormId: '@pack:calls' } },
        // phone + call_id: how the SMS follow-up loop finds this task — an inbound
        // text is matched by phone_eq on the sender's number, and the task's
        // call_id ties it to the appointment the same call created.
        { id: 'phone', type: 'phone', label: 'Phone', required: false, properties: { placeholder: '+61 400 000 000' } },
        { id: 'call_id', type: 'short_text', label: 'Call ID', required: false, properties: {} },
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
        // SMS follow-up loop state (blank = not SMS-managed). 'active' is the switch
        // the sms-followup-conversation flow acts on — and the sms-auto-reply-draft
        // flow defers to — so exactly one path ever answers a given inbound text.
        {
          id: 'sms_state',
          type: 'dropdown',
          label: 'SMS follow-up',
          required: false,
          properties: {
            options: [
              { id: 'active', label: 'Texting — awaiting customer reply', value: 'active' },
              { id: 'done', label: 'Resolved by SMS', value: 'done' },
              { id: 'handoff', label: 'Needs a human', value: 'handoff' },
              { id: 'opted_out', label: 'Customer opted out (STOP)', value: 'opted_out' },
            ],
          },
        },
        { id: 'sms_exchanges', type: 'number', label: 'SMS messages sent', required: false, properties: { min: 0, step: 1 } },
        // Phase 2 missed-call callback queue (blank = not a callback task).
        // 'queued' is the switch the outbound-callback-result flow acts on:
        // the missed-call flow creates the task queued + fires call.dial; the
        // callback's own call.ended then transitions it (reached / sms_sent /
        // needs_human). A refused dial (outbound off, quiet hours, cap) just
        // leaves it queued — visibly pending for a human.
        {
          id: 'callback_state',
          type: 'dropdown',
          label: 'Callback',
          required: false,
          properties: {
            options: [
              { id: 'queued', label: 'Calling back automatically', value: 'queued' },
              { id: 'reached', label: 'Reached by callback', value: 'reached' },
              { id: 'sms_sent', label: "Couldn't reach — apology text sent", value: 'sms_sent' },
              { id: 'needs_human', label: "Couldn't reach — please ring them", value: 'needs_human' },
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
      // table + driver install, phone status, recent hardware events). Rows are written
      // AUTOMATICALLY from aokie.hardware.error events — a manual "New device setup"
      // button is meaningless here, so new responses stay off (feature request 2026-07-13).
      customScreen: {
        enabled: true,
        allowNewResponses: false,
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
      // Settings-style singleton: one record, edited in place — opening the section jumps
      // straight into editing it (the entry form only shows until the first save).
      settings: { ...defaultSettings, singleRecord: true },
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
          // BUSINESS INFO grounding (2026-07-13: the agent invented a menu on
          // a live call). The ONLY facts the AI may share about the business —
          // anything not covered here it must offer to have the team confirm.
          id: 'business_info',
          type: 'long_text',
          label: 'Business info the AI may share',
          required: false,
          properties: {
            placeholder:
              'Menu, services, prices, opening hours, parking, policies, FAQ… The AI answers business questions ONLY from this text and never invents details. Leave it blank and the AI offers to have the team confirm instead.',
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
        {
          // PHASE 0.5 record-driven screening (flow layer): read per call by
          // the personalize-caller flow, so it applies from the NEXT call —
          // no reconnect. Distinct from the plugin-level number rules
          // (blockedNumbers / acceptPattern) which live in plugin settings.
          id: 'whitelist_only',
          type: 'dropdown',
          label: 'Whitelist mode (known customers only)',
          required: false,
          description:
            'Yes = callers with no Customer record are rejected as soon as their number is known; customers whose Status is Blocked are always rejected. Callers who WITHHOLD their number are not covered by this — use "Screen private numbers" in Call screening for those.',
          properties: { options: [{ id: 'no', label: 'No (allow everyone)', value: 'no' }, { id: 'yes', label: 'Yes (known customers only)', value: 'yes' }] },
        },
        {
          // PHASE 0.5 defaultCountryCode: outbound SMS to a locally-typed
          // number (leading 0) is sent as +CC…; RECOGNITION is unaffected
          // (matching is digits-only last-9-suffix everywhere).
          id: 'default_country_code',
          type: 'short_text',
          label: 'Default country code for texts (e.g. +61)',
          required: false,
          description:
            'Used when texting a customer whose saved number starts with 0: the leading 0 is replaced with this code (0412… becomes +61412…). Leave blank to send numbers exactly as saved. Caller recognition does not need this.',
          properties: { placeholder: 'e.g. +61' },
        },
        { id: 'active', type: 'dropdown', label: 'Active', required: false, properties: { options: [{ id: 'yes', label: 'Yes', value: 'yes' }, { id: 'no', label: 'No', value: 'no' }] } },
      ],
      // The section IS the settings console (SDK screen): grouped cards, a
      // live "what the receptionist is running now" readout (settings.get)
      // and Save & apply now (settings.set, same payload as the Configure
      // Receptionist flow). The screen manages the singleton record itself,
      // so the generic New-record chrome stays off.
      customScreen: {
        enabled: true,
        allowNewResponses: false,
        kind: 'sdk',
        sdkScreen: { screenId: 'aokie-receptionist-settings', title: 'Receptionist Settings' },
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
          // KPI rows (audit AOK-DASH-001): row 1 is TODAY's operational
          // activity (every tile shares the 'today' window in the business
          // timezone — ReportService buckets/filters agree on the boundary);
          // row 2 is CURRENT-STATE gauges (open work + totals) that are
          // deliberately NOT time-windowed and say so in their titles. Mixing
          // today's counts with all-time totals in one unlabelled row was the
          // finding. Every KPI drills to its matching records.
          widgets: [
            { id: 'k1', title: 'Calls today', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: '__submitted_at', op: 'today' }] } },
            { id: 'k2', title: 'Missed today', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'missed' }, { field: '__submitted_at', op: 'today' }] } },
            { id: 'k3', title: 'Bookings today', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:appointments', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: '__submitted_at', op: 'today' }] } },
            { id: 'k4', title: 'Orders today', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:orders', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: '__submitted_at', op: 'today' }] } },
            { id: 'k5', title: 'Avg call today (sec)', layout: { x: 0, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:calls', viz: 'kpi', measure: { fn: 'avg', field: 'duration_seconds' }, filters: [{ field: '__submitted_at', op: 'today' }] } },
            { id: 'k6', title: 'Open follow-ups', layout: { x: 3, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:follow-up-tasks', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'open' }] } },
            { id: 'k7', title: 'Pending SMS approvals', layout: { x: 6, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:sms-messages', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'approval_status', op: 'eq', value: 'pending_approval' }] } },
            { id: 'k8', title: 'Customers (all time)', layout: { x: 9, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customers', viz: 'kpi', measure: { fn: 'count' } } },
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
          'connector.aokie.phone.disconnect',
          'connector.aokie.phone.connect',
          'connector.aokie.call.current',
          'connector.aokie.call.answer',
          'connector.aokie.call.reject',
          'connector.aokie.call.hangup',
          'connector.aokie.call.operatorSpeak',
          'connector.aokie.call.configureAgent',
          // Phase 2 outbound: the plugin's kill switch (outboundEnabled,
          // default OFF) + quiet hours + daily cap gate every dial — this
          // grant alone can never place a call.
          'connector.aokie.call.dial',
          'connector.aokie.sms.threads',
          'connector.aokie.sms.thread',
          'connector.aokie.sms.send',
          // The Receptionist Settings console reads the RUNNING config and
          // pushes 'Save & apply now' / Call screening via settings.get/set —
          // these grants vanished in an earlier permission sync and the whole
          // console quietly hid its apply controls (live report 2026-07-14).
          'connector.aokie.settings.get',
          'connector.aokie.settings.set',
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
      // connector.aokie.<command> permission rows are ENFORCED server-side: the remote
      // relay checks them per command (memberCanRelay) and the desktop's local loopback
      // requires a capability minted from them (SEC-001). Least privilege by design
      // (audit AOK-ROLE-001): Receptionist operates calls/SMS but cannot rewire
      // endpoints or install drivers; Device Admin administers hardware/settings but
      // cannot answer or speak; Viewer reads records only.
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
          name: 'Device Admin',
          description:
            'Hardware & configuration delegation (audit AOK-ROLE-001): dongle setup, phone pairing, receptionist settings and outbox redrive — WITHOUT call operation. settings.set can redirect caller audio (sttEndpoint/ttsEndpoint), so it deliberately lives here, not with front-desk staff.',
          permissions: [
            { packFormId: 'hardware-events', permission: 'submit_responses' },
            { packFormId: 'hardware-events', permission: 'view_all_responses' },
            { packFormId: 'receptionist-settings', permission: 'submit_responses' },
            { packFormId: 'receptionist-settings', permission: 'view_all_responses' },
            { packFormId: 'receptionist-settings', permission: 'edit_responses' },
            { packFormId: null, permission: 'connector.aokie.dongle.list' },
            { packFormId: null, permission: 'connector.aokie.dongle.getPreferred' },
            { packFormId: null, permission: 'connector.aokie.dongle.setPreferred' },
            { packFormId: null, permission: 'connector.aokie.dongle.installDriver' },
            { packFormId: null, permission: 'connector.aokie.dongle.diagnostics' },
            { packFormId: null, permission: 'connector.aokie.phone.status' },
            { packFormId: null, permission: 'connector.aokie.phone.startPairing' },
            { packFormId: null, permission: 'connector.aokie.phone.stopPairing' },
            { packFormId: null, permission: 'connector.aokie.phone.listPaired' },
            { packFormId: null, permission: 'connector.aokie.phone.disconnect' },
            { packFormId: null, permission: 'connector.aokie.phone.connect' },
            { packFormId: null, permission: 'connector.aokie.settings.get' },
            { packFormId: null, permission: 'connector.aokie.settings.set' },
            { packFormId: null, permission: 'connector.aokie.outbox.redrive' },
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
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            // phone_eq: digits-only last-9-suffix match pushed down to the
            // database (answersPhone.<field>), so the lookup finds the
            // customer at ANY table size instead of scanning the newest 200.
            data: { form: '@pack:customers', return: 'all', limit: 5, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.callerPhone' }] },
          },
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
      name: 'Personalize Caller',
      slug: 'personalize-caller',
      description:
        "Sync on aokie.call.caller_id (the caller's number becomes known ~1s after an instant auto-answer — usually before the greeting plays): match the number against Customers (digits-only, last-9 suffix so +61… and 04… formats agree) and push a by-name greeting plus a KNOWN-CALLER persona block via call.configureAgent — a CALL-SCOPED overlay the plugin wipes at the call boundary, so a failed or raced setup on the NEXT call can never leak this caller's personalization to a different caller (settings.set remains for durable, caller-independent config). Unknown numbers push the same base config as a call-scoped overlay (identical to the global config — a no-op in effect). If this loses the race with the greeting, the persona context still personalizes every AI reply on the call. RECORD-DRIVEN SCREENING (call-policy spec Phase 0.5): a matched customer whose Status is 'blocked' — or, in whitelist mode (Receptionist Settings), any caller with NO Customer record — is rejected via call.reject instead of configured: the call ends immediately and its Calls row reads outcome 'rejected'. Withheld numbers never reach this flow (no caller_id event) — the plugin's 'Screen private numbers' setting covers those.",
      nodeCapabilities: ['formlogic.responses.read', 'connector.aokie.call.configureAgent', 'connector.aokie.call.reject'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }] } },
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            // phone_eq: digits-only last-9-suffix match pushed down to the
            // database, so the caller is recognised at ANY customer count.
            data: { form: '@pack:customers', return: 'all', limit: 5, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          {
            id: 'appointments',
            type: 'formlogic_list_responses',
            // The caller's bookings on record (phone_eq, DB-pushed): the make
            // block filters to upcoming requested/confirmed and grounds the
            // persona so the agent answers calendar questions from RECORDS.
            data: { form: '@pack:appointments', return: 'all', limit: 20, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          {
            id: 'allappts',
            type: 'formlogic_list_responses',
            // The WHOLE calendar (bounded): the persona gets a privacy-safe
            // occupancy digest (times only, never other callers' names) so
            // the agent answers "are you free on Friday?" from records.
            data: { form: '@pack:appointments', return: 'all', limit: 200 },
          },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'make', type: 'logic_block', data: { expr: FLOW_PERSONALIZE_CALLER } },
          // PHASE 0.5: blocked customer / not-on-whitelist → reject the call
          // instead of configuring the agent for it. Exclusive branches: a
          // rejected call must never also receive a persona push (and a
          // configured call must never be hung up on).
          { id: 'gate', type: 'condition', data: { expr: '(nodes.make || {}).reject === true' } },
          {
            id: 'reject',
            type: 'connector_request',
            data: {
              connectorId: 'aokie',
              command: 'call.reject',
              // On post-answer-id phones (the live Pixel: CLCC) the call is
              // already active — reject_or_hangup ends it cleanly and the
              // session tracker records outcome 'rejected' (audit trail).
              payload: { callId: '$inputs.callId' },
            },
          },
          {
            id: 'push',
            type: 'connector_request',
            data: {
              connectorId: 'aokie',
              command: 'call.configureAgent',
              // Call-scoped: the overlay names ITS call and dies with it. The
              // persona takes effect on the NEXT caller turn; the greeting
              // applies if it lands before the greeting plays (it usually does).
              payload: { callId: '$inputs.callId', persona: '$nodes.make.persona', greeting: '$nodes.make.greeting' },
            },
          },
          { id: 'out', type: 'output', data: { value: { found: '$nodes.make.found', name: '$nodes.make.name', greeting: '$nodes.make.greeting', reject: '$nodes.make.reject', rejectReason: '$nodes.make.rejectReason' } } },
        ],
        edges: [
          { source: 'in', target: 'customers' },
          { source: 'customers', target: 'appointments' },
          { source: 'appointments', target: 'allappts' },
          { source: 'allappts', target: 'settings' },
          { source: 'settings', target: 'make' },
          { source: 'make', target: 'gate' },
          { source: 'gate', target: 'reject', sourceHandle: 'true' },
          { source: 'gate', target: 'push', sourceHandle: 'false' },
          { source: 'reject', target: 'out' },
          { source: 'push', target: 'out' },
        ],
      },
    },
    {
      name: 'Business Lookup',
      slug: 'business-lookup',
      description:
        "Mid-call live lookup (2026-07-14): the Aokie plugin invokes this over the plugin flow.run RPC while the agent is ON the call - the agent replied [[LOOKUP: question]] and speaks its answer from the digest this flow returns (date questions get a flow-composed spoken sentence delivered verbatim). Read-only and deterministic (no LLM, no writes): 90-day calendar occupancy with TIMES ONLY for ordinary callers (other customers are never named) plus the caller phone number own bookings. MANAGER CALLS (Phase 3): the plugin sets manager:true in its flow.run input when the caller id matched managerNumbers - the digest and spoken answers then include customer NAMES on occupancy slots (the condition-gated customers fetch only runs for managers; caller ID alone stays READ-ONLY - writes will require the spoken PIN). The appointments fetch is windowed IN THE DATABASE (gte/lte pushdown) so a growing calendar cannot overflow the fetch cap. No event binding - it only runs when the plugin asks.",
      nodeCapabilities: ['formlogic.responses.read'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'question', example: 'Any tables free Friday night?' }, { name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }, { name: 'manager', example: false }] } },
          // The window bounds the DB query itself: gte/lte push down (server
          // filters BEFORE the limit), so old + far-future rows never crowd
          // in-window bookings out of the 200-row cap.
          { id: 'win', type: 'logic_block', data: { expr: FLOW_LOOKUP_WINDOW } },
          {
            id: 'appts',
            type: 'formlogic_list_responses',
            data: {
              form: '@pack:appointments',
              return: 'all',
              limit: 200,
              filters: [
                { field: 'date', op: 'gte', value: '$nodes.win.todayIso' },
                { field: 'date', op: 'lte', value: '$nodes.win.horizonIso' },
              ],
            },
          },
          // Phase 3: the customer-name map costs a 200-row fetch — only
          // manager calls pay it. $nodes.customers is null on the false
          // branch, which the make block treats as "no names".
          { id: 'mgr', type: 'condition', data: { expr: 'inputs.manager === true' } },
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            data: { form: '@pack:customers', return: 'all', limit: 200 },
          },
          { id: 'make', type: 'logic_block', data: { expr: FLOW_BUSINESS_LOOKUP } },
          { id: 'out', type: 'output', data: { value: { digest: '$nodes.make.digest', spoken: '$nodes.make.spoken' } } },
        ],
        edges: [
          { source: 'in', target: 'win' },
          { source: 'win', target: 'appts' },
          { source: 'appts', target: 'mgr' },
          { source: 'mgr', target: 'customers', sourceHandle: 'true' },
          { source: 'mgr', target: 'make', sourceHandle: 'false' },
          { source: 'customers', target: 'make' },
          { source: 'make', target: 'out' },
        ],
      },
    },
    {
      name: 'Manager Action Plan',
      slug: 'manager-action-plan',
      description:
        "Phase 3 slice 2 (manager write tools): the Aokie plugin invokes this over flow.run ONLY after the caller passed BOTH manager gates - caller id matched managerNumbers AND the spoken PIN verified (deterministic digit comparison in the plugin; the model never sees or judges a PIN). The local LLM only STRUCTURES the manager's spoken request into one action (confirm / cancel / move a booking, block a number, or none); every date is re-validated as real-calendar and not-past, the target booking is matched against real records (an ambiguous day gets an honest spoken question listing the choices - never a guessed write), and the spoken outcome is composed from records, never model prose. This flow writes NOTHING: the plugin emits aokie.manager.action with the validated update and the manager-action-apply binding performs the single appointment write on the durable plane. No event binding - it only runs when the plugin asks.",
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'request', example: 'Cancel the 2 PM on Friday' }, { name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }] } },
          // Same DB-side window as business-lookup: managers change UPCOMING
          // bookings, so old + far-future rows never crowd the fetch cap.
          { id: 'win', type: 'logic_block', data: { expr: FLOW_LOOKUP_WINDOW } },
          {
            id: 'appts',
            type: 'formlogic_list_responses',
            data: {
              form: '@pack:appointments',
              return: 'all',
              limit: 200,
              filters: [
                { field: 'date', op: 'gte', value: '$nodes.win.todayIso' },
                { field: 'date', op: 'lte', value: '$nodes.win.horizonIso' },
              ],
            },
          },
          { id: 'customers', type: 'formlogic_list_responses', data: { form: '@pack:customers', return: 'all', limit: 200 } },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'ctx', type: 'logic_block', data: { expr: FLOW_MANAGER_CTX } },
          {
            id: 'decide',
            type: 'llm_chat',
            data: {
              system:
                'You structure a business manager\'s spoken request about their own booking calendar. Reply with ONLY one JSON object - no prose, no markdown fences.',
              prompt:
                'Today is {{nodes.ctx.today}}.\n\n{{nodes.ctx.llmContext}}\n\nReturn ONLY this JSON:\n{"action": "confirm" | "cancel" | "move" | "block" | "none", "target_date": "YYYY-MM-DD" or null, "target_time": "HH:MM" or null, "target_name": string or null, "new_date": "YYYY-MM-DD" or null, "new_time": "HH:MM" or null, "block_number": string or null}\n\nRules: "confirm" / "cancel" / "move" act on ONE existing booking from the list - set "target_date" to that booking\'s EXISTING date (resolve relative wording like "Friday" or "tomorrow" from today\'s date), and fill "target_time"/"target_name" only when the manager said them; for "move", "new_date"/"new_time" are the NEW slot in YYYY-MM-DD / 24-hour HH:MM (only the parts the manager gave); "block" is for blocking a phone number - put the digits they said in "block_number"; anything that is not one of these changes (questions, greetings, unclear speech) is "none". Use null when unsure - never guess.',
              model: '{{nodes.ctx.model}}',
              maxTokens: 250,
              temperature: 0,
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
            },
          },
          { id: 'plan', type: 'logic_block', data: { expr: FLOW_MANAGER_PLAN } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                ok: '$nodes.plan.ok',
                spoken: '$nodes.plan.spoken',
                summary: '$nodes.plan.summary',
                hasUpdate: '$nodes.plan.hasUpdate',
                updateId: '$nodes.plan.updateId',
                update: '$nodes.plan.update',
                hasBlock: '$nodes.plan.hasBlock',
                blockNumber: '$nodes.plan.blockNumber',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'win' },
          { source: 'win', target: 'appts' },
          { source: 'appts', target: 'customers' },
          { source: 'customers', target: 'settings' },
          { source: 'settings', target: 'ctx' },
          { source: 'ctx', target: 'decide' },
          { source: 'decide', target: 'plan' },
          { source: 'plan', target: 'out' },
        ],
      },
    },
    {
      name: 'Manager Action Apply',
      slug: 'manager-action-apply',
      description:
        "The write half of the manager line: bound to aokie.manager.action, which the plugin emits ONLY for a PIN-verified manager change that the manager-action-plan flow validated. Deliberately a thin pass-through - validation already happened in the plan flow - so the binding's guarded output action performs the one appointment write on the durable plane (outboxed, acked, retried): a crash between the spoken confirmation and the write is replayed instead of lost.",
      nodeCapabilities: [],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: {
              inputs: [
                { name: 'callId', example: 'call_123' },
                { name: 'summary', example: 'Manager confirmed the Friday 14:00 booking.' },
                { name: 'hasUpdate', example: true },
                { name: 'updateId', example: 'resp_1' },
                { name: 'update', example: { status: 'confirmed' } },
              ],
            },
          },
          { id: 'pass', type: 'logic_block', data: { expr: FLOW_MANAGER_APPLY } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                hasUpdate: '$nodes.pass.hasUpdate',
                updateId: '$nodes.pass.updateId',
                update: '$nodes.pass.update',
                summaryLine: '$nodes.pass.summaryLine',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'pass' },
          { source: 'pass', target: 'out' },
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
          // call_id filters push the lookup into the DATABASE (audit
          // AOK-FLOW-001) — a call older than the fetch window is still
          // found. The context script's own scan stays as belt-and-braces.
          { id: 'calls', type: 'formlogic_list_responses', data: { form: '@pack:calls', return: 'all', limit: 200, filters: [{ field: 'call_id', op: 'eq', value: '$inputs.callId' }] } },
          { id: 'turns', type: 'formlogic_list_responses', data: { form: '@pack:transcript-turns', return: 'all', limit: 200, filters: [{ field: 'call_id', op: 'eq', value: '$inputs.callId' }] } },
          { id: 'context', type: 'logic_block', data: { expr: FLOW_CALL_CONTEXT } },
          {
            id: 'summary',
            type: 'llm_chat',
            data: {
              system: 'You are the note-taker for a small-business phone receptionist. Be brief and factual.',
              prompt:
                'Summarise this phone call in at most two sentences. Then on a new line write "FOLLOW-UP: yes" if the business must contact the caller again, otherwise "FOLLOW-UP: no".\n\nTranscript:\n{{nodes.context.transcript}}',
              maxTokens: 400,
              // Qwen3-class models otherwise burn the WHOLE budget in a hidden
              // <think> block and return empty content — seen as 'no transcript
              // summary available' on every live call while the extractor
              // (which has this override) worked fine.
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
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
        'Async after aokie.sms.received: draft a reply with the local LLM and store it as an outbound Messages row with approval_status pending_approval — a human approves before anything is sent. Defers to the SMS Follow-up Conversation flow: while the sender has an open SMS-managed follow-up task (sms_state active), that loop answers autonomously and no draft is produced; a STOP opt-out suppresses drafting too.',
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read', 'formlogic.responses.write'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'from', example: '+61400000000' }, { name: 'body', example: 'Are you open Sunday?' }] } },
          // Deference gate: is this sender mid-conversation with the automated
          // SMS follow-up loop (or opted out of texts entirely)? phone_eq pushes
          // the lookup into the database, so this works at any task count.
          {
            id: 'tasks',
            type: 'formlogic_list_responses',
            data: { form: '@pack:follow-up-tasks', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          {
            id: 'gate',
            type: 'condition',
            data: {
              expr: "(function () { var rows = (nodes.tasks && nodes.tasks.responses) || []; for (var i = 0; i < rows.length; i++) { var a = (rows[i] && rows[i].answers) || {}; var st = String(a.status || ''); var ss = String(a.sms_state || ''); if ((st === 'open' || st === 'in_progress') && (ss === 'active' || ss === 'opted_out')) return false; } return true; })()",
            },
          },
          {
            id: 'draft',
            type: 'llm_chat',
            data: {
              system: 'You draft short, friendly SMS replies for a small-business receptionist. Reply with the SMS text only — no preamble.',
              prompt: 'Draft a reply to this SMS from {{inputs.from}}:\n\n{{inputs.body}}',
              maxTokens: 120,
              // Same Qwen3 thinking-mode guard as every other llm_chat node.
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
            },
          },
          // Converges from both gate branches: when the gate skipped the draft
          // node, nodes.draft is absent → content '' → hasDraft false.
          { id: 'build', type: 'logic_block', data: { expr: FLOW_SMS_DRAFT_BUILD } },
          { id: 'out', type: 'output', data: { value: { hasDraft: '$nodes.build.hasDraft', draftMessage: '$nodes.build.draftMessage' } } },
        ],
        edges: [
          { source: 'in', target: 'tasks' },
          { source: 'tasks', target: 'gate' },
          { source: 'gate', target: 'draft', sourceHandle: 'true' },
          { source: 'gate', target: 'build', sourceHandle: 'false' },
          { source: 'draft', target: 'build' },
          { source: 'build', target: 'out' },
        ],
      },
    },
    {
      name: 'SMS Follow-up Conversation',
      slug: 'sms-followup-conversation',
      description:
        "The autonomous half of the SMS follow-up loop: async on aokie.sms.received, match the sender to their open SMS-managed follow-up task (phone_eq, sms_state 'active') and to the appointment that task is about (shared call_id). STOP always opts the customer out, a plain YES confirms without a model call, and a hard cap of 6 outbound texts per task hands off to a human. Everything else goes to the local LLM, which decides confirm / reschedule / cancel / ask / handoff — the binding's guarded output actions then update the Appointment, update + close the task ('done'), send the reply (sms.send) and log it in Messages. Confirm/reschedule/cancel replies are composed from the records, never model prose. Senders with no active task are untouched — the SMS Auto Reply Draft flow keeps its human-approval path for them.",
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read'],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: { inputs: [{ name: 'from', example: '+61400000000' }, { name: 'body', example: 'YES' }, { name: 'messageId', example: 'sms_123' }] },
          },
          // All three lookups are phone_eq on the sender's number, pushed down to
          // the database — the loop works at any table size.
          {
            id: 'tasks',
            type: 'formlogic_list_responses',
            data: { form: '@pack:follow-up-tasks', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          {
            id: 'appointments',
            type: 'formlogic_list_responses',
            data: { form: '@pack:appointments', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          {
            id: 'messages',
            type: 'formlogic_list_responses',
            data: { form: '@pack:sms-messages', return: 'all', limit: 30, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          // PHASE 0.5: the sender's Customer record (phone_eq) — an owner can
          // mark a customer not-SMS-capable or blocked MID-LOOP; the ctx block
          // then stops the loop deterministically (verdict 'no_sms').
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            data: { form: '@pack:customers', return: 'all', limit: 5, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.from' }] },
          },
          { id: 'ctx', type: 'logic_block', data: { expr: FLOW_SMS_CONVO_CTX } },
          // Only the 'llm' verdict pays for a model call: no matching task, STOP,
          // a plain YES, and the exchange cap are all decided deterministically.
          { id: 'gate', type: 'condition', data: { expr: "String((nodes.ctx || {}).verdict || '') === 'llm'" } },
          {
            id: 'decide',
            type: 'llm_chat',
            data: {
              system:
                'You manage SMS follow-ups for a small-business receptionist: confirming, moving or cancelling booking requests. Reply with ONLY one JSON object — no prose, no markdown fences.',
              prompt:
                'Today is {{nodes.ctx.today}}.\n\n{{nodes.ctx.llmContext}}\n\nReturn ONLY this JSON:\n{"action": "confirm" | "reschedule" | "cancel" | "ask" | "handoff", "target_date": "YYYY-MM-DD" or null, "date": "YYYY-MM-DD" or null, "time": "HH:MM" or null, "service": string or null, "actions": null or [{"action": "confirm" | "reschedule" | "cancel", "target_date": "YYYY-MM-DD", "date": "YYYY-MM-DD" or null, "time": "HH:MM" or null}], "reply": "one short friendly SMS (under 300 characters, plain text, no emoji)"}\n\nRules: "confirm" only when the customer clearly agrees to the listed booking(s) — a confirm covers ALL of them; when MORE THAN ONE booking is listed and they want to change or cancel one, set "target_date" to the EXISTING date of the booking they mean (from the list) — if you cannot tell which one, use "ask"; when ONE message asks DIFFERENT things for different bookings (example: "yes to Thursday and 6pm for Sunday" = confirm Thursday\'s booking AND move Sunday\'s to 18:00), fill the "actions" array with one entry per booking — each entry\'s "target_date" is that booking\'s EXISTING date from the list, and "date"/"time" are its NEW slot for a reschedule; otherwise set "actions" to null; "reschedule" when they propose a different day/time — "date"/"time" are the NEW slot; resolve relative dates ("next Tuesday", "tomorrow") from today\'s date and use 24-hour time; "cancel" only when they clearly no longer want a booking; "ask" when you need one clarifying detail (your reply is the question); "handoff" for anything else — complaints, other requests, or anything unclear. Never invent prices, opening hours or services; never promise anything except booking changes; use null when unsure — never guess.',
              model: '{{nodes.ctx.model}}',
              maxTokens: 350,
              temperature: 0,
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
            },
          },
          // Converges from both gate branches (nodes.decide is absent on the
          // deterministic path — the plan block only reads it for verdict 'llm').
          { id: 'plan', type: 'logic_block', data: { expr: FLOW_SMS_CONVO_PLAN } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                summaryLine: '$nodes.plan.summaryLine',
                hasApptUpdate: '$nodes.plan.hasApptUpdate',
                apptResponseId: '$nodes.plan.apptResponseId',
                apptUpdate: '$nodes.plan.apptUpdate',
                hasApptUpdate2: '$nodes.plan.hasApptUpdate2',
                apptResponseId2: '$nodes.plan.apptResponseId2',
                apptUpdate2: '$nodes.plan.apptUpdate2',
                hasApptUpdate3: '$nodes.plan.hasApptUpdate3',
                apptResponseId3: '$nodes.plan.apptResponseId3',
                apptUpdate3: '$nodes.plan.apptUpdate3',
                hasApptCreate: '$nodes.plan.hasApptCreate',
                newAppointment: '$nodes.plan.newAppointment',
                hasTaskUpdate: '$nodes.plan.hasTaskUpdate',
                taskId: '$nodes.plan.taskId',
                taskUpdate: '$nodes.plan.taskUpdate',
                hasReply: '$nodes.plan.hasReply',
                reply: '$nodes.plan.reply',
                outboundMessage: '$nodes.plan.outboundMessage',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'tasks' },
          { source: 'tasks', target: 'appointments' },
          { source: 'appointments', target: 'messages' },
          { source: 'messages', target: 'settings' },
          { source: 'settings', target: 'customers' },
          { source: 'customers', target: 'ctx' },
          { source: 'ctx', target: 'gate' },
          { source: 'gate', target: 'decide', sourceHandle: 'true' },
          { source: 'gate', target: 'plan', sourceHandle: 'false' },
          { source: 'decide', target: 'plan' },
          { source: 'plan', target: 'out' },
        ],
      },
    },
    {
      name: 'SMS Delivery Status',
      slug: 'sms-delivery-status',
      description:
        "Async on aokie.sms.sent / aokie.sms.failed (the phone's asynchronous ack of an outbound text): find the newest QUEUED outbound Messages row for the recipient and flip its status to sent or failed — so the Messages screen tells the truth about delivery instead of showing 'Queued' forever. The ack's messageId is plugin-minted and never matches our rows, so recipient + newest-queued is the correlation.",
      nodeCapabilities: ['formlogic.responses.read'],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: { inputs: [{ name: 'to', example: '+61400000000' }, { name: 'outcome', example: 'sent' }, { name: 'reason', example: '' }] },
          },
          {
            id: 'messages',
            type: 'formlogic_list_responses',
            data: { form: '@pack:sms-messages', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.to' }] },
          },
          { id: 'mark', type: 'logic_block', data: { expr: FLOW_SMS_DELIVERY } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                hasUpdate: '$nodes.mark.hasUpdate',
                responseId: '$nodes.mark.responseId',
                update: '$nodes.mark.update',
                summaryLine: '$nodes.mark.summaryLine',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'messages' },
          { source: 'messages', target: 'mark' },
          { source: 'mark', target: 'out' },
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
            data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'text', example: 'Are you open on Sunday?' }, { name: 'turn', example: 4 }] },
          },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'turns', type: 'formlogic_list_responses', data: { form: '@pack:transcript-turns', return: 'all', limit: 200, filters: [{ field: 'call_id', op: 'eq', value: '$inputs.callId' }] } },
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
        'The automation that makes it a real receptionist: async after aokie.call.ended, read this call\'s transcript turns, have the local LLM extract structured intent (who called, what they want, and the agreed date/time), then — via the binding\'s guarded output actions — add the caller to Customers if new, create a requested Appointment when a slot was agreed, log an Order when they ordered, and raise a Follow-up Task when a human needs to confirm (unclear time, message taken, or callback asked). Booking-intent tasks with a real caller number also kick off the SMS follow-up loop: a confirmation text goes out immediately (sms.send) and the SMS Follow-up Conversation flow drives the replies until the task closes. Malformed model output degrades to a follow-up task, never a bad record.',
      nodeCapabilities: ['model.llm.local', 'formlogic.responses.read'],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }, { name: 'callerPhone', example: '+61400000000' }] },
          },
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            // phone_eq: the digits-tail match IS expressible now — pushed
            // down to the database, so the lookup works at any customer
            // count instead of scanning the newest 200.
            data: { form: '@pack:customers', return: 'all', limit: 5, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.callerPhone' }] },
          },
          { id: 'turns', type: 'formlogic_list_responses', data: { form: '@pack:transcript-turns', return: 'all', limit: 200, filters: [{ field: 'call_id', op: 'eq', value: '$inputs.callId' }] } },
          { id: 'calls', type: 'formlogic_list_responses', data: { form: '@pack:calls', return: 'all', limit: 1, filters: [{ field: 'call_id', op: 'eq', value: '$inputs.callId' }] } },
          // The caller's existing appointments (phone_eq): dedupe guard (a
          // re-confirmed booking must not duplicate) + still-pending ones fold
          // into the new SMS loop's confirmation text.
          {
            id: 'appts',
            type: 'formlogic_list_responses',
            data: { form: '@pack:appointments', return: 'all', limit: 20, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.callerPhone' }] },
          },
          // Any still-active SMS loop for this number (phone_eq): the new loop
          // supersedes it, so a YES is never ambiguous between two threads.
          {
            id: 'tasks',
            type: 'formlogic_list_responses',
            data: { form: '@pack:follow-up-tasks', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.callerPhone' }] },
          },
          // Business name for the kickoff SMS the plan block composes.
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'ctx', type: 'logic_block', data: { expr: FLOW_AFTER_CALL_CTX } },
          {
            id: 'extract',
            type: 'llm_chat',
            data: {
              system:
                'You extract structured booking data from phone-call transcripts for a small business. Reply with ONLY one JSON object — no prose, no markdown fences.',
              prompt:
                'Today is {{nodes.ctx.today}}. The caller\'s phone number is {{nodes.ctx.phone}}.\n\nTranscript:\n{{nodes.ctx.transcript}}\n\nReturn ONLY this JSON:\n{"intent": "appointment" | "order" | "message" | "question" | "other", "sentiment": "positive" | "neutral" | "negative", "caller_name": string or null, "service": string or null, "appointments": [{"service": string or null, "date": "YYYY-MM-DD" or null, "time": "HH:MM" or null}], "summary": "one factual sentence", "callback_requested": true or false}\n\nRules: "appointments" lists EVERY separate booking the caller agreed to on THIS call (most calls have one; use [] when none was agreed); do NOT list a booking the caller merely mentioned already having; each entry\'s time must be one the caller explicitly said FOR THAT booking — never copy a time from one booking to another, use null when no time was stated; resolve relative dates ("tomorrow", "next Tuesday") from today\'s date; use 24-hour time; judge sentiment from the caller\'s tone; use null when unsure — never guess.',
              maxTokens: 700,
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
                hasCall: '$nodes.plan.hasCall',
                callResponseId: '$nodes.plan.callResponseId',
                callUpdate: '$nodes.plan.callUpdate',
                hasCustomerCreate: '$nodes.plan.hasCustomerCreate',
                customer: '$nodes.plan.customer',
                hasAppointment: '$nodes.plan.hasAppointment',
                appointment: '$nodes.plan.appointment',
                hasAppointment2: '$nodes.plan.hasAppointment2',
                appointment2: '$nodes.plan.appointment2',
                hasAppointment3: '$nodes.plan.hasAppointment3',
                appointment3: '$nodes.plan.appointment3',
                hasOrder: '$nodes.plan.hasOrder',
                order: '$nodes.plan.order',
                hasTask: '$nodes.plan.hasTask',
                task: '$nodes.plan.task',
                hasPriorTaskClose: '$nodes.plan.hasPriorTaskClose',
                priorTaskId: '$nodes.plan.priorTaskId',
                priorTaskUpdate: '$nodes.plan.priorTaskUpdate',
                hasKickoffSms: '$nodes.plan.hasKickoffSms',
                kickoffSms: '$nodes.plan.kickoffSms',
                kickoffMessage: '$nodes.plan.kickoffMessage',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'customers' },
          { source: 'customers', target: 'turns' },
          { source: 'turns', target: 'calls' },
          { source: 'calls', target: 'appts' },
          { source: 'appts', target: 'tasks' },
          { source: 'tasks', target: 'settings' },
          { source: 'settings', target: 'ctx' },
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
        "Async after a missed aokie.call.ended (binding condition gates on the missed outcome): raise a high-priority call-back task — and, Phase 2, CALL THEM BACK. When the caller is dialable (real number, not a blocked customer, no callback already pending) the task is created with callback_state 'queued' and the binding fires call.dial with a records-composed opening line ('sorry, we just missed your call'). The plugin's guardrails (outboundEnabled kill switch — default OFF, quiet hours, daily cap) refuse the dial typed, in which case the task simply stays queued for a human. The callback call's own call.ended (direction outbound) then transitions the task via the outbound-callback-result flow.",
      nodeCapabilities: ['formlogic.responses.read'],
      flowJson: {
        nodes: [
          { id: 'in', type: 'input', data: { inputs: [{ name: 'callerPhone', example: '+61400000000' }, { name: 'callId', example: 'call_123' }, { name: 'from', example: '+61400000000' }] } },
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            data: { form: '@pack:customers', return: 'all', limit: 5, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.callerPhone' }] },
          },
          // Existing open callbacks for this number: a second missed call
          // must not mint a second dial while one is already pending.
          {
            id: 'tasks',
            type: 'formlogic_list_responses',
            data: { form: '@pack:follow-up-tasks', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.callerPhone' }] },
          },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'task', type: 'logic_block', data: { expr: FLOW_MISSED_TASK } },
          { id: 'out', type: 'output', data: { value: { task: '$nodes.task.task', wantsCallback: '$nodes.task.wantsCallback', dial: '$nodes.task.dial' } } },
        ],
        edges: [
          { source: 'in', target: 'customers' },
          { source: 'customers', target: 'tasks' },
          { source: 'tasks', target: 'settings' },
          { source: 'settings', target: 'task' },
          { source: 'task', target: 'out' },
        ],
      },
    },
    {
      name: 'Outbound Callback Result',
      slug: 'outbound-callback-result',
      description:
        "Async on aokie.call.ended for OUTBOUND calls (direction 'outbound'): transition the pending missed-call callback task by what actually happened. Reached (outcome completed) → task done. Not reached (no_answer/failed) → sms_capable customers get a records-composed apology text (replies ride the existing human-approval draft path — deliberately NOT the booking confirmation loop) and the task stays open as 'sms_sent'; landline/blocked customers go straight to 'needs_human' at urgent priority. An outbound call with no queued callback task (e.g. a manual test dial) is a clean no-op.",
      nodeCapabilities: ['formlogic.responses.read'],
      flowJson: {
        nodes: [
          {
            id: 'in',
            type: 'input',
            data: { inputs: [{ name: 'callId', example: 'call_123' }, { name: 'to', example: '+61400000000' }, { name: 'outcome', example: 'no_answer' }] },
          },
          {
            id: 'tasks',
            type: 'formlogic_list_responses',
            data: { form: '@pack:follow-up-tasks', return: 'all', limit: 10, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.to' }] },
          },
          {
            id: 'customers',
            type: 'formlogic_list_responses',
            data: { form: '@pack:customers', return: 'all', limit: 5, filters: [{ field: 'phone', op: 'phone_eq', value: '$inputs.to' }] },
          },
          { id: 'settings', type: 'formlogic_list_responses', data: { form: '@pack:receptionist-settings', return: 'all', limit: 5 } },
          { id: 'plan', type: 'logic_block', data: { expr: FLOW_CALLBACK_RESULT } },
          {
            id: 'out',
            type: 'output',
            data: {
              value: {
                summaryLine: '$nodes.plan.summaryLine',
                hasTaskUpdate: '$nodes.plan.hasTaskUpdate',
                taskId: '$nodes.plan.taskId',
                taskUpdate: '$nodes.plan.taskUpdate',
                hasSms: '$nodes.plan.hasSms',
                sms: '$nodes.plan.sms',
                smsMessage: '$nodes.plan.smsMessage',
              },
            },
          },
        ],
        edges: [
          { source: 'in', target: 'tasks' },
          { source: 'tasks', target: 'customers' },
          { source: 'customers', target: 'settings' },
          { source: 'settings', target: 'plan' },
          { source: 'plan', target: 'out' },
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
      flow: 'personalize-caller',
      event: 'aokie.call.caller_id',
      connectorId: 'aokie',
      // Sync so the personalized greeting/persona push completes before later
      // events on this call are processed (per-call serial queues keep this
      // AFTER the incoming-bound Configure Receptionist push). The greeting
      // race is graceful: if the call's greeting already played, the persona
      // still personalizes every reply.
      mode: 'sync',
      timeoutMs: 3000,
      inputMap: { callId: '$event.data.callId', from: '$event.data.from' },
      // §9.7: sync live-call bindings carry a spoken fallback. If the
      // personalization stalls, the caller hears the generic greeting the
      // Configure Receptionist flow already set — never silence.
      fallbackPolicy: { onError: 'log_and_continue', fallbackReply: 'Thanks for calling! How can I help you today?' },
      sortOrder: 8,
    },
    {
      flow: 'call-summary-follow-up',
      event: 'aokie.call.ended',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 60000,
      condition: { type: 'expression', expr: "event && event.data ? Number(event.data.durationSeconds || 0) > 5 : false" },
      inputMap: { callId: '$event.data.callId' },
      // This binding OWNS the Calls summary only. Follow-up tasks are created
      // solely by the after-call-actions binding, whose structured needTask
      // (callback / message / booking) is the authoritative signal — so a booking
      // call gets ONE actionable task, not a duplicate generic one. (The decide
      // block still computes followUpRequired/followUpTask; they are intentionally
      // no longer wired to an output action.)
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:calls', when: '$result.hasCall', responseId: '$result.responseId', answers: '$result.callUpdate' },
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
      // missed-call binding below owns the missed path). Abuse-terminated calls
      // are skipped too (Phase 1): no records, tasks or SMS may be minted off
      // an abusive transcript — texting a just-blocked caller would be worse
      // than doing nothing. OUTBOUND calls are skipped as well (Phase 2, live
      // test call 2821e7e2: the INBOUND booking extractor ran on the very
      // first outbound test call and minted a junk appointment + an active
      // SMS confirmation loop at the callee) — outbound-aware post-call
      // processing arrives with the callback-queue slice. The call-summary
      // binding still records what happened on the Calls row.
      condition: {
        type: 'expression',
        expr: "event && event.data ? (Number(event.data.durationSeconds || 0) > 5 && String(event.data.outcome || '') !== 'missed' && String(event.data.status || '') !== 'missed' && String(event.data.outcome || '') !== 'terminated_abuse' && String(event.data.direction || '') !== 'outbound') : false",
      },
      inputMap: { callId: '$event.data.callId', from: '$event.data.from', callerPhone: '$event.data.callerPhone' },
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:calls', when: '$result.hasCall', responseId: '$result.callResponseId', answers: '$result.callUpdate' },
        { type: 'formlogic.submitResponse', form: '@pack:customers', when: '$result.hasCustomerCreate', answers: '$result.customer' },
        // A call can book up to THREE appointments (multi-booking, 2026-07-13);
        // each is its own gated create so a single booking stays a single write.
        { type: 'formlogic.submitResponse', form: '@pack:appointments', when: '$result.hasAppointment', answers: '$result.appointment' },
        { type: 'formlogic.submitResponse', form: '@pack:appointments', when: '$result.hasAppointment2', answers: '$result.appointment2' },
        { type: 'formlogic.submitResponse', form: '@pack:appointments', when: '$result.hasAppointment3', answers: '$result.appointment3' },
        { type: 'formlogic.submitResponse', form: '@pack:orders', when: '$result.hasOrder', answers: '$result.order' },
        // One SMS loop per phone: an earlier still-active loop closes as
        // superseded BEFORE the new task exists, so the conversation flow can
        // never match two active threads for one number.
        { type: 'formlogic.updateResponse', form: '@pack:follow-up-tasks', when: '$result.hasPriorTaskClose', responseId: '$result.priorTaskId', answers: '$result.priorTaskUpdate' },
        { type: 'formlogic.submitResponse', form: '@pack:follow-up-tasks', when: '$result.hasTask', answers: '$result.task' },
        // SMS follow-up kickoff: text the caller their booking confirmation request
        // the moment the task exists (actions run in order, so the task row above is
        // already written). A failed send surfaces in outputActionErrors + the
        // desktop error log; the task stays open either way, so nothing is lost.
        { type: 'connector.request', connectorId: 'aokie', command: 'sms.send', when: '$result.hasKickoffSms', payload: { to: '$result.kickoffSms.to', body: '$result.kickoffSms.body' } },
        { type: 'formlogic.submitResponse', form: '@pack:sms-messages', when: '$result.hasKickoffSms', answers: '$result.kickoffMessage' },
        { type: 'formlogic.toast', message: 'After-call: {{result.summaryLine}}' },
      ],
      retryPolicy: { maxAttempts: 2, backoff: 'exponential' },
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 7,
    },
    {
      flow: 'sms-followup-conversation',
      event: 'aokie.sms.received',
      connectorId: 'aokie',
      mode: 'async',
      // Reads four forms + (usually) one local-LLM decision; async, so it never
      // blocks the event queue. The inbound Messages row is already stored by the
      // app logic before bindings run, so the flow sees the full thread history.
      timeoutMs: 60000,
      inputMap: { from: '$event.data.from', body: '$event.data.body', messageId: '$event.data.messageId' },
      outputActions: [
        // Up to three appointment writes: a YES confirms EVERY booking the
        // loop covers (multi-booking, 2026-07-13).
        { type: 'formlogic.updateResponse', form: '@pack:appointments', when: '$result.hasApptUpdate', responseId: '$result.apptResponseId', answers: '$result.apptUpdate' },
        { type: 'formlogic.updateResponse', form: '@pack:appointments', when: '$result.hasApptUpdate2', responseId: '$result.apptResponseId2', answers: '$result.apptUpdate2' },
        { type: 'formlogic.updateResponse', form: '@pack:appointments', when: '$result.hasApptUpdate3', responseId: '$result.apptResponseId3', answers: '$result.apptUpdate3' },
        { type: 'formlogic.submitResponse', form: '@pack:appointments', when: '$result.hasApptCreate', answers: '$result.newAppointment' },
        { type: 'formlogic.updateResponse', form: '@pack:follow-up-tasks', when: '$result.hasTaskUpdate', responseId: '$result.taskId', answers: '$result.taskUpdate' },
        // Record updates land BEFORE the reply is sent, so the customer is never
        // told something the records don't yet say.
        { type: 'connector.request', connectorId: 'aokie', command: 'sms.send', when: '$result.hasReply', payload: { to: '$result.reply.to', body: '$result.reply.body' } },
        { type: 'formlogic.submitResponse', form: '@pack:sms-messages', when: '$result.hasReply', answers: '$result.outboundMessage' },
        { type: 'formlogic.toast', message: 'SMS follow-up: {{result.summaryLine}}' },
      ],
      retryPolicy: { maxAttempts: 2, backoff: 'exponential' },
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 9,
    },
    {
      flow: 'sms-delivery-status',
      event: 'aokie.sms.sent',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 15000,
      // The literal 'sent' rides the inputMap so ONE flow serves both acks.
      inputMap: { to: '$event.data.to', outcome: 'sent' },
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:sms-messages', when: '$result.hasUpdate', responseId: '$result.responseId', answers: '$result.update' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 10,
    },
    {
      flow: 'sms-delivery-status',
      event: 'aokie.sms.failed',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 15000,
      inputMap: { to: '$event.data.to', outcome: 'failed', reason: '$event.data.reason' },
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:sms-messages', when: '$result.hasUpdate', responseId: '$result.responseId', answers: '$result.update' },
        // A failed send is a customer who was promised a text — shout about it.
        { type: 'formlogic.toast', message: 'SMS to {{event.data.to}} FAILED: {{event.data.reason}}' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 11,
    },
    {
      flow: 'missed-call-follow-up',
      event: 'aokie.call.ended',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 15000,
      // Belt-and-braces direction guard: outbound attempts end no_answer/
      // failed (never 'missed'), but a missed OUTBOUND call must never
      // trigger its own callback loop.
      condition: {
        type: 'expression',
        expr: "event && event.data ? ((String(event.data.outcome || '') === 'missed' || String(event.data.status || '') === 'missed') && String(event.data.direction || '') !== 'outbound') : false",
      },
      inputMap: { callId: '$event.data.callId', callerPhone: '$event.data.callerPhone', from: '$event.data.from' },
      // Task row FIRST (always — the audit trail), then the dial. A refused
      // dial (kill switch off, quiet hours, daily cap) lands in
      // outputActionErrors and the task stays visibly 'queued' for a human.
      outputActions: [
        { type: 'formlogic.submitResponse', form: '@pack:follow-up-tasks', answers: '$result.task' },
        { type: 'connector.request', connectorId: 'aokie', command: 'call.dial', when: '$result.wantsCallback', payload: { number: '$result.dial.number', openingLine: '$result.dial.openingLine', purpose: '$result.dial.purpose' } },
        { type: 'formlogic.toast', message: 'Missed call: {{result.task.summary}}' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 4,
    },
    {
      flow: 'outbound-callback-result',
      event: 'aokie.call.ended',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 30000,
      condition: {
        type: 'expression',
        expr: "event && event.data ? String(event.data.direction || '') === 'outbound' : false",
      },
      inputMap: { callId: '$event.data.callId', to: '$event.data.from', outcome: '$event.data.outcome' },
      // Task transition BEFORE the apology text (same records-before-send
      // rule as the SMS loop), then the Messages row for the thread history.
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:follow-up-tasks', when: '$result.hasTaskUpdate', responseId: '$result.taskId', answers: '$result.taskUpdate' },
        { type: 'connector.request', connectorId: 'aokie', command: 'sms.send', when: '$result.hasSms', payload: { to: '$result.sms.to', body: '$result.sms.body' } },
        { type: 'formlogic.submitResponse', form: '@pack:sms-messages', when: '$result.hasSms', answers: '$result.smsMessage' },
        { type: 'formlogic.toast', message: 'Callback: {{result.summaryLine}}' },
      ],
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 12,
    },
    {
      flow: 'manager-action-apply',
      event: 'aokie.manager.action',
      connectorId: 'aokie',
      mode: 'async',
      timeoutMs: 15000,
      inputMap: {
        callId: '$event.data.callId',
        summary: '$event.data.summary',
        hasUpdate: '$event.data.hasUpdate',
        updateId: '$event.data.updateId',
        update: '$event.data.update',
      },
      // ONE guarded appointment write per event - the plan flow already
      // validated it and the manager already heard the spoken confirmation;
      // this is the durable copy of that promise.
      outputActions: [
        { type: 'formlogic.updateResponse', form: '@pack:appointments', when: '$result.hasUpdate', responseId: '$result.updateId', answers: '$result.update' },
        { type: 'formlogic.toast', message: 'Manager line: {{result.summaryLine}}' },
      ],
      retryPolicy: { maxAttempts: 2, backoff: 'exponential' },
      fallbackPolicy: { onError: 'log_and_continue' },
      sortOrder: 13,
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
      // DISABLED by default: the shipped install uses the IN-PLUGIN AI
      // receptionist, which owns replies — the plugin refuses operatorSpeak
      // while it does (double-responder guard), so this binding firing on
      // every caller turn just produced a guaranteed error run per turn
      // (live report 2026-07-13). Enable it ONLY when running flow-driven
      // replies (aiReceptionist off in the plugin settings).
      enabled: false,
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
      // `turn` rides along so aokie_speak's inResponseTo default (§9.2) can
      // name the caller turn this reply answers — a reply that loses the race
      // to a NEWER caller turn is refused typed (stale_turn) and skipped.
      inputMap: { callId: '$event.data.callId', text: '$event.data.text', turn: '$event.data.turn' },
      fallbackPolicy: {
        onError: 'log_and_continue',
        fallbackReply: "Sorry, I didn't catch that — could you say it again?",
      },
      sortOrder: 6,
    },
  ],
};
