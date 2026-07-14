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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total customers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Customer types', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'kpi', measure: { fn: 'countDistinct', field: 'customer_type' } } },
            { id: 'c1', title: 'Customers by type', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'donut', groupBy: { field: 'customer_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'c2', title: 'New customers over time', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent customers', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:customer', titleField: 'name', subtitleField: 'customer_type', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total jobs', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Pipeline value', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'k3', title: 'Avg job value', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job', viz: 'kpi', measure: { fn: 'avg', field: 'estimated_value' } } },
            { id: 'k4', title: 'Job types', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job', viz: 'kpi', measure: { fn: 'countDistinct', field: 'job_type' } } },
            { id: 'c1', title: 'Jobs by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:job', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Jobs by type', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:job', viz: 'donut', groupBy: { field: 'job_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'l1', title: 'Recent jobs', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:job', titleField: 'site_address', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'customer',
          type: 'linked_record',
          label: 'Customer',
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total visits', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:site-visit', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Hours on site', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:site-visit', viz: 'kpi', measure: { fn: 'sum', field: 'hours_on_site' } } },
            { id: 'k3', title: 'Avg hours / visit', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:site-visit', viz: 'kpi', measure: { fn: 'avg', field: 'hours_on_site' } } },
            { id: 'c1', title: 'Visits by technician', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:site-visit', viz: 'bar', groupBy: { field: 'technician_name', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Visits over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:site-visit', viz: 'area', groupBy: { field: 'visit_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent visits', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:site-visit', titleField: 'technician_name', subtitleField: 'work_performed', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'job',
          type: 'linked_record',
          label: 'Job',
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total invoiced', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'sum', field: 'total' } } },
            { id: 'k2', title: 'Invoices', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Avg invoice', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'avg', field: 'total' } } },
            { id: 'k4', title: 'Labour billed', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'sum', field: 'labour_amount' } } },
            { id: 'c1', title: 'Invoices by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Invoiced over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'area', groupBy: { field: 'issue_date', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent invoices', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:invoice', titleField: 'invoice_number', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'job',
          type: 'linked_record',
          label: 'Job',
          required: true,
          properties: { targetFormId: '@pack:job' },
        },
        {
          id: 'customer',
          type: 'linked_record',
          label: 'Customer',
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total requests', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Units requested', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'kpi', measure: { fn: 'sum', field: 'quantity' } } },
            { id: 'k3', title: 'Avg unit cost', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'kpi', measure: { fn: 'avg', field: 'unit_cost' } } },
            { id: 'k4', title: 'Suppliers', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'kpi', measure: { fn: 'countDistinct', field: 'supplier' } } },
            { id: 'c1', title: 'Requests by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Requests by supplier', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'donut', groupBy: { field: 'supplier', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 6 } },
            { id: 'l1', title: 'Recent requests', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:parts-request', titleField: 'item', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'job',
          type: 'linked_record',
          label: 'Job',
          required: true,
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
      settings: { icon: 'Wrench' },
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
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Customers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Jobs', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Total invoiced', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'sum', field: 'total' } } },
            { id: 'k4', title: 'Parts requests', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-request', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'c1', title: 'Invoiced over time', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'line', groupBy: { field: 'issue_date', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'c2', title: 'Jobs by status', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:job', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent jobs', layout: { x: 0, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:job', titleField: 'site_address', subtitleField: 'status', limit: 6 } },
            { id: 'a2', title: 'Recent activity', layout: { x: 8, y: 4, w: 4, h: 3 }, kind: 'activity' },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 7, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
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
      reports: [
        {
          reportId: 'jobs-by-status',
          kind: 'chart',
          name: 'Jobs by status',
          spec: { formId: '@pack:job', viz: 'bar', groupBy: { field: 'status' }, measure: { fn: 'count' } },
        },
        {
          reportId: 'jobs-over-time',
          kind: 'chart',
          name: 'Jobs booked over time',
          spec: { formId: '@pack:job', viz: 'line', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' } },
        },
        {
          reportId: 'pipeline-by-customer-type',
          kind: 'chart',
          name: 'Pipeline value by customer type',
          description: 'Estimated job value grouped by the customer’s type (Jobs joined to Customers).',
          spec: {
            formId: '@pack:job',
            viz: 'bar',
            joins: [{ via: 'customer', formId: '@pack:customer', type: 'left' }],
            groupBy: { field: '@pack:customer::customer_type' },
            measure: { fn: 'sum', field: 'estimated_value' },
          },
        },
        {
          reportId: 'total-invoiced',
          kind: 'chart',
          name: 'Total invoiced',
          spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'sum', field: 'total' } },
        },
        {
          reportId: 'field-service-overview',
          kind: 'document',
          name: 'Field Service overview',
          description: 'A one-page snapshot of the job pipeline, customer mix and billing.',
          blocks: [
            { kind: 'text', title: 'Overview', body: 'A snapshot of where jobs sit in the workflow, the value in the pipeline by customer segment, and total invoicing to date.' },
            { kind: 'report', reportId: 'jobs-by-status', caption: 'Where current jobs sit in the workflow.' },
            { kind: 'report', reportId: 'pipeline-by-customer-type', caption: 'Estimated pipeline value by customer segment.' },
            { kind: 'report', reportId: 'total-invoiced' },
          ],
        },
      ],
    },
  ],
};
