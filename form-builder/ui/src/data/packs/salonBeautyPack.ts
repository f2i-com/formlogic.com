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
  primaryColor: '#db2777',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const salonBeautyPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'salon-beauty-studio',
    name: 'Hair Salon & Beauty Studio',
    description:
      'A booking and client manager for a hair salon or beauty studio: keep client profiles, a service menu and stylist roster, book and track appointments, and record retail product sales — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['salon', 'beauty', 'appointments', 'bookings', 'clients'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Client ─────────────────────────────────────────────────────────
    {
      packFormId: 'client',
      title: 'Client',
      icon: 'Users',
      description:
        'Add a salon client with their contact details, preferences and the date they first visited.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Client',
          description: 'Capture the client details so you can book appointments and track their history.',
          required: false,
          properties: {},
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Client Name',
          required: true,
          properties: { placeholder: 'Full name' },
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
          id: 'client_since',
          type: 'date',
          label: 'Client Since',
          required: false,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes & Preferences',
          required: false,
          properties: { placeholder: 'Colour formula, allergies, preferred stylist, favourite products…' },
        },
      ],
    },

    // ── 2. Service ────────────────────────────────────────────────────────
    {
      packFormId: 'service',
      title: 'Service',
      icon: 'Scissors',
      description:
        'Define a service on the menu with its category, duration and price.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'name',
          type: 'short_text',
          label: 'Service Name',
          required: true,
          properties: { placeholder: 'e.g. Cut & Blow Dry, Full Head Colour' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'hair', label: 'Hair', value: 'hair' },
              { id: 'colour', label: 'Colour', value: 'colour' },
              { id: 'nails', label: 'Nails', value: 'nails' },
              { id: 'skin', label: 'Skin', value: 'skin' },
              { id: 'massage', label: 'Massage', value: 'massage' },
              { id: 'other', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'duration_minutes',
          type: 'number',
          label: 'Duration (minutes)',
          required: true,
          properties: { placeholder: '45', min: 5, step: 5 },
        },
        {
          id: 'price',
          type: 'number',
          label: 'Price ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: false,
          properties: { placeholder: 'What the service includes…' },
        },
      ],
    },

    // ── 3. Stylist ────────────────────────────────────────────────────────
    {
      packFormId: 'stylist',
      title: 'Stylist',
      icon: 'UserCog',
      description:
        'Add a stylist or therapist to the roster with their role and contact number.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'name',
          type: 'short_text',
          label: 'Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'role',
          type: 'dropdown',
          label: 'Role',
          required: true,
          properties: {
            options: [
              { id: 'senior-stylist', label: 'Senior Stylist', value: 'senior-stylist' },
              { id: 'stylist', label: 'Stylist', value: 'stylist' },
              { id: 'colour-specialist', label: 'Colour Specialist', value: 'colour-specialist' },
              { id: 'nail-technician', label: 'Nail Technician', value: 'nail-technician' },
              { id: 'therapist', label: 'Beauty Therapist', value: 'therapist' },
              { id: 'apprentice', label: 'Apprentice', value: 'apprentice' },
            ],
          },
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
              { id: 'active', label: 'Currently active / taking bookings', value: 'active' },
            ],
          },
        },
      ],
    },

    // ── 4. Appointment ────────────────────────────────────────────────────
    {
      packFormId: 'appointment',
      title: 'Appointment',
      icon: 'CalendarClock',
      description:
        'Book an appointment linking a client, a service and a stylist with date, time, status and price.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client',
          type: 'linked_record',
          label: 'Client',
          required: false,
          properties: { targetFormId: '@pack:client' },
        },
        {
          id: 'service',
          type: 'linked_record',
          label: 'Service',
          required: false,
          properties: { targetFormId: '@pack:service' },
        },
        {
          id: 'stylist',
          type: 'linked_record',
          label: 'Stylist',
          required: false,
          properties: { targetFormId: '@pack:stylist' },
        },
        {
          id: 'date',
          type: 'date',
          label: 'Date',
          required: true,
          properties: {},
        },
        {
          id: 'time',
          type: 'time',
          label: 'Time',
          required: true,
          properties: {},
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'booked', label: 'Booked', value: 'booked' },
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'no-show', label: 'No-show', value: 'no-show' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
        {
          id: 'price',
          type: 'number',
          label: 'Price ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Anything the stylist should know for this visit…' },
        },
      ],
    },

    // ── 5. Product Sale ───────────────────────────────────────────────────
    {
      packFormId: 'product-sale',
      title: 'Product Sale',
      icon: 'ShoppingBag',
      description:
        'Record a retail product sold to a client, with quantity, amount and date.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client',
          type: 'linked_record',
          label: 'Client',
          required: false,
          properties: { targetFormId: '@pack:client' },
        },
        {
          id: 'product_name',
          type: 'short_text',
          label: 'Product',
          required: true,
          properties: { placeholder: 'e.g. Shampoo, Styling Cream' },
        },
        {
          id: 'quantity',
          type: 'number',
          label: 'Quantity',
          required: true,
          properties: { placeholder: '1', min: 1, step: 1 },
        },
        {
          id: 'amount',
          type: 'number',
          label: 'Amount ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'date',
          type: 'date',
          label: 'Sale Date',
          required: true,
          properties: {},
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'salon',
      name: 'Salon',
      description:
        'A salon operations hub: manage clients, the service menu and stylist roster, book and track appointments, and record product sales from one dashboard.',
      settings: {},
      theme: {
        primaryColor: '#db2777',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'client', displayName: 'Clients', sortOrder: 1, isVisible: true },
        { packFormId: 'service', displayName: 'Services', sortOrder: 2, isVisible: true },
        { packFormId: 'stylist', displayName: 'Stylists', sortOrder: 3, isVisible: true },
        { packFormId: 'appointment', displayName: 'Appointments', sortOrder: 4, isVisible: true },
        { packFormId: 'product-sale', displayName: 'Product Sales', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading Salon…</div></div></div>`,
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
function linkId(v){
  if(v == null) return '';
  if(Array.isArray(v)) return v.length ? linkId(v[0]) : '';
  if(typeof v === 'object') return v.id || v.recordId || v.value || '';
  return String(v);
}
function nameMap(records, field){
  var m = {};
  for (var i=0;i<records.length;i++){
    var rid = records[i].id || (records[i].answers ? records[i].answers.id : '');
    if(rid) m[rid] = (records[i].answers||{})[field] || '';
  }
  return m;
}
function fmtDate(s){
  if(!s) return '';
  var d = new Date(s); if(isNaN(d.getTime())) return '';
  var diff = Math.floor((Date.now() - d.getTime())/86400000);
  if(diff === 0) return 'today';
  if(diff === -1) return 'tomorrow';
  if(diff === 1) return 'yesterday';
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
}
function fmtMoney(n){
  var v = Number(n) || 0;
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function dayNum(s){
  if(!s) return NaN;
  var d = new Date(s); if(isNaN(d.getTime())) return NaN;
  d.setHours(0,0,0,0);
  return Math.floor(d.getTime()/86400000);
}
function todayNum(){
  var d = new Date(); d.setHours(0,0,0,0);
  return Math.floor(d.getTime()/86400000);
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

  var clientForm = findForm(ctx, 'Clients');
  var serviceForm = findForm(ctx, 'Services');
  var stylistForm = findForm(ctx, 'Stylists');
  var apptForm = findForm(ctx, 'Appointments');
  var saleForm = findForm(ctx, 'Product Sales');

  var out = await Promise.all([recs(apptForm), recs(clientForm), recs(serviceForm)]);
  var appts = out[0], clients = out[1], services = out[2];

  var clientNames = nameMap(clients, 'name');
  var serviceNames = nameMap(services, 'name');

  var statusOpts = fieldOptions(apptForm, 'status');
  var statusColors = {
    'booked':'#38bdf8',
    'confirmed':'var(--fl-accent)',
    'completed':'var(--fl-good)',
    'no-show':'var(--fl-bad)',
    'cancelled':'var(--fl-warn)'
  };
  var statusOrder = ['booked','confirmed','completed','no-show','cancelled'];
  var statusCounts = { 'booked':0, 'confirmed':0, 'completed':0, 'no-show':0, 'cancelled':0 };

  var today = todayNum();
  var apptsToday = 0, revenue = 0, upcoming = 0, noShows = 0;
  var upcomingList = [];
  for (var i=0;i<appts.length;i++){
    var a = appts[i].answers || {};
    var st = a.status;
    if(statusCounts[st]!=null) statusCounts[st]++;
    var dn = dayNum(a.date);
    if(dn === today && st!=='cancelled') apptsToday++;
    if(st==='completed') revenue += Number(a.price) || 0;
    if(st==='no-show') noShows++;
    if((st==='booked' || st==='confirmed') && !isNaN(dn) && dn >= today){
      upcoming++;
      upcomingList.push({ rec: appts[i], a: a, dn: dn });
    }
  }
  upcomingList.sort(function(x,y){ return x.dn - y.dn; });

  var head = '<header class="hd"><div class="hd-left"><div class="logo">💇</div>'
    + '<div><h1>'+h(ctx.appName || 'Salon')+'</h1>'
    + '<p class="sub">'+ (user ? 'Signed in as '+h(user.name || user.email || 'front desk') : 'Salon operations') +' · '+clients.length+' clients</p></div>'
    + '</div><button class="btn primary" data-nav="appointment">+ New Appointment</button></header>';

  var stats = '<div class="stats">'
    + statCard('Appointments Today', apptsToday.toLocaleString(), appts.length + ' total booked', 'var(--fl-accent)')
    + statCard('Revenue', fmtMoney(revenue), statusCounts['completed'] + ' completed', 'var(--fl-good)')
    + statCard('Upcoming', upcoming.toLocaleString(), 'booked & confirmed', '#38bdf8')
    + statCard('No-shows', noShows.toLocaleString(), (noShows>0 ? 'follow up' : 'all clear'), 'var(--fl-bad)')
    + statCard('Active Clients', clients.length.toLocaleString(), services.length + ' services on menu', '#a78bfa')
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
  if(upcomingList.length === 0){
    itemsHtml = '<div class="empty-panel">No upcoming appointments<button class="btn ghost sm" data-nav="appointment">Book one now</button></div>';
  } else {
    var n = Math.min(6, upcomingList.length);
    for (var ri=0; ri<n; ri++){
      var a = upcomingList[ri].a;
      var clientName = clientNames[linkId(a.client)] || 'Walk-in client';
      var svcName = serviceNames[linkId(a.service)] || 'Service';
      var sk2 = a.status;
      var statusL = optLabel(statusOpts, sk2) || 'Booked';
      var sc = statusColors[sk2] || 'var(--fl-faint)';
      var meta = svcName;
      var dt = fmtDate(a.date);
      if(dt) meta += ' · ' + dt;
      if(a.time) meta += ' · ' + a.time;
      itemsHtml += '<div class="item"><div class="item-main">'
        + '<span class="item-title">'+h(clientName)+'</span>'
        + '<span class="item-meta">'+h(meta)+'</span></div>'
        + '<span class="badge" style="color:'+sc+';border-color:color-mix(in srgb,'+sc+' 40%,transparent);background:color-mix(in srgb,'+sc+' 13%,transparent)">'+h(statusL)+'</span>'
        + '</div>';
    }
  }
  var upcomingPanel = '<div class="panel"><h2>Upcoming appointments<span class="tag">'+upcoming+'</span></h2>'+itemsHtml+'</div>';

  var actionDefs = [
    { key:'appointment', form:apptForm, label:'New Appointment', icon:'📅' },
    { key:'client', form:clientForm, label:'New Client', icon:'👤' },
    { key:'service', form:serviceForm, label:'Add Service', icon:'✂️' },
    { key:'sale', form:saleForm, label:'Record Sale', icon:'🛍️' },
    { key:'stylist', form:stylistForm, label:'Add Stylist', icon:'💅' }
  ];
  var actionsHtml = '';
  for (var ai=0; ai<actionDefs.length; ai++){
    if(!actionDefs[ai].form) continue;
    actionsHtml += '<button class="btn ghost" data-nav="'+actionDefs[ai].key+'"><span aria-hidden="true">'+actionDefs[ai].icon+'</span>'+h(actionDefs[ai].label)+'</button>';
  }
  var actions = '<div class="panel"><h2>Quick actions</h2><div class="actions">'+actionsHtml+'</div></div>';

  var navMap = {};
  if(apptForm) navMap.appointment = apptForm.formId;
  if(clientForm) navMap.client = clientForm.formId;
  if(serviceForm) navMap.service = serviceForm.formId;
  if(saleForm) navMap.sale = saleForm.formId;
  if(stylistForm) navMap.stylist = stylistForm.formId;

  root.innerHTML = '<div class="wrap">'+head+stats+'<div class="panels">'+statusPanel+upcomingPanel+'</div>'+actions+'</div>';

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
          name: 'Salon Owner',
          description: 'Full access to all salon forms.',
          permissions: [
            { packFormId: 'client', permission: 'submit_responses' },
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'client', permission: 'edit_responses' },
            { packFormId: 'client', permission: 'delete_responses' },
            { packFormId: 'client', permission: 'export_responses' },
            { packFormId: 'service', permission: 'submit_responses' },
            { packFormId: 'service', permission: 'view_all_responses' },
            { packFormId: 'service', permission: 'edit_responses' },
            { packFormId: 'service', permission: 'delete_responses' },
            { packFormId: 'service', permission: 'export_responses' },
            { packFormId: 'stylist', permission: 'submit_responses' },
            { packFormId: 'stylist', permission: 'view_all_responses' },
            { packFormId: 'stylist', permission: 'edit_responses' },
            { packFormId: 'stylist', permission: 'delete_responses' },
            { packFormId: 'stylist', permission: 'export_responses' },
            { packFormId: 'appointment', permission: 'submit_responses' },
            { packFormId: 'appointment', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'edit_responses' },
            { packFormId: 'appointment', permission: 'delete_responses' },
            { packFormId: 'appointment', permission: 'export_responses' },
            { packFormId: 'product-sale', permission: 'submit_responses' },
            { packFormId: 'product-sale', permission: 'view_all_responses' },
            { packFormId: 'product-sale', permission: 'edit_responses' },
            { packFormId: 'product-sale', permission: 'delete_responses' },
            { packFormId: 'product-sale', permission: 'export_responses' },
          ],
        },
        {
          name: 'Front Desk',
          description: 'Reception staff who book appointments, manage clients and record sales.',
          permissions: [
            { packFormId: 'client', permission: 'submit_responses' },
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'client', permission: 'edit_responses' },
            { packFormId: 'service', permission: 'view_all_responses' },
            { packFormId: 'stylist', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'submit_responses' },
            { packFormId: 'appointment', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'edit_responses' },
            { packFormId: 'product-sale', permission: 'submit_responses' },
            { packFormId: 'product-sale', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Stylist',
          description: 'Stylists and therapists who view their appointments and update outcomes.',
          permissions: [
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'service', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'view_all_responses' },
            { packFormId: 'appointment', permission: 'edit_responses' },
            { packFormId: 'product-sale', permission: 'submit_responses' },
            { packFormId: 'product-sale', permission: 'view_all_responses' },
          ],
        },
      ],
    },
  ],
};
