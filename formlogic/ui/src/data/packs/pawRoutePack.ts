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
  primaryColor: '#16a34a',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const pawRoutePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'pawroute-pet-care',
    name: 'PawRoute — Dog Walking & Pet Care',
    description:
      'A daily operations hub for a dog walking and pet care studio: keep client and pet profiles, roster your walkers and sitters, schedule walks and visits, and log incidents and care notes — all linked together.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['pets', 'dog-walking', 'pet-care', 'scheduling', 'clients'],
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
        'Add a pet owner with their contact details, home access instructions and billing status.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Client',
          description: 'Capture the owner details so walks are easy to book and the door is easy to open.',
          required: false,
          properties: {},
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Client Name',
          required: true,
          properties: { placeholder: 'Full name' },
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
          required: true,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'address',
          type: 'location',
          label: 'Address',
          required: false,
          properties: {},
        },
        {
          id: 'access_instructions',
          type: 'long_text',
          label: 'Access Instructions',
          required: false,
          properties: { placeholder: 'Key safe code, gate latch, alarm, where the leash lives…' },
        },
        {
          id: 'emergency_contact',
          type: 'short_text',
          label: 'Emergency Contact',
          required: false,
          properties: { placeholder: 'Name and number' },
        },
        {
          id: 'preferred_contact',
          type: 'dropdown',
          label: 'Preferred Contact Method',
          required: false,
          properties: {
            options: [
              { id: 'text-message', label: 'Text message', value: 'text-message' },
              { id: 'phone-call', label: 'Phone call', value: 'phone-call' },
              { id: 'email', label: 'Email', value: 'email' },
              { id: 'app', label: 'App', value: 'app' },
            ],
          },
        },
        {
          id: 'billing_status',
          type: 'dropdown',
          label: 'Billing Status',
          required: false,
          properties: {
            options: [
              { id: 'up-to-date', label: 'Up to date', value: 'up-to-date' },
              { id: 'pending', label: 'Pending', value: 'pending' },
              { id: 'overdue', label: 'Overdue', value: 'overdue' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Preferred routes, treat rules, anything the walker should know…' },
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
            { id: 'k1', title: 'Total clients', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Overdue billing', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'billing_status', op: 'eq', value: 'overdue' }] } },
            { id: 'k3', title: 'Pending billing', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'billing_status', op: 'eq', value: 'pending' }] } },
            { id: 'c1', title: 'Billing status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client', viz: 'donut', groupBy: { field: 'billing_status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c2', title: 'Preferred contact', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client', viz: 'bar', groupBy: { field: 'preferred_contact', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'New clients over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent clients', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:client', titleField: 'name', subtitleField: 'phone', limit: 6 } },
          ],
        },
      },
    },
    // ── 2. Pet ────────────────────────────────────────────────────────────
    {
      packFormId: 'pet',
      title: 'Pet',
      icon: 'PawPrint',
      description:
        'Add a pet with its species, size, temperament, care notes and the client it belongs to.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Pet',
          description: 'Add the pet so every walker knows exactly who they are meeting at the door.',
          required: false,
          properties: {},
        },
        {
          id: 'name',
          type: 'short_text',
          label: 'Pet Name',
          required: true,
          properties: { placeholder: 'e.g. Biscuit' },
        },
        {
          id: 'species',
          type: 'dropdown',
          label: 'Species',
          required: false,
          properties: {
            options: [
              { id: 'dog', label: 'Dog', value: 'dog' },
              { id: 'cat', label: 'Cat', value: 'cat' },
              { id: 'other', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'breed',
          type: 'short_text',
          label: 'Breed',
          required: false,
          properties: { placeholder: 'e.g. Border Collie' },
        },
        {
          id: 'size',
          type: 'dropdown',
          label: 'Size',
          required: false,
          properties: {
            options: [
              { id: 'small', label: 'Small', value: 'small' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'large', label: 'Large', value: 'large' },
              { id: 'giant', label: 'Giant', value: 'giant' },
            ],
          },
        },
        {
          id: 'temperament',
          type: 'checkboxes',
          label: 'Temperament',
          required: false,
          properties: {
            options: [
              { id: 'friendly', label: 'Friendly', value: 'friendly' },
              { id: 'nervous', label: 'Nervous', value: 'nervous' },
              { id: 'reactive', label: 'Reactive', value: 'reactive' },
              { id: 'pulls-on-leash', label: 'Pulls on leash', value: 'pulls-on-leash' },
              { id: 'senior', label: 'Senior', value: 'senior' },
              { id: 'puppy', label: 'Puppy', value: 'puppy' },
            ],
          },
        },
        {
          id: 'medical_notes',
          type: 'long_text',
          label: 'Medical Notes',
          required: false,
          properties: { placeholder: 'Allergies, medication, vet advice…' },
        },
        {
          id: 'feeding_instructions',
          type: 'long_text',
          label: 'Feeding Instructions',
          required: false,
          properties: { placeholder: 'What, how much and when…' },
        },
        {
          id: 'owner',
          type: 'linked_record',
          label: 'Owner',
          required: true,
          properties: { targetFormId: '@pack:client' },
        },
        {
          id: 'vet_contact',
          type: 'phone',
          label: 'Vet Contact',
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'photo',
          type: 'file_upload',
          label: 'Photo',
          required: false,
          properties: { acceptedFileTypes: ['.jpg', '.png'] },
        },
        {
          id: 'active',
          type: 'dropdown',
          label: 'Active',
          required: false,
          properties: {
            options: [
              { id: 'active', label: 'Active', value: 'active' },
              { id: 'paused', label: 'Paused', value: 'paused' },
              { id: 'archived', label: 'Archived', value: 'archived' },
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
            { id: 'k1', title: 'Total pets', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Active pets', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'active', op: 'eq', value: 'active' }] } },
            { id: 'k3', title: 'Dogs', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'species', op: 'eq', value: 'dog' }] } },
            { id: 'c1', title: 'Pets by size', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'bar', groupBy: { field: 'size', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Species share', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'donut', groupBy: { field: 'species', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Temperament mix', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'bar', groupBy: { field: 'temperament', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c4', title: 'New pets over time', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent pets', layout: { x: 0, y: 7, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:pet', titleField: 'name', subtitleField: 'breed', limit: 6 } },
          ],
        },
      },
    },
    // ── 3. Team Member ────────────────────────────────────────────────────
    {
      packFormId: 'team-member',
      title: 'Team Member',
      icon: 'UserCog',
      description:
        'Add a walker, sitter or admin to the crew with their service areas and weekly availability.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Team Member',
          description: 'Put a new walker or sitter on the roster so routes can be assigned their way.',
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
          id: 'role',
          type: 'dropdown',
          label: 'Role',
          required: false,
          properties: {
            options: [
              { id: 'walker', label: 'Walker', value: 'walker' },
              { id: 'sitter', label: 'Sitter', value: 'sitter' },
              { id: 'admin', label: 'Admin', value: 'admin' },
            ],
          },
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
          required: false,
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
            { id: 'k1', title: 'Total team', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:team-member', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Active team', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:team-member', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'active', op: 'eq', value: 'active' }] } },
            { id: 'k3', title: 'Walkers', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:team-member', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'role', op: 'eq', value: 'walker' }] } },
            { id: 'c1', title: 'Team by role', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:team-member', viz: 'bar', groupBy: { field: 'role', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Service area coverage', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:team-member', viz: 'bar', groupBy: { field: 'service_areas', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Availability by day', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:team-member', viz: 'bar', groupBy: { field: 'availability', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent team members', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:team-member', titleField: 'name', subtitleField: 'role', limit: 6 } },
          ],
        },
      },
    },
    // ── 4. Walk & Visit ───────────────────────────────────────────────────
    {
      packFormId: 'walk',
      title: 'Walk & Visit',
      icon: 'Route',
      description:
        'Book a walk or visit linking a pet, client and walker with date, time, duration, status and charge.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Walk or Visit',
          description: 'Put a walk on the route board so the right walker turns up at the right door.',
          required: false,
          properties: {},
        },
        {
          id: 'pet',
          type: 'linked_record',
          label: 'Pet',
          required: true,
          properties: { targetFormId: '@pack:pet' },
        },
        {
          id: 'client',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client' },
        },
        {
          id: 'walker',
          type: 'linked_record',
          label: 'Walker',
          required: true,
          properties: { targetFormId: '@pack:team-member' },
        },
        {
          id: 'service_type',
          type: 'dropdown',
          label: 'Service Type',
          required: false,
          properties: {
            options: [
              { id: 'solo-walk', label: 'Solo walk', value: 'solo-walk' },
              { id: 'group-walk', label: 'Group walk', value: 'group-walk' },
              { id: 'drop-in-visit', label: 'Drop-in visit', value: 'drop-in-visit' },
              { id: 'pet-sitting', label: 'Pet sitting', value: 'pet-sitting' },
              { id: 'pet-taxi', label: 'Pet taxi', value: 'pet-taxi' },
            ],
          },
        },
        {
          id: 'date',
          type: 'date',
          label: 'Scheduled Date',
          required: true,
          properties: {},
        },
        {
          id: 'time',
          type: 'time',
          label: 'Scheduled Time',
          required: true,
          properties: {},
        },
        {
          id: 'duration',
          type: 'dropdown',
          label: 'Duration',
          required: false,
          properties: {
            options: [
              { id: '15-minutes', label: '15 minutes', value: '15-minutes' },
              { id: '30-minutes', label: '30 minutes', value: '30-minutes' },
              { id: '45-minutes', label: '45 minutes', value: '45-minutes' },
              { id: '60-minutes', label: '60 minutes', value: '60-minutes' },
            ],
          },
        },
        {
          id: 'status',
          type: 'dropdown',
          label: 'Status',
          required: false,
          properties: {
            options: [
              { id: 'scheduled', label: 'Scheduled', value: 'scheduled' },
              { id: 'in-progress', label: 'In progress', value: 'in-progress' },
              { id: 'completed', label: 'Completed', value: 'completed' },
              { id: 'cancelled', label: 'Cancelled', value: 'cancelled' },
              { id: 'no-access', label: 'No access', value: 'no-access' },
            ],
          },
        },
        {
          id: 'weather',
          type: 'dropdown',
          label: 'Weather',
          required: false,
          properties: {
            options: [
              { id: 'sunny', label: 'Sunny', value: 'sunny' },
              { id: 'overcast', label: 'Overcast', value: 'overcast' },
              { id: 'rain', label: 'Rain', value: 'rain' },
              { id: 'windy', label: 'Windy', value: 'windy' },
              { id: 'hot', label: 'Hot', value: 'hot' },
            ],
          },
        },
        {
          id: 'walk_notes',
          type: 'long_text',
          label: 'Walk Notes',
          required: false,
          properties: { placeholder: 'How the walk went, anything the owner should hear about…' },
        },
        {
          id: 'photo_proof',
          type: 'file_upload',
          label: 'Photo Proof',
          required: false,
          properties: { acceptedFileTypes: ['.jpg', '.png'] },
        },
        {
          id: 'charge_amount',
          type: 'number',
          label: 'Charge Amount ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
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
            { id: 'k1', title: 'Total walks', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Revenue', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'kpi', measure: { fn: 'sum', field: 'charge_amount' } } },
            { id: 'k3', title: 'Completed', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'status', op: 'eq', value: 'completed' }] } },
            { id: 'k4', title: 'Avg charge', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'kpi', measure: { fn: 'avg', field: 'charge_amount' } } },
            { id: 'c1', title: 'Walks by service', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'bar', groupBy: { field: 'service_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Status share', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Walks over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c4', title: 'Walks by walker', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'bar', joins: [{ via: 'walker', formId: '@pack:team-member', type: 'left' }], groupBy: { field: '@pack:team-member::name', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent walks', layout: { x: 0, y: 7, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:walk', titleField: 'service_type', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
    },
    // ── 5. Incident & Care Note ───────────────────────────────────────────
    {
      packFormId: 'incident',
      title: 'Incident & Care Note',
      icon: 'HeartPulse',
      description:
        'Log an incident or care note against a pet and walk, with type, severity, what happened and any follow-up.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'New Incident or Care Note',
          description: 'Write down what happened on the walk so the owner and the team stay in the loop.',
          required: false,
          properties: {},
        },
        {
          id: 'pet',
          type: 'linked_record',
          label: 'Pet',
          required: true,
          properties: { targetFormId: '@pack:pet' },
        },
        {
          id: 'walk',
          type: 'linked_record',
          label: 'Walk or Visit',
          required: true,
          properties: { targetFormId: '@pack:walk' },
        },
        {
          id: 'incident_type',
          type: 'dropdown',
          label: 'Incident Type',
          required: false,
          properties: {
            options: [
              { id: 'injury', label: 'Injury', value: 'injury' },
              { id: 'escape-risk', label: 'Escape risk', value: 'escape-risk' },
              { id: 'aggression', label: 'Aggression', value: 'aggression' },
              { id: 'illness', label: 'Illness', value: 'illness' },
              { id: 'no-access', label: 'No access', value: 'no-access' },
              { id: 'owner-note', label: 'Owner note', value: 'owner-note' },
            ],
          },
        },
        {
          id: 'severity',
          type: 'dropdown',
          label: 'Severity',
          required: false,
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
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'What happened, when and where…' },
        },
        {
          id: 'action_taken',
          type: 'long_text',
          label: 'Action Taken',
          required: false,
          properties: { placeholder: 'What you did about it and who you told…' },
        },
        {
          id: 'follow_up',
          type: 'dropdown',
          label: 'Follow-up Required',
          required: false,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'photo',
          type: 'file_upload',
          label: 'Photo',
          required: false,
          properties: { acceptedFileTypes: ['.jpg', '.png'] },
        },
        {
          id: 'reported_by',
          type: 'linked_record',
          label: 'Reported By',
          required: true,
          properties: { targetFormId: '@pack:team-member' },
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
            { id: 'k1', title: 'Total notes', layout: { x: 0, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Open follow-ups', layout: { x: 4, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'follow_up', op: 'eq', value: 'yes' }] } },
            { id: 'k3', title: 'Urgent', layout: { x: 8, y: 0, w: 4, h: 1 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'kpi', measure: { fn: 'count' }, filters: [{ field: 'severity', op: 'eq', value: 'urgent' }] } },
            { id: 'c1', title: 'By incident type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'bar', groupBy: { field: 'incident_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Severity share', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'donut', groupBy: { field: 'severity', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Notes over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent care notes', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:incident', titleField: 'incident_type', subtitleField: 'severity', limit: 6 } },
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
      packAppId: 'pawroute',
      name: 'PawRoute',
      description:
        'A dog walking and pet care operations hub: keep client and pet profiles, roster walkers and sitters, run the daily route board, and stay on top of incidents and care notes from one dashboard.',
      settings: { icon: 'PawPrint' },
      theme: {
        primaryColor: '#16a34a',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'client', displayName: 'Clients', sortOrder: 1, isVisible: true },
        { packFormId: 'pet', displayName: 'Pets', sortOrder: 2, isVisible: true },
        { packFormId: 'team-member', displayName: 'Team Members', sortOrder: 3, isVisible: true },
        { packFormId: 'walk', displayName: 'Walks & Visits', sortOrder: 4, isVisible: true },
        { packFormId: 'incident', displayName: 'Incidents & Care Notes', sortOrder: 5, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Clients', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Pets', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:pet', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Walks & visits', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Revenue', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'kpi', measure: { fn: 'sum', field: 'charge_amount' } } },
            { id: 'a1', title: 'Quick actions', layout: { x: 0, y: 1, w: 12, h: 1 }, kind: 'actions' },
            { id: 'c1', title: 'Walks by service', layout: { x: 0, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'bar', groupBy: { field: 'service_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Walk status share', layout: { x: 6, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'donut', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Walks over time', layout: { x: 0, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:walk', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'c4', title: 'Incidents by severity', layout: { x: 4, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:incident', viz: 'bar', groupBy: { field: 'severity', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'act1', title: 'Recent activity', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'activity' },
            { id: 'l1', title: 'Recent walks', layout: { x: 0, y: 8, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:walk', titleField: 'service_type', subtitleField: 'status', limit: 6 } },
          ],
        },
      },
      roles: [
        {
          name: 'Studio Manager',
          description: 'Full access to every PawRoute form.',
          permissions: [
            { packFormId: 'client', permission: 'submit_responses' },
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'client', permission: 'edit_responses' },
            { packFormId: 'client', permission: 'delete_responses' },
            { packFormId: 'client', permission: 'export_responses' },
            { packFormId: 'pet', permission: 'submit_responses' },
            { packFormId: 'pet', permission: 'view_all_responses' },
            { packFormId: 'pet', permission: 'edit_responses' },
            { packFormId: 'pet', permission: 'delete_responses' },
            { packFormId: 'pet', permission: 'export_responses' },
            { packFormId: 'team-member', permission: 'submit_responses' },
            { packFormId: 'team-member', permission: 'view_all_responses' },
            { packFormId: 'team-member', permission: 'edit_responses' },
            { packFormId: 'team-member', permission: 'delete_responses' },
            { packFormId: 'team-member', permission: 'export_responses' },
            { packFormId: 'walk', permission: 'submit_responses' },
            { packFormId: 'walk', permission: 'view_all_responses' },
            { packFormId: 'walk', permission: 'edit_responses' },
            { packFormId: 'walk', permission: 'delete_responses' },
            { packFormId: 'walk', permission: 'export_responses' },
            { packFormId: 'incident', permission: 'submit_responses' },
            { packFormId: 'incident', permission: 'view_all_responses' },
            { packFormId: 'incident', permission: 'edit_responses' },
            { packFormId: 'incident', permission: 'delete_responses' },
            { packFormId: 'incident', permission: 'export_responses' },
          ],
        },
        {
          name: 'Dispatcher',
          description: 'Office staff who manage clients and pets, book walks and keep an eye on care notes.',
          permissions: [
            { packFormId: 'client', permission: 'submit_responses' },
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'client', permission: 'edit_responses' },
            { packFormId: 'pet', permission: 'submit_responses' },
            { packFormId: 'pet', permission: 'view_all_responses' },
            { packFormId: 'pet', permission: 'edit_responses' },
            { packFormId: 'team-member', permission: 'view_all_responses' },
            { packFormId: 'walk', permission: 'submit_responses' },
            { packFormId: 'walk', permission: 'view_all_responses' },
            { packFormId: 'walk', permission: 'edit_responses' },
            { packFormId: 'incident', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Walker',
          description: 'Walkers and sitters in the field who run their walks and log care notes.',
          permissions: [
            { packFormId: 'client', permission: 'view_all_responses' },
            { packFormId: 'pet', permission: 'view_all_responses' },
            { packFormId: 'walk', permission: 'view_all_responses' },
            { packFormId: 'walk', permission: 'edit_responses' },
            { packFormId: 'incident', permission: 'submit_responses' },
            { packFormId: 'incident', permission: 'view_all_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'walks-total',
          kind: 'chart' as const,
          name: 'Total walks',
          description: 'Count of all walks and visits on record.',
          spec: {
            formId: '@pack:walk',
            viz: 'kpi' as const,
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'walks-by-service',
          kind: 'chart' as const,
          name: 'Walks by service type',
          description: 'Count of walks and visits broken down by service type.',
          spec: {
            formId: '@pack:walk',
            viz: 'bar' as const,
            groupBy: { field: 'service_type' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'walks-by-walker',
          kind: 'chart' as const,
          name: 'Walks by walker',
          description: 'Count of walks grouped by the linked walker name.',
          spec: {
            formId: '@pack:walk',
            viz: 'bar' as const,
            joins: [{ via: 'walker', formId: '@pack:team-member', type: 'left' as const }],
            groupBy: { field: '@pack:team-member::name' },
            measure: { fn: 'count' as const },
            seriesSort: 'value' as const,
            sort: 'desc' as const,
          },
        },
        {
          reportId: 'walks-over-time',
          kind: 'chart' as const,
          name: 'Walks over time',
          description: 'Monthly trend of walks and visits booked.',
          spec: {
            formId: '@pack:walk',
            viz: 'line' as const,
            groupBy: { field: '__submitted_at', bucket: 'month' as const },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'revenue-total',
          kind: 'chart' as const,
          name: 'Total revenue',
          description: 'Total charge amount summed across all walks and visits.',
          spec: {
            formId: '@pack:walk',
            viz: 'kpi' as const,
            measure: { fn: 'sum' as const, field: 'charge_amount' },
          },
        },
        {
          reportId: 'incidents-by-severity',
          kind: 'chart' as const,
          name: 'Incidents by severity',
          description: 'Count of incidents and care notes grouped by severity.',
          spec: {
            formId: '@pack:incident',
            viz: 'bar' as const,
            groupBy: { field: 'severity' },
            measure: { fn: 'count' as const },
          },
        },
        {
          reportId: 'pawroute-overview',
          kind: 'document' as const,
          name: 'Pet care operations overview',
          description: 'High-level summary of walk activity, revenue and care alerts across PawRoute.',
          blocks: [
            {
              kind: 'text' as const,
              title: 'Pet care operations overview',
              body: 'This report summarises walk and visit activity, revenue and care notes across PawRoute. Use it to see how the route board is filling up, which walkers carry the load, where revenue comes from, and how incidents are trending.',
            },
            { kind: 'report' as const, reportId: 'walks-by-service', caption: 'Walk volume by service type.' },
            { kind: 'report' as const, reportId: 'walks-by-walker', caption: 'Walk load by walker.' },
            { kind: 'report' as const, reportId: 'walks-over-time', caption: 'Month-by-month walk volume.' },
            { kind: 'report' as const, reportId: 'revenue-total', caption: 'Total charge revenue across all walks.' },
            { kind: 'report' as const, reportId: 'incidents-by-severity', caption: 'Incidents and care notes by severity.' },
          ],
        },
      ],
    },
  ],
};
