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
  primaryColor: '#0284c7',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const stayReadyPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'stayready-short-stay',
    name: 'StayReady — Short-Stay Turnover',
    description:
      'Run short-stay properties without the scramble: track bookings and guest stays, schedule cleaner turnovers between checkout and check-in, log condition inspections, and keep every property stocked and guest-ready.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['airbnb', 'short-stay', 'turnovers', 'cleaning', 'property'],
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
        'Add a short-stay property with its address, size, access instructions and listing status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Property',
          description: 'Add the property once and every booking, turnover and inspection can link back to it.',
          required: false,
          properties: {},
        },
        {
          id: 'property_name',
          type: 'short_text',
          label: 'Property Name',
          required: true,
          properties: { placeholder: 'e.g. Seaview Apartment 4B' },
        },
        {
          id: 'address',
          type: 'location',
          label: 'Address',
          required: false,
          properties: {},
        },
        {
          id: 'property_type',
          type: 'dropdown',
          label: 'Property Type',
          required: true,
          properties: {
            options: [
              { id: 'apartment', label: 'Apartment', value: 'apartment' },
              { id: 'house', label: 'House', value: 'house' },
              { id: 'townhouse', label: 'Townhouse', value: 'townhouse' },
              { id: 'studio', label: 'Studio', value: 'studio' },
              { id: 'cabin', label: 'Cabin', value: 'cabin' },
            ],
          },
        },
        {
          id: 'bedrooms',
          type: 'number',
          label: 'Bedrooms',
          required: false,
          properties: { placeholder: '2', min: 0, step: 1 },
        },
        {
          id: 'bathrooms',
          type: 'number',
          label: 'Bathrooms',
          required: false,
          properties: { placeholder: '1', min: 0 },
        },
        {
          id: 'access_instructions',
          type: 'long_text',
          label: 'Access Instructions',
          required: false,
          properties: { placeholder: 'Lockbox code, parking, wifi details, alarm notes…' },
        },
        {
          id: 'owner',
          type: 'short_text',
          label: 'Owner',
          required: false,
          properties: { placeholder: 'Owner name' },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: true,
          properties: {
            options: [
              { id: 'live', label: 'Live', value: 'live' },
              { id: 'paused', label: 'Paused', value: 'paused' },
              { id: 'offboarding', label: 'Offboarding', value: 'offboarding' },
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
            { id: 'k1', title: 'Properties', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Live listings', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'live' }] } },
            { id: 'k3', title: 'Avg bedrooms', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'avg', field: 'bedrooms' } } },
            { id: 'k4', title: 'Avg bathrooms', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'avg', field: 'bathrooms' } } },
            { id: 'c1', title: 'By property type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:property', viz: 'bar', groupBy: { field: 'property_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Listing status', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:property', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'New properties over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:property', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent properties', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:property', titleField: 'property_name', subtitleField: 'owner', limit: 6 } },
          ],
        },
      },
    },
    // ── 2. Cleaner ────────────────────────────────────────────────────────
    {
      packFormId: 'cleaner',
      title: 'Cleaner',
      icon: 'Sparkles',
      description:
        'Add a cleaner to the roster with their contact details, service areas and weekly availability.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Cleaner',
          description: 'Capture who cleans for you, where they work and which days they can take a turnover.',
          required: false,
          properties: {},
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: false,
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
          id: 'service_areas',
          type: 'checkboxes',
          label: 'Service Areas',
          required: false,
          properties: {
            options: [
              { id: 'north-side', label: 'North side', value: 'north-side' },
              { id: 'south-side', label: 'South side', value: 'south-side' },
              { id: 'east-side', label: 'East side', value: 'east-side' },
              { id: 'west-side', label: 'West side', value: 'west-side' },
              { id: 'inner-city', label: 'Inner city', value: 'inner-city' },
            ],
          },
        },
        {
          id: 'availability',
          type: 'checkboxes',
          label: 'Availability',
          required: false,
          properties: {
            options: [
              { id: 'monday', label: 'Monday', value: 'monday' },
              { id: 'tuesday', label: 'Tuesday', value: 'tuesday' },
              { id: 'wednesday', label: 'Wednesday', value: 'wednesday' },
              { id: 'thursday', label: 'Thursday', value: 'thursday' },
              { id: 'friday', label: 'Friday', value: 'friday' },
              { id: 'saturday', label: 'Saturday', value: 'saturday' },
              { id: 'sunday', label: 'Sunday', value: 'sunday' },
            ],
          },
        },
        {
          id: 'active',
          type: 'dropdown',
          label: 'Active',
          required: true,
          properties: {
            options: [
              { id: 'active', label: 'Active', value: 'active' },
              { id: 'inactive', label: 'Inactive', value: 'inactive' },
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
            { id: 'k1', title: 'Cleaners', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Active', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'active', op: 'eq', value: 'active' }] } },
            { id: 'k3', title: 'Inactive', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'active', op: 'eq', value: 'inactive' }] } },
            { id: 'c1', title: 'Coverage by service area', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'bar', groupBy: { field: 'service_areas', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Weekly availability', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'bar', groupBy: { field: 'availability', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 7 } },
            { id: 'c3', title: 'Active vs inactive', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'donut', groupBy: { field: 'active', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'l1', title: 'Recent cleaners', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:cleaner', titleField: 'name', subtitleField: 'phone', limit: 6 } },
          ],
        },
      },
    },

    // ── 3. Booking ────────────────────────────────────────────────────────
    {
      packFormId: 'booking',
      title: 'Booking',
      icon: 'CalendarDays',
      description:
        'Record a guest booking with stay dates, party size, platform and status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Booking',
          description: 'Log the stay so turnovers can be scheduled around checkout and check-in.',
          required: false,
          properties: {},
        },
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: true,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'guest_name',
          type: 'short_text',
          label: 'Guest Name',
          required: true,
          properties: { placeholder: 'Guest full name' },
        },
        {
          id: 'check_in',
          type: 'date',
          label: 'Check-in Date',
          required: false,
          properties: {},
        },
        {
          id: 'check_out',
          type: 'date',
          label: 'Check-out Date',
          required: false,
          properties: {},
        },
        {
          id: 'guest_count',
          type: 'number',
          label: 'Guest Count',
          required: false,
          properties: { placeholder: '2', min: 1, step: 1 },
        },
        {
          id: 'platform',
          type: 'dropdown',
          label: 'Platform',
          required: true,
          properties: {
            options: [
              { id: 'airbnb', label: 'Airbnb', value: 'airbnb' },
              { id: 'booking-com', label: 'Booking.com', value: 'booking-com' },
              { id: 'direct', label: 'Direct', value: 'direct' },
              { id: 'other', label: 'Other', value: 'other' },
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
              { id: 'confirmed', label: 'Confirmed', value: 'confirmed' },
              { id: 'checked-in', label: 'Checked in', value: 'checked-in' },
              { id: 'checked-out', label: 'Checked out', value: 'checked-out' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Late arrival, cot needed, allergies…' },
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
            { id: 'k1', title: 'Bookings', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'In house', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'checked-in' }] } },
            { id: 'k3', title: 'Confirmed', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'confirmed' }] } },
            { id: 'k4', title: 'Total guests', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'kpi', measure: { fn: 'sum', field: 'guest_count' } } },
            { id: 'c1', title: 'By platform', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'bar', groupBy: { field: 'platform', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Booking status', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Bookings over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent bookings', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:booking', titleField: 'guest_name', subtitleField: 'platform', limit: 6 } },
          ],
        },
      },
    },
    // ── 4. Turnover ───────────────────────────────────────────────────────
    {
      packFormId: 'turnover',
      title: 'Turnover',
      icon: 'RotateCcw',
      description:
        'Schedule a turnover clean between guests, linking the property, booking and cleaner.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Schedule Turnover',
          description: 'Book the clean between guests: date, start time, cleaner and linen.',
          required: false,
          properties: {},
        },
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: true,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'booking',
          type: 'linked_record',
          label: 'Booking',
          required: true,
          properties: { targetFormId: '@pack:booking' },
        },
        {
          id: 'cleaner',
          type: 'linked_record',
          label: 'Cleaner',
          required: true,
          properties: { targetFormId: '@pack:cleaner' },
        },
        {
          id: 'turnover_date',
          type: 'date',
          label: 'Turnover Date',
          required: true,
          properties: {},
        },
        {
          id: 'start_time',
          type: 'time',
          label: 'Start Time',
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
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'in-progress', label: 'In progress', value: 'in-progress' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'issue', label: 'Issue', value: 'issue' },
            ],
          },
        },
        {
          id: 'linen_required',
          type: 'dropdown',
          label: 'Linen Required',
          required: false,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'What the cleaner should know for this turnover…' },
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
            { id: 'k1', title: 'Turnovers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Scheduled', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'scheduled' }] } },
            { id: 'k3', title: 'Completed', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'completed' }] } },
            { id: 'k4', title: 'Issues', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'issue' }] } },
            { id: 'c1', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Turnovers by property', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'bar', joins: [{ via: 'property', formId: '@pack:property', type: 'left' }], groupBy: { field: '@pack:property::property_name', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Scheduled over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent turnovers', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:turnover', titleField: 'notes', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },

    // ── 5. Inspection ─────────────────────────────────────────────────────
    {
      packFormId: 'inspection',
      title: 'Inspection',
      icon: 'ClipboardCheck',
      description:
        'Log a property walkthrough with a condition rating, damage notes and photos.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Inspection',
          description: 'Record the walkthrough so damage and missing items are caught before the next guest arrives.',
          required: false,
          properties: {},
        },
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: true,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'inspection_date',
          type: 'date',
          label: 'Inspection Date',
          required: true,
          properties: {},
        },
        {
          id: 'condition_rating',
          type: 'rating',
          label: 'Condition Rating',
          required: true,
          properties: { max: 5 },
        },
        {
          id: 'missing_items',
          type: 'long_text',
          label: 'Missing Items',
          required: false,
          properties: { placeholder: 'Anything missing since the last stay…' },
        },
        {
          id: 'damage_notes',
          type: 'long_text',
          label: 'Damage Notes',
          required: false,
          properties: { placeholder: 'Damage found, wear and tear, repairs needed…' },
        },
        {
          id: 'photos',
          type: 'file_upload',
          label: 'Photos',
          required: false,
          properties: { acceptedFileTypes: ['.jpg', '.png'] },
        },
        {
          id: 'follow_up_required',
          type: 'dropdown',
          label: 'Follow-up Required',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
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
            { id: 'k1', title: 'Inspections', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Open follow-ups', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'follow_up_required', op: 'eq', value: 'yes' }] } },
            { id: 'k3', title: 'Avg condition', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'kpi', measure: { fn: 'avg', field: 'condition_rating' } } },
            { id: 'c1', title: 'Condition spread', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'bar', groupBy: { field: 'condition_rating', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 6 } },
            { id: 'c2', title: 'Follow-up needed', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'donut', groupBy: { field: 'follow_up_required', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Inspections over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent inspections', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:inspection', titleField: 'damage_notes', subtitleField: 'missing_items', limit: 6 } },
          ],
        },
      },
    },

    // ── 6. Supply Item ────────────────────────────────────────────────────
    {
      packFormId: 'supply',
      title: 'Supply Item',
      icon: 'Boxes',
      description:
        'Track a consumable supply item for a property with stock on hand and its reorder point.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Supply Item',
          description: 'Track what each property keeps on the shelf and when it needs a top-up.',
          required: false,
          properties: {},
        },
        {
          id: 'property',
          type: 'linked_record',
          label: 'Property',
          required: true,
          properties: { targetFormId: '@pack:property' },
        },
        {
          id: 'supply_item',
          type: 'short_text',
          label: 'Supply Item',
          required: true,
          properties: { placeholder: 'e.g. Toilet paper' },
        },
        {
          id: 'current_stock',
          type: 'number',
          label: 'Current Stock',
          required: false,
          properties: { placeholder: '6', min: 0, step: 1 },
        },
        {
          id: 'reorder_point',
          type: 'number',
          label: 'Reorder Point',
          required: false,
          properties: { placeholder: '4', min: 0, step: 1 },
        },
        {
          id: 'unit',
          type: 'dropdown',
          label: 'Unit',
          required: false,
          properties: {
            options: [
              { id: 'units', label: 'Units', value: 'units' },
              { id: 'packs', label: 'Packs', value: 'packs' },
              { id: 'bottles', label: 'Bottles', value: 'bottles' },
              { id: 'sets', label: 'Sets', value: 'sets' },
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
              { id: 'ok', label: 'OK', value: 'ok' },
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'out', label: 'Out', value: 'out' },
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
            { id: 'k1', title: 'Supply items', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Out of stock', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'out' }] } },
            { id: 'k3', title: 'Low stock', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'low' }] } },
            { id: 'k4', title: 'Units on hand', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'kpi', measure: { fn: 'sum', field: 'current_stock' } } },
            { id: 'c1', title: 'Stock status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c2', title: 'By unit', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'bar', groupBy: { field: 'unit', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Items by property', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'bar', joins: [{ via: 'property', formId: '@pack:property', type: 'left' }], groupBy: { field: '@pack:property::property_name', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent supplies', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:supply', titleField: 'supply_item', subtitleField: 'unit', limit: 6 } },
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
      packAppId: 'stayready',
      name: 'StayReady',
      description:
        'A short-stay turnover hub: track bookings and guest stays, schedule cleaner turnovers between checkout and check-in, log condition inspections, and keep every property stocked and guest-ready.',
      settings: { icon: 'BedDouble' },
      theme: {
        primaryColor: '#0284c7',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'property', displayName: 'Properties', sortOrder: 1, isVisible: true },
        { packFormId: 'cleaner', displayName: 'Cleaners', sortOrder: 2, isVisible: true },
        { packFormId: 'booking', displayName: 'Bookings', sortOrder: 3, isVisible: true },
        { packFormId: 'turnover', displayName: 'Turnovers', sortOrder: 4, isVisible: true },
        { packFormId: 'inspection', displayName: 'Inspections', sortOrder: 5, isVisible: true },
        { packFormId: 'supply', displayName: 'Supplies', sortOrder: 6, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Bookings', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Turnovers', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Properties', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:property', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Cleaners', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:cleaner', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k5', title: 'Inspections', layout: { x: 0, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:inspection', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k6', title: 'Supply items', layout: { x: 3, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:supply', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k7', title: 'Guests hosted', layout: { x: 6, y: 1, w: 6, h: 1 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'kpi', measure: { fn: 'sum', field: 'guest_count' } } },
            { id: 'c1', title: 'Bookings over time', layout: { x: 0, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c2', title: 'Turnovers by status', layout: { x: 6, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:turnover', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent bookings', layout: { x: 0, y: 5, w: 4, h: 3 }, kind: 'list', list: { formId: '@pack:booking', titleField: 'guest_name', subtitleField: 'platform', limit: 6 } },
            { id: 'act1', title: 'Recent activity', layout: { x: 4, y: 5, w: 4, h: 3 }, kind: 'activity' },
            { id: 'c3', title: 'Bookings by platform', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:booking', viz: 'donut', groupBy: { field: 'platform', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 8, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
      },
      roles: [
        {
          name: 'Property Manager',
          description: 'Full access to every StayReady form.',
          permissions: [
            { packFormId: 'property', permission: 'submit_responses' },
            { packFormId: 'property', permission: 'view_all_responses' },
            { packFormId: 'property', permission: 'edit_responses' },
            { packFormId: 'property', permission: 'delete_responses' },
            { packFormId: 'property', permission: 'export_responses' },
            { packFormId: 'cleaner', permission: 'submit_responses' },
            { packFormId: 'cleaner', permission: 'view_all_responses' },
            { packFormId: 'cleaner', permission: 'edit_responses' },
            { packFormId: 'cleaner', permission: 'delete_responses' },
            { packFormId: 'cleaner', permission: 'export_responses' },
            { packFormId: 'booking', permission: 'submit_responses' },
            { packFormId: 'booking', permission: 'view_all_responses' },
            { packFormId: 'booking', permission: 'edit_responses' },
            { packFormId: 'booking', permission: 'delete_responses' },
            { packFormId: 'booking', permission: 'export_responses' },
            { packFormId: 'turnover', permission: 'submit_responses' },
            { packFormId: 'turnover', permission: 'view_all_responses' },
            { packFormId: 'turnover', permission: 'edit_responses' },
            { packFormId: 'turnover', permission: 'delete_responses' },
            { packFormId: 'turnover', permission: 'export_responses' },
            { packFormId: 'inspection', permission: 'submit_responses' },
            { packFormId: 'inspection', permission: 'view_all_responses' },
            { packFormId: 'inspection', permission: 'edit_responses' },
            { packFormId: 'inspection', permission: 'delete_responses' },
            { packFormId: 'inspection', permission: 'export_responses' },
            { packFormId: 'supply', permission: 'submit_responses' },
            { packFormId: 'supply', permission: 'view_all_responses' },
            { packFormId: 'supply', permission: 'edit_responses' },
            { packFormId: 'supply', permission: 'delete_responses' },
            { packFormId: 'supply', permission: 'export_responses' },
          ],
        },
        {
          name: 'Guest Coordinator',
          description: 'Books guest stays, schedules turnovers and keeps property details current.',
          permissions: [
            { packFormId: 'property', permission: 'view_all_responses' },
            { packFormId: 'property', permission: 'edit_responses' },
            { packFormId: 'cleaner', permission: 'view_all_responses' },
            { packFormId: 'booking', permission: 'submit_responses' },
            { packFormId: 'booking', permission: 'view_all_responses' },
            { packFormId: 'booking', permission: 'edit_responses' },
            { packFormId: 'turnover', permission: 'submit_responses' },
            { packFormId: 'turnover', permission: 'view_all_responses' },
            { packFormId: 'turnover', permission: 'edit_responses' },
            { packFormId: 'inspection', permission: 'view_all_responses' },
            { packFormId: 'supply', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Cleaning Crew',
          description: 'Cleaners who work turnovers, log inspections and flag low supplies.',
          permissions: [
            { packFormId: 'property', permission: 'view_all_responses' },
            { packFormId: 'turnover', permission: 'view_all_responses' },
            { packFormId: 'turnover', permission: 'edit_responses' },
            { packFormId: 'inspection', permission: 'submit_responses' },
            { packFormId: 'inspection', permission: 'view_all_responses' },
            { packFormId: 'supply', permission: 'submit_responses' },
            { packFormId: 'supply', permission: 'view_all_responses' },
            { packFormId: 'supply', permission: 'edit_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'bookings-total',
          kind: 'chart' as const,
          name: 'Total bookings',
          description: 'Count of every guest booking recorded across the portfolio.',
          spec: {
            formId: '@pack:booking',
            viz: 'kpi' as const,
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'bookings-by-platform',
          kind: 'chart' as const,
          name: 'Bookings by platform',
          description: 'Where stays are booked — Airbnb, Booking.com, direct or elsewhere.',
          spec: {
            formId: '@pack:booking',
            viz: 'bar' as const,
            groupBy: { field: 'platform' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'bookings-over-time',
          kind: 'chart' as const,
          name: 'Bookings over time',
          description: 'Monthly trend of guest bookings recorded.',
          spec: {
            formId: '@pack:booking',
            viz: 'line' as const,
            groupBy: { field: '__submitted_at', bucket: 'month' as const },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'turnovers-by-property',
          kind: 'chart' as const,
          name: 'Turnovers by property',
          description: 'Which properties generate the most turnover cleans, via the linked property.',
          spec: {
            formId: '@pack:turnover',
            viz: 'bar' as const,
            joins: [{ via: 'property', formId: '@pack:property', type: 'left' as const }],
            groupBy: { field: '@pack:property::property_name' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'turnovers-by-status',
          kind: 'chart' as const,
          name: 'Turnovers by status',
          description: 'Turnover cleans broken down by scheduled, in progress, completed and issue.',
          spec: {
            formId: '@pack:turnover',
            viz: 'bar' as const,
            groupBy: { field: 'status' },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'open-follow-ups',
          kind: 'chart' as const,
          name: 'Open inspection follow-ups',
          description: 'Inspections flagged as needing follow-up before the next guest.',
          spec: {
            formId: '@pack:inspection',
            viz: 'kpi' as const,
            filters: [{ field: 'follow_up_required', op: 'eq', value: 'yes' }],
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'stayready-overview',
          kind: 'document' as const,
          name: 'Short-stay operations overview',
          description: 'High-level summary of booking activity and turnover operations across the portfolio.',
          blocks: [
            {
              kind: 'text' as const,
              title: 'Short-stay operations overview',
              body: 'This report summarises guest booking activity and turnover operations across the short-stay portfolio. Use it to monitor where bookings come from, how volume is trending month to month, which properties generate the most cleans, and whether inspection follow-ups are being closed out before the next guest arrives.',
            },
            { kind: 'report' as const, reportId: 'bookings-total', caption: 'Total guest bookings recorded.' },
            { kind: 'report' as const, reportId: 'bookings-by-platform', caption: 'Booking volume by platform.' },
            { kind: 'report' as const, reportId: 'bookings-over-time', caption: 'Month-by-month booking volume.' },
            { kind: 'report' as const, reportId: 'turnovers-by-property', caption: 'Turnover cleans by property.' },
            { kind: 'report' as const, reportId: 'turnovers-by-status', caption: 'Turnover pipeline by status.' },
            { kind: 'report' as const, reportId: 'open-follow-ups', caption: 'Inspection follow-ups still open.' },
          ],
        },
      ],
    },
  ],
};

export default stayReadyPack;
