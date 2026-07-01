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
  primaryColor: '#7c3aed',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const jobInvoicePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'job-invoice-management',
    name: 'Job & Invoice Management',
    description:
      'A universal job-to-quote-to-invoice-to-payment pipeline for any service business, covering clients, jobs, quotes, invoices, and payments with a live billing dashboard.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['invoicing', 'jobs', 'quotes', 'billing', 'operations'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Client ─────────────────────────────────────────────────────────
    {
      packFormId: 'client',
      title: 'Client',
      icon: 'Building2',
      description:
        'Capture client business and contact details, billing address, and relationship start date.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Add a Client',
          description: 'Record a new client so you can raise jobs, quotes, and invoices against them.',
          required: false,
          properties: {},
        },
        {
          id: 'business_name',
          type: 'short_text',
          label: 'Business / Client Name',
          required: true,
          properties: { placeholder: 'e.g. Acme Pty Ltd' },
        },
        {
          id: 'contact_name',
          type: 'short_text',
          label: 'Primary Contact',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
          properties: { placeholder: 'billing@example.com' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'billing_address',
          type: 'long_text',
          label: 'Billing Address',
          required: false,
          properties: { placeholder: 'Street, city, state, postcode' },
        },
        {
          id: 'client_type',
          type: 'dropdown',
          label: 'Client Type',
          required: true,
          properties: {
            options: [
              { id: 'residential', label: 'Residential', value: 'residential' },
              { id: 'commercial', label: 'Commercial', value: 'commercial' },
              { id: 'government', label: 'Government', value: 'government' },
              { id: 'non-profit', label: 'Non-Profit', value: 'non-profit' },
            ],
          },
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
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Anything worth remembering about this client' },
        },
      ],
    },

    // ── 2. Job ────────────────────────────────────────────────────────────
    {
      packFormId: 'job',
      title: 'Job',
      icon: 'Briefcase',
      description:
        'Track a piece of work through its lifecycle, from lead to completion, linked to a client.',
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
          id: 'title',
          type: 'short_text',
          label: 'Job Title',
          required: true,
          properties: { placeholder: 'e.g. Kitchen renovation' },
        },
        {
          id: 'service_type',
          type: 'dropdown',
          label: 'Service Type',
          required: true,
          properties: {
            options: [
              { id: 'consulting', label: 'Consulting', value: 'consulting' },
              { id: 'installation', label: 'Installation', value: 'installation' },
              { id: 'repair', label: 'Repair / Maintenance', value: 'repair' },
              { id: 'design', label: 'Design', value: 'design' },
              { id: 'support', label: 'Support', value: 'support' },
              { id: 'other-service', label: 'Other', value: 'other-service' },
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
              { id: 'lead', label: 'Lead', value: 'lead' },
              { id: 'quoted', label: 'Quoted', value: 'quoted' },
              { id: 'won', label: 'Won', value: 'won' },
              { id: 'in-progress', label: 'In Progress', value: 'in-progress' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'closed', label: 'Closed', value: 'closed' },
            ],
          },
        },
        {
          id: 'start_date',
          type: 'date',
          label: 'Start Date',
          required: false,
          properties: {},
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: false,
          properties: { placeholder: 'Scope of work, deliverables, and any special requirements' },
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

    // ── 3. Quote ──────────────────────────────────────────────────────────
    {
      packFormId: 'quote',
      title: 'Quote',
      icon: 'FileText',
      description: 'Issue a priced quote against a job with subtotal, tax, total, and validity.',
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
          id: 'quote_number',
          type: 'short_text',
          label: 'Quote Number',
          required: true,
          properties: { placeholder: 'e.g. Q-1001' },
        },
        {
          id: 'issue_date',
          type: 'date',
          label: 'Issue Date',
          required: true,
          properties: {},
        },
        {
          id: 'valid_until',
          type: 'date',
          label: 'Valid Until',
          required: false,
          properties: {},
        },
        {
          id: 'subtotal',
          type: 'number',
          label: 'Subtotal ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'tax',
          type: 'number',
          label: 'Tax ($)',
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
              { id: 'accepted', label: 'Accepted', value: 'accepted' },
              { id: 'declined', label: 'Declined', value: 'declined' },
              { id: 'expired', label: 'Expired', value: 'expired' },
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
        'Bill a client for a completed job and track how much has been paid and what remains.',
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
          id: 'client',
          type: 'linked_record',
          label: 'Client',
          required: false,
          properties: { targetFormId: '@pack:client' },
        },
        {
          id: 'invoice_number',
          type: 'short_text',
          label: 'Invoice Number',
          required: true,
          properties: { placeholder: 'e.g. INV-2001' },
        },
        {
          id: 'issue_date',
          type: 'date',
          label: 'Issue Date',
          required: true,
          properties: {},
        },
        {
          id: 'due_date',
          type: 'date',
          label: 'Due Date',
          required: true,
          properties: {},
        },
        {
          id: 'amount',
          type: 'number',
          label: 'Amount ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'amount_paid',
          type: 'number',
          label: 'Amount Paid ($)',
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
              { id: 'draft', label: 'Draft', value: 'draft' },
              { id: 'sent', label: 'Sent', value: 'sent' },
              { id: 'part-paid', label: 'Part Paid', value: 'part-paid' },
              { id: 'paid', label: 'Paid', value: 'paid' },
              { id: 'overdue', label: 'Overdue', value: 'overdue' },
            ],
          },
        },
      ],
    },

    // ── 5. Payment ────────────────────────────────────────────────────────
    {
      packFormId: 'payment',
      title: 'Payment',
      icon: 'CreditCard',
      description: 'Record a payment received against an invoice, including method and reference.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'invoice',
          type: 'linked_record',
          label: 'Invoice',
          required: false,
          properties: { targetFormId: '@pack:invoice' },
        },
        {
          id: 'payment_date',
          type: 'date',
          label: 'Payment Date',
          required: true,
          properties: {},
        },
        {
          id: 'amount',
          type: 'number',
          label: 'Amount ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'method',
          type: 'dropdown',
          label: 'Payment Method',
          required: true,
          properties: {
            options: [
              { id: 'card', label: 'Card', value: 'card' },
              { id: 'bank-transfer', label: 'Bank Transfer', value: 'bank-transfer' },
              { id: 'cash', label: 'Cash', value: 'cash' },
              { id: 'cheque', label: 'Cheque', value: 'cheque' },
              { id: 'other-method', label: 'Other', value: 'other-method' },
            ],
          },
        },
        {
          id: 'reference',
          type: 'short_text',
          label: 'Reference',
          required: false,
          properties: { placeholder: 'Transaction ID or memo' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Any details about this payment' },
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'billing-pipeline',
      name: 'Billing Pipeline',
      description:
        'A universal job-to-cash workspace for any service business: manage clients, jobs, quotes, invoices, and payments with a live billing dashboard.',
      settings: {},
      theme: {
        primaryColor: '#7c3aed',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'client', displayName: 'Clients', sortOrder: 1, isVisible: true },
        { packFormId: 'job', displayName: 'Jobs', sortOrder: 2, isVisible: true },
        { packFormId: 'quote', displayName: 'Quotes', sortOrder: 3, isVisible: true },
        { packFormId: 'invoice', displayName: 'Invoices', sortOrder: 4, isVisible: true },
        { packFormId: 'payment', displayName: 'Payments', sortOrder: 5, isVisible: true },
      ],
      roles: [
        {
          name: 'Business Owner',
          description: 'Full access to clients, jobs, quotes, invoices, and payments.',
          permissions: [
            { packFormId: 'client', permission: 'submit_responses' },
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'client', permission: 'edit_responses' },
            { packFormId: 'client', permission: 'delete_responses' },
            { packFormId: 'client', permission: 'export_responses' },
            { packFormId: 'job', permission: 'submit_responses' },
            { packFormId: 'job', permission: 'view_all_responses' },
            { packFormId: 'job', permission: 'edit_responses' },
            { packFormId: 'job', permission: 'delete_responses' },
            { packFormId: 'job', permission: 'export_responses' },
            { packFormId: 'quote', permission: 'submit_responses' },
            { packFormId: 'quote', permission: 'view_all_responses' },
            { packFormId: 'quote', permission: 'edit_responses' },
            { packFormId: 'quote', permission: 'delete_responses' },
            { packFormId: 'quote', permission: 'export_responses' },
            { packFormId: 'invoice', permission: 'submit_responses' },
            { packFormId: 'invoice', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'edit_responses' },
            { packFormId: 'invoice', permission: 'delete_responses' },
            { packFormId: 'invoice', permission: 'export_responses' },
            { packFormId: 'payment', permission: 'submit_responses' },
            { packFormId: 'payment', permission: 'view_all_responses' },
            { packFormId: 'payment', permission: 'edit_responses' },
            { packFormId: 'payment', permission: 'delete_responses' },
            { packFormId: 'payment', permission: 'export_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'pipeline-by-stage',
          kind: 'chart',
          name: 'Pipeline by stage',
          description: 'Estimated value of jobs grouped by pipeline stage.',
          spec: {
            formId: '@pack:job',
            viz: 'bar',
            groupBy: { field: 'status' },
            measure: { fn: 'sum', field: 'estimated_value' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'invoiced-by-client',
          kind: 'chart',
          name: 'Invoiced by client',
          description: 'Total invoice amount grouped by client name.',
          spec: {
            formId: '@pack:invoice',
            viz: 'bar',
            joins: [{ via: 'client', formId: '@pack:client', type: 'left' }],
            groupBy: { field: '@pack:client::business_name' },
            measure: { fn: 'sum', field: 'amount' },
            seriesSort: 'value',
            sort: 'desc',
            limit: 10,
          },
        },
        {
          reportId: 'revenue-over-time',
          kind: 'chart',
          name: 'Revenue over time',
          description: 'Total invoiced amount by month.',
          spec: {
            formId: '@pack:invoice',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'sum', field: 'amount' },
          },
        },
        {
          reportId: 'total-invoiced',
          kind: 'chart',
          name: 'Total invoiced',
          description: 'Sum of all invoice amounts raised.',
          spec: {
            formId: '@pack:invoice',
            viz: 'kpi',
            measure: { fn: 'sum', field: 'amount' },
          },
        },
        {
          reportId: 'billing-pipeline-overview',
          kind: 'document',
          name: 'Billing Pipeline overview',
          description: 'Combined overview of pipeline health and billing performance.',
          blocks: [
            {
              kind: 'text',
              title: 'Billing Pipeline Overview',
              body: 'This report summarises the health of the job-to-cash pipeline. It shows where jobs sit by estimated value across each pipeline stage, how invoiced revenue is distributed across clients, how revenue has trended month-by-month, and the total amount invoiced to date.',
            },
            { kind: 'report', reportId: 'pipeline-by-stage', caption: 'Jobs by stage (estimated value)' },
            { kind: 'report', reportId: 'invoiced-by-client', caption: 'Invoice totals per client' },
            { kind: 'report', reportId: 'revenue-over-time', caption: 'Monthly invoiced revenue' },
            { kind: 'report', reportId: 'total-invoiced', caption: 'Total invoiced (all time)' },
          ],
        },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading Billing Pipeline…</div></div></div>`,
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
.stat-val{font-size:25px;font-weight:750;color:var(--fl-text);margin-top:8px;line-height:1;font-variant-numeric:tabular-nums;}
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
function num(v){ var n = Number(v); return isNaN(n) ? 0 : n; }
function normId(v){
  if(v == null) return '';
  if(Array.isArray(v)) return v.length ? normId(v[0]) : '';
  if(typeof v === 'object') return String(v.id != null ? v.id : (v.recordId != null ? v.recordId : ''));
  return String(v);
}
function fmtMoney(n){
  var v = num(n);
  if(Math.abs(v) >= 1000) return '$' + Math.round(v).toLocaleString();
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
  var jobForm = findForm(ctx, 'Jobs');
  var quoteForm = findForm(ctx, 'Quotes');
  var invoiceForm = findForm(ctx, 'Invoices');
  var paymentForm = findForm(ctx, 'Payments');

  var out = await Promise.all([recs(clientForm), recs(jobForm), recs(quoteForm), recs(invoiceForm), recs(paymentForm)]);
  var clients = out[0], jobs = out[1], quotes = out[2], invoices = out[3], payments = out[4];

  // Client lookup by record id -> business name
  var clientMap = {};
  for (var i=0;i<clients.length;i++){ var ca = clients[i].answers || {}; clientMap[String(clients[i].id)] = ca.business_name || ca.contact_name || ''; }

  var jobStatusOpts = fieldOptions(jobForm, 'status');
  var invStatusOpts = fieldOptions(invoiceForm, 'status');

  // KPI: pipeline value = estimated value of OPEN jobs (not completed/closed)
  var openStages = { lead:1, quoted:1, won:1, 'in-progress':1 };
  var pipeline = 0;
  for (var i=0;i<jobs.length;i++){ var ja = jobs[i].answers || {}; if(openStages[ja.status]) pipeline += num(ja.estimated_value); }

  var quotedTotal = 0;
  for (var i=0;i<quotes.length;i++){ var qa = quotes[i].answers || {}; if(qa.status==='sent' || qa.status==='accepted') quotedTotal += num(qa.total); }

  var invoicedTotal = 0, paidTotal = 0, overdueTotal = 0;
  for (var i=0;i<invoices.length;i++){
    var ia = invoices[i].answers || {};
    invoicedTotal += num(ia.amount);
    paidTotal += num(ia.amount_paid);
    if(ia.status === 'overdue') overdueTotal += Math.max(0, num(ia.amount) - num(ia.amount_paid));
  }

  var head = '<header class="hd"><div class="hd-left"><div class="logo">🧾</div>'
    + '<div><h1>'+h(ctx.appName || 'Billing Pipeline')+'</h1>'
    + '<p class="sub">'+ (user ? 'Signed in as '+h(user.name || user.email || 'user') : 'Job to cash') +' · '+jobs.length+' jobs · '+invoices.length+' invoices</p></div>'
    + '</div><button class="btn primary" data-nav="job">+ New Job</button></header>';

  var stats = '<div class="stats">'
    + statCard('Pipeline', fmtMoney(pipeline), 'open jobs', 'var(--fl-accent)')
    + statCard('Quoted', fmtMoney(quotedTotal), 'sent & accepted', '#38bdf8')
    + statCard('Invoiced', fmtMoney(invoicedTotal), invoices.length + ' invoices', 'var(--fl-warn)')
    + statCard('Paid', fmtMoney(paidTotal), payments.length + ' payments', 'var(--fl-good)')
    + statCard('Overdue', fmtMoney(overdueTotal), (overdueTotal>0 ? 'follow up' : 'all current'), 'var(--fl-bad)')
    + '</div>';

  // Jobs by stage bars
  var stageColors = { lead:'var(--fl-faint)', quoted:'#38bdf8', won:'var(--fl-accent)', 'in-progress':'var(--fl-warn)', completed:'var(--fl-good)', closed:'var(--fl-muted)' };
  var stageCounts = {};
  for (var i=0;i<jobStatusOpts.length;i++){ stageCounts[jobStatusOpts[i].value] = 0; }
  for (var i=0;i<jobs.length;i++){ var st = (jobs[i].answers||{}).status; if(stageCounts[st]!=null) stageCounts[st]++; }
  var maxStage = 0;
  for (var k in stageCounts){ if(stageCounts[k] > maxStage) maxStage = stageCounts[k]; }
  var barsHtml = '';
  if(jobs.length === 0){
    barsHtml = '<div class="empty-panel">No jobs yet<button class="btn primary sm" data-nav="job">Create a job</button></div>';
  } else {
    for (var si=0; si<jobStatusOpts.length; si++){
      var sv = jobStatusOpts[si].value;
      barsHtml += bar(jobStatusOpts[si].label, stageCounts[sv], maxStage, stageColors[sv] || 'var(--fl-faint)');
    }
  }
  var stagePanel = '<div class="panel"><h2>Jobs by stage<span class="tag">'+jobs.length+' total</span></h2>'+barsHtml+'</div>';

  // Recent invoices
  var statusColors = { paid:'var(--fl-good)', 'part-paid':'#38bdf8', sent:'var(--fl-accent)', overdue:'var(--fl-bad)', draft:'var(--fl-faint)' };
  var itemsHtml = '';
  if(invoices.length === 0){
    itemsHtml = '<div class="empty-panel">No invoices yet<button class="btn ghost sm" data-nav="invoice">Raise the first invoice</button></div>';
  } else {
    var sorted = invoices.slice().sort(function(a,b){ return new Date(b.submittedAt||0) - new Date(a.submittedAt||0); });
    var n = Math.min(6, sorted.length);
    for (var ri=0; ri<n; ri++){
      var a = sorted[ri].answers || {};
      var clientName = clientMap[normId(a.client)] || a.invoice_number || '(no client)';
      var st2 = a.status;
      var stL = optLabel(invStatusOpts, st2) || 'Draft';
      var sc = statusColors[st2] || 'var(--fl-faint)';
      var meta = fmtMoney(a.amount);
      var dt = fmtDate(sorted[ri].submittedAt);
      if(dt) meta += ' · ' + dt;
      itemsHtml += '<div class="item"><div class="item-main">'
        + '<span class="item-title">'+h(clientName)+'</span>'
        + '<span class="item-meta">'+h(meta)+'</span></div>'
        + '<span class="badge" style="color:'+sc+';border-color:color-mix(in srgb,'+sc+' 40%,transparent);background:color-mix(in srgb,'+sc+' 13%,transparent)">'+h(stL)+'</span>'
        + '</div>';
    }
  }
  var recentPanel = '<div class="panel"><h2>Recent invoices<span class="tag">latest</span></h2>'+itemsHtml+'</div>';

  var actionDefs = [
    { key:'job', form:jobForm, label:'New Job', icon:'💼' },
    { key:'client', form:clientForm, label:'New Client', icon:'🏢' },
    { key:'quote', form:quoteForm, label:'New Quote', icon:'📄' },
    { key:'invoice', form:invoiceForm, label:'New Invoice', icon:'🧾' },
    { key:'payment', form:paymentForm, label:'Record Payment', icon:'💳' }
  ];
  var actionsHtml = '';
  for (var ai=0; ai<actionDefs.length; ai++){
    if(!actionDefs[ai].form) continue;
    actionsHtml += '<button class="btn ghost" data-nav="'+actionDefs[ai].key+'"><span aria-hidden="true">'+actionDefs[ai].icon+'</span>'+h(actionDefs[ai].label)+'</button>';
  }
  var actions = '<div class="panel"><h2>Quick actions</h2><div class="actions">'+actionsHtml+'</div></div>';

  var navMap = {};
  if(clientForm) navMap.client = clientForm.formId;
  if(jobForm) navMap.job = jobForm.formId;
  if(quoteForm) navMap.quote = quoteForm.formId;
  if(invoiceForm) navMap.invoice = invoiceForm.formId;
  if(paymentForm) navMap.payment = paymentForm.formId;

  root.innerHTML = '<div class="wrap">'+head+stats+'<div class="panels">'+stagePanel+recentPanel+'</div>'+actions+'</div>';

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
    },
  ],
};
