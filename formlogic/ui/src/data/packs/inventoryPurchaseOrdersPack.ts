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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total products', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:product', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Units on hand', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:product', viz: 'kpi', measure: { fn: 'sum', field: 'stock_on_hand' } } },
            { id: 'k3', title: 'Avg unit cost', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:product', viz: 'kpi', measure: { fn: 'avg', field: 'unit_cost' } } },
            { id: 'c1', title: 'Products by category', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:product', viz: 'bar', groupBy: { field: 'category', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'New products over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:product', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent products', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:product', titleField: 'name', subtitleField: 'sku', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total suppliers', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:supplier', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Avg lead time (days)', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:supplier', viz: 'kpi', measure: { fn: 'avg', field: 'lead_time_days' } } },
            { id: 'k3', title: 'Longest lead time', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:supplier', viz: 'kpi', measure: { fn: 'max', field: 'lead_time_days' } } },
            { id: 'c1', title: 'Suppliers by payment terms', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:supplier', viz: 'bar', groupBy: { field: 'payment_terms', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'c2', title: 'New suppliers over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:supplier', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent suppliers', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:supplier', titleField: 'name', subtitleField: 'contact_name', limit: 6 } },
          ],
        },
      },
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
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Purchase orders', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total value', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'kpi', measure: { fn: 'sum', field: 'total' } } },
            { id: 'k3', title: 'Avg PO value', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'kpi', measure: { fn: 'avg', field: 'total' } } },
            { id: 'k4', title: 'Suppliers used', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'kpi', measure: { fn: 'countDistinct', field: 'supplier' } } },
            { id: 'c1', title: 'PO value by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'value', sort: 'desc' } },
            { id: 'c2', title: 'PO value over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent purchase orders', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:purchase-order', titleField: 'po_number', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
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
          required: true,
          properties: { targetFormId: '@pack:purchase-order' },
        },
        {
          id: 'product',
          type: 'linked_record',
          label: 'Product',
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Line items', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:po-line-item', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total value', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:po-line-item', viz: 'kpi', measure: { fn: 'sum', field: 'line_total' } } },
            { id: 'k3', title: 'Units ordered', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:po-line-item', viz: 'kpi', measure: { fn: 'sum', field: 'quantity' } } },
            { id: 'c1', title: 'Value by product category', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:po-line-item', viz: 'bar', joins: [{ via: 'product', formId: '@pack:product', type: 'left' }], groupBy: { field: '@pack:product::category', bucket: 'none' }, measure: { fn: 'sum', field: 'line_total' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Line items over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:po-line-item', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent line items', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:po-line-item', titleField: 'quantity', limit: 6 } },
          ],
        },
      },
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
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total movements', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:stock-movement', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total quantity moved', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:stock-movement', viz: 'kpi', measure: { fn: 'sum', field: 'quantity' } } },
            { id: 'k3', title: 'Products moved', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:stock-movement', viz: 'kpi', measure: { fn: 'countDistinct', field: 'product' } } },
            { id: 'c1', title: 'Movements by type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:stock-movement', viz: 'bar', groupBy: { field: 'movement_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc' } },
            { id: 'c2', title: 'Movements over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:stock-movement', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent movements', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:stock-movement', titleField: 'reason', subtitleField: 'movement_type', limit: 6 } },
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
      packAppId: 'inventory',
      name: 'Inventory',
      description:
        'A stock-control and purchasing hub: track products, suppliers, purchase orders, line items and stock movements — with low-stock alerts and live stock value — from one dashboard.',
      settings: { icon: 'Package' },
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
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Products', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:product', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Suppliers', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:supplier', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Purchase orders', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Stock movements', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:stock-movement', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'c1', title: 'PO value by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'value', sort: 'desc' } },
            { id: 'c2', title: 'Purchasing spend over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:purchase-order', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'Products by category', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:product', viz: 'donut', groupBy: { field: 'category', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'a1', title: 'Recent activity', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'activity' },
            { id: 'a2', title: 'Quick actions', layout: { x: 0, y: 7, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
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
      reports: [
        {
          reportId: 'products-by-category',
          kind: 'chart',
          name: 'Products by category',
          description: 'Count of catalogue products broken down by category.',
          spec: {
            formId: '@pack:product',
            viz: 'pie',
            groupBy: { field: 'category' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'po-by-status',
          kind: 'chart',
          name: 'Purchase orders by status',
          description: 'Total PO value (sum of total field) grouped by order status.',
          spec: {
            formId: '@pack:purchase-order',
            viz: 'bar',
            groupBy: { field: 'status' },
            measure: { fn: 'sum', field: 'total' },
          },
        },
        {
          reportId: 'po-value-over-time',
          kind: 'chart',
          name: 'PO value over time',
          description: 'Monthly trend of purchase order total value.',
          spec: {
            formId: '@pack:purchase-order',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'sum', field: 'total' },
            sort: 'asc',
          },
        },
        {
          reportId: 'stock-movements-by-type',
          kind: 'chart',
          name: 'Stock movements by type',
          description: 'Number of stock movements broken down by movement type.',
          spec: {
            formId: '@pack:stock-movement',
            viz: 'bar',
            groupBy: { field: 'movement_type' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'inventory-overview',
          kind: 'document',
          name: 'Inventory Overview',
          blocks: [
            {
              kind: 'text',
              title: 'Inventory & Purchasing Overview',
              body: 'This document summarises the state of your inventory and purchasing pipeline. Use it to review open purchase orders by status, understand stock movement patterns, and track spending trends over time.',
            },
            { kind: 'report', reportId: 'po-by-status', caption: 'Purchase order values broken down by current status.' },
            { kind: 'report', reportId: 'po-value-over-time', caption: 'Monthly purchasing spend trend.' },
            { kind: 'report', reportId: 'stock-movements-by-type', caption: 'Breakdown of all logged stock movements by movement type.' },
          ],
        },
      ],
    },
  ],
};
