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
  primaryColor: '#c026d3',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const caterCraftPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'catercraft-catering',
    name: 'CaterCraft — Catering & Event Orders',
    description:
      'Quote, plan, produce and deliver catering jobs: keep clients and a menu package library, move every job through the pipeline, run kitchen production by station, dispatch delivery runs and confirm dietary requirements — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['catering', 'events', 'kitchen', 'delivery', 'hospitality'],
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
        'Add a catering client with their organisation, contact details and billing address.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Client',
          description: 'Capture who is ordering so every quote, job and invoice lands with the right person.',
          required: false,
          properties: {},
        },
        {
          id: 'client_name',
          type: 'short_text',
          label: 'Client Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'organisation',
          type: 'short_text',
          label: 'Organisation',
          required: false,
          properties: { placeholder: 'Company, school or venue (if any)' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: false,
          properties: { placeholder: 'you@example.com' },
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
          type: 'location',
          label: 'Billing Address',
          required: false,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Favourite menus, invoicing quirks, tastings booked…' },
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
            { id: 'k1', title: 'Total clients', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Organisations', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'countDistinct', field: 'organisation' } } },
            { id: 'c1', title: 'New clients over time', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c2', title: 'Top organisations', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client', viz: 'bar', groupBy: { field: 'organisation', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent clients', layout: { x: 6, y: 3, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:client', titleField: 'client_name', subtitleField: 'organisation', limit: 6 } },
          ],
        },
      },
    },

    // ── 2. Menu Package ───────────────────────────────────────────────────
    {
      packFormId: 'menu-package',
      title: 'Menu Package',
      icon: 'ChefHat',
      description:
        'Define a menu package with its category, per-person price, minimum guests and the diets it supports.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Menu Package',
          description: 'Build the library your quotes come from — price it per person and note the diets it covers.',
          required: false,
          properties: {},
        },
        {
          id: 'package_name',
          type: 'short_text',
          label: 'Package Name',
          required: true,
          properties: { placeholder: 'e.g. Executive Lunch, Harvest Grazing Table' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: false,
          properties: {
            options: [
              { id: 'breakfast', label: 'Breakfast', value: 'breakfast' },
              { id: 'lunch', label: 'Lunch', value: 'lunch' },
              { id: 'dinner', label: 'Dinner', value: 'dinner' },
              { id: 'grazing', label: 'Grazing', value: 'grazing' },
              { id: 'drinks', label: 'Drinks', value: 'drinks' },
            ],
          },
        },
        {
          id: 'price_per_person',
          type: 'number',
          label: 'Price per Person ($)',
          required: false,
          properties: { placeholder: '38', min: 0 },
        },
        {
          id: 'min_guests',
          type: 'number',
          label: 'Minimum Guests',
          required: false,
          properties: { placeholder: '10', min: 1 },
        },
        {
          id: 'dietary_support',
          type: 'checkboxes',
          label: 'Dietary Support',
          required: false,
          properties: {
            options: [
              { id: 'vegan', label: 'Vegan', value: 'vegan' },
              { id: 'vegetarian', label: 'Vegetarian', value: 'vegetarian' },
              { id: 'gluten-free', label: 'Gluten-free', value: 'gluten-free' },
              { id: 'dairy-free', label: 'Dairy-free', value: 'dairy-free' },
              { id: 'nut-free', label: 'Nut-free', value: 'nut-free' },
              { id: 'halal', label: 'Halal', value: 'halal' },
            ],
          },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: false,
          properties: { placeholder: 'What is on the menu and how it is served…' },
        },
        {
          id: 'active_status',
          type: 'dropdown',
          label: 'Active',
          required: false,
          properties: {
            options: [
              { id: 'active', label: 'Active', value: 'active' },
              { id: 'seasonal', label: 'Seasonal', value: 'seasonal' },
              { id: 'retired', label: 'Retired', value: 'retired' },
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
            { id: 'k1', title: 'Total packages', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:menu-package', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Avg per person', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:menu-package', viz: 'kpi', measure: { fn: 'avg', field: 'price_per_person' } } },
            { id: 'c1', title: 'Packages by category', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:menu-package', viz: 'bar', groupBy: { field: 'category', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Dietary coverage', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:menu-package', viz: 'bar', groupBy: { field: 'dietary_support', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Active status share', layout: { x: 0, y: 4, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:menu-package', viz: 'donut', groupBy: { field: 'active_status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'l1', title: 'Recent packages', layout: { x: 4, y: 4, w: 8, h: 3 }, kind: 'list', list: { formId: '@pack:menu-package', titleField: 'package_name', subtitleField: 'category', limit: 6 } },
          ],
        },
      },
    },
    // ── 3. Catering Job ───────────────────────────────────────────────────
    {
      packFormId: 'catering-job',
      title: 'Catering Job',
      icon: 'CalendarClock',
      description:
        'Log a catering job linking the client with the event, guest count, service type, venue and pipeline status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Catering Job',
          description: 'Start with the enquiry — everything else in the kitchen and on the road hangs off this job.',
          required: false,
          properties: {},
        },
        {
          id: 'client',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client' },
        },
        {
          id: 'event_name',
          type: 'short_text',
          label: 'Event Name',
          required: true,
          properties: { placeholder: 'e.g. Hartley wedding reception' },
        },
        {
          id: 'event_date',
          type: 'date',
          label: 'Event Date',
          required: false,
          properties: {},
        },
        {
          id: 'delivery_time',
          type: 'time',
          label: 'Delivery Time',
          required: false,
          properties: {},
        },
        {
          id: 'guest_count',
          type: 'number',
          label: 'Guest Count',
          required: false,
          properties: { placeholder: '80', min: 1 },
        },
        {
          id: 'service_type',
          type: 'dropdown',
          label: 'Service Type',
          required: false,
          properties: {
            options: [
              { id: 'drop-off', label: 'Drop-off', value: 'drop-off' },
              { id: 'staffed-buffet', label: 'Staffed buffet', value: 'staffed-buffet' },
              { id: 'plated', label: 'Plated', value: 'plated' },
              { id: 'grazing-table', label: 'Grazing table', value: 'grazing-table' },
            ],
          },
        },
        {
          id: 'venue_address',
          type: 'location',
          label: 'Venue Address',
          required: false,
          properties: {},
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: false,
          properties: {
            options: [
              { id: 'enquiry', label: 'Enquiry', value: 'enquiry' },
              { id: 'quoted', label: 'Quoted', value: 'quoted' },
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'prep', label: 'Prep', value: 'prep' },
              { id: 'delivered', label: 'Delivered', value: 'delivered' },
              { id: 'closed', label: 'Closed', value: 'closed' },
            ],
          },
        },
        {
          id: 'estimated_value',
          type: 'number',
          label: 'Estimated Value ($)',
          required: false,
          properties: { placeholder: '3500', min: 0 },
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
            { id: 'k1', title: 'Total jobs', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Pipeline value', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'c1', title: 'Jobs by status', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Service type mix', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'donut', groupBy: { field: 'service_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Events by month', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'area', groupBy: { field: 'event_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent jobs', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:catering-job', titleField: 'event_name', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },

    // ── 4. Production Task ────────────────────────────────────────────────
    {
      packFormId: 'production-task',
      title: 'Production Task',
      icon: 'CookingPot',
      description:
        'Add a kitchen production task for a catering job, assigned to a station with a due date and status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Production Task',
          description: 'Break the job into station work — the board tracks what is done, due and blocked.',
          required: false,
          properties: {},
        },
        {
          id: 'catering_job',
          type: 'linked_record',
          label: 'Catering Job',
          required: true,
          properties: { targetFormId: '@pack:catering-job' },
        },
        {
          id: 'task',
          type: 'short_text',
          label: 'Task',
          required: true,
          properties: { placeholder: 'e.g. Bake 120 dinner rolls' },
        },
        {
          id: 'station',
          type: 'dropdown',
          label: 'Station',
          required: false,
          properties: {
            options: [
              { id: 'prep', label: 'Prep', value: 'prep' },
              { id: 'bakery', label: 'Bakery', value: 'bakery' },
              { id: 'cold', label: 'Cold', value: 'cold' },
              { id: 'hot', label: 'Hot', value: 'hot' },
              { id: 'packing', label: 'Packing', value: 'packing' },
              { id: 'delivery', label: 'Delivery', value: 'delivery' },
            ],
          },
        },
        {
          id: 'due_date',
          type: 'date',
          label: 'Due Date',
          required: false,
          properties: {},
        },
        {
          id: 'due_time',
          type: 'time',
          label: 'Due Time',
          required: false,
          properties: {},
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned To',
          required: false,
          properties: { placeholder: 'Who is on it' },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: false,
          properties: {
            options: [
              { id: 'not-started', label: 'Not started', value: 'not-started' },
              { id: 'in-progress', label: 'In progress', value: 'in-progress' },
              { id: 'done', label: 'Done', value: 'done' },
              { id: 'blocked', label: 'Blocked', value: 'blocked' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Recipe notes, batch sizes, allergens to watch…' },
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
            { id: 'k1', title: 'Total tasks', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:production-task', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Assignees', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:production-task', viz: 'kpi', measure: { fn: 'countDistinct', field: 'assigned_to' } } },
            { id: 'c1', title: 'Tasks by station', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:production-task', viz: 'bar', groupBy: { field: 'station', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Status breakdown', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:production-task', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Tasks added over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:production-task', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent tasks', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:production-task', titleField: 'task', subtitleField: 'station', limit: 6 } },
          ],
        },
      },
    },
    // ── 5. Delivery Run ───────────────────────────────────────────────────
    {
      packFormId: 'delivery-run',
      title: 'Delivery Run',
      icon: 'Truck',
      description:
        'Schedule a delivery run for a catering job with driver, vehicle, pickup and delivery times, and proof on arrival.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Delivery Run',
          description: 'Put the job on the road — who is driving, in what, and when it leaves the kitchen.',
          required: false,
          properties: {},
        },
        {
          id: 'catering_job',
          type: 'linked_record',
          label: 'Catering Job',
          required: true,
          properties: { targetFormId: '@pack:catering-job' },
        },
        {
          id: 'driver',
          type: 'short_text',
          label: 'Driver',
          required: false,
          properties: { placeholder: 'Driver name' },
        },
        {
          id: 'vehicle',
          type: 'short_text',
          label: 'Vehicle',
          required: false,
          properties: { placeholder: 'e.g. Van 2 (refrigerated)' },
        },
        {
          id: 'pickup_time',
          type: 'time',
          label: 'Pickup Time',
          required: false,
          properties: {},
        },
        {
          id: 'delivery_time',
          type: 'time',
          label: 'Delivery Time',
          required: false,
          properties: {},
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: false,
          properties: {
            options: [
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'loaded', label: 'Loaded', value: 'loaded' },
              { id: 'en-route', label: 'En route', value: 'en-route' },
              { id: 'delivered', label: 'Delivered', value: 'delivered' },
              { id: 'issue', label: 'Issue', value: 'issue' },
            ],
          },
        },
        {
          id: 'delivery_notes',
          type: 'long_text',
          label: 'Delivery Notes',
          required: false,
          properties: { placeholder: 'Gate codes, loading dock, who signed…' },
        },
        {
          id: 'proof_photo',
          type: 'file_upload',
          label: 'Proof Photo',
          required: false,
          properties: {
            acceptedFileTypes: ['.jpg', '.png'],
            allowMultiple: false,
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
            { id: 'k1', title: 'Total runs', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:delivery-run', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Drivers', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:delivery-run', viz: 'kpi', measure: { fn: 'countDistinct', field: 'driver' } } },
            { id: 'c1', title: 'Runs by status', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:delivery-run', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Runs per driver', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:delivery-run', viz: 'bar', groupBy: { field: 'driver', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Runs over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:delivery-run', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent runs', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:delivery-run', titleField: 'driver', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },

    // ── 6. Dietary Requirement ────────────────────────────────────────────
    {
      packFormId: 'dietary-requirement',
      title: 'Dietary Requirement',
      icon: 'Salad',
      description:
        'Record a dietary requirement for a catering job with the guests affected and kitchen confirmation.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Dietary Requirement',
          description: 'Note every diet the kitchen must cater for — nothing gets plated until it is confirmed.',
          required: false,
          properties: {},
        },
        {
          id: 'catering_job',
          type: 'linked_record',
          label: 'Catering Job',
          required: true,
          properties: { targetFormId: '@pack:catering-job' },
        },
        {
          id: 'requirement_type',
          type: 'dropdown',
          label: 'Requirement Type',
          required: false,
          properties: {
            options: [
              { id: 'vegan', label: 'Vegan', value: 'vegan' },
              { id: 'vegetarian', label: 'Vegetarian', value: 'vegetarian' },
              { id: 'gluten-free', label: 'Gluten-free', value: 'gluten-free' },
              { id: 'dairy-free', label: 'Dairy-free', value: 'dairy-free' },
              { id: 'nut-free', label: 'Nut-free', value: 'nut-free' },
              { id: 'halal', label: 'Halal', value: 'halal' },
              { id: 'other', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'guest_count',
          type: 'number',
          label: 'Guest Count',
          required: false,
          properties: { placeholder: '4', min: 1 },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Severity, cross-contact rules, who it is for…' },
        },
        {
          id: 'kitchen_confirmed',
          type: 'dropdown',
          label: 'Confirmed with Kitchen',
          required: false,
          properties: {
            options: [
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'pending', label: 'Pending', value: 'pending' },
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
            { id: 'k1', title: 'Total requirements', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:dietary-requirement', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Guests covered', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:dietary-requirement', viz: 'kpi', measure: { fn: 'sum', field: 'guest_count' } } },
            { id: 'c1', title: 'By requirement type', layout: { x: 6, y: 0, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:dietary-requirement', viz: 'bar', groupBy: { field: 'requirement_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Kitchen confirmation', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:dietary-requirement', viz: 'donut', groupBy: { field: 'kitchen_confirmed', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Guests by requirement', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:dietary-requirement', viz: 'bar', groupBy: { field: 'requirement_type', bucket: 'none' }, measure: { fn: 'sum', field: 'guest_count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent requirements', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:dietary-requirement', titleField: 'requirement_type', subtitleField: 'kitchen_confirmed', limit: 6 } },
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
      packAppId: 'catercraft',
      name: 'CaterCraft',
      description:
        'A catering operations hub: keep clients and a menu package library, move every job through the pipeline, run the kitchen by station, dispatch delivery runs and confirm dietary requirements from one dashboard.',
      settings: { icon: 'UtensilsCrossed' },
      theme: {
        primaryColor: '#c026d3',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'client', displayName: 'Clients', sortOrder: 1, isVisible: true },
        { packFormId: 'menu-package', displayName: 'Menu Packages', sortOrder: 2, isVisible: true },
        { packFormId: 'catering-job', displayName: 'Catering Jobs', sortOrder: 3, isVisible: true },
        { packFormId: 'production-task', displayName: 'Production Tasks', sortOrder: 4, isVisible: true },
        { packFormId: 'delivery-run', displayName: 'Delivery Runs', sortOrder: 5, isVisible: true },
        { packFormId: 'dietary-requirement', displayName: 'Dietary Requirements', sortOrder: 6, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Clients', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Catering jobs', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Pipeline value', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'k4', title: 'Guests booked', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'kpi', measure: { fn: 'sum', field: 'guest_count' } } },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 1, w: 12, h: 1 }, kind: 'actions' },
            { id: 'c1', title: 'Jobs by status', layout: { x: 0, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Service type mix', layout: { x: 6, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:catering-job', viz: 'donut', groupBy: { field: 'service_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Tasks by station', layout: { x: 0, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:production-task', viz: 'bar', groupBy: { field: 'station', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c4', title: 'Deliveries by status', layout: { x: 4, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:delivery-run', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'act1', title: 'Recent activity', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'activity' },
            { id: 'l1', title: 'Recent catering jobs', layout: { x: 0, y: 8, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:catering-job', titleField: 'event_name', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
      roles: [
        {
          name: 'Catering Manager',
          description: 'Full access to every catering form.',
          permissions: [
            { packFormId: 'client', permission: 'submit_responses' },
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'client', permission: 'edit_responses' },
            { packFormId: 'client', permission: 'delete_responses' },
            { packFormId: 'client', permission: 'export_responses' },
            { packFormId: 'menu-package', permission: 'submit_responses' },
            { packFormId: 'menu-package', permission: 'view_all_responses' },
            { packFormId: 'menu-package', permission: 'edit_responses' },
            { packFormId: 'menu-package', permission: 'delete_responses' },
            { packFormId: 'menu-package', permission: 'export_responses' },
            { packFormId: 'catering-job', permission: 'submit_responses' },
            { packFormId: 'catering-job', permission: 'view_all_responses' },
            { packFormId: 'catering-job', permission: 'edit_responses' },
            { packFormId: 'catering-job', permission: 'delete_responses' },
            { packFormId: 'catering-job', permission: 'export_responses' },
            { packFormId: 'production-task', permission: 'submit_responses' },
            { packFormId: 'production-task', permission: 'view_all_responses' },
            { packFormId: 'production-task', permission: 'edit_responses' },
            { packFormId: 'production-task', permission: 'delete_responses' },
            { packFormId: 'production-task', permission: 'export_responses' },
            { packFormId: 'delivery-run', permission: 'submit_responses' },
            { packFormId: 'delivery-run', permission: 'view_all_responses' },
            { packFormId: 'delivery-run', permission: 'edit_responses' },
            { packFormId: 'delivery-run', permission: 'delete_responses' },
            { packFormId: 'delivery-run', permission: 'export_responses' },
            { packFormId: 'dietary-requirement', permission: 'submit_responses' },
            { packFormId: 'dietary-requirement', permission: 'view_all_responses' },
            { packFormId: 'dietary-requirement', permission: 'edit_responses' },
            { packFormId: 'dietary-requirement', permission: 'delete_responses' },
            { packFormId: 'dietary-requirement', permission: 'export_responses' },
          ],
        },
        {
          name: 'Kitchen Lead',
          description: 'Runs production: works jobs and tasks, confirms dietary requirements, references the menu.',
          permissions: [
            { packFormId: 'menu-package', permission: 'view_all_responses' },
            { packFormId: 'catering-job', permission: 'view_all_responses' },
            { packFormId: 'catering-job', permission: 'edit_responses' },
            { packFormId: 'production-task', permission: 'submit_responses' },
            { packFormId: 'production-task', permission: 'view_all_responses' },
            { packFormId: 'production-task', permission: 'edit_responses' },
            { packFormId: 'dietary-requirement', permission: 'submit_responses' },
            { packFormId: 'dietary-requirement', permission: 'view_all_responses' },
            { packFormId: 'dietary-requirement', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Delivery Driver',
          description: 'Sees confirmed jobs and updates the delivery runs they are on.',
          permissions: [
            { packFormId: 'catering-job', permission: 'view_all_responses' },
            { packFormId: 'delivery-run', permission: 'submit_responses' },
            { packFormId: 'delivery-run', permission: 'view_all_responses' },
            { packFormId: 'delivery-run', permission: 'edit_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'catering-jobs-count',
          kind: 'chart' as const,
          name: 'Catering jobs',
          description: 'Total number of catering jobs logged.',
          spec: {
            formId: '@pack:catering-job',
            viz: 'kpi' as const,
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'jobs-by-status',
          kind: 'chart' as const,
          name: 'Jobs by status',
          description: 'Count of catering jobs broken down by their pipeline status.',
          spec: {
            formId: '@pack:catering-job',
            viz: 'bar' as const,
            groupBy: { field: 'status' },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'jobs-by-service-type',
          kind: 'chart' as const,
          name: 'Jobs by service type',
          description: 'How catering jobs split across drop-off, staffed buffet, plated and grazing service.',
          spec: {
            formId: '@pack:catering-job',
            viz: 'bar' as const,
            groupBy: { field: 'service_type' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'jobs-over-time',
          kind: 'chart' as const,
          name: 'Jobs over time',
          description: 'Monthly trend of catering jobs logged.',
          spec: {
            formId: '@pack:catering-job',
            viz: 'line' as const,
            groupBy: { field: '__submitted_at', bucket: 'month' as const },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'pipeline-value',
          kind: 'chart' as const,
          name: 'Pipeline value',
          description: 'Total estimated value summed across all catering jobs.',
          spec: {
            formId: '@pack:catering-job',
            viz: 'kpi' as const,
            measure: { fn: 'sum' as const, field: 'estimated_value' },
          },
        },
        {
          reportId: 'tasks-by-job',
          kind: 'chart' as const,
          name: 'Production tasks by job',
          description: 'Count of production tasks grouped by the linked catering job.',
          spec: {
            formId: '@pack:production-task',
            viz: 'bar' as const,
            joins: [{ via: 'catering_job', formId: '@pack:catering-job', type: 'left' as const }],
            groupBy: { field: '@pack:catering-job::event_name' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'catercraft-overview',
          kind: 'document' as const,
          name: 'Catering operations overview',
          description: 'High-level summary of the catering pipeline, service mix and production load.',
          blocks: [
            {
              kind: 'text' as const,
              title: 'Catering operations overview',
              body: 'This report summarises the catering pipeline from enquiry to close. Use it to track how jobs move through each status, which service types are in demand, the value sitting in the pipeline and where production effort is concentrated across events.',
            },
            { kind: 'report' as const, reportId: 'jobs-by-status', caption: 'Catering jobs by current pipeline status.' },
            { kind: 'report' as const, reportId: 'jobs-by-service-type', caption: 'Demand by service type.' },
            { kind: 'report' as const, reportId: 'jobs-over-time', caption: 'Month-by-month job volume.' },
            { kind: 'report' as const, reportId: 'pipeline-value', caption: 'Total estimated value across all jobs.' },
            { kind: 'report' as const, reportId: 'tasks-by-job', caption: 'Production task load per event.' },
          ],
        },
      ],
    },
  ],
};
