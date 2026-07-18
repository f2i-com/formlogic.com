// ── Type re-use ─────────────────────────────────────────────────────────────
import type { PackData } from '../types';

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
  primaryColor: '#ea580c',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const mechanicWorkshopPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'mechanic-workshop',
    name: 'Mechanic Workshop Manager',
    description:
      'Run an auto mechanic workshop end to end: manage customers and their vehicles, open and track job cards through the bay, log parts used, and raise invoices — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['mechanic', 'automotive', 'workshop', 'repairs', 'vehicles'],
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
        'Add a workshop customer with their contact details so you can link their vehicles and jobs.',
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
            { id: 'c1', title: 'Customers by type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'bar', groupBy: { field: 'customer_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'New customers over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'Type share', layout: { x: 0, y: 4, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'donut', groupBy: { field: 'customer_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'l1', title: 'Recent customers', layout: { x: 4, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:customer', titleField: 'name', subtitleField: 'phone', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Customer',
          description: 'Capture the customer details so you can book their vehicles in for work.',
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
          required: false,
          properties: { placeholder: 'Street, suburb, state, postcode' },
        },
        {
          id: 'customer_type',
          type: 'dropdown',
          label: 'Customer Type',
          required: true,
          properties: {
            options: [
              { id: 'private', label: 'Private / Retail', value: 'private' },
              { id: 'fleet', label: 'Fleet', value: 'fleet' },
              { id: 'business', label: 'Business', value: 'business' },
              { id: 'dealer', label: 'Dealer / Trade', value: 'dealer' },
              { id: 'insurance', label: 'Insurance', value: 'insurance' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Preferred contact times, account terms, history…' },
        },
      ],
    },

    // ── 2. Vehicle ────────────────────────────────────────────────────────
    {
      packFormId: 'vehicle',
      title: 'Vehicle',
      icon: 'Car',
      description:
        'Register a vehicle against a customer with make, model, year, plate, odometer and fuel type.',
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
            { id: 'k1', title: 'Total vehicles', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:vehicle', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Avg odometer (km)', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:vehicle', viz: 'kpi', measure: { fn: 'avg', field: 'odometer' } } },
            { id: 'c1', title: 'Vehicles by fuel type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:vehicle', viz: 'bar', groupBy: { field: 'fuel', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Vehicles added over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:vehicle', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'Fuel share', layout: { x: 0, y: 4, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:vehicle', viz: 'donut', groupBy: { field: 'fuel', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'l1', title: 'Recent vehicles', layout: { x: 4, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:vehicle', titleField: 'make', subtitleField: 'registration', limit: 6 } },
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
          id: 'make',
          type: 'short_text',
          label: 'Make',
          required: true,
          properties: { placeholder: 'e.g. Toyota' },
        },
        {
          id: 'model',
          type: 'short_text',
          label: 'Model',
          required: true,
          properties: { placeholder: 'e.g. Corolla' },
        },
        {
          id: 'year',
          type: 'number',
          label: 'Year',
          required: true,
          properties: { placeholder: '2018', min: 1950, max: 2027, step: 1 },
        },
        {
          id: 'registration',
          type: 'short_text',
          label: 'Registration / Plate',
          required: true,
          properties: { placeholder: 'e.g. ABC-123' },
        },
        {
          id: 'odometer',
          type: 'number',
          label: 'Odometer (km)',
          required: false,
          properties: { placeholder: '0', min: 0, step: 1 },
        },
        {
          id: 'fuel',
          type: 'dropdown',
          label: 'Fuel Type',
          required: true,
          properties: {
            options: [
              { id: 'petrol', label: 'Petrol', value: 'petrol' },
              { id: 'diesel', label: 'Diesel', value: 'diesel' },
              { id: 'hybrid', label: 'Hybrid', value: 'hybrid' },
              { id: 'electric', label: 'Electric', value: 'electric' },
              { id: 'lpg', label: 'LPG', value: 'lpg' },
            ],
          },
        },
        {
          id: 'vin',
          type: 'short_text',
          label: 'VIN',
          required: false,
          properties: { placeholder: 'Vehicle identification number' },
        },
      ],
    },

    // ── 3. Job Card ───────────────────────────────────────────────────────
    {
      packFormId: 'job-card',
      title: 'Job Card',
      icon: 'ClipboardList',
      description:
        'Open a job card for a vehicle: complaint, status, technician, labour hours, priority and date in.',
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
            { id: 'k1', title: 'Total job cards', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Labour hours', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'kpi', measure: { fn: 'sum', field: 'labour_hours' } } },
            { id: 'k3', title: 'Technicians', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'kpi', measure: { fn: 'countDistinct', field: 'technician' } } },
            { id: 'c1', title: 'Job cards by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Jobs opened over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'area', groupBy: { field: 'date_in', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'By priority', layout: { x: 0, y: 4, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'donut', groupBy: { field: 'priority', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'l1', title: 'Recent job cards', layout: { x: 4, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:job-card', titleField: 'complaint', subtitleField: 'technician', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'vehicle',
          type: 'linked_record',
          label: 'Vehicle',
          required: true,
          properties: { targetFormId: '@pack:vehicle' },
        },
        {
          id: 'customer',
          type: 'linked_record',
          label: 'Customer',
          required: true,
          properties: { targetFormId: '@pack:customer' },
        },
        {
          id: 'complaint',
          type: 'long_text',
          label: 'Complaint / Work Requested',
          required: true,
          properties: { placeholder: 'Describe the reported fault or the work requested…' },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'booked', label: 'Booked', value: 'booked' },
              { id: 'in-progress', label: 'In Progress', value: 'in-progress' },
              { id: 'awaiting-parts', label: 'Awaiting Parts', value: 'awaiting-parts' },
              { id: 'ready', label: 'Ready for Pickup', value: 'ready' },
              { id: 'invoiced', label: 'Invoiced', value: 'invoiced' },
            ],
          },
        },
        {
          id: 'technician',
          type: 'short_text',
          label: 'Technician',
          required: false,
          properties: { placeholder: 'Assigned mechanic' },
        },
        {
          id: 'labour_hours',
          type: 'number',
          label: 'Labour Hours',
          required: false,
          properties: { placeholder: '0', min: 0, step: 0.25 },
        },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'normal', label: 'Normal', value: 'normal' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'urgent', label: 'Urgent', value: 'urgent' },
            ],
          },
        },
        {
          id: 'date_in',
          type: 'date',
          label: 'Date In',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 4. Parts Used ─────────────────────────────────────────────────────
    {
      packFormId: 'parts-used',
      title: 'Parts Used',
      icon: 'Package',
      description:
        'Log a part consumed on a job card, with quantity and unit cost.',
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
            { id: 'k1', title: 'Line items', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-used', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Units used', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-used', viz: 'kpi', measure: { fn: 'sum', field: 'quantity' } } },
            { id: 'k3', title: 'Avg unit cost', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:parts-used', viz: 'kpi', measure: { fn: 'avg', field: 'unit_cost' } } },
            { id: 'c1', title: 'Parts by supplier', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:parts-used', viz: 'bar', groupBy: { field: 'supplier', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Parts logged over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:parts-used', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'Top parts by volume', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:parts-used', viz: 'bar', groupBy: { field: 'part_name', bucket: 'none' }, measure: { fn: 'sum', field: 'quantity' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent parts', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:parts-used', titleField: 'part_name', subtitleField: 'supplier', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'job_card',
          type: 'linked_record',
          label: 'Job Card',
          required: true,
          properties: { targetFormId: '@pack:job-card' },
        },
        {
          id: 'part_name',
          type: 'short_text',
          label: 'Part Name',
          required: true,
          properties: { placeholder: 'e.g. Oil filter' },
        },
        {
          id: 'part_number',
          type: 'short_text',
          label: 'Part Number',
          required: false,
          properties: { placeholder: 'e.g. OF-1042' },
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
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'supplier',
          type: 'short_text',
          label: 'Supplier',
          required: false,
          properties: { placeholder: 'Where the part was sourced' },
        },
      ],
    },

    // ── 5. Invoice ────────────────────────────────────────────────────────
    {
      packFormId: 'invoice',
      title: 'Invoice',
      icon: 'Receipt',
      description:
        'Raise an invoice against a job card with labour, parts and total amounts.',
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
            { id: 'k1', title: 'Total invoices', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total invoiced', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'sum', field: 'total' } } },
            { id: 'k3', title: 'Average invoice', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'avg', field: 'total' } } },
            { id: 'c1', title: 'Invoices by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Revenue over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'area', groupBy: { field: 'issue_date', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'Status share', layout: { x: 0, y: 4, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'l1', title: 'Recent invoices', layout: { x: 4, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:invoice', titleField: 'invoice_number', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'job_card',
          type: 'linked_record',
          label: 'Job Card',
          required: true,
          properties: { targetFormId: '@pack:job-card' },
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
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'workshop',
      name: 'Workshop',
      description:
        'A workshop operations hub for an auto mechanic: track customers, vehicles, job cards, parts used and invoices from one dashboard.',
      settings: { icon: 'Car' },
      theme: {
        primaryColor: '#ea580c',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'customer', displayName: 'Customers', sortOrder: 1, isVisible: true },
        { packFormId: 'vehicle', displayName: 'Vehicles', sortOrder: 2, isVisible: true },
        { packFormId: 'job-card', displayName: 'Job Cards', sortOrder: 3, isVisible: true },
        { packFormId: 'parts-used', displayName: 'Parts Used', sortOrder: 4, isVisible: true },
        { packFormId: 'invoice', displayName: 'Invoices', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Customers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:customer', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Vehicles', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:vehicle', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Job cards', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Total invoiced', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'kpi', measure: { fn: 'sum', field: 'total' } } },
            { id: 'c1', title: 'Job cards by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:job-card', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Revenue over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:invoice', viz: 'area', groupBy: { field: 'issue_date', bucket: 'month' }, measure: { fn: 'sum', field: 'total' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent job cards', layout: { x: 0, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:job-card', titleField: 'complaint', subtitleField: 'technician', limit: 6 } },
            { id: 'a2', title: 'Recent activity', layout: { x: 8, y: 4, w: 4, h: 3 }, kind: 'activity' },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 7, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
      },
      roles: [
        {
          name: 'Workshop Owner',
          description: 'Full access to all workshop forms.',
          permissions: [
            { packFormId: 'customer', permission: 'submit_responses' },
            { packFormId: 'customer', permission: 'view_all_responses' },
            { packFormId: 'customer', permission: 'edit_responses' },
            { packFormId: 'customer', permission: 'delete_responses' },
            { packFormId: 'customer', permission: 'export_responses' },
            { packFormId: 'vehicle', permission: 'submit_responses' },
            { packFormId: 'vehicle', permission: 'view_all_responses' },
            { packFormId: 'vehicle', permission: 'edit_responses' },
            { packFormId: 'vehicle', permission: 'delete_responses' },
            { packFormId: 'vehicle', permission: 'export_responses' },
            { packFormId: 'job-card', permission: 'submit_responses' },
            { packFormId: 'job-card', permission: 'view_all_responses' },
            { packFormId: 'job-card', permission: 'edit_responses' },
            { packFormId: 'job-card', permission: 'delete_responses' },
            { packFormId: 'job-card', permission: 'export_responses' },
            { packFormId: 'parts-used', permission: 'submit_responses' },
            { packFormId: 'parts-used', permission: 'view_all_responses' },
            { packFormId: 'parts-used', permission: 'edit_responses' },
            { packFormId: 'parts-used', permission: 'delete_responses' },
            { packFormId: 'parts-used', permission: 'export_responses' },
            { packFormId: 'invoice', permission: 'submit_responses' },
            { packFormId: 'invoice', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'edit_responses' },
            { packFormId: 'invoice', permission: 'delete_responses' },
            { packFormId: 'invoice', permission: 'export_responses' },
          ],
        },
        {
          name: 'Mechanic',
          description: 'Technicians who work job cards and log the parts they use.',
          permissions: [
            { packFormId: 'customer', permission: 'view_all_responses' },
            { packFormId: 'vehicle', permission: 'view_all_responses' },
            { packFormId: 'job-card', permission: 'view_all_responses' },
            { packFormId: 'job-card', permission: 'edit_responses' },
            { packFormId: 'parts-used', permission: 'submit_responses' },
            { packFormId: 'parts-used', permission: 'view_all_responses' },
            { packFormId: 'parts-used', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Service Advisor',
          description: 'Front-desk staff who book vehicles in, manage customers and raise invoices.',
          permissions: [
            { packFormId: 'customer', permission: 'submit_responses' },
            { packFormId: 'customer', permission: 'view_all_responses' },
            { packFormId: 'customer', permission: 'edit_responses' },
            { packFormId: 'vehicle', permission: 'submit_responses' },
            { packFormId: 'vehicle', permission: 'view_all_responses' },
            { packFormId: 'vehicle', permission: 'edit_responses' },
            { packFormId: 'job-card', permission: 'submit_responses' },
            { packFormId: 'job-card', permission: 'view_all_responses' },
            { packFormId: 'job-card', permission: 'edit_responses' },
            { packFormId: 'parts-used', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'submit_responses' },
            { packFormId: 'invoice', permission: 'view_all_responses' },
            { packFormId: 'invoice', permission: 'edit_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'jobcards-by-status',
          kind: 'chart',
          name: 'Job Cards by Status',
          description: 'Count of job cards grouped by their current workflow status.',
          spec: {
            formId: '@pack:job-card',
            viz: 'bar',
            groupBy: { field: 'status' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'jobs-by-vehicle-make',
          kind: 'chart',
          name: 'Jobs by Vehicle Make',
          description: 'Number of job cards raised per vehicle make, resolved via the vehicle link.',
          spec: {
            formId: '@pack:job-card',
            viz: 'bar',
            joins: [{ via: 'vehicle', formId: '@pack:vehicle', type: 'left' }],
            groupBy: { field: '@pack:vehicle::make' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
            limit: 10,
          },
        },
        {
          reportId: 'jobs-over-time',
          kind: 'chart',
          name: 'Jobs Over Time',
          description: 'Monthly trend of job cards opened.',
          spec: {
            formId: '@pack:job-card',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'total-labour-hours',
          kind: 'chart',
          name: 'Total Labour Hours',
          description: 'Sum of all labour hours logged across all job cards.',
          spec: {
            formId: '@pack:job-card',
            viz: 'kpi',
            measure: { fn: 'sum', field: 'labour_hours' },
          },
        },
        {
          reportId: 'workshop-overview',
          kind: 'document',
          name: 'Workshop Overview',
          description: 'A summary document of workshop activity combining key charts for management reporting.',
          blocks: [
            {
              kind: 'text',
              title: 'Workshop Overview',
              body: 'This report summarises current workshop activity: the job card pipeline by status, job volume broken down by vehicle make, monthly throughput trend, and cumulative labour hours on record.',
            },
            { kind: 'report', reportId: 'jobcards-by-status', caption: 'Current job card status breakdown' },
            { kind: 'report', reportId: 'jobs-by-vehicle-make', caption: 'Top vehicle makes by job volume' },
            { kind: 'report', reportId: 'jobs-over-time', caption: 'Monthly job card volume trend' },
            { kind: 'report', reportId: 'total-labour-hours', caption: 'Cumulative labour hours across all jobs' },
          ],
        },
      ],
    },
  ],
};

export default mechanicWorkshopPack;
