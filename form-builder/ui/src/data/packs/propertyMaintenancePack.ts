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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total properties', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Property types', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'countDistinct', field: 'property_type' } } },
            { id: 'c1', title: 'By property type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:property', viz: 'bar', groupBy: { field: 'property_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Added over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:property', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent properties', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:property', titleField: 'address', subtitleField: 'owner_manager', limit: 8 } },
          ],
        },
      },
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
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total tenants', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:tenant', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Properties leased', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:tenant', viz: 'kpi', measure: { fn: 'countDistinct', field: 'property' } } },
            { id: 'c1', title: 'New leases over time', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:tenant', viz: 'area', groupBy: { field: 'lease_start', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c2', title: 'Tenants by property type', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:tenant', viz: 'bar', joins: [{ via: 'property', formId: '@pack:property', type: 'left' }], groupBy: { field: '@pack:property::property_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent tenants', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:tenant', titleField: 'name', subtitleField: 'unit', limit: 8 } },
          ],
        },
      },
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
          required: true,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'tenant',
          type: 'linked_record',
          label: 'Tenant',
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total requests', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Urgent', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'priority', op: 'eq', value: 'urgent' }] } },
            { id: 'k3', title: 'New this month', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: '__submitted_at', op: 'this_month' }] } },
            { id: 'c1', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Priority mix', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'donut', groupBy: { field: 'priority', bucket: 'none' }, measure: { fn: 'count' } } },
            { id: 'c3', title: 'By category', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'bar', groupBy: { field: 'category', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c4', title: 'Requests over time', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'area', groupBy: { field: 'reported_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent requests', layout: { x: 0, y: 7, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:maintenance-request', titleField: 'description', subtitleField: 'category', limit: 8 } },
          ],
        },
      },
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
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total work orders', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total cost', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'kpi', measure: { fn: 'sum', field: 'cost' } } },
            { id: 'k3', title: 'Total hours', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'kpi', measure: { fn: 'sum', field: 'hours' } } },
            { id: 'k4', title: 'Avg cost', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'kpi', measure: { fn: 'avg', field: 'cost' } } },
            { id: 'c1', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Spend over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'area', groupBy: { field: 'scheduled_date', bucket: 'month' }, measure: { fn: 'sum', field: 'cost' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent work orders', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:work-order', titleField: 'assigned_to', subtitleField: 'status', limit: 8 } },
          ],
        },
      },
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
          required: true,
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Total inspections', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Avg condition', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'kpi', measure: { fn: 'avg', field: 'condition' } } },
            { id: 'c1', title: 'By inspection type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'bar', groupBy: { field: 'inspection_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Inspections over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'area', groupBy: { field: 'inspection_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c3', title: 'By property type', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'bar', joins: [{ via: 'property', formId: '@pack:property', type: 'left' }], groupBy: { field: '@pack:property::property_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent inspections', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:inspection', titleField: 'inspector', subtitleField: 'inspection_type', limit: 8 } },
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
      packAppId: 'maintenance',
      name: 'Maintenance',
      description:
        'A property-maintenance operations hub for property managers and handymen: track properties, tenants, maintenance requests, work orders and inspections from one dashboard.',
      settings: { icon: 'Hammer' },
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
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Requests', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Work orders', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Properties', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Total spend', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:work-order', viz: 'kpi', measure: { fn: 'sum', field: 'cost' } } },
            { id: 'c1', title: 'Requests by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Requests over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-request', viz: 'area', groupBy: { field: 'reported_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 4, w: 12, h: 1 }, kind: 'actions' },
            { id: 'l1', title: 'Recent requests', layout: { x: 0, y: 5, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:maintenance-request', titleField: 'description', subtitleField: 'status', limit: 8 } },
            { id: 'v1', title: 'Recent activity', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'activity' },
          ],
        },
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
      reports: [
        {
          reportId: 'wo-by-status',
          kind: 'chart',
          name: 'Work orders by status',
          description: 'Count of work orders grouped by their current status.',
          spec: {
            formId: '@pack:work-order',
            viz: 'bar',
            groupBy: { field: 'status' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'req-by-priority',
          kind: 'chart',
          name: 'Maintenance requests by priority',
          description: 'Distribution of maintenance requests across priority levels.',
          spec: {
            formId: '@pack:maintenance-request',
            viz: 'pie',
            groupBy: { field: 'priority' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'req-over-time',
          kind: 'chart',
          name: 'Requests over time',
          description: 'Monthly volume of maintenance requests submitted.',
          spec: {
            formId: '@pack:maintenance-request',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'total-work-cost',
          kind: 'chart',
          name: 'Total work cost',
          description: 'Running KPI of total maintenance spend across all work orders.',
          spec: {
            formId: '@pack:work-order',
            viz: 'kpi',
            measure: { fn: 'sum', field: 'cost' },
          },
        },
        {
          reportId: 'maintenance-overview',
          kind: 'document',
          name: 'Maintenance overview',
          description: 'Executive summary of property maintenance operations.',
          blocks: [
            {
              kind: 'text',
              title: 'Maintenance overview',
              body: 'This report summarises current property maintenance operations: the volume and status of active work orders, the priority profile of maintenance requests, how request volumes are trending month-on-month, and total maintenance expenditure to date.',
            },
            { kind: 'report', reportId: 'wo-by-status', caption: 'Work orders by status' },
            { kind: 'report', reportId: 'req-by-priority', caption: 'Maintenance requests by priority' },
            { kind: 'report', reportId: 'req-over-time', caption: 'Requests submitted per month' },
            { kind: 'report', reportId: 'total-work-cost', caption: 'Total maintenance spend' },
          ],
        },
      ],
    },
  ],
};
