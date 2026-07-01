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
  primaryColor: '#0d9488',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const propertyMaintenancePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'property-maintenance',
    name: 'Property Maintenance & Handyman',
    description:
      'A maintenance-request and work-order tracker for property managers and handymen: manage properties and tenants, log maintenance requests, schedule and track work orders, and record inspections — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['property', 'maintenance', 'handyman', 'jobs', 'landlord'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Property ───────────────────────────────────────────────────────
    {
      packFormId: 'property',
      title: 'Property',
      icon: 'Home',
      description:
        'Add a property with its address, type, owner or manager, and on-site access notes.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Property',
          description: 'Capture the property details so you can track tenants, requests and inspections.',
          required: false,
          properties: {},
        },
        {
          id: 'address',
          type: 'long_text',
          label: 'Address',
          required: true,
          properties: { placeholder: 'Street, suburb, state, postcode' },
        },
        {
          id: 'property_type',
          type: 'dropdown',
          label: 'Property Type',
          required: true,
          properties: {
            options: [
              { id: 'house', label: 'House', value: 'house' },
              { id: 'apartment', label: 'Apartment', value: 'apartment' },
              { id: 'commercial', label: 'Commercial', value: 'commercial' },
              { id: 'strata', label: 'Strata / Body Corporate', value: 'strata' },
            ],
          },
        },
        {
          id: 'owner_manager',
          type: 'short_text',
          label: 'Owner / Manager Name',
          required: true,
          properties: { placeholder: 'Landlord or managing agent' },
        },
        {
          id: 'manager_phone',
          type: 'phone',
          label: 'Contact Phone',
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'access_notes',
          type: 'long_text',
          label: 'Access Notes',
          required: false,
          properties: { placeholder: 'Gate codes, lockbox, parking, pets, preferred entry times…' },
        },
      ],
    },

    // ── 2. Tenant ─────────────────────────────────────────────────────────
    {
      packFormId: 'tenant',
      title: 'Tenant',
      icon: 'User',
      description:
        'Register a tenant against a property with their contact details.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: false,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Tenant Name',
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
          id: 'unit',
          type: 'short_text',
          label: 'Unit / Room',
          required: false,
          properties: { placeholder: 'e.g. Unit 3, Room B' },
        },
        {
          id: 'lease_start',
          type: 'date',
          label: 'Lease Start Date',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 3. Maintenance Request ────────────────────────────────────────────
    {
      packFormId: 'maintenance-request',
      title: 'Maintenance Request',
      icon: 'Wrench',
      description:
        'Log a maintenance issue reported for a property by a tenant, with category, priority and status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: false,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'tenant',
          type: 'linked_record',
          label: 'Tenant',
          required: false,
          properties: { targetFormId: '@pack:tenant' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'plumbing', label: 'Plumbing', value: 'plumbing' },
              { id: 'electrical', label: 'Electrical', value: 'electrical' },
              { id: 'appliance', label: 'Appliance', value: 'appliance' },
              { id: 'structural', label: 'Structural', value: 'structural' },
              { id: 'garden', label: 'Garden / Grounds', value: 'garden' },
              { id: 'other', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'urgent', label: 'Urgent', value: 'urgent' },
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
              { id: 'new', label: 'New', value: 'new' },
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'in-progress', label: 'In Progress', value: 'in-progress' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'closed', label: 'Closed', value: 'closed' },
            ],
          },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Describe the issue and its location within the property…' },
        },
        {
          id: 'reported_date',
          type: 'date',
          label: 'Reported Date',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 4. Work Order ─────────────────────────────────────────────────────
    {
      packFormId: 'work-order',
      title: 'Work Order',
      icon: 'ClipboardCheck',
      description:
        'Schedule and track the work to resolve a maintenance request, with assignee, hours and cost.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'request',
          type: 'linked_record',
          label: 'Maintenance Request',
          required: false,
          properties: { targetFormId: '@pack:maintenance-request' },
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned To',
          required: true,
          properties: { placeholder: 'Handyman or contractor name' },
        },
        {
          id: 'scheduled_date',
          type: 'date',
          label: 'Scheduled Date',
          required: true,
          properties: {},
        },
        {
          id: 'hours',
          type: 'number',
          label: 'Hours',
          required: false,
          properties: { placeholder: '0', min: 0, step: 0.25 },
        },
        {
          id: 'cost',
          type: 'number',
          label: 'Cost ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'in-progress', label: 'In Progress', value: 'in-progress' },
              { id: 'on-hold', label: 'On Hold', value: 'on-hold' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'invoiced', label: 'Invoiced', value: 'invoiced' },
            ],
          },
        },
        {
          id: 'work_done',
          type: 'long_text',
          label: 'Work Done',
          required: false,
          properties: { placeholder: 'Describe the work performed and any parts used…' },
        },
      ],
    },

    // ── 5. Inspection ─────────────────────────────────────────────────────
    {
      packFormId: 'inspection',
      title: 'Inspection',
      icon: 'Search',
      description:
        'Record a property inspection with its type, overall condition rating and notes.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: false,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'inspection_type',
          type: 'dropdown',
          label: 'Inspection Type',
          required: true,
          properties: {
            options: [
              { id: 'routine', label: 'Routine', value: 'routine' },
              { id: 'move-in', label: 'Move-in', value: 'move-in' },
              { id: 'move-out', label: 'Move-out', value: 'move-out' },
              { id: 'safety', label: 'Safety / Compliance', value: 'safety' },
              { id: 'final', label: 'Final', value: 'final' },
            ],
          },
        },
        {
          id: 'inspection_date',
          type: 'date',
          label: 'Inspection Date',
          required: true,
          properties: {},
        },
        {
          id: 'condition',
          type: 'rating',
          label: 'Overall Condition',
          required: true,
          properties: { max: 5 },
        },
        {
          id: 'inspector',
          type: 'short_text',
          label: 'Inspector',
          required: false,
          properties: { placeholder: 'Who carried out the inspection' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Findings, defects, follow-up actions…' },
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'maintenance',
      name: 'Maintenance',
      description:
        'A property-maintenance operations hub for property managers and handymen: track properties, tenants, maintenance requests, work orders and inspections from one dashboard.',
      settings: {},
      theme: {
        primaryColor: '#0d9488',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'property', displayName: 'Properties', sortOrder: 1, isVisible: true },
        { packFormId: 'tenant', displayName: 'Tenants', sortOrder: 2, isVisible: true },
        { packFormId: 'maintenance-request', displayName: 'Maintenance Requests', sortOrder: 3, isVisible: true },
        { packFormId: 'work-order', displayName: 'Work Orders', sortOrder: 4, isVisible: true },
        { packFormId: 'inspection', displayName: 'Inspections', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading Maintenance…</div></div></div>`,
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
function fmtDate(s){
  if(!s) return '';
  var d = new Date(s); if(isNaN(d.getTime())) return '';
  var diff = Math.floor((Date.now() - d.getTime())/86400000);
  if(diff <= 0) return 'today';
  if(diff === 1) return 'yesterday';
  if(diff < 7) return diff + 'd ago';
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
}
function isThisMonth(s){
  if(!s) return false;
  var d = new Date(s); if(isNaN(d.getTime())) return false;
  var now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
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

  var propForm = findForm(ctx, 'Properties');
  var tenantForm = findForm(ctx, 'Tenants');
  var reqForm = findForm(ctx, 'Maintenance Requests');
  var woForm = findForm(ctx, 'Work Orders');
  var inspForm = findForm(ctx, 'Inspections');

  var out = await Promise.all([recs(reqForm), recs(propForm), recs(woForm)]);
  var requests = out[0], properties = out[1], workOrders = out[2];

  // Property id -> address map for resolving linked records.
  var propMap = {};
  for (var i=0;i<properties.length;i++){
    var pid = properties[i].id || (properties[i].answers ? properties[i].answers.id : '');
    if(pid) propMap[pid] = (properties[i].answers||{}).address || 'Property';
  }

  var statusOpts = fieldOptions(reqForm, 'status');
  var catOpts = fieldOptions(reqForm, 'category');

  var catColors = {
    'plumbing':'#38bdf8',
    'electrical':'var(--fl-warn)',
    'appliance':'var(--fl-accent)',
    'structural':'var(--fl-bad)',
    'garden':'var(--fl-good)',
    'other':'var(--fl-faint)'
  };
  var catOrder = ['plumbing','electrical','appliance','structural','garden','other'];
  var catCounts = { 'plumbing':0, 'electrical':0, 'appliance':0, 'structural':0, 'garden':0, 'other':0 };

  var statusColors = {
    'new':'#38bdf8',
    'scheduled':'var(--fl-accent)',
    'in-progress':'var(--fl-warn)',
    'completed':'var(--fl-good)',
    'closed':'var(--fl-faint)'
  };

  var openReq = 0, urgentReq = 0, completedThisMonth = 0;
  for (var i=0;i<requests.length;i++){
    var a = requests[i].answers || {};
    if(catCounts[a.category]!=null) catCounts[a.category]++;
    var st = a.status;
    if(st==='new' || st==='scheduled' || st==='in-progress') openReq++;
    if(a.priority==='urgent' && st!=='completed' && st!=='closed') urgentReq++;
    if(st==='completed' && isThisMonth(a.reported_date || requests[i].submittedAt)) completedThisMonth++;
  }

  var scheduledWO = 0;
  for (var i=0;i<workOrders.length;i++){
    var wst = (workOrders[i].answers||{}).status;
    if(wst==='scheduled' || wst==='in-progress') scheduledWO++;
  }

  var head = '<header class="hd"><div class="hd-left"><div class="logo">🏠</div>'
    + '<div><h1>'+h(ctx.appName || 'Maintenance')+'</h1>'
    + '<p class="sub">'+ (user ? 'Signed in as '+h(user.name || user.email || 'manager') : 'Property maintenance operations') +' · '+properties.length+' properties</p></div>'
    + '</div><button class="btn primary" data-nav="request">+ New Request</button></header>';

  var stats = '<div class="stats">'
    + statCard('Open Requests', openReq.toLocaleString(), requests.length + ' total requests', 'var(--fl-accent)')
    + statCard('Urgent', urgentReq.toLocaleString(), (urgentReq>0 ? 'need attention' : 'all clear'), 'var(--fl-bad)')
    + statCard('Scheduled Work', scheduledWO.toLocaleString(), workOrders.length + ' work orders', '#38bdf8')
    + statCard('Properties', properties.length.toLocaleString(), 'under management', 'var(--fl-good)')
    + statCard('Completed', completedThisMonth.toLocaleString(), 'this month', 'var(--fl-warn)')
    + '</div>';

  var maxCat = 0;
  for (var ci=0; ci<catOrder.length; ci++){ if(catCounts[catOrder[ci]] > maxCat) maxCat = catCounts[catOrder[ci]]; }
  var barsHtml = '';
  if(requests.length === 0){
    barsHtml = '<div class="empty-panel">No requests yet<button class="btn primary sm" data-nav="request">Log a request</button></div>';
  } else {
    for (var ci=0; ci<catOrder.length; ci++){
      var ck = catOrder[ci];
      barsHtml += bar(optLabel(catOpts, ck) || ck, catCounts[ck], maxCat, catColors[ck]);
    }
  }
  var catPanel = '<div class="panel"><h2>Requests by category<span class="tag">'+requests.length+' total</span></h2>'+barsHtml+'</div>';

  var itemsHtml = '';
  if(requests.length === 0){
    itemsHtml = '<div class="empty-panel">Nothing to show yet<button class="btn ghost sm" data-nav="property">Add a property</button></div>';
  } else {
    var n = Math.min(6, requests.length);
    for (var ri=0; ri<n; ri++){
      var a = requests[ri].answers || {};
      var propName = propMap[linkId(a.property)] || 'Unassigned property';
      var catL = optLabel(catOpts, a.category) || 'Uncategorised';
      var sk2 = a.status;
      var statusL = optLabel(statusOpts, sk2) || 'Unset';
      var sc = statusColors[sk2] || 'var(--fl-faint)';
      var meta = catL;
      var dt = fmtDate(a.reported_date || requests[ri].submittedAt);
      if(dt) meta += ' · ' + dt;
      itemsHtml += '<div class="item"><div class="item-main">'
        + '<span class="item-title">'+h(propName)+'</span>'
        + '<span class="item-meta">'+h(meta)+'</span></div>'
        + '<span class="badge" style="color:'+sc+';border-color:color-mix(in srgb,'+sc+' 40%,transparent);background:color-mix(in srgb,'+sc+' 13%,transparent)">'+h(statusL)+'</span>'
        + '</div>';
    }
  }
  var recentPanel = '<div class="panel"><h2>Recent requests<span class="tag">latest</span></h2>'+itemsHtml+'</div>';

  var actionDefs = [
    { key:'request', form:reqForm, label:'New Request', icon:'🔧' },
    { key:'property', form:propForm, label:'Add Property', icon:'🏠' },
    { key:'workorder', form:woForm, label:'New Work Order', icon:'📋' },
    { key:'inspection', form:inspForm, label:'Log Inspection', icon:'🔍' },
    { key:'tenant', form:tenantForm, label:'Add Tenant', icon:'👤' }
  ];
  var actionsHtml = '';
  for (var ai=0; ai<actionDefs.length; ai++){
    if(!actionDefs[ai].form) continue;
    actionsHtml += '<button class="btn ghost" data-nav="'+actionDefs[ai].key+'"><span aria-hidden="true">'+actionDefs[ai].icon+'</span>'+h(actionDefs[ai].label)+'</button>';
  }
  var actions = '<div class="panel"><h2>Quick actions</h2><div class="actions">'+actionsHtml+'</div></div>';

  var navMap = {};
  if(reqForm) navMap.request = reqForm.formId;
  if(propForm) navMap.property = propForm.formId;
  if(woForm) navMap.workorder = woForm.formId;
  if(inspForm) navMap.inspection = inspForm.formId;
  if(tenantForm) navMap.tenant = tenantForm.formId;

  root.innerHTML = '<div class="wrap">'+head+stats+'<div class="panels">'+catPanel+recentPanel+'</div>'+actions+'</div>';

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
          name: 'Property Manager',
          description: 'Full access to all property maintenance forms.',
          permissions: [
            { packFormId: 'property', permission: 'submit_responses' },
            { packFormId: 'property', permission: 'view_all_responses' },
            { packFormId: 'property', permission: 'edit_responses' },
            { packFormId: 'property', permission: 'delete_responses' },
            { packFormId: 'property', permission: 'export_responses' },
            { packFormId: 'tenant', permission: 'submit_responses' },
            { packFormId: 'tenant', permission: 'view_all_responses' },
            { packFormId: 'tenant', permission: 'edit_responses' },
            { packFormId: 'tenant', permission: 'delete_responses' },
            { packFormId: 'tenant', permission: 'export_responses' },
            { packFormId: 'maintenance-request', permission: 'submit_responses' },
            { packFormId: 'maintenance-request', permission: 'view_all_responses' },
            { packFormId: 'maintenance-request', permission: 'edit_responses' },
            { packFormId: 'maintenance-request', permission: 'delete_responses' },
            { packFormId: 'maintenance-request', permission: 'export_responses' },
            { packFormId: 'work-order', permission: 'submit_responses' },
            { packFormId: 'work-order', permission: 'view_all_responses' },
            { packFormId: 'work-order', permission: 'edit_responses' },
            { packFormId: 'work-order', permission: 'delete_responses' },
            { packFormId: 'work-order', permission: 'export_responses' },
            { packFormId: 'inspection', permission: 'submit_responses' },
            { packFormId: 'inspection', permission: 'view_all_responses' },
            { packFormId: 'inspection', permission: 'edit_responses' },
            { packFormId: 'inspection', permission: 'delete_responses' },
            { packFormId: 'inspection', permission: 'export_responses' },
          ],
        },
        {
          name: 'Handyman',
          description: 'Field handymen who work maintenance requests, complete work orders and log inspections.',
          permissions: [
            { packFormId: 'property', permission: 'view_all_responses' },
            { packFormId: 'tenant', permission: 'view_all_responses' },
            { packFormId: 'maintenance-request', permission: 'view_all_responses' },
            { packFormId: 'maintenance-request', permission: 'edit_responses' },
            { packFormId: 'work-order', permission: 'submit_responses' },
            { packFormId: 'work-order', permission: 'view_all_responses' },
            { packFormId: 'work-order', permission: 'edit_responses' },
            { packFormId: 'inspection', permission: 'submit_responses' },
            { packFormId: 'inspection', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Landlord',
          description: 'Property owners who log requests and review work on their properties.',
          permissions: [
            { packFormId: 'property', permission: 'submit_responses' },
            { packFormId: 'property', permission: 'view_all_responses' },
            { packFormId: 'tenant', permission: 'view_all_responses' },
            { packFormId: 'maintenance-request', permission: 'submit_responses' },
            { packFormId: 'maintenance-request', permission: 'view_all_responses' },
            { packFormId: 'work-order', permission: 'view_all_responses' },
            { packFormId: 'inspection', permission: 'view_all_responses' },
          ],
        },
      ],
    },
  ],
};
