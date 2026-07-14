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
  primaryColor: '#4d7c0f',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const agriLogPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'agrilog-farm',
    name: 'AgriLog — Farm Jobs & Harvest Tracker',
    description:
      'A whole-farm operations log for small farms: map your paddocks and their crops, schedule and track field jobs, tally every harvest load, keep a compliant chemical register with live withholding periods, and stay on top of machinery and its maintenance — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['farm', 'agriculture', 'harvest', 'paddocks', 'compliance'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Paddock ────────────────────────────────────────────────────────
    {
      packFormId: 'paddock',
      title: 'Paddock',
      icon: 'Sprout',
      description:
        'Map a block or paddock with its crop, area, irrigation and current working status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Paddock',
          description: 'Add a block so you can plan jobs, log harvests and keep chemical records against it.',
          required: false,
          properties: {},
        },
        {
          id: 'block_name',
          type: 'short_text',
          label: 'Block name',
          required: true,
          properties: { placeholder: 'e.g. North Paddock, River Block 3' },
        },
        {
          id: 'crop',
          type: 'short_text',
          label: 'Crop',
          required: false,
          properties: { placeholder: 'e.g. Wheat, Barley, Lucerne' },
        },
        {
          id: 'area_ha',
          type: 'number',
          label: 'Area (hectares)',
          required: false,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'soil_notes',
          type: 'long_text',
          label: 'Soil notes',
          required: false,
          properties: { placeholder: 'Soil type, pH, drainage, recent amendments…' },
        },
        {
          id: 'irrigation',
          type: 'dropdown',
          label: 'Irrigation type',
          required: false,
          properties: {
            options: [
              { id: 'drip', label: 'Drip', value: 'drip' },
              { id: 'sprinkler', label: 'Sprinkler', value: 'sprinkler' },
              { id: 'flood', label: 'Flood', value: 'flood' },
              { id: 'dryland', label: 'Dryland', value: 'dryland' },
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
              { id: 'in-crop', label: 'In crop', value: 'in-crop' },
              { id: 'fallow', label: 'Fallow', value: 'fallow' },
              { id: 'being-prepared', label: 'Being prepared', value: 'being-prepared' },
              { id: 'grazing', label: 'Grazing', value: 'grazing' },
            ],
          },
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
            { id: 'k1', title: 'Total blocks', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:paddock', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total area (ha)', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:paddock', viz: 'kpi', measure: { fn: 'sum', field: 'area_ha' } } },
            { id: 'c2', title: 'Irrigation mix', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:paddock', viz: 'donut', groupBy: { field: 'irrigation', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c1', title: 'Blocks by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:paddock', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'New blocks over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:paddock', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent blocks', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:paddock', titleField: 'block_name', subtitleField: 'crop', limit: 6 } },
          ],
        },
      },
    },

    // ── 2. Farm Job ───────────────────────────────────────────────────────
    {
      packFormId: 'farm-job',
      title: 'Farm Job',
      icon: 'ClipboardList',
      description:
        'Schedule a field job against a block — planting, spraying, harvest or maintenance — and track it to done.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Farm Job',
          description: 'Plan a job on a paddock, assign it and keep the work board moving.',
          required: false,
          properties: {},
        },
        {
          id: 'block',
          type: 'linked_record',
          label: 'Block',
          required: true,
          properties: { targetFormId: '@pack:paddock' },
        },
        {
          id: 'job_type',
          type: 'dropdown',
          label: 'Job type',
          required: true,
          properties: {
            options: [
              { id: 'planting', label: 'Planting', value: 'planting' },
              { id: 'spraying', label: 'Spraying', value: 'spraying' },
              { id: 'irrigation', label: 'Irrigation', value: 'irrigation' },
              { id: 'fertiliser', label: 'Fertiliser', value: 'fertiliser' },
              { id: 'harvest', label: 'Harvest', value: 'harvest' },
              { id: 'maintenance', label: 'Maintenance', value: 'maintenance' },
            ],
          },
        },
        {
          id: 'scheduled_date',
          type: 'date',
          label: 'Scheduled date',
          required: true,
          properties: {},
        },
        {
          id: 'completed_date',
          type: 'date',
          label: 'Completed date',
          required: false,
          properties: {},
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned to',
          required: false,
          properties: { placeholder: 'Who is doing the work' },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'planned', label: 'Planned', value: 'planned' },
              { id: 'in-progress', label: 'In progress', value: 'in-progress' },
              { id: 'done', label: 'Done', value: 'done' },
              { id: 'rained-off', label: 'Rained off', value: 'rained-off' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Rates, gear, paddock conditions, anything to hand over…' },
        },
        {
          id: 'photos',
          type: 'file_upload',
          label: 'Photos',
          required: false,
          properties: { acceptedFileTypes: ['.jpg', '.png'] },
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
            { id: 'k1', title: 'Total jobs', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Done', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'done' }] } },
            { id: 'c2', title: 'Jobs by type', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'donut', groupBy: { field: 'job_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 8 } },
            { id: 'c1', title: 'Jobs by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Jobs scheduled over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'area', groupBy: { field: 'scheduled_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent jobs', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:farm-job', titleField: 'job_type', subtitleField: 'assigned_to', limit: 6 } },
          ],
        },
      },
    },

    // ── 3. Harvest Log ────────────────────────────────────────────────────
    {
      packFormId: 'harvest-log',
      title: 'Harvest Log',
      icon: 'Wheat',
      description:
        'Record a harvested load off a block with its crop, quantity, grade and where it went.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Harvest Log',
          description: 'Log a load as it comes off the paddock so the season tally stays current.',
          required: false,
          properties: {},
        },
        {
          id: 'block',
          type: 'linked_record',
          label: 'Block',
          required: true,
          properties: { targetFormId: '@pack:paddock' },
        },
        {
          id: 'harvest_date',
          type: 'date',
          label: 'Harvest date',
          required: true,
          properties: {},
        },
        {
          id: 'crop',
          type: 'short_text',
          label: 'Crop',
          required: false,
          properties: { placeholder: 'e.g. Wheat, Apples, Hay' },
        },
        {
          id: 'quantity',
          type: 'number',
          label: 'Quantity',
          required: false,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'unit',
          type: 'dropdown',
          label: 'Unit',
          required: false,
          properties: {
            options: [
              { id: 'tonnes', label: 'Tonnes', value: 'tonnes' },
              { id: 'kg', label: 'kg', value: 'kg' },
              { id: 'bins', label: 'Bins', value: 'bins' },
              { id: 'bales', label: 'Bales', value: 'bales' },
            ],
          },
        },
        {
          id: 'grade',
          type: 'dropdown',
          label: 'Grade',
          required: false,
          properties: {
            options: [
              { id: 'premium', label: 'Premium', value: 'premium' },
              { id: 'grade-1', label: 'Grade 1', value: 'grade-1' },
              { id: 'grade-2', label: 'Grade 2', value: 'grade-2' },
              { id: 'juice-feed', label: 'Juice or feed', value: 'juice-feed' },
            ],
          },
        },
        {
          id: 'buyer',
          type: 'short_text',
          label: 'Buyer or destination',
          required: false,
          properties: { placeholder: 'e.g. Co-op silo, Packing shed, On-farm store' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Moisture, quality notes, docket numbers…' },
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
            { id: 'k1', title: 'Total loads', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total quantity', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'kpi', measure: { fn: 'sum', field: 'quantity' } } },
            { id: 'c2', title: 'Loads by unit', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'donut', groupBy: { field: 'unit', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c1', title: 'Loads by grade', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'bar', groupBy: { field: 'grade', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Harvest over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'area', groupBy: { field: 'harvest_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent loads', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:harvest-log', titleField: 'crop', subtitleField: 'buyer', limit: 6 } },
          ],
        },
      },
    },

    // ── 4. Chemical Application ───────────────────────────────────────────
    {
      packFormId: 'chemical-application',
      title: 'Chemical Application',
      icon: 'SprayCan',
      description:
        'Record a spray or chemical application against a block, with rate, operator and withholding period — your compliance register.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Chemical Application',
          description: 'Log every application as you go — this register and its withholding periods are your audit trail.',
          required: false,
          properties: {},
        },
        {
          id: 'block',
          type: 'linked_record',
          label: 'Block',
          required: true,
          properties: { targetFormId: '@pack:paddock' },
        },
        {
          id: 'product_used',
          type: 'short_text',
          label: 'Product used',
          required: true,
          properties: { placeholder: 'Product / active ingredient' },
        },
        {
          id: 'rate',
          type: 'short_text',
          label: 'Rate',
          required: false,
          properties: { placeholder: 'e.g. 2 L/ha' },
        },
        {
          id: 'application_date',
          type: 'date',
          label: 'Application date',
          required: false,
          properties: {},
        },
        {
          id: 'operator',
          type: 'short_text',
          label: 'Operator',
          required: false,
          properties: { placeholder: 'Who applied it' },
        },
        {
          id: 'weather',
          type: 'long_text',
          label: 'Weather conditions',
          required: false,
          properties: { placeholder: 'Wind speed and direction, temperature, delta-T…' },
        },
        {
          id: 'whp_end',
          type: 'date',
          label: 'Withholding period end',
          required: false,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Batch numbers, target pest or weed, tank mix…' },
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
            { id: 'k1', title: 'On the register', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:chemical-application', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Applied this month', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:chemical-application', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'application_date', op: 'this_month' }] } },
            { id: 'c2', title: 'By product used', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:chemical-application', viz: 'donut', groupBy: { field: 'product_used', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c1', title: 'Applications by block', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:chemical-application', viz: 'bar', joins: [{ via: 'block', formId: '@pack:paddock', type: 'left' }], groupBy: { field: '@pack:paddock::block_name', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Applications over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:chemical-application', viz: 'area', groupBy: { field: 'application_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent applications', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:chemical-application', titleField: 'product_used', subtitleField: 'operator', limit: 6 } },
          ],
        },
      },
    },

    // ── 5. Machine ────────────────────────────────────────────────────────
    {
      packFormId: 'machinery',
      title: 'Machine',
      icon: 'Tractor',
      description:
        'Add a machine to the shed with its type, hours, service-due date and running status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Machine',
          description: 'Add a tractor, harvester or implement so you can track hours, service and maintenance against it.',
          required: false,
          properties: {},
        },
        {
          id: 'machine_name',
          type: 'short_text',
          label: 'Machine name',
          required: true,
          properties: { placeholder: 'e.g. John Deere 6120, Boom Sprayer' },
        },
        {
          id: 'machine_type',
          type: 'dropdown',
          label: 'Type',
          required: false,
          properties: {
            options: [
              { id: 'tractor', label: 'Tractor', value: 'tractor' },
              { id: 'harvester', label: 'Harvester', value: 'harvester' },
              { id: 'sprayer', label: 'Sprayer', value: 'sprayer' },
              { id: 'ute', label: 'Ute', value: 'ute' },
              { id: 'implement', label: 'Implement', value: 'implement' },
              { id: 'pump', label: 'Pump', value: 'pump' },
            ],
          },
        },
        {
          id: 'service_due',
          type: 'date',
          label: 'Service due date',
          required: false,
          properties: {},
        },
        {
          id: 'hours',
          type: 'number',
          label: 'Hours',
          required: false,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'running', label: 'Running', value: 'running' },
              { id: 'due-for-service', label: 'Due for service', value: 'due-for-service' },
              { id: 'in-workshop', label: 'In workshop', value: 'in-workshop' },
              { id: 'retired', label: 'Retired', value: 'retired' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Attachments, quirks, registration, insurance…' },
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
            { id: 'k1', title: 'Machines', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:machinery', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total hours', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:machinery', viz: 'kpi', measure: { fn: 'sum', field: 'hours' } } },
            { id: 'c2', title: 'Fleet by type', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:machinery', viz: 'donut', groupBy: { field: 'machine_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 8 } },
            { id: 'c1', title: 'Machines by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:machinery', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Hours by type', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:machinery', viz: 'bar', groupBy: { field: 'machine_type', bucket: 'none' }, measure: { fn: 'sum', field: 'hours' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'The shed', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:machinery', titleField: 'machine_name', subtitleField: 'machine_type', limit: 6 } },
          ],
        },
      },
    },

    // ── 6. Maintenance Log ────────────────────────────────────────────────
    {
      packFormId: 'maintenance-log',
      title: 'Maintenance Log',
      icon: 'Wrench',
      description:
        'Log a service or repair on a machine with its type, cost and a photo or receipt.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Maintenance Log',
          description: 'Record every service and repair so upkeep costs and machine history stay on record.',
          required: false,
          properties: {},
        },
        {
          id: 'machine',
          type: 'linked_record',
          label: 'Machine',
          required: true,
          properties: { targetFormId: '@pack:machinery' },
        },
        {
          id: 'date',
          type: 'date',
          label: 'Date',
          required: true,
          properties: {},
        },
        {
          id: 'maintenance_type',
          type: 'dropdown',
          label: 'Maintenance type',
          required: false,
          properties: {
            options: [
              { id: 'scheduled-service', label: 'Scheduled service', value: 'scheduled-service' },
              { id: 'repair', label: 'Repair', value: 'repair' },
              { id: 'tyres-tracks', label: 'Tyres or tracks', value: 'tyres-tracks' },
              { id: 'electrical', label: 'Electrical', value: 'electrical' },
              { id: 'hydraulics', label: 'Hydraulics', value: 'hydraulics' },
            ],
          },
        },
        {
          id: 'cost',
          type: 'number',
          label: 'Cost ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'What was done, parts fitted, workshop or contractor…' },
        },
        {
          id: 'photo',
          type: 'file_upload',
          label: 'Photo or receipt',
          required: false,
          properties: { acceptedFileTypes: ['.jpg', '.png', '.pdf'] },
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
            { id: 'k1', title: 'Jobs logged', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:maintenance-log', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total spend', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:maintenance-log', viz: 'kpi', measure: { fn: 'sum', field: 'cost' } } },
            { id: 'c2', title: 'Spend by type', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-log', viz: 'donut', groupBy: { field: 'maintenance_type', bucket: 'none' }, measure: { fn: 'sum', field: 'cost' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c1', title: 'Cost by machine', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-log', viz: 'bar', joins: [{ via: 'machine', formId: '@pack:machinery', type: 'left' }], groupBy: { field: '@pack:machinery::machine_name', bucket: 'none' }, measure: { fn: 'sum', field: 'cost' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Maintenance over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:maintenance-log', viz: 'area', groupBy: { field: 'date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent maintenance', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:maintenance-log', titleField: 'maintenance_type', subtitleField: 'notes', limit: 6 } },
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
      packAppId: 'agrilog',
      name: 'AgriLog',
      description:
        'A farm operations hub: plan the week\'s jobs across your paddocks, tally harvest loads, keep the chemical register with live withholding periods, and stay on top of machinery service and maintenance — all from one dashboard.',
      settings: { icon: 'Tractor' },
      theme: {
        primaryColor: '#4d7c0f',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'paddock', displayName: 'Paddocks', sortOrder: 1, isVisible: true },
        { packFormId: 'farm-job', displayName: 'Farm Jobs', sortOrder: 2, isVisible: true },
        { packFormId: 'harvest-log', displayName: 'Harvest Logs', sortOrder: 3, isVisible: true },
        { packFormId: 'chemical-application', displayName: 'Chemical Applications', sortOrder: 4, isVisible: true },
        { packFormId: 'machinery', displayName: 'Machinery', sortOrder: 5, isVisible: true },
        { packFormId: 'maintenance-log', displayName: 'Maintenance Logs', sortOrder: 6, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Paddocks', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:paddock', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Farm jobs', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Harvest loads', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Machines', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:machinery', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'c1', title: 'Jobs by status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:farm-job', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Harvest over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:harvest-log', viz: 'area', groupBy: { field: 'harvest_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 4, w: 12, h: 1 }, kind: 'actions' },
            { id: 'l1', title: 'Recent farm jobs', layout: { x: 0, y: 5, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:farm-job', titleField: 'job_type', subtitleField: 'assigned_to', limit: 6 } },
            { id: 'ac1', title: 'Activity', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'activity' },
          ],
        },
      },
      roles: [
        {
          name: 'Farm Manager',
          description: 'Full access to every AgriLog form.',
          permissions: [
            { packFormId: 'paddock', permission: 'submit_responses' },
            { packFormId: 'paddock', permission: 'view_all_responses' },
            { packFormId: 'paddock', permission: 'edit_responses' },
            { packFormId: 'paddock', permission: 'delete_responses' },
            { packFormId: 'paddock', permission: 'export_responses' },
            { packFormId: 'farm-job', permission: 'submit_responses' },
            { packFormId: 'farm-job', permission: 'view_all_responses' },
            { packFormId: 'farm-job', permission: 'edit_responses' },
            { packFormId: 'farm-job', permission: 'delete_responses' },
            { packFormId: 'farm-job', permission: 'export_responses' },
            { packFormId: 'harvest-log', permission: 'submit_responses' },
            { packFormId: 'harvest-log', permission: 'view_all_responses' },
            { packFormId: 'harvest-log', permission: 'edit_responses' },
            { packFormId: 'harvest-log', permission: 'delete_responses' },
            { packFormId: 'harvest-log', permission: 'export_responses' },
            { packFormId: 'chemical-application', permission: 'submit_responses' },
            { packFormId: 'chemical-application', permission: 'view_all_responses' },
            { packFormId: 'chemical-application', permission: 'edit_responses' },
            { packFormId: 'chemical-application', permission: 'delete_responses' },
            { packFormId: 'chemical-application', permission: 'export_responses' },
            { packFormId: 'machinery', permission: 'submit_responses' },
            { packFormId: 'machinery', permission: 'view_all_responses' },
            { packFormId: 'machinery', permission: 'edit_responses' },
            { packFormId: 'machinery', permission: 'delete_responses' },
            { packFormId: 'machinery', permission: 'export_responses' },
            { packFormId: 'maintenance-log', permission: 'submit_responses' },
            { packFormId: 'maintenance-log', permission: 'view_all_responses' },
            { packFormId: 'maintenance-log', permission: 'edit_responses' },
            { packFormId: 'maintenance-log', permission: 'delete_responses' },
            { packFormId: 'maintenance-log', permission: 'export_responses' },
          ],
        },
        {
          name: 'Farm Hand',
          description: 'Field workers who log jobs, harvests and maintenance and read the paddock and machinery lists.',
          permissions: [
            { packFormId: 'paddock', permission: 'view_all_responses' },
            { packFormId: 'farm-job', permission: 'submit_responses' },
            { packFormId: 'farm-job', permission: 'view_all_responses' },
            { packFormId: 'farm-job', permission: 'edit_responses' },
            { packFormId: 'harvest-log', permission: 'submit_responses' },
            { packFormId: 'harvest-log', permission: 'view_all_responses' },
            { packFormId: 'machinery', permission: 'view_all_responses' },
            { packFormId: 'maintenance-log', permission: 'submit_responses' },
            { packFormId: 'maintenance-log', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Agronomist',
          description: 'Advisers who keep the chemical register and review harvest quality, with read access across the farm.',
          permissions: [
            { packFormId: 'paddock', permission: 'view_all_responses' },
            { packFormId: 'farm-job', permission: 'view_all_responses' },
            { packFormId: 'harvest-log', permission: 'submit_responses' },
            { packFormId: 'harvest-log', permission: 'view_all_responses' },
            { packFormId: 'chemical-application', permission: 'submit_responses' },
            { packFormId: 'chemical-application', permission: 'view_all_responses' },
            { packFormId: 'chemical-application', permission: 'edit_responses' },
            { packFormId: 'chemical-application', permission: 'export_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'farm-jobs-count',
          kind: 'chart' as const,
          name: 'Farm jobs',
          description: 'Total number of field jobs logged across the farm.',
          spec: {
            formId: '@pack:farm-job',
            viz: 'kpi' as const,
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'jobs-by-type',
          kind: 'chart' as const,
          name: 'Jobs by type',
          description: 'Count of field jobs broken down by job type.',
          spec: {
            formId: '@pack:farm-job',
            viz: 'bar' as const,
            groupBy: { field: 'job_type' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'harvest-over-time',
          kind: 'chart' as const,
          name: 'Harvest logs over time',
          description: 'Monthly trend of harvest loads logged.',
          spec: {
            formId: '@pack:harvest-log',
            viz: 'line' as const,
            groupBy: { field: '__submitted_at', bucket: 'month' as const },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'harvest-by-grade',
          kind: 'chart' as const,
          name: 'Harvest by grade',
          description: 'Count of harvest loads grouped by their quality grade.',
          spec: {
            formId: '@pack:harvest-log',
            viz: 'bar' as const,
            groupBy: { field: 'grade' },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'maintenance-spend',
          kind: 'chart' as const,
          name: 'Maintenance spend',
          description: 'Total maintenance cost summed across all machines.',
          spec: {
            formId: '@pack:maintenance-log',
            viz: 'kpi' as const,
            measure: { fn: 'sum' as const, field: 'cost' },
          },
        },
        {
          reportId: 'jobs-by-block',
          kind: 'chart' as const,
          name: 'Jobs by block',
          description: 'Field jobs counted by the paddock they were logged against.',
          spec: {
            formId: '@pack:farm-job',
            viz: 'bar' as const,
            joins: [{ via: 'block', formId: '@pack:paddock', type: 'left' as const }],
            groupBy: { field: '@pack:paddock::block_name' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'agrilog-overview',
          kind: 'document' as const,
          name: 'Farm operations register',
          description: 'A season-at-a-glance summary of jobs, harvest, machinery and the chemical register.',
          blocks: [
            {
              kind: 'text' as const,
              title: 'Farm operations register',
              body: 'This register summarises field work, harvest and machinery upkeep across the farm. The chemical applications section is the compliance artifact: it records every product used, its rate and operator, and the withholding period end date that governs when produce may be harvested or grazed — keep it complete and current for audits and buyer assurance programs.',
            },
            { kind: 'report' as const, reportId: 'farm-jobs-count', caption: 'Total field jobs logged.' },
            { kind: 'report' as const, reportId: 'jobs-by-type', caption: 'Where the work goes, by job type.' },
            { kind: 'report' as const, reportId: 'harvest-over-time', caption: 'Harvest loads logged month by month.' },
            { kind: 'report' as const, reportId: 'harvest-by-grade', caption: 'Quality split across harvested loads.' },
            { kind: 'report' as const, reportId: 'jobs-by-block', caption: 'Job effort by paddock.' },
            { kind: 'report' as const, reportId: 'maintenance-spend', caption: 'Total machinery maintenance spend.' },
          ],
        },
      ],
    },
  ],
};
