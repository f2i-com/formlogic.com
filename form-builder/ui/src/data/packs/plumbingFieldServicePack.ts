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
  primaryColor: '#0284c7',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const plumbingFieldServicePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'plumbing-field-service',
    name: 'Plumbing & Trades Field Service',
    description:
      'Field-service operations for a plumbing or trades business: manage customers, schedule and track jobs, log on-site work orders, raise invoices, and request parts and materials — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['plumbing', 'trades', 'field-service', 'jobs', 'scheduling'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Customer ───────────────────────────────────────────────────────
    {
      packFormId: 'customer',
      title: 'Customer',
      icon: 'Users',
      description:
        'Add a residential or commercial customer with their contact details and service address.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Customer',
          description: 'Capture the customer details so you can book and invoice their jobs.',
          required: false,
          properties: {},
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Customer Name',
          required: true,
          properties: { placeholder: 'Full name or business name' },
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
          required: true,
          properties: { placeholder: 'Street, suburb, state, postcode' },
        },
        {
          id: 'customer_type',
          type: 'dropdown',
          label: 'Customer Type',
          required: true,
          properties: {
            options: [
              { id: 'residential', label: 'Residential', value: 'residential' },
              { id: 'commercial', label: 'Commercial', value: 'commercial' },
              { id: 'property-manager', label: 'Property Manager', value: 'property-manager' },
              { id: 'strata', label: 'Strata / Body Corporate', value: 'strata' },
              { id: 'real-estate', label: 'Real Estate Agency', value: 'real-estate' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Access instructions, gate codes, preferred contact times…' },
        },
      ],
    },

    // ── 2. Job ────────────────────────────────────────────────────────────
    {
      packFormId: 'job',
      title: 'Job',
      icon: 'Wrench',
      description:
        'Book a plumbing job for a customer with type, status, priority, schedule and estimated value.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'customer',
          type: 'linked_record',
          label: 'Customer',
          required: false,
          properties: { targetFormId: '@pack:customer' },
        },
        {
          id: 'job_type',
          type: 'dropdown',
          label: 'Job Type',
          required: true,
          properties: {
            options: [
              { id: 'repair', label: 'Repair', value: 'repair' },
              { id: 'installation', label: 'Installation', value: 'installation' },
              { id: 'maintenance', label: 'Maintenance', value: 'maintenance' },
              { id: 'emergency', label: 'Emergency Call-out', value: 'emergency' },
              { id: 'quote', label: 'Quote', value: 'quote' },
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
              { id: 'in-progress', label: 'In Progress', value: 'in-progress' },
              { id: 'on-hold', label: 'On Hold', value: 'on-hold' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'invoiced', label: 'Invoiced', value: 'invoiced' },
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
          id: 'scheduled_date',
          type: 'date',
          label: 'Scheduled Date',
          required: true,
          properties: {},
        },
        {
          id: 'site_address',
          type: 'long_text',
          label: 'Site Address',
          required: true,
          properties: { placeholder: 'Where the work will take place' },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Job Description',
          required: true,
          properties: { placeholder: 'Describe the work required…' },
        },
        {
          id: 'estimated_value',
          type: 'number',
          label: 'Estimated Value ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
        },
      ],
    },

    // ── 3. Site Visit / Work Order ────────────────────────────────────────
    {
      packFormId: 'site-visit',
      title: 'Work Order / Site Visit',
      icon: 'ClipboardCheck',
      description:
        'Log an on-site visit against a job: technician, hours, work performed and materials used.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'job',
          type: 'linked_record',
          label: 'Job',
          required: false,
          properties: { targetFormId: '@pack:job' },
        },
        {
          id: 'technician_name',
          type: 'short_text',
          label: 'Technician Name',
          required: true,
          properties: { placeholder: 'Who attended the site' },
        },
        {
          id: 'visit_date',
          type: 'date',
          label: 'Visit Date',
          required: true,
          properties: {},
        },
        {
          id: 'hours_on_site',
          type: 'number',
          label: 'Hours on Site',
          required: true,
          properties: { placeholder: '0', min: 0, step: 0.25 },
        },
        {
          id: 'work_performed',
          type: 'long_text',
          label: 'Work Performed',
          required: true,
          properties: { placeholder: 'Describe the work completed during this visit…' },
        },
        {
          id: 'materials_used',
          type: 'long_text',
          label: 'Materials Used',
          required: false,
          properties: { placeholder: 'List any parts or materials consumed…' },
        },
        {
          id: 'follow_up_required',
          type: 'checkbox',
          label: 'Follow-up',
          required: false,
          properties: {
            options: [
              { id: 'follow-up', label: 'Follow-up visit required', value: 'follow-up' },
            ],
          },
        },
      ],
    },

    // ── 4. Invoice ────────────────────────────────────────────────────────
    {
      packFormId: 'invoice',
      title: 'Invoice',
      icon: 'Receipt',
      description:
        'Raise an invoice against a completed job with labour, parts and total amounts.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'job',
          type: 'linked_record',
          label: 'Job',
          required: false,
          properties: { targetFormId: '@pack:job' },
        },
        {
          id: 'customer',
          type: 'linked_record',
          label: 'Customer',
          required: false,
          properties: { targetFormId: '@pack:customer' },
        },
        {
          id: 'invoice_number',
          type: 'short_text',
          label: 'Invoice Number',
          required: true,
          properties: { placeholder: 'e.g. INV-1042' },
        },
        {
          id: 'issue_date',
          type: 'date',
          label: 'Issue Date',
          required: true,
          properties: {},
        },
        {
          id: 'labour_amount',
          type: 'number',
          label: 'Labour Amount ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'parts_amount',
          type: 'number',
          label: 'Parts Amount ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'total',
          type: 'number',
          label: 'Total ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'draft', label: 'Draft', value: 'draft' },
              { id: 'sent', label: 'Sent', value: 'sent' },
              { id: 'paid', label: 'Paid', value: 'paid' },
              { id: 'overdue', label: 'Overdue', value: 'overdue' },
            ],
          },
        },
      ],
    },

    // ── 5. Parts & Materials Request ──────────────────────────────────────
    {
      packFormId: 'parts-request',
      title: 'Parts & Materials Request',
      icon: 'Package',
      description:
        'Request parts and materials for a job, with quantity, supplier and unit cost.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'job',
          type: 'linked_record',
          label: 'Job',
          required: false,
          properties: { targetFormId: '@pack:job' },
        },
        {
          id: 'item',
          type: 'short_text',
          label: 'Item',
          required: true,
          properties: { placeholder: 'e.g. 15mm copper elbow' },
        },
        {
          id: 'quantity',
          type: 'number',
          label: 'Quantity',
          required: true,
          properties: { placeholder: '1', min: 1, step: 1 },
        },
        {
          id: 'supplier',
          type: 'short_text',
          label: 'Supplier',
          required: false,
          properties: { placeholder: 'Where to source the part' },
        },
        {
          id: 'unit_cost',
          type: 'number',
          label: 'Unit Cost ($)',
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
              { id: 'requested', label: 'Requested', value: 'requested' },
              { id: 'ordered', label: 'Ordered', value: 'ordered' },
              { id: 'received', label: 'Received', value: 'received' },
              { id: 'installed', label: 'Installed', value: 'installed' },
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
      packAppId: 'field-service',
      name: 'Field Service',
      description:
        'A field-service operations hub for a plumbing or trades business: track customers, jobs, site visits, invoices and parts requests from one dashboard.',
      settings: {},
      theme: {
        primaryColor: '#0284c7',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'customer', displayName: 'Customers', sortOrder: 1, isVisible: true },
        { packFormId: 'job', displayName: 'Jobs', sortOrder: 2, isVisible: true },
        { packFormId: 'site-visit', displayName: 'Site Visits', sortOrder: 3, isVisible: true },
        { packFormId: 'invoice', displayName: 'Invoices', sortOrder: 4, isVisible: true },
        { packFormId: 'parts-request', displayName: 'Parts Requests', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading Field Service…</div></div></div>`,
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
function fmtMoney(n){
  var v = Number(n) || 0;
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function isToday(s){
  if(!s) return false;
  var d = new Date(s); if(isNaN(d.getTime())) return false;
  var now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
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

  var custForm = findForm(ctx, 'Customers');
  var jobForm = findForm(ctx, 'Jobs');
  var visitForm = findForm(ctx, 'Site Visits');
  var invoiceForm = findForm(ctx, 'Invoices');
  var partsForm = findForm(ctx, 'Parts Requests');

  var out = await Promise.all([recs(jobForm), recs(custForm), recs(invoiceForm)]);
  var jobs = out[0], customers = out[1], invoices = out[2];

  // Customer id -> name map for resolving linked records.
  var custMap = {};
  for (var i=0;i<customers.length;i++){
    var cid = customers[i].id || (customers[i].answers ? customers[i].answers.id : '');
    if(cid) custMap[cid] = (customers[i].answers||{}).name || 'Customer';
  }

  var statusOpts = fieldOptions(jobForm, 'status');
  var typeOpts = fieldOptions(jobForm, 'job_type');

  var statusColors = {
    'scheduled':'#38bdf8',
    'in-progress':'var(--fl-accent)',
    'on-hold':'var(--fl-warn)',
    'completed':'var(--fl-good)',
    'invoiced':'#a78bfa'
  };
  var statusOrder = ['scheduled','in-progress','on-hold','completed','invoiced'];
  var statusCounts = { 'scheduled':0, 'in-progress':0, 'on-hold':0, 'completed':0, 'invoiced':0 };

  var openJobs = 0, todayJobs = 0, emergencyJobs = 0;
  for (var i=0;i<jobs.length;i++){
    var a = jobs[i].answers || {};
    var st = a.status;
    if(statusCounts[st]!=null) statusCounts[st]++;
    if(st==='scheduled' || st==='in-progress' || st==='on-hold') openJobs++;
    if(st==='scheduled' && isToday(a.scheduled_date)) todayJobs++;
    if(a.job_type==='emergency' && st!=='completed' && st!=='invoiced') emergencyJobs++;
  }

  var revenueInvoiced = 0, outstanding = 0, unpaidCount = 0;
  for (var i=0;i<invoices.length;i++){
    var ia = invoices[i].answers || {};
    var tot = Number(ia.total) || 0;
    revenueInvoiced += tot;
    if(ia.status==='sent' || ia.status==='overdue'){ outstanding += tot; unpaidCount++; }
  }

  var head = '<header class="hd"><div class="hd-left"><div class="logo">🔧</div>'
    + '<div><h1>'+h(ctx.appName || 'Field Service')+'</h1>'
    + '<p class="sub">'+ (user ? 'Signed in as '+h(user.name || user.email || 'technician') : 'Field-service operations') +' · '+customers.length+' customers</p></div>'
    + '</div><button class="btn primary" data-nav="job">+ New Job</button></header>';

  var stats = '<div class="stats">'
    + statCard('Open Jobs', openJobs.toLocaleString(), jobs.length + ' total jobs', 'var(--fl-accent)')
    + statCard('Scheduled Today', todayJobs.toLocaleString(), statusCounts['scheduled'] + ' scheduled', '#38bdf8')
    + statCard('Revenue Invoiced', fmtMoney(revenueInvoiced), invoices.length + ' invoices', 'var(--fl-good)')
    + statCard('Outstanding', fmtMoney(outstanding), unpaidCount + ' unpaid', 'var(--fl-warn)')
    + statCard('Emergency Jobs', emergencyJobs.toLocaleString(), (emergencyJobs>0 ? 'need attention' : 'all clear'), 'var(--fl-bad)')
    + '</div>';

  var maxStatus = 0;
  for (var si=0; si<statusOrder.length; si++){ if(statusCounts[statusOrder[si]] > maxStatus) maxStatus = statusCounts[statusOrder[si]]; }
  var barsHtml = '';
  if(jobs.length === 0){
    barsHtml = '<div class="empty-panel">No jobs yet<button class="btn primary sm" data-nav="job">Book a job</button></div>';
  } else {
    for (var si=0; si<statusOrder.length; si++){
      var sk = statusOrder[si];
      barsHtml += bar(optLabel(statusOpts, sk) || sk, statusCounts[sk], maxStatus, statusColors[sk]);
    }
  }
  var statusPanel = '<div class="panel"><h2>Jobs by status<span class="tag">'+jobs.length+' total</span></h2>'+barsHtml+'</div>';

  var itemsHtml = '';
  if(jobs.length === 0){
    itemsHtml = '<div class="empty-panel">Nothing to show yet<button class="btn ghost sm" data-nav="customer">Add a customer</button></div>';
  } else {
    var n = Math.min(6, jobs.length);
    for (var ri=0; ri<n; ri++){
      var a = jobs[ri].answers || {};
      var custName = custMap[linkId(a.customer)] || 'Unassigned customer';
      var typeL = optLabel(typeOpts, a.job_type) || 'Job';
      var sk2 = a.status;
      var statusL = optLabel(statusOpts, sk2) || 'Unset';
      var sc = statusColors[sk2] || 'var(--fl-faint)';
      var meta = typeL;
      var dt = fmtDate(a.scheduled_date || jobs[ri].submittedAt);
      if(dt) meta += ' · ' + dt;
      itemsHtml += '<div class="item"><div class="item-main">'
        + '<span class="item-title">'+h(custName)+'</span>'
        + '<span class="item-meta">'+h(meta)+'</span></div>'
        + '<span class="badge" style="color:'+sc+';border-color:color-mix(in srgb,'+sc+' 40%,transparent);background:color-mix(in srgb,'+sc+' 13%,transparent)">'+h(statusL)+'</span>'
        + '</div>';
    }
  }
  var recentPanel = '<div class="panel"><h2>Recent jobs<span class="tag">latest</span></h2>'+itemsHtml+'</div>';

  var actionDefs = [
    { key:'job', form:jobForm, label:'New Job', icon:'🔧' },
    { key:'customer', form:custForm, label:'New Customer', icon:'👤' },
    { key:'visit', form:visitForm, label:'Log Site Visit', icon:'📋' },
    { key:'invoice', form:invoiceForm, label:'New Invoice', icon:'🧾' },
    { key:'parts', form:partsForm, label:'Request Parts', icon:'📦' }
  ];
  var actionsHtml = '';
  for (var ai=0; ai<actionDefs.length; ai++){
    if(!actionDefs[ai].form) continue;
    actionsHtml += '<button class="btn ghost" data-nav="'+actionDefs[ai].key+'"><span aria-hidden="true">'+actionDefs[ai].icon+'</span>'+h(actionDefs[ai].label)+'</button>';
  }
  var actions = '<div class="panel"><h2>Quick actions</h2><div class="actions">'+actionsHtml+'</div></div>';

  var navMap = {};
  if(jobForm) navMap.job = jobForm.formId;
  if(custForm) navMap.customer = custForm.formId;
  if(visitForm) navMap.visit = visitForm.formId;
  if(invoiceForm) navMap.invoice = invoiceForm.formId;
  if(partsForm) navMap.parts = partsForm.formId;

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
          name: 'Business Owner',
          description: 'Full access to all field-service forms.',
          permissions: [
            { packFormId: 'customer', permission: 'submit_responses' },
            { packFormId: 'customer', permission: 'view_all_responses' },
            { packFormId: 'customer', permission: 'edit_responses' },
            { packFormId: 'customer', permission: 'delete_responses' },
            { packFormId: 'customer', permission: 'export_responses' },
            { packFormId: 'job', permission: 'submit_responses' },
            { packFormId: 'job', permission: 'view_all_responses' },
            { packFormId: 'job', permission: 'edit_responses' },
            { packFormId: 'job', permission: 'delete_responses' },
            { packFormId: 'job', permission: 'export_responses' },
            { packFormId: 'site-visit', permission: 'submit_responses' },
            { packFormId: 'site-visit', permission: 'view_all_responses' },
            { packFormId: 'site-visit', permission: 'edit_responses' },
            { packFormId: 'site-visit', permission: 'delete_responses' },
            { packFormId: 'site-visit', permission: 'export_responses' },
            { packFormId: 'invoice', permission: 'submit_responses' },
            { packFormId: 'invoice', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'edit_responses' },
            { packFormId: 'invoice', permission: 'delete_responses' },
            { packFormId: 'invoice', permission: 'export_responses' },
            { packFormId: 'parts-request', permission: 'submit_responses' },
            { packFormId: 'parts-request', permission: 'view_all_responses' },
            { packFormId: 'parts-request', permission: 'edit_responses' },
            { packFormId: 'parts-request', permission: 'delete_responses' },
            { packFormId: 'parts-request', permission: 'export_responses' },
          ],
        },
        {
          name: 'Technician',
          description: 'Field technicians who work jobs, log visits and request parts.',
          permissions: [
            { packFormId: 'customer', permission: 'view_all_responses' },
            { packFormId: 'job', permission: 'view_all_responses' },
            { packFormId: 'job', permission: 'edit_responses' },
            { packFormId: 'site-visit', permission: 'submit_responses' },
            { packFormId: 'site-visit', permission: 'view_all_responses' },
            { packFormId: 'site-visit', permission: 'edit_responses' },
            { packFormId: 'parts-request', permission: 'submit_responses' },
            { packFormId: 'parts-request', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Office / Dispatch',
          description: 'Office staff who book jobs, manage customers and raise invoices.',
          permissions: [
            { packFormId: 'customer', permission: 'submit_responses' },
            { packFormId: 'customer', permission: 'view_all_responses' },
            { packFormId: 'customer', permission: 'edit_responses' },
            { packFormId: 'job', permission: 'submit_responses' },
            { packFormId: 'job', permission: 'view_all_responses' },
            { packFormId: 'job', permission: 'edit_responses' },
            { packFormId: 'site-visit', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'submit_responses' },
            { packFormId: 'invoice', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'edit_responses' },
            { packFormId: 'parts-request', permission: 'view_all_responses' },
          ],
        },
      ],
    },
  ],
};
