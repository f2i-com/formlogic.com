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
  primaryColor: '#6366f1',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const inventoryPurchaseOrdersPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'inventory-purchase-orders',
    name: 'Inventory & Purchase Orders',
    description:
      'Stock-control and purchasing operations: manage products and suppliers, raise purchase orders with line items, and log every stock movement — with low-stock and stock-value tracking, all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['inventory', 'purchasing', 'stock', 'suppliers', 'warehouse'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Product ────────────────────────────────────────────────────────
    {
      packFormId: 'product',
      title: 'Product',
      icon: 'Package',
      description:
        'Add a product to your catalogue with SKU, pricing, stock-on-hand and reorder settings.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Product',
          description: 'Capture the product details so you can track stock, cost and reorders.',
          required: false,
          properties: {},
        },
        {
          id: 'sku',
          type: 'short_text',
          label: 'SKU',
          required: true,
          properties: { placeholder: 'e.g. WID-001' },
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Product Name',
          required: true,
          properties: { placeholder: 'Descriptive product name' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'raw-materials', label: 'Raw Materials', value: 'raw-materials' },
              { id: 'components', label: 'Components', value: 'components' },
              { id: 'finished-goods', label: 'Finished Goods', value: 'finished-goods' },
              { id: 'packaging', label: 'Packaging', value: 'packaging' },
              { id: 'consumables', label: 'Consumables', value: 'consumables' },
              { id: 'accessories', label: 'Accessories', value: 'accessories' },
            ],
          },
        },
        {
          id: 'unit_cost',
          type: 'number',
          label: 'Unit Cost ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0, step: 0.01 },
        },
        {
          id: 'sell_price',
          type: 'number',
          label: 'Sell Price ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0, step: 0.01 },
        },
        {
          id: 'stock_on_hand',
          type: 'number',
          label: 'Stock on Hand',
          required: true,
          properties: { placeholder: '0', min: 0, step: 1 },
        },
        {
          id: 'reorder_point',
          type: 'number',
          label: 'Reorder Point',
          required: true,
          properties: { placeholder: '0', min: 0, step: 1 },
        },
        {
          id: 'location',
          type: 'short_text',
          label: 'Location',
          required: false,
          properties: { placeholder: 'e.g. Aisle 4, Bay B' },
        },
      ],
    },

    // ── 2. Supplier ───────────────────────────────────────────────────────
    {
      packFormId: 'supplier',
      title: 'Supplier',
      icon: 'Truck',
      description:
        'Add a supplier with contact details, payment terms and typical lead time.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'name',
          type: 'short_text',
          label: 'Supplier Name',
          required: true,
          properties: { placeholder: 'Company or business name' },
        },
        {
          id: 'contact_name',
          type: 'short_text',
          label: 'Contact Name',
          required: false,
          properties: { placeholder: 'Primary contact person' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: false,
          properties: { placeholder: 'orders@supplier.com' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'payment_terms',
          type: 'dropdown',
          label: 'Payment Terms',
          required: true,
          properties: {
            options: [
              { id: 'prepaid', label: 'Prepaid', value: 'prepaid' },
              { id: 'cod', label: 'Cash on Delivery', value: 'cod' },
              { id: 'net-7', label: 'Net 7', value: 'net-7' },
              { id: 'net-15', label: 'Net 15', value: 'net-15' },
              { id: 'net-30', label: 'Net 30', value: 'net-30' },
              { id: 'net-60', label: 'Net 60', value: 'net-60' },
            ],
          },
        },
        {
          id: 'lead_time_days',
          type: 'number',
          label: 'Lead Time (days)',
          required: false,
          properties: { placeholder: '0', min: 0, step: 1 },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Minimum order quantities, account numbers, delivery notes…' },
        },
      ],
    },

    // ── 3. Purchase Order ─────────────────────────────────────────────────
    {
      packFormId: 'purchase-order',
      title: 'Purchase Order',
      icon: 'ShoppingCart',
      description:
        'Raise a purchase order against a supplier with dates, status and total value.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'supplier',
          type: 'linked_record',
          label: 'Supplier',
          required: false,
          properties: { targetFormId: '@pack:supplier' },
        },
        {
          id: 'po_number',
          type: 'short_text',
          label: 'PO Number',
          required: true,
          properties: { placeholder: 'e.g. PO-1042' },
        },
        {
          id: 'order_date',
          type: 'date',
          label: 'Order Date',
          required: true,
          properties: {},
        },
        {
          id: 'expected_date',
          type: 'date',
          label: 'Expected Delivery Date',
          required: false,
          properties: {},
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'draft', label: 'Draft', value: 'draft' },
              { id: 'ordered', label: 'Ordered', value: 'ordered' },
              { id: 'part-received', label: 'Part Received', value: 'part-received' },
              { id: 'received', label: 'Received', value: 'received' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
        {
          id: 'total',
          type: 'number',
          label: 'Total ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0, step: 0.01 },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Delivery instructions, references…' },
        },
      ],
    },

    // ── 4. PO Line Item ───────────────────────────────────────────────────
    {
      packFormId: 'po-line-item',
      title: 'PO Line Item',
      icon: 'ListChecks',
      description:
        'A single line on a purchase order: the product, quantity ordered and cost.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'purchase_order',
          type: 'linked_record',
          label: 'Purchase Order',
          required: false,
          properties: { targetFormId: '@pack:purchase-order' },
        },
        {
          id: 'product',
          type: 'linked_record',
          label: 'Product',
          required: false,
          properties: { targetFormId: '@pack:product' },
        },
        {
          id: 'quantity',
          type: 'number',
          label: 'Quantity',
          required: true,
          properties: { placeholder: '1', min: 1, step: 1 },
        },
        {
          id: 'unit_cost',
          type: 'number',
          label: 'Unit Cost ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0, step: 0.01 },
        },
        {
          id: 'line_total',
          type: 'number',
          label: 'Line Total ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0, step: 0.01 },
        },
      ],
    },

    // ── 5. Stock Movement ─────────────────────────────────────────────────
    {
      packFormId: 'stock-movement',
      title: 'Stock Movement',
      icon: 'ArrowLeftRight',
      description:
        'Log a change to stock levels: goods received, sold, adjusted, returned or damaged.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'product',
          type: 'linked_record',
          label: 'Product',
          required: false,
          properties: { targetFormId: '@pack:product' },
        },
        {
          id: 'movement_type',
          type: 'dropdown',
          label: 'Movement Type',
          required: true,
          properties: {
            options: [
              { id: 'received', label: 'Received', value: 'received' },
              { id: 'sold', label: 'Sold', value: 'sold' },
              { id: 'adjustment', label: 'Adjustment', value: 'adjustment' },
              { id: 'return', label: 'Return', value: 'return' },
              { id: 'damaged', label: 'Damaged', value: 'damaged' },
            ],
          },
        },
        {
          id: 'quantity',
          type: 'number',
          label: 'Quantity',
          required: true,
          properties: { placeholder: '0', step: 1 },
        },
        {
          id: 'reason',
          type: 'short_text',
          label: 'Reason / Reference',
          required: false,
          properties: { placeholder: 'e.g. PO-1042, stocktake, customer return' },
        },
        {
          id: 'date',
          type: 'date',
          label: 'Date',
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
      packAppId: 'inventory',
      name: 'Inventory',
      description:
        'A stock-control and purchasing hub: track products, suppliers, purchase orders, line items and stock movements — with low-stock alerts and live stock value — from one dashboard.',
      settings: {},
      theme: {
        primaryColor: '#6366f1',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'product', displayName: 'Products', sortOrder: 1, isVisible: true },
        { packFormId: 'supplier', displayName: 'Suppliers', sortOrder: 2, isVisible: true },
        { packFormId: 'purchase-order', displayName: 'Purchase Orders', sortOrder: 3, isVisible: true },
        { packFormId: 'po-line-item', displayName: 'PO Line Items', sortOrder: 4, isVisible: true },
        { packFormId: 'stock-movement', displayName: 'Stock Movements', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading Inventory…</div></div></div>`,
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
function fmtMoney(n){
  var v = Number(n) || 0;
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
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

  var productForm = findForm(ctx, 'Products');
  var supplierForm = findForm(ctx, 'Suppliers');
  var poForm = findForm(ctx, 'Purchase Orders');
  var lineForm = findForm(ctx, 'PO Line Items');
  var moveForm = findForm(ctx, 'Stock Movements');

  var out = await Promise.all([recs(productForm), recs(poForm), recs(moveForm)]);
  var products = out[0], pos = out[1], movements = out[2];

  // Build product list with derived stock status.
  var productList = [];
  var lowCount = 0, outCount = 0, stockValue = 0;
  for (var i=0;i<products.length;i++){
    var a = products[i].answers || {};
    var onhand = Number(a.stock_on_hand) || 0;
    var reorder = Number(a.reorder_point) || 0;
    var cost = Number(a.unit_cost) || 0;
    stockValue += onhand * cost;
    var status = onhand <= 0 ? 'out' : (onhand <= reorder ? 'low' : 'ok');
    if(status === 'out') outCount++;
    else if(status === 'low') lowCount++;
    productList.push({
      name: a.name || a.sku || 'Product',
      sku: a.sku || '',
      onhand: onhand,
      reorder: reorder,
      status: status,
      rank: status === 'out' ? 0 : (status === 'low' ? 1 : 2)
    });
  }
  productList.sort(function(x,y){ return x.rank - y.rank; });

  var openPOs = 0;
  for (var i=0;i<pos.length;i++){
    var st = (pos[i].answers || {}).status;
    if(st === 'draft' || st === 'ordered' || st === 'part-received') openPOs++;
  }

  var typeOpts = fieldOptions(moveForm, 'movement_type');
  var typeColors = {
    'received':'var(--fl-good)',
    'sold':'var(--fl-accent)',
    'adjustment':'#38bdf8',
    'return':'var(--fl-warn)',
    'damaged':'var(--fl-bad)'
  };
  var typeOrder = ['received','sold','adjustment','return','damaged'];
  var typeCounts = { 'received':0, 'sold':0, 'adjustment':0, 'return':0, 'damaged':0 };
  for (var i=0;i<movements.length;i++){
    var mt = (movements[i].answers || {}).movement_type;
    if(typeCounts[mt] != null) typeCounts[mt]++;
  }

  var statusColors = { 'out':'var(--fl-bad)', 'low':'var(--fl-warn)', 'ok':'var(--fl-good)' };
  var statusLabels = { 'out':'Out of stock', 'low':'Low stock', 'ok':'In stock' };

  var head = '<header class="hd"><div class="hd-left"><div class="logo">📦</div>'
    + '<div><h1>'+h(ctx.appName || 'Inventory')+'</h1>'
    + '<p class="sub">'+ (user ? 'Signed in as '+h(user.name || user.email || 'operator') : 'Stock & purchasing operations') +' · '+products.length+' products</p></div>'
    + '</div><button class="btn primary" data-nav="product">+ New Product</button></header>';

  var stats = '<div class="stats">'
    + statCard('Total SKUs', products.length.toLocaleString(), (products.length ? 'in catalogue' : 'none yet'), 'var(--fl-accent)')
    + statCard('Low Stock', lowCount.toLocaleString(), (lowCount > 0 ? 'at / below reorder' : 'all healthy'), 'var(--fl-warn)')
    + statCard('Open POs', openPOs.toLocaleString(), pos.length + ' total POs', '#38bdf8')
    + statCard('Stock Value', fmtMoney(stockValue), 'on hand at cost', 'var(--fl-good)')
    + statCard('Out of Stock', outCount.toLocaleString(), (outCount > 0 ? 'need reorder' : 'all clear'), 'var(--fl-bad)')
    + '</div>';

  var maxType = 0;
  for (var ti=0; ti<typeOrder.length; ti++){ if(typeCounts[typeOrder[ti]] > maxType) maxType = typeCounts[typeOrder[ti]]; }
  var barsHtml = '';
  if(movements.length === 0){
    barsHtml = '<div class="empty-panel">No stock movements yet<button class="btn primary sm" data-nav="movement">Record a movement</button></div>';
  } else {
    for (var ti=0; ti<typeOrder.length; ti++){
      var tk = typeOrder[ti];
      barsHtml += bar(optLabel(typeOpts, tk) || tk, typeCounts[tk], maxType, typeColors[tk]);
    }
  }
  var movePanel = '<div class="panel"><h2>Movements by type<span class="tag">'+movements.length+' total</span></h2>'+barsHtml+'</div>';

  var itemsHtml = '';
  if(productList.length === 0){
    itemsHtml = '<div class="empty-panel">No products yet<button class="btn ghost sm" data-nav="product">Add a product</button></div>';
  } else {
    var n = Math.min(6, productList.length);
    for (var ri=0; ri<n; ri++){
      var p = productList[ri];
      var sc = statusColors[p.status] || 'var(--fl-faint)';
      var meta = (p.sku ? p.sku + ' · ' : '') + p.onhand + ' on hand · reorder at ' + p.reorder;
      itemsHtml += '<div class="item"><div class="item-main">'
        + '<span class="item-title">'+h(p.name)+'</span>'
        + '<span class="item-meta">'+h(meta)+'</span></div>'
        + '<span class="badge" style="color:'+sc+';border-color:color-mix(in srgb,'+sc+' 40%,transparent);background:color-mix(in srgb,'+sc+' 13%,transparent)">'+h(statusLabels[p.status] || 'In stock')+'</span>'
        + '</div>';
    }
  }
  var lowPanel = '<div class="panel"><h2>Low-stock &amp; products<span class="tag">'+(lowCount+outCount)+' need reorder</span></h2>'+itemsHtml+'</div>';

  var actionDefs = [
    { key:'product', form:productForm, label:'Add Product', icon:'📦' },
    { key:'po', form:poForm, label:'New Purchase Order', icon:'🛒' },
    { key:'movement', form:moveForm, label:'Record Movement', icon:'🔁' },
    { key:'supplier', form:supplierForm, label:'Add Supplier', icon:'🚚' }
  ];
  var actionsHtml = '';
  for (var ai=0; ai<actionDefs.length; ai++){
    if(!actionDefs[ai].form) continue;
    actionsHtml += '<button class="btn ghost" data-nav="'+actionDefs[ai].key+'"><span aria-hidden="true">'+actionDefs[ai].icon+'</span>'+h(actionDefs[ai].label)+'</button>';
  }
  var actions = '<div class="panel"><h2>Quick actions</h2><div class="actions">'+actionsHtml+'</div></div>';

  var navMap = {};
  if(productForm) navMap.product = productForm.formId;
  if(supplierForm) navMap.supplier = supplierForm.formId;
  if(poForm) navMap.po = poForm.formId;
  if(lineForm) navMap.line = lineForm.formId;
  if(moveForm) navMap.movement = moveForm.formId;

  root.innerHTML = '<div class="wrap">'+head+stats+'<div class="panels">'+movePanel+lowPanel+'</div>'+actions+'</div>';

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
          name: 'Inventory Manager',
          description: 'Full access to all inventory and purchasing forms.',
          permissions: [
            { packFormId: 'product', permission: 'submit_responses' },
            { packFormId: 'product', permission: 'view_all_responses' },
            { packFormId: 'product', permission: 'edit_responses' },
            { packFormId: 'product', permission: 'delete_responses' },
            { packFormId: 'product', permission: 'export_responses' },
            { packFormId: 'supplier', permission: 'submit_responses' },
            { packFormId: 'supplier', permission: 'view_all_responses' },
            { packFormId: 'supplier', permission: 'edit_responses' },
            { packFormId: 'supplier', permission: 'delete_responses' },
            { packFormId: 'supplier', permission: 'export_responses' },
            { packFormId: 'purchase-order', permission: 'submit_responses' },
            { packFormId: 'purchase-order', permission: 'view_all_responses' },
            { packFormId: 'purchase-order', permission: 'edit_responses' },
            { packFormId: 'purchase-order', permission: 'delete_responses' },
            { packFormId: 'purchase-order', permission: 'export_responses' },
            { packFormId: 'po-line-item', permission: 'submit_responses' },
            { packFormId: 'po-line-item', permission: 'view_all_responses' },
            { packFormId: 'po-line-item', permission: 'edit_responses' },
            { packFormId: 'po-line-item', permission: 'delete_responses' },
            { packFormId: 'po-line-item', permission: 'export_responses' },
            { packFormId: 'stock-movement', permission: 'submit_responses' },
            { packFormId: 'stock-movement', permission: 'view_all_responses' },
            { packFormId: 'stock-movement', permission: 'edit_responses' },
            { packFormId: 'stock-movement', permission: 'delete_responses' },
            { packFormId: 'stock-movement', permission: 'export_responses' },
          ],
        },
        {
          name: 'Purchasing Officer',
          description: 'Staff who manage suppliers and raise purchase orders.',
          permissions: [
            { packFormId: 'product', permission: 'view_all_responses' },
            { packFormId: 'supplier', permission: 'submit_responses' },
            { packFormId: 'supplier', permission: 'view_all_responses' },
            { packFormId: 'supplier', permission: 'edit_responses' },
            { packFormId: 'purchase-order', permission: 'submit_responses' },
            { packFormId: 'purchase-order', permission: 'view_all_responses' },
            { packFormId: 'purchase-order', permission: 'edit_responses' },
            { packFormId: 'po-line-item', permission: 'submit_responses' },
            { packFormId: 'po-line-item', permission: 'view_all_responses' },
            { packFormId: 'po-line-item', permission: 'edit_responses' },
            { packFormId: 'stock-movement', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Warehouse Staff',
          description: 'Warehouse team who receive goods and log stock movements.',
          permissions: [
            { packFormId: 'product', permission: 'view_all_responses' },
            { packFormId: 'product', permission: 'edit_responses' },
            { packFormId: 'purchase-order', permission: 'view_all_responses' },
            { packFormId: 'purchase-order', permission: 'edit_responses' },
            { packFormId: 'po-line-item', permission: 'view_all_responses' },
            { packFormId: 'stock-movement', permission: 'submit_responses' },
            { packFormId: 'stock-movement', permission: 'view_all_responses' },
            { packFormId: 'stock-movement', permission: 'edit_responses' },
          ],
        },
      ],
    },
  ],
};
