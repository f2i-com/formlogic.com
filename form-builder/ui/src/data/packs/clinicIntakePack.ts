// ── Type re-use ─────────────────────────────────────────────────────────────
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
  primaryColor: '#0891b2',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const clinicIntakePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'clinic-appointment-intake',
    name: 'Clinic Appointment & Intake',
    description:
      'A light front-desk toolkit for a small clinic: register patients, manage providers, book and track appointments, collect patient intake details and consent, and schedule follow-ups — all linked together on one dashboard. Administrative only; no diagnoses or treatment records.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['clinic', 'appointments', 'intake', 'patients', 'front-desk'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Patient ────────────────────────────────────────────────────────
    {
      packFormId: 'patient',
      title: 'Patient',
      icon: 'User',
      description:
        'Register a patient with their contact details, date of birth and emergency contact.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Register a Patient',
          description: 'Capture the patient details so you can book appointments and record intake.',
          required: false,
          properties: {},
        },
        {
          id: 'full_name',
          type: 'short_text',
          label: 'Full Name',
          required: true,
          properties: { placeholder: 'First and last name' },
        },
        {
          id: 'date_of_birth',
          type: 'date',
          label: 'Date of Birth',
          required: true,
          properties: {},
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: true,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: false,
          properties: { placeholder: 'you@example.com' },
        },
        {
          id: 'address',
          type: 'long_text',
          label: 'Address',
          required: false,
          properties: { placeholder: 'Street, suburb, state, postcode' },
        },
        {
          id: 'emergency_contact_name',
          type: 'short_text',
          label: 'Emergency Contact Name',
          required: false,
          properties: { placeholder: 'Full name of emergency contact' },
        },
        {
          id: 'emergency_contact_phone',
          type: 'phone',
          label: 'Emergency Contact Phone',
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
      ],
    },

    // ── 2. Provider ───────────────────────────────────────────────────────
    {
      packFormId: 'provider',
      title: 'Provider',
      icon: 'Stethoscope',
      description:
        'Add a clinician or practitioner with their role and availability status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'full_name',
          type: 'short_text',
          label: 'Provider Name',
          required: true,
          properties: { placeholder: 'e.g. Dr. Alex Morgan' },
        },
        {
          id: 'role',
          type: 'dropdown',
          label: 'Specialty / Role',
          required: true,
          properties: {
            options: [
              { id: 'gp', label: 'General Practitioner', value: 'gp' },
              { id: 'nurse', label: 'Nurse', value: 'nurse' },
              { id: 'physiotherapist', label: 'Physiotherapist', value: 'physiotherapist' },
              { id: 'dentist', label: 'Dentist', value: 'dentist' },
              { id: 'psychologist', label: 'Psychologist', value: 'psychologist' },
              { id: 'specialist', label: 'Specialist', value: 'specialist' },
            ],
          },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: false,
          properties: { placeholder: 'provider@clinic.example' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'active',
          type: 'checkbox',
          label: 'Availability',
          required: false,
          properties: {
            options: [
              { id: 'active', label: 'Currently accepting appointments', value: 'active' },
            ],
          },
        },
      ],
    },

    // ── 3. Appointment ────────────────────────────────────────────────────
    {
      packFormId: 'appointment',
      title: 'Appointment',
      icon: 'CalendarClock',
      description:
        'Book an appointment for a patient with a provider, including type, date, time and status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'patient',
          type: 'linked_record',
          label: 'Patient',
          required: false,
          properties: { targetFormId: '@pack:patient' },
        },
        {
          id: 'provider',
          type: 'linked_record',
          label: 'Provider',
          required: false,
          properties: { targetFormId: '@pack:provider' },
        },
        {
          id: 'appt_date',
          type: 'date',
          label: 'Appointment Date',
          required: true,
          properties: {},
        },
        {
          id: 'appt_time',
          type: 'time',
          label: 'Appointment Time',
          required: true,
          properties: {},
        },
        {
          id: 'appt_type',
          type: 'dropdown',
          label: 'Appointment Type',
          required: true,
          properties: {
            options: [
              { id: 'new-patient', label: 'New Patient', value: 'new-patient' },
              { id: 'follow-up', label: 'Follow-up', value: 'follow-up' },
              { id: 'consultation', label: 'Consultation', value: 'consultation' },
              { id: 'procedure', label: 'Procedure', value: 'procedure' },
              { id: 'telehealth', label: 'Telehealth', value: 'telehealth' },
            ],
          },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'arrived', label: 'Arrived', value: 'arrived' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'no-show', label: 'No-show', value: 'no-show' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Scheduling notes, reason for visit, room…' },
        },
      ],
    },

    // ── 4. Intake Form ────────────────────────────────────────────────────
    {
      packFormId: 'intake-form',
      title: 'Intake Form',
      icon: 'ClipboardList',
      description:
        'Collect patient intake details before a visit: reason, symptoms, medications and consent.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'patient',
          type: 'linked_record',
          label: 'Patient',
          required: false,
          properties: { targetFormId: '@pack:patient' },
        },
        {
          id: 'reason_for_visit',
          type: 'long_text',
          label: 'Reason for Visit',
          required: true,
          properties: { placeholder: 'Why are you coming in today?' },
        },
        {
          id: 'symptoms',
          type: 'long_text',
          label: 'Current Symptoms',
          required: false,
          properties: { placeholder: 'Describe any symptoms you are experiencing…' },
        },
        {
          id: 'current_medications',
          type: 'long_text',
          label: 'Current Medications',
          required: false,
          properties: { placeholder: 'List any medications you are currently taking…' },
        },
        {
          id: 'preferred_contact',
          type: 'dropdown',
          label: 'Preferred Contact Method',
          required: true,
          properties: {
            options: [
              { id: 'phone', label: 'Phone Call', value: 'phone' },
              { id: 'sms', label: 'Text Message', value: 'sms' },
              { id: 'email', label: 'Email', value: 'email' },
            ],
          },
        },
        {
          id: 'consent',
          type: 'checkbox',
          label: 'Consent',
          required: true,
          properties: {
            options: [
              { id: 'consent-to-treat', label: 'I consent to be seen and treated by the clinic', value: 'consent-to-treat' },
            ],
          },
        },
      ],
    },

    // ── 5. Follow-up ──────────────────────────────────────────────────────
    {
      packFormId: 'follow-up',
      title: 'Follow-up',
      icon: 'CalendarPlus',
      description:
        'Schedule a follow-up against an appointment with the next action and its status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'appointment',
          type: 'linked_record',
          label: 'Appointment',
          required: false,
          properties: { targetFormId: '@pack:appointment' },
        },
        {
          id: 'followup_date',
          type: 'date',
          label: 'Follow-up Date',
          required: true,
          properties: {},
        },
        {
          id: 'action',
          type: 'long_text',
          label: 'Action / Next Steps',
          required: true,
          properties: { placeholder: 'What needs to happen at or before the follow-up…' },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'pending', label: 'Pending', value: 'pending' },
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'front-desk',
      name: 'Front Desk',
      description:
        'A front-desk hub for a small clinic: register patients, manage providers, book appointments, capture intake and consent, and schedule follow-ups from one dashboard.',
      settings: {},
      theme: {
        primaryColor: '#0891b2',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'patient', displayName: 'Patients', sortOrder: 1, isVisible: true },
        { packFormId: 'provider', displayName: 'Providers', sortOrder: 2, isVisible: true },
        { packFormId: 'appointment', displayName: 'Appointments', sortOrder: 3, isVisible: true },
        { packFormId: 'intake-form', displayName: 'Intake Forms', sortOrder: 4, isVisible: true },
        { packFormId: 'follow-up', displayName: 'Follow-ups', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading Front Desk…</div></div></div>`,
        css: `
:root{color-scheme:light dark;}
*{box-sizing:border-box;}
#app{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fl-text);min-height:100vh;padding:28px 22px;background:radial-gradient(1100px 560px at 12% -12%,color-mix(in srgb,var(--fl-accent) 16%,transparent),transparent 60%),radial-gradient(900px 520px at 108% -6%,color-mix(in srgb,var(--fl-accent) 8%,transparent),transparent 55%),transparent;}
.wrap{max-width:1080px;margin:0 auto;}
.empty{padding:64px 0;text-align:center;color:var(--fl-muted);}
.hd{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap;}
.hd-left{display:flex;align-items:center;gap:14px;}
.logo{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;font-size:22px;background:var(--fl-accent);color:var(--fl-accent-contrast);box-shadow:0 6px 18px color-mix(in srgb,var(--fl-accent) 35%,transparent);}
.hd h1{margin:0;font-size:21px;font-weight:700;letter-spacing:-.01em;color:var(--fl-text);}
.hd .sub{margin:2px 0 0;font-size:13px;color:var(--fl-muted);}
.btn{font:inherit;cursor:pointer;border-radius:10px;border:1px solid transparent;padding:10px 16px;font-weight:600;font-size:13.5px;color:var(--fl-text);background:var(--fl-surface-2);transition:transform .12s ease,background .2s ease,border-color .2s ease;}
.btn:hover{transform:translateY(-1px);}
.btn:focus-visible{outline:2px solid var(--fl-accent);outline-offset:2px;}
.btn.primary{background:var(--fl-accent);color:var(--fl-accent-contrast);box-shadow:0 6px 16px color-mix(in srgb,var(--fl-accent) 32%,transparent);}
.btn.ghost{background:var(--fl-surface-2);border-color:var(--fl-border);}
.btn.sm{padding:7px 12px;font-size:12.5px;}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:18px;}
.card{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;padding:16px;box-shadow:var(--fl-shadow);}
.stat-top{display:flex;align-items:center;gap:8px;}
.dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 3px var(--fl-track);}
.stat-label{font-size:11.5px;color:var(--fl-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;}
.stat-val{font-size:29px;font-weight:750;color:var(--fl-text);margin-top:8px;line-height:1;}
.stat-hint{font-size:12px;color:var(--fl-faint);margin-top:6px;}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;}
.panel{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;padding:18px;box-shadow:var(--fl-shadow);}
.panel h2{margin:0 0 14px;font-size:14px;font-weight:700;color:var(--fl-text);display:flex;align-items:center;gap:8px;}
.panel h2 .tag{margin-left:auto;font-size:11px;font-weight:600;color:var(--fl-muted);background:var(--fl-surface-2);padding:3px 8px;border-radius:20px;}
.bar-row{display:grid;grid-template-columns:92px 1fr 34px;align-items:center;gap:10px;margin-bottom:12px;}
.bar-row:last-child{margin-bottom:0;}
.bar-name{font-size:12.5px;color:var(--fl-text);text-transform:capitalize;}
.bar-track{height:9px;border-radius:6px;background:var(--fl-track);overflow:hidden;}
.bar-fill{height:100%;border-radius:6px;transition:width 1s cubic-bezier(.22,1,.36,1);}
.bar-val{font-size:12.5px;color:var(--fl-muted);text-align:right;font-variant-numeric:tabular-nums;}
.item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--fl-border);}
.item:last-child{border-bottom:none;}
.item-main{min-width:0;flex:1;}
.item-title{display:block;font-size:13.5px;color:var(--fl-text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.item-meta{display:block;font-size:11.5px;color:var(--fl-faint);margin-top:2px;text-transform:capitalize;}
.badge{flex:none;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;border:1px solid;text-transform:capitalize;}
.empty-panel{text-align:center;color:var(--fl-muted);font-size:13px;padding:26px 0;display:flex;flex-direction:column;align-items:center;gap:12px;}
.actions{display:flex;flex-wrap:wrap;gap:10px;}
.actions .btn{display:flex;align-items:center;gap:8px;}
@media(max-width:860px){.stats{grid-template-columns:repeat(2,1fr);}.panels{grid-template-columns:1fr;}}
@media(max-width:460px){.stats{grid-template-columns:1fr;}}
`,
        js: `
var FL = window.FormLogic;
function h(s){ return FL.escapeHtml(s == null ? '' : String(s)); }
function findForm(ctx, name){
  var t = String(name).toLowerCase();
  for (var i=0;i<ctx.forms.length;i++){ if (String(ctx.forms[i].displayName||'').toLowerCase()===t) return ctx.forms[i]; }
  return null;
}
function fieldOptions(form, fieldId){
  if(!form) return [];
  for (var i=0;i<form.fields.length;i++){ var f=form.fields[i]; if(f.id===fieldId && f.properties && f.properties.options) return f.properties.options; }
  return [];
}
function optLabel(opts, val){
  for (var i=0;i<opts.length;i++){ if(opts[i].value===val) return opts[i].label; }
  return val ? String(val) : '';
}
function recs(form){ return form ? FL.records(form.formId, { limit: 500 }).catch(function(){ return []; }) : Promise.resolve([]); }
function recId(r){ return r ? (r.id || (r.answers ? r.answers.id : '') || '') : ''; }
function linkId(v){
  if(v == null) return '';
  if(Array.isArray(v)) return v.length ? linkId(v[0]) : '';
  if(typeof v === 'object') return v.id || v.recordId || v.value || '';
  return String(v);
}
function startOfToday(){ var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); }
function isToday(s){
  if(!s) return false;
  var d = new Date(s); if(isNaN(d.getTime())) return false;
  var now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
}
function fmtDate(s){
  if(!s) return '';
  var d = new Date(s); if(isNaN(d.getTime())) return '';
  var diff = Math.floor((d.getTime() - startOfToday())/86400000);
  if(diff === 0) return 'today';
  if(diff === 1) return 'tomorrow';
  if(diff === -1) return 'yesterday';
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
}
function fmtTime(s){
  if(!s) return '';
  var m = String(s).match(/^(\\d{1,2}):(\\d{2})/);
  if(!m) return String(s);
  var hr = parseInt(m[1],10); var mn = m[2];
  var ap = hr >= 12 ? 'PM' : 'AM';
  var h12 = hr % 12; if(h12===0) h12 = 12;
  return h12 + ':' + mn + ' ' + ap;
}
function statCard(label, value, hint, color){
  return '<div class="card stat">'
    + '<div class="stat-top"><span class="dot" style="background:'+color+'"></span><span class="stat-label">'+h(label)+'</span></div>'
    + '<div class="stat-val">'+h(value)+'</div>'
    + '<div class="stat-hint">'+h(hint)+'</div>'
    + '</div>';
}
function bar(label, count, max, color){
  var pct = max>0 ? Math.max(4, Math.round(count/max*100)) : 0;
  return '<div class="bar-row"><span class="bar-name">'+h(label)+'</span>'
    + '<div class="bar-track"><div class="bar-fill" data-pct="'+pct+'" style="width:0;background:'+color+'"></div></div>'
    + '<span class="bar-val">'+count+'</span></div>';
}
async function main(){
  var root = document.getElementById('app');
  var ctx;
  try { ctx = await FL.context(); } catch(e){ root.innerHTML = '<div class="wrap"><div class="empty">Could not load the dashboard.</div></div>'; return; }
  var user = await FL.currentUser().catch(function(){ return null; });

  var patientForm = findForm(ctx, 'Patients');
  var providerForm = findForm(ctx, 'Providers');
  var apptForm = findForm(ctx, 'Appointments');
  var intakeForm = findForm(ctx, 'Intake Forms');
  var followupForm = findForm(ctx, 'Follow-ups');

  var out = await Promise.all([recs(apptForm), recs(patientForm), recs(intakeForm)]);
  var appts = out[0], patients = out[1], intakes = out[2];

  // Patient id -> name map for resolving linked records.
  var patientMap = {};
  for (var i=0;i<patients.length;i++){
    var pid = recId(patients[i]);
    if(pid) patientMap[pid] = (patients[i].answers||{}).full_name || 'Patient';
  }

  var statusOpts = fieldOptions(apptForm, 'status');
  var typeOpts = fieldOptions(apptForm, 'appt_type');

  var statusColors = {
    'scheduled':'#38bdf8',
    'confirmed':'var(--fl-accent)',
    'arrived':'#a78bfa',
    'completed':'var(--fl-good)',
    'no-show':'var(--fl-bad)',
    'cancelled':'var(--fl-warn)'
  };
  var statusOrder = ['scheduled','confirmed','arrived','completed','no-show','cancelled'];
  var statusCounts = { 'scheduled':0, 'confirmed':0, 'arrived':0, 'completed':0, 'no-show':0, 'cancelled':0 };

  var start = startOfToday();
  var todayCount = 0, upcomingCount = 0, noShowCount = 0;
  var upcoming = [];
  for (var i=0;i<appts.length;i++){
    var a = appts[i].answers || {};
    var st = a.status;
    if(statusCounts[st]!=null) statusCounts[st]++;
    if(isToday(a.appt_date)) todayCount++;
    if(st==='no-show') noShowCount++;
    var d = new Date(a.appt_date).getTime();
    if(!isNaN(d) && d >= start && st!=='cancelled' && st!=='completed'){
      upcomingCount++;
      upcoming.push({ a:a, d:d });
    }
  }
  upcoming.sort(function(x,y){ return x.d - y.d; });

  // New patients registered in the last 30 days.
  var newPatients = 0, cutoff = Date.now() - 30*86400000;
  for (var i=0;i<patients.length;i++){
    var t = new Date(patients[i].submittedAt).getTime();
    if(!isNaN(t) && t >= cutoff) newPatients++;
  }

  // Patients still awaiting an intake form.
  var intakeSet = {};
  for (var i=0;i<intakes.length;i++){
    var ipid = linkId((intakes[i].answers||{}).patient);
    if(ipid) intakeSet[ipid] = true;
  }
  var pendingIntakes = 0;
  for (var i=0;i<patients.length;i++){
    var ppid = recId(patients[i]);
    if(ppid && !intakeSet[ppid]) pendingIntakes++;
  }

  var head = '<header class="hd"><div class="hd-left"><div class="logo">🩺</div>'
    + '<div><h1>'+h(ctx.appName || 'Front Desk')+'</h1>'
    + '<p class="sub">'+ (user ? 'Signed in as '+h(user.name || user.email || 'staff') : 'Clinic front desk') +' · '+patients.length+' patients</p></div>'
    + '</div><button class="btn primary" data-nav="appointment">+ New Appointment</button></header>';

  var stats = '<div class="stats">'
    + statCard('Today', todayCount.toLocaleString(), 'appointments today', 'var(--fl-accent)')
    + statCard('New Patients', newPatients.toLocaleString(), 'last 30 days', '#38bdf8')
    + statCard('Upcoming', upcomingCount.toLocaleString(), appts.length + ' total appts', '#a78bfa')
    + statCard('No-shows', noShowCount.toLocaleString(), (noShowCount>0 ? 'to follow up' : 'all clear'), 'var(--fl-bad)')
    + statCard('Pending Intakes', pendingIntakes.toLocaleString(), (pendingIntakes>0 ? 'awaiting intake' : 'all complete'), 'var(--fl-warn)')
    + '</div>';

  var maxStatus = 0;
  for (var si=0; si<statusOrder.length; si++){ if(statusCounts[statusOrder[si]] > maxStatus) maxStatus = statusCounts[statusOrder[si]]; }
  var barsHtml = '';
  if(appts.length === 0){
    barsHtml = '<div class="empty-panel">No appointments yet<button class="btn primary sm" data-nav="appointment">Book an appointment</button></div>';
  } else {
    for (var si=0; si<statusOrder.length; si++){
      var sk = statusOrder[si];
      barsHtml += bar(optLabel(statusOpts, sk) || sk, statusCounts[sk], maxStatus, statusColors[sk]);
    }
  }
  var statusPanel = '<div class="panel"><h2>Appointments by status<span class="tag">'+appts.length+' total</span></h2>'+barsHtml+'</div>';

  var itemsHtml = '';
  if(upcoming.length === 0){
    itemsHtml = '<div class="empty-panel">No upcoming appointments<button class="btn ghost sm" data-nav="patient">Register a patient</button></div>';
  } else {
    var n = Math.min(6, upcoming.length);
    for (var ri=0; ri<n; ri++){
      var a = upcoming[ri].a;
      var patName = patientMap[linkId(a.patient)] || 'Unassigned patient';
      var typeL = optLabel(typeOpts, a.appt_type) || 'Appointment';
      var sk2 = a.status;
      var statusL = optLabel(statusOpts, sk2) || 'Unset';
      var sc = statusColors[sk2] || 'var(--fl-faint)';
      var meta = typeL;
      var dt = fmtDate(a.appt_date);
      var tm = fmtTime(a.appt_time);
      if(dt) meta += ' · ' + dt;
      if(tm) meta += ' · ' + tm;
      itemsHtml += '<div class="item"><div class="item-main">'
        + '<span class="item-title">'+h(patName)+'</span>'
        + '<span class="item-meta">'+h(meta)+'</span></div>'
        + '<span class="badge" style="color:'+sc+';border-color:color-mix(in srgb,'+sc+' 40%,transparent);background:color-mix(in srgb,'+sc+' 13%,transparent)">'+h(statusL)+'</span>'
        + '</div>';
    }
  }
  var recentPanel = '<div class="panel"><h2>Today &amp; upcoming<span class="tag">next up</span></h2>'+itemsHtml+'</div>';

  var actionDefs = [
    { key:'appointment', form:apptForm, label:'New Appointment', icon:'📅' },
    { key:'patient', form:patientForm, label:'Register Patient', icon:'👤' },
    { key:'intake', form:intakeForm, label:'New Intake', icon:'📝' },
    { key:'provider', form:providerForm, label:'Add Provider', icon:'🩺' },
    { key:'followup', form:followupForm, label:'New Follow-up', icon:'🔁' }
  ];
  var actionsHtml = '';
  for (var ai=0; ai<actionDefs.length; ai++){
    if(!actionDefs[ai].form) continue;
    actionsHtml += '<button class="btn ghost" data-nav="'+actionDefs[ai].key+'"><span aria-hidden="true">'+actionDefs[ai].icon+'</span>'+h(actionDefs[ai].label)+'</button>';
  }
  var actions = '<div class="panel"><h2>Quick actions</h2><div class="actions">'+actionsHtml+'</div></div>';

  var navMap = {};
  if(apptForm) navMap.appointment = apptForm.formId;
  if(patientForm) navMap.patient = patientForm.formId;
  if(intakeForm) navMap.intake = intakeForm.formId;
  if(providerForm) navMap.provider = providerForm.formId;
  if(followupForm) navMap.followup = followupForm.formId;

  root.innerHTML = '<div class="wrap">'+head+stats+'<div class="panels">'+statusPanel+recentPanel+'</div>'+actions+'</div>';

  var btns = root.querySelectorAll('[data-nav]');
  for (var bi=0; bi<btns.length; bi++){
    btns[bi].addEventListener('click', function(){
      var id = navMap[this.getAttribute('data-nav')];
      if(id) FL.navigate(id); else FL.toast.error('That form is not available.');
    });
  }

  requestAnimationFrame(function(){ setTimeout(function(){
    var els = root.querySelectorAll('.bar-fill');
    for (var i=0;i<els.length;i++){ els[i].style.width = (els[i].getAttribute('data-pct')||0)+'%'; }
  }, 60); });
}
main();
`,
      },
      roles: [
        {
          name: 'Clinic Administrator',
          description: 'Full access to all front-desk forms.',
          permissions: [
            { packFormId: 'patient', permission: 'submit_responses' },
            { packFormId: 'patient', permission: 'view_all_responses' },
            { packFormId: 'patient', permission: 'edit_responses' },
            { packFormId: 'patient', permission: 'delete_responses' },
            { packFormId: 'patient', permission: 'export_responses' },
            { packFormId: 'provider', permission: 'submit_responses' },
            { packFormId: 'provider', permission: 'view_all_responses' },
            { packFormId: 'provider', permission: 'edit_responses' },
            { packFormId: 'provider', permission: 'delete_responses' },
            { packFormId: 'provider', permission: 'export_responses' },
            { packFormId: 'appointment', permission: 'submit_responses' },
            { packFormId: 'appointment', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'edit_responses' },
            { packFormId: 'appointment', permission: 'delete_responses' },
            { packFormId: 'appointment', permission: 'export_responses' },
            { packFormId: 'intake-form', permission: 'submit_responses' },
            { packFormId: 'intake-form', permission: 'view_all_responses' },
            { packFormId: 'intake-form', permission: 'edit_responses' },
            { packFormId: 'intake-form', permission: 'delete_responses' },
            { packFormId: 'intake-form', permission: 'export_responses' },
            { packFormId: 'follow-up', permission: 'submit_responses' },
            { packFormId: 'follow-up', permission: 'view_all_responses' },
            { packFormId: 'follow-up', permission: 'edit_responses' },
            { packFormId: 'follow-up', permission: 'delete_responses' },
            { packFormId: 'follow-up', permission: 'export_responses' },
          ],
        },
        {
          name: 'Front Desk',
          description: 'Reception staff who register patients, book appointments and capture intake.',
          permissions: [
            { packFormId: 'patient', permission: 'submit_responses' },
            { packFormId: 'patient', permission: 'view_all_responses' },
            { packFormId: 'patient', permission: 'edit_responses' },
            { packFormId: 'provider', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'submit_responses' },
            { packFormId: 'appointment', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'edit_responses' },
            { packFormId: 'intake-form', permission: 'submit_responses' },
            { packFormId: 'intake-form', permission: 'view_all_responses' },
            { packFormId: 'intake-form', permission: 'edit_responses' },
            { packFormId: 'follow-up', permission: 'submit_responses' },
            { packFormId: 'follow-up', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Provider',
          description: 'Clinicians who view their patients, appointments and intake, and log follow-ups.',
          permissions: [
            { packFormId: 'patient', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'edit_responses' },
            { packFormId: 'intake-form', permission: 'view_all_responses' },
            { packFormId: 'follow-up', permission: 'submit_responses' },
            { packFormId: 'follow-up', permission: 'view_all_responses' },
            { packFormId: 'follow-up', permission: 'edit_responses' },
          ],
        },
      ],
    },
  ],
};
