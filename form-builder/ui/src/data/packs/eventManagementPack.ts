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
  primaryColor: '#0891b2',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const eventManagementPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'event-management',
    name: 'Event Management',
    description:
      'Complete event management workflow covering registration, speaker submissions, vendor applications, volunteer coordination, incident logging, budget tracking, and post-event feedback.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['events', 'registration', 'speakers', 'vendors', 'volunteers', 'feedback'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Event Registration ─────────────────────────────────────────────
    {
      packFormId: 'event-registration',
      title: 'Event Registration',
      icon: 'Ticket',
      description:
        'Register attendees for events with ticket selection, dietary requirements, and accessibility needs.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Event Registration',
          description:
            'Welcome! Please complete this form to register for the event. We look forward to seeing you there.',
          required: false,
          properties: {},
        },
        {
          id: 'attendee_name',
          type: 'short_text',
          label: 'Full Name',
          required: true,
          properties: { placeholder: 'Enter your full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
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
          id: 'organization',
          type: 'short_text',
          label: 'Organization / Company',
          required: false,
          properties: { placeholder: 'Your company or organization' },
        },
        {
          id: 'ticket_type',
          type: 'dropdown',
          label: 'Ticket Type',
          required: true,
          properties: {
            options: [
              { id: 'general', label: 'General Admission', value: 'general' },
              { id: 'vip', label: 'VIP', value: 'vip' },
              { id: 'early_bird', label: 'Early Bird', value: 'early_bird' },
              { id: 'student', label: 'Student', value: 'student' },
              { id: 'speaker', label: 'Speaker', value: 'speaker' },
            ],
          },
        },
        {
          id: 'dietary_requirements',
          type: 'checkboxes',
          label: 'Dietary Requirements',
          required: false,
          properties: {
            options: [
              { id: 'vegetarian', label: 'Vegetarian', value: 'vegetarian' },
              { id: 'vegan', label: 'Vegan', value: 'vegan' },
              { id: 'gluten_free', label: 'Gluten Free', value: 'gluten_free' },
              { id: 'halal', label: 'Halal', value: 'halal' },
              { id: 'kosher', label: 'Kosher', value: 'kosher' },
              { id: 'nut_free', label: 'Nut Free', value: 'nut_free' },
              { id: 'none_diet', label: 'None', value: 'none' },
            ],
          },
        },
        {
          id: 'accessibility_needs',
          type: 'long_text',
          label: 'Accessibility Needs',
          required: false,
          properties: { placeholder: 'Please describe any accessibility requirements' },
        },
        {
          id: 'emergency_contact_name',
          type: 'short_text',
          label: 'Emergency Contact Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'emergency_contact_phone',
          type: 'phone',
          label: 'Emergency Contact Phone',
          required: true,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'thank_you',
          type: 'thank_you',
          label: 'Registration Complete',
          description:
            'Thank you for registering! You will receive a confirmation email shortly with event details.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 2. Speaker / Presenter Submission ─────────────────────────────────
    {
      packFormId: 'speaker-submission',
      title: 'Speaker / Presenter Submission',
      icon: 'Mic',
      description:
        'Collect speaker proposals including topic, abstract, bio, and equipment requirements.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'speaker_name',
          type: 'short_text',
          label: 'Speaker Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
          properties: { placeholder: 'speaker@example.com' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: true,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'bio',
          type: 'long_text',
          label: 'Speaker Bio',
          required: true,
          properties: { placeholder: 'Brief biography (150-300 words)' },
        },
        {
          id: 'topic_title',
          type: 'short_text',
          label: 'Topic / Session Title',
          required: true,
          properties: { placeholder: 'Title of your presentation' },
        },
        {
          id: 'abstract',
          type: 'long_text',
          label: 'Abstract',
          description: 'Provide a summary of your talk (200-500 words).',
          required: true,
          properties: { placeholder: 'Describe what attendees will learn...' },
        },
        {
          id: 'presentation_type',
          type: 'dropdown',
          label: 'Presentation Type',
          required: true,
          properties: {
            options: [
              { id: 'keynote', label: 'Keynote', value: 'keynote' },
              { id: 'breakout', label: 'Breakout Session', value: 'breakout' },
              { id: 'workshop', label: 'Workshop', value: 'workshop' },
              { id: 'panel', label: 'Panel Discussion', value: 'panel' },
              { id: 'lightning', label: 'Lightning Talk', value: 'lightning' },
            ],
          },
        },
        {
          id: 'equipment_needs',
          type: 'checkboxes',
          label: 'Equipment Needs',
          required: false,
          properties: {
            options: [
              { id: 'projector', label: 'Projector', value: 'projector' },
              { id: 'microphone', label: 'Microphone', value: 'microphone' },
              { id: 'whiteboard', label: 'Whiteboard', value: 'whiteboard' },
              { id: 'laptop', label: 'Laptop', value: 'laptop' },
              { id: 'wifi', label: 'High-Speed WiFi', value: 'wifi' },
              { id: 'other_eq', label: 'Other (specify in notes)', value: 'other' },
            ],
          },
        },
        {
          id: 'headshot',
          type: 'file_upload',
          label: 'Headshot Photo',
          required: false,
          properties: {
            acceptedFileTypes: ['.jpg', '.png'],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Additional Notes',
          required: false,
          properties: { placeholder: 'Any additional information or requirements' },
        },
      ],
    },

    // ── 3. Vendor / Exhibitor Application ─────────────────────────────────
    {
      packFormId: 'vendor-application',
      title: 'Vendor / Exhibitor Application',
      icon: 'Store',
      description:
        'Process vendor and exhibitor applications with booth preferences and insurance verification.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'company_name',
          type: 'short_text',
          label: 'Company Name',
          required: true,
          properties: { placeholder: 'Business or organization name' },
        },
        {
          id: 'contact_name',
          type: 'short_text',
          label: 'Contact Name',
          required: true,
          properties: { placeholder: 'Primary contact person' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
          properties: { placeholder: 'contact@company.com' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: true,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'website',
          type: 'short_text',
          label: 'Website',
          required: false,
          properties: { placeholder: 'https://www.example.com' },
        },
        {
          id: 'products_services',
          type: 'long_text',
          label: 'Products / Services',
          required: true,
          properties: { placeholder: 'Describe what you will be showcasing or selling' },
        },
        {
          id: 'booth_size',
          type: 'dropdown',
          label: 'Booth Size',
          required: true,
          properties: {
            options: [
              { id: 'small', label: 'Small (6x6)', value: 'small' },
              { id: 'medium', label: 'Medium (10x10)', value: 'medium' },
              { id: 'large', label: 'Large (10x20)', value: 'large' },
              { id: 'premium', label: 'Premium (20x20)', value: 'premium' },
            ],
          },
        },
        {
          id: 'power_requirements',
          type: 'checkboxes',
          label: 'Power Requirements',
          required: false,
          properties: {
            options: [
              { id: 'standard', label: 'Standard Power (120V)', value: 'standard' },
              { id: 'high', label: 'High Power (240V)', value: 'high' },
              { id: 'multiple', label: 'Multiple Outlets', value: 'multiple' },
              { id: 'none_power', label: 'None Required', value: 'none' },
            ],
          },
        },
        {
          id: 'insurance_certificate',
          type: 'file_upload',
          label: 'Insurance Certificate',
          required: false,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png'],
          },
        },
        {
          id: 'special_requests',
          type: 'long_text',
          label: 'Special Requests',
          required: false,
          properties: { placeholder: 'Any special setup requirements or requests' },
        },
      ],
    },

    // ── 4. Volunteer Sign-Up ──────────────────────────────────────────────
    {
      packFormId: 'volunteer-signup',
      title: 'Volunteer Sign-Up',
      icon: 'HandHelping',
      description:
        'Recruit and coordinate event volunteers with availability and skills tracking.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'volunteer_name',
          type: 'short_text',
          label: 'Full Name',
          required: true,
          properties: { placeholder: 'Enter your full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
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
          id: 'availability',
          type: 'checkboxes',
          label: 'Availability',
          required: true,
          properties: {
            options: [
              { id: 'setup', label: 'Setup (day before)', value: 'setup' },
              { id: 'event_day', label: 'Event Day', value: 'event_day' },
              { id: 'teardown', label: 'Teardown (day after)', value: 'teardown' },
              { id: 'all_days', label: 'All Days', value: 'all_days' },
            ],
          },
        },
        {
          id: 'skills',
          type: 'checkboxes',
          label: 'Skills & Interests',
          required: false,
          properties: {
            options: [
              { id: 'registration', label: 'Registration Desk', value: 'registration' },
              { id: 'tech_support', label: 'Tech / AV Support', value: 'tech_support' },
              { id: 'crowd_mgmt', label: 'Crowd Management', value: 'crowd_mgmt' },
              { id: 'hospitality', label: 'Hospitality / Catering', value: 'hospitality' },
              { id: 'photography', label: 'Photography / Video', value: 'photography' },
              { id: 'first_aid', label: 'First Aid', value: 'first_aid' },
            ],
          },
        },
        {
          id: 't_shirt_size',
          type: 'dropdown',
          label: 'T-Shirt Size',
          required: true,
          properties: {
            options: [
              { id: 'xs', label: 'XS', value: 'xs' },
              { id: 's', label: 'S', value: 's' },
              { id: 'm', label: 'M', value: 'm' },
              { id: 'l', label: 'L', value: 'l' },
              { id: 'xl', label: 'XL', value: 'xl' },
              { id: 'xxl', label: 'XXL', value: 'xxl' },
            ],
          },
        },
        {
          id: 'emergency_contact_name',
          type: 'short_text',
          label: 'Emergency Contact Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'emergency_contact_phone',
          type: 'phone',
          label: 'Emergency Contact Phone',
          required: true,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Additional Notes',
          required: false,
          properties: { placeholder: 'Anything else we should know' },
        },
      ],
    },

    // ── 5. Post-Event Feedback ────────────────────────────────────────────
    {
      packFormId: 'event-feedback',
      title: 'Post-Event Feedback',
      icon: 'MessageSquare',
      description:
        'Collect attendee feedback after events to measure satisfaction and identify improvements.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'attendee_record',
          type: 'linked_record',
          label: 'Attendee',
          required: false,
          properties: { targetFormId: '@pack:event-registration' },
        },
        {
          id: 'overall_rating',
          type: 'rating',
          label: 'Overall Event Rating',
          required: true,
          properties: { max: 5 },
        },
        {
          id: 'venue_rating',
          type: 'scale',
          label: 'Venue Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'speakers_rating',
          type: 'scale',
          label: 'Speakers / Content Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'organization_rating',
          type: 'scale',
          label: 'Organization & Logistics Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'food_rating',
          type: 'scale',
          label: 'Food & Beverage Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: false,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'what_enjoyed',
          type: 'long_text',
          label: 'What did you enjoy most?',
          required: false,
          properties: { placeholder: 'Tell us what you liked' },
        },
        {
          id: 'suggestions',
          type: 'long_text',
          label: 'Suggestions for Improvement',
          required: false,
          properties: { placeholder: 'How can we make the next event better?' },
        },
        {
          id: 'would_attend_again',
          type: 'multiple_choice',
          label: 'Would you attend this event again?',
          required: true,
          properties: {
            options: [
              { id: 'definitely', label: 'Definitely', value: 'definitely' },
              { id: 'probably', label: 'Probably', value: 'probably' },
              { id: 'unsure', label: 'Unsure', value: 'unsure' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'would_recommend',
          type: 'multiple_choice',
          label: 'Would you recommend this event to others?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'maybe', label: 'Maybe', value: 'maybe' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
      ],
    },

    // ── 6. Event Incident Log ─────────────────────────────────────────────
    {
      packFormId: 'event-incident-log',
      title: 'Event Incident Log',
      icon: 'AlertTriangle',
      description:
        'Document incidents that occur during events for safety records and post-event review.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'reporter_name',
          type: 'short_text',
          label: 'Reporter Name',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'incident_date',
          type: 'date',
          label: 'Date',
          required: true,
          properties: {},
        },
        {
          id: 'incident_time',
          type: 'time',
          label: 'Time',
          required: true,
          properties: {},
        },
        {
          id: 'location',
          type: 'short_text',
          label: 'Location',
          required: true,
          properties: { placeholder: 'Where did the incident occur?' },
        },
        {
          id: 'incident_type',
          type: 'dropdown',
          label: 'Incident Type',
          required: true,
          properties: {
            options: [
              { id: 'medical', label: 'Medical Emergency', value: 'medical' },
              { id: 'safety', label: 'Safety Hazard', value: 'safety' },
              { id: 'security', label: 'Security Issue', value: 'security' },
              { id: 'property', label: 'Property Damage', value: 'property' },
              { id: 'weather', label: 'Weather Related', value: 'weather' },
              { id: 'complaint', label: 'Attendee Complaint', value: 'complaint' },
              { id: 'other_type', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Describe what happened in detail' },
        },
        {
          id: 'severity',
          type: 'dropdown',
          label: 'Severity',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'actions_taken',
          type: 'long_text',
          label: 'Actions Taken',
          required: true,
          properties: { placeholder: 'What was done to address the incident?' },
        },
        {
          id: 'witnesses',
          type: 'long_text',
          label: 'Witnesses',
          required: false,
          properties: { placeholder: 'Names and contact info of witnesses' },
        },
        {
          id: 'photos',
          type: 'file_upload',
          label: 'Photos / Evidence',
          required: false,
          properties: {
            acceptedFileTypes: ['.jpg', '.png', '.pdf'],
            allowMultiple: true,
          },
        },
      ],
    },

    // ── 7. Event Budget Item ──────────────────────────────────────────────
    {
      packFormId: 'budget-tracker',
      title: 'Event Budget Item',
      icon: 'DollarSign',
      description:
        'Track event budget items with estimated vs. actual costs and variance calculation.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'item_name',
          type: 'short_text',
          label: 'Item Name',
          required: true,
          properties: { placeholder: 'Budget item description' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'venue', label: 'Venue', value: 'venue' },
              { id: 'catering', label: 'Catering', value: 'catering' },
              { id: 'av_equipment', label: 'AV Equipment', value: 'av_equipment' },
              { id: 'marketing', label: 'Marketing', value: 'marketing' },
              { id: 'speakers', label: 'Speaker Fees', value: 'speakers' },
              { id: 'decor', label: 'Decorations', value: 'decor' },
              { id: 'transportation', label: 'Transportation', value: 'transportation' },
              { id: 'staffing', label: 'Staffing', value: 'staffing' },
              { id: 'insurance', label: 'Insurance', value: 'insurance' },
              { id: 'other_cat', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'estimated_cost',
          type: 'number',
          label: 'Estimated Cost ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'actual_cost',
          type: 'number',
          label: 'Actual Cost ($)',
          required: false,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'variance',
          type: 'calculated',
          label: 'Variance ($)',
          description: 'Difference between estimated and actual cost (negative = over budget).',
          required: false,
          properties: {
            calculationExpression: 'Math.round((estimated_cost - (actual_cost || 0)) * 100) / 100',
          },
        },
        {
          id: 'vendor',
          type: 'short_text',
          label: 'Vendor / Supplier',
          required: false,
          properties: { placeholder: 'Name of vendor or supplier' },
        },
        {
          id: 'receipt',
          type: 'file_upload',
          label: 'Receipt / Invoice',
          required: false,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png'],
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Additional notes about this budget item' },
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'event-hub',
      name: 'Event Hub',
      description:
        'Centralised event management platform covering registration, speaker coordination, vendor management, volunteer sign-ups, incident logging, budget tracking, and post-event feedback.',
      settings: {},
      theme: {
        primaryColor: '#0891b2',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'event-registration', displayName: 'Event Registration', sortOrder: 1, isVisible: true },
        { packFormId: 'speaker-submission', displayName: 'Speaker Submissions', sortOrder: 2, isVisible: true },
        { packFormId: 'vendor-application', displayName: 'Vendor Applications', sortOrder: 3, isVisible: true },
        { packFormId: 'volunteer-signup', displayName: 'Volunteer Sign-Ups', sortOrder: 4, isVisible: true },
        { packFormId: 'event-incident-log', displayName: 'Incident Log', sortOrder: 5, isVisible: true },
        { packFormId: 'budget-tracker', displayName: 'Budget Tracker', sortOrder: 6, isVisible: true },
        { packFormId: 'event-feedback', displayName: 'Post-Event Feedback', sortOrder: 7, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading dashboard…</div></div></div>`,
        css: `
* { box-sizing: border-box; }
html, body { margin: 0; }
#app { min-height: 100vh; padding: 26px 20px 46px; color: var(--fl-text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: transparent; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1060px; margin: 0 auto; }
.empty { padding: 64px 20px; text-align: center; color: var(--fl-muted); font-size: 15px; }
.hdr { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
.hdr-l { display: flex; align-items: center; gap: 14px; }
.logo { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 15px; color: var(--fl-accent-contrast); background: var(--fl-accent); box-shadow: 0 6px 20px color-mix(in srgb, var(--fl-accent) 35%, transparent); }
.hdr h1 { margin: 0; font-size: 21px; font-weight: 700; letter-spacing: -0.01em; color: var(--fl-text); }
.sub { margin: 2px 0 0; font-size: 13px; color: var(--fl-muted); }
.hdr-r { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.user { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fl-muted); background: var(--fl-surface-2); border: 1px solid var(--fl-border); padding: 7px 12px; border-radius: 999px; }
.udot { width: 8px; height: 8px; border-radius: 50%; background: var(--fl-good); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-good) 20%, transparent); }
.btn-primary { border: 0; cursor: pointer; font-size: 13px; font-weight: 700; color: var(--fl-accent-contrast); background: var(--fl-accent); padding: 9px 15px; border-radius: 10px; box-shadow: 0 6px 18px color-mix(in srgb, var(--fl-accent) 35%, transparent); transition: transform .12s, box-shadow .12s; }
.btn-primary:hover { transform: translateY(-1px); box-shadow: 0 9px 24px color-mix(in srgb, var(--fl-accent) 45%, transparent); }
.card { background: var(--fl-surface); border: 1px solid var(--fl-border); border-radius: 16px; box-shadow: var(--fl-shadow); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 13px; margin-bottom: 16px; }
.stat { padding: 16px 17px; }
.stat-val { font-size: 27px; font-weight: 800; letter-spacing: -0.02em; line-height: 1; }
.stat-lbl { margin-top: 7px; font-size: 12px; color: var(--fl-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.stat-sub { margin-top: 6px; font-size: 12px; color: var(--fl-faint); }
.warn { color: var(--fl-warn); font-weight: 600; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.panel { padding: 18px 19px; }
.panel-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 15px; }
.panel-h h2 { margin: 0; font-size: 15px; font-weight: 700; color: var(--fl-text); }
.panel-n { font-size: 12px; color: var(--fl-muted); }
.link { background: none; border: 0; cursor: pointer; color: var(--fl-accent); font-size: 12px; font-weight: 600; padding: 0; }
.link:hover { text-decoration: underline; }
.bars { display: flex; flex-direction: column; gap: 11px; }
.bar-row { display: grid; grid-template-columns: 116px 1fr 36px; align-items: center; gap: 11px; }
.bar-name { font-size: 13px; color: var(--fl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { height: 9px; background: var(--fl-track); border-radius: 6px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 6px; transition: width 1s cubic-bezier(.22,1,.36,1); }
.bar-val { font-size: 13px; font-weight: 700; color: var(--fl-text); text-align: right; }
.reclist { display: flex; flex-direction: column; }
.rec-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--fl-border); }
.rec-row:first-child { border-top: 0; padding-top: 2px; }
.rec-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.rec-name { font-size: 14px; color: var(--fl-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rec-org { font-size: 12px; color: var(--fl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.rec-date { font-size: 12px; color: var(--fl-muted); white-space: nowrap; min-width: 76px; text-align: right; }
.empty-sm { padding: 28px 8px; text-align: center; color: var(--fl-muted); font-size: 13px; }
.bud-nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 16px; }
.bud { display: flex; flex-direction: column; gap: 5px; padding: 12px 14px; background: var(--fl-surface-2); border: 1px solid var(--fl-border); border-radius: 12px; }
.bud-l { font-size: 11px; color: var(--fl-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.bud-v { font-size: 18px; font-weight: 800; color: var(--fl-text); }
.bud-v.pos { color: var(--fl-good); }
.bud-v.neg { color: var(--fl-bad); }
.prog { display: flex; align-items: center; gap: 12px; }
.prog-track { flex: 1; height: 10px; background: var(--fl-track); border-radius: 6px; overflow: hidden; }
.prog-fill { height: 100%; border-radius: 6px; transition: width 1s cubic-bezier(.22,1,.36,1); }
.prog-lbl { font-size: 12px; color: var(--fl-muted); white-space: nowrap; }
.quick { margin-top: 6px; }
.quick-l { display: block; font-size: 12px; color: var(--fl-faint); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 10px; }
.qbtns { display: flex; flex-wrap: wrap; gap: 10px; }
.qbtn { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--fl-muted); background: var(--fl-surface-2); border: 1px solid var(--fl-border); padding: 9px 14px; border-radius: 10px; transition: background .12s, border-color .12s, transform .12s; }
.qbtn:hover { background: color-mix(in srgb, var(--fl-accent) 10%, var(--fl-surface-2)); border-color: color-mix(in srgb, var(--fl-accent) 40%, transparent); transform: translateY(-1px); }
.qi { font-size: 15px; line-height: 1; }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } .bar-row { grid-template-columns: 96px 1fr 32px; } }
`,
        js: `
var FL = window.FormLogic;
function h(s){ return FL && FL.escapeHtml ? FL.escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s); }
function findForm(ctx, name){
  var t = String(name).toLowerCase();
  for (var i = 0; i < ctx.forms.length; i++){ if (String(ctx.forms[i].displayName || '').toLowerCase() === t) return ctx.forms[i]; }
  return null;
}
function fieldOptions(form, fieldId){
  if (!form || !form.fields) return [];
  for (var i = 0; i < form.fields.length; i++){ var f = form.fields[i]; if (f.id === fieldId && f.properties && f.properties.options) return f.properties.options; }
  return [];
}
function labelMap(form, fieldId){
  var m = {}; var o = fieldOptions(form, fieldId);
  for (var i = 0; i < o.length; i++){ m[o[i].value] = o[i].label; }
  return m;
}
function fmtInt(n){ return Number(n || 0).toLocaleString(); }
function fmtMoney(n){ return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtDate(s){ if (!s) return ''; var d = new Date(s); if (isNaN(d.getTime())) return ''; return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function num(v){ var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function bar(label, count, max, color){
  var pct = max > 0 ? Math.max(3, Math.round(count / max * 100)) : 0;
  return '<div class="bar-row"><span class="bar-name">' + h(label) + '</span>'
    + '<div class="bar-track"><div class="bar-fill" data-pct="' + pct + '" style="width:0;background:' + color + '"></div></div>'
    + '<span class="bar-val">' + fmtInt(count) + '</span></div>';
}
function stat(value, label, accent, sub){
  return '<div class="card stat"><div class="stat-val" style="color:color-mix(in srgb,' + accent + ' 60%,var(--fl-text))">' + value + '</div>'
    + '<div class="stat-lbl">' + h(label) + '</div>' + (sub ? '<div class="stat-sub">' + sub + '</div>' : '') + '</div>';
}
function qa(form, label, icon){
  if (!form) return '';
  return '<button class="qbtn" data-nav="' + h(form.formId) + '"><span class="qi">' + icon + '</span><span>' + h(label) + '</span></button>';
}
async function main(){
  var root = document.getElementById('app');
  var ctx;
  try { ctx = await FL.context(); } catch (e){ root.innerHTML = '<div class="wrap"><div class="empty">Could not load the dashboard.</div></div>'; return; }
  if (!ctx || !ctx.forms){ root.innerHTML = '<div class="wrap"><div class="empty">No forms available.</div></div>'; return; }
  var user = await FL.currentUser().catch(function(){ return null; });
  var userName = user && user.name ? user.name : (user && user.email ? user.email : 'Guest');

  var regForm = findForm(ctx, 'Event Registration');
  var speakerForm = findForm(ctx, 'Speaker Submissions');
  var vendorForm = findForm(ctx, 'Vendor Applications');
  var volForm = findForm(ctx, 'Volunteer Sign-Ups');
  var incidentForm = findForm(ctx, 'Incident Log');
  var budgetForm = findForm(ctx, 'Budget Tracker');
  var feedbackForm = findForm(ctx, 'Post-Event Feedback');

  function recs(f){ return f ? FL.records(f.formId, { limit: 500 }).catch(function(){ return []; }) : Promise.resolve([]); }
  var res = await Promise.all([recs(regForm), recs(speakerForm), recs(vendorForm), recs(volForm), recs(incidentForm), recs(budgetForm), recs(feedbackForm)]);
  var regRecs = res[0], speakerRecs = res[1], vendorRecs = res[2], volRecs = res[3], incRecs = res[4], budRecs = res[5];

  var i, r, a;

  var urgent = 0;
  for (i = 0; i < incRecs.length; i++){ var sv = incRecs[i].answers ? incRecs[i].answers.severity : null; if (sv === 'high' || sv === 'critical') urgent++; }

  var estTotal = 0, actTotal = 0;
  for (i = 0; i < budRecs.length; i++){ a = budRecs[i].answers || {}; estTotal += num(a.estimated_cost); actTotal += num(a.actual_cost); }
  var variance = estTotal - actTotal;
  var budPct = estTotal > 0 ? Math.min(100, Math.round(actTotal / estTotal * 100)) : 0;

  var ticketOpts = fieldOptions(regForm, 'ticket_type');
  var ticketColors = { general: '#38bdf8', vip: '#f59e0b', early_bird: '#22c55e', student: '#a78bfa', speaker: '#f472b6' };
  var tCounts = {}, tMax = 0;
  for (i = 0; i < regRecs.length; i++){ a = regRecs[i].answers || {}; if (a.ticket_type){ tCounts[a.ticket_type] = (tCounts[a.ticket_type] || 0) + 1; } }
  for (i = 0; i < ticketOpts.length; i++){ var cc = tCounts[ticketOpts[i].value] || 0; if (cc > tMax) tMax = cc; }
  var barsHtml = '';
  for (i = 0; i < ticketOpts.length; i++){ var opt = ticketOpts[i]; barsHtml += bar(opt.label, tCounts[opt.value] || 0, tMax, ticketColors[opt.value] || 'var(--fl-accent)'); }

  var ticketLbl = labelMap(regForm, 'ticket_type');
  var recentHtml = '';
  var rn = Math.min(6, regRecs.length);
  for (i = 0; i < rn; i++){
    r = regRecs[i]; a = r.answers || {};
    var nm = a.attendee_name || 'Unknown attendee';
    var tv = a.ticket_type;
    var tl = ticketLbl[tv] || tv || 'General Admission';
    var tc = ticketColors[tv] || 'var(--fl-accent)';
    var org = a.organization || '';
    var dt = fmtDate(r.submittedAt);
    recentHtml += '<div class="rec-row"><div class="rec-main"><span class="rec-name">' + h(nm) + '</span>'
      + (org ? '<span class="rec-org">' + h(org) + '</span>' : '') + '</div>'
      + '<span class="badge" style="color:color-mix(in srgb,' + tc + ' 55%,var(--fl-text));border-color:color-mix(in srgb,' + tc + ' 40%,transparent);background:color-mix(in srgb,' + tc + ' 16%,transparent)">' + h(tl) + '</span>'
      + '<span class="rec-date">' + h(dt) + '</span></div>';
  }

  var html = '<div class="wrap">';
  html += '<header class="hdr"><div class="hdr-l"><div class="logo">EH</div>'
    + '<div><h1>' + h(ctx.appName || 'Event Hub') + '</h1><p class="sub">Event operations dashboard</p></div></div>'
    + '<div class="hdr-r"><div class="user"><span class="udot"></span>' + h(userName) + '</div>'
    + (regForm ? '<button class="btn-primary" data-nav="' + h(regForm.formId) + '">+ New Registration</button>' : '')
    + '</div></header>';

  html += '<div class="stats">'
    + stat(fmtInt(regRecs.length), 'Registrations', '#38bdf8', '')
    + stat(fmtInt(speakerRecs.length), 'Speaker Subs', '#f472b6', '')
    + stat(fmtInt(vendorRecs.length), 'Vendors', '#f59e0b', '')
    + stat(fmtInt(volRecs.length), 'Volunteers', '#22c55e', '')
    + stat(fmtInt(incRecs.length), 'Incidents', '#ef4444', urgent > 0 ? '<span class="warn">' + urgent + ' high / critical</span>' : 'all clear')
    + '</div>';

  html += '<div class="grid2">';
  html += '<section class="card panel"><div class="panel-h"><h2>Registrations by Ticket Type</h2><span class="panel-n">' + fmtInt(regRecs.length) + ' total</span></div>'
    + (regRecs.length && ticketOpts.length ? '<div class="bars">' + barsHtml + '</div>'
      : '<div class="empty-sm">No registrations yet.' + (regForm ? ' <button class="link" data-nav="' + h(regForm.formId) + '">Add one</button>' : '') + '</div>')
    + '</section>';
  html += '<section class="card panel"><div class="panel-h"><h2>Recent Registrations</h2>' + (regForm ? '<button class="link" data-nav="' + h(regForm.formId) + '">View all</button>' : '') + '</div>'
    + (recentHtml ? '<div class="reclist">' + recentHtml + '</div>' : '<div class="empty-sm">No registrations yet.</div>')
    + '</section>';
  html += '</div>';

  html += '<section class="card panel wide"><div class="panel-h"><h2>Budget Overview</h2>' + (budgetForm ? '<button class="link" data-nav="' + h(budgetForm.formId) + '">Manage</button>' : '') + '</div>'
    + (budRecs.length ? (
        '<div class="bud-nums">'
        + '<div class="bud"><span class="bud-l">Estimated</span><span class="bud-v">' + fmtMoney(estTotal) + '</span></div>'
        + '<div class="bud"><span class="bud-l">Actual</span><span class="bud-v">' + fmtMoney(actTotal) + '</span></div>'
        + '<div class="bud"><span class="bud-l">Variance</span><span class="bud-v ' + (variance >= 0 ? 'pos' : 'neg') + '">' + (variance >= 0 ? '+' : '−') + fmtMoney(Math.abs(variance)) + '</span></div>'
        + '<div class="bud"><span class="bud-l">Line Items</span><span class="bud-v">' + fmtInt(budRecs.length) + '</span></div>'
        + '</div>'
        + '<div class="prog"><div class="prog-track"><div class="prog-fill bar-fill" data-pct="' + budPct + '" style="width:0;background:' + (actTotal > estTotal ? 'var(--fl-bad)' : 'var(--fl-accent)') + '"></div></div><span class="prog-lbl">' + budPct + '% of budget spent</span></div>'
      ) : '<div class="empty-sm">No budget items yet.' + (budgetForm ? ' <button class="link" data-nav="' + h(budgetForm.formId) + '">Add one</button>' : '') + '</div>')
    + '</section>';

  html += '<div class="quick"><span class="quick-l">Quick actions</span><div class="qbtns">'
    + qa(regForm, 'Register Attendee', '🎟️')
    + qa(speakerForm, 'Add Speaker', '🎤')
    + qa(vendorForm, 'Add Vendor', '🏪')
    + qa(volForm, 'Add Volunteer', '🙋')
    + qa(incidentForm, 'Log Incident', '⚠️')
    + qa(budgetForm, 'Add Budget Item', '💰')
    + qa(feedbackForm, 'Collect Feedback', '💬')
    + '</div></div>';

  html += '</div>';
  root.innerHTML = html;

  var navs = root.querySelectorAll('[data-nav]');
  for (i = 0; i < navs.length; i++){
    (function(btn){ btn.addEventListener('click', function(){ FL.navigate(btn.getAttribute('data-nav')); }); })(navs[i]);
  }

  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    var els = root.querySelectorAll('.bar-fill');
    for (var k = 0; k < els.length; k++){ els[k].style.width = (els[k].getAttribute('data-pct') || 0) + '%'; }
  }); });
}
main();
`,
      },
      roles: [
        {
          name: 'Event Manager',
          description: 'Full access to all event management forms.',
          permissions: [
            { packFormId: 'event-registration', permission: 'submit_responses' },
            { packFormId: 'event-registration', permission: 'view_all_responses' },
            { packFormId: 'event-registration', permission: 'edit_responses' },
            { packFormId: 'event-registration', permission: 'delete_responses' },
            { packFormId: 'event-registration', permission: 'export_responses' },
            { packFormId: 'speaker-submission', permission: 'submit_responses' },
            { packFormId: 'speaker-submission', permission: 'view_all_responses' },
            { packFormId: 'speaker-submission', permission: 'edit_responses' },
            { packFormId: 'speaker-submission', permission: 'delete_responses' },
            { packFormId: 'speaker-submission', permission: 'export_responses' },
            { packFormId: 'vendor-application', permission: 'submit_responses' },
            { packFormId: 'vendor-application', permission: 'view_all_responses' },
            { packFormId: 'vendor-application', permission: 'edit_responses' },
            { packFormId: 'vendor-application', permission: 'delete_responses' },
            { packFormId: 'vendor-application', permission: 'export_responses' },
            { packFormId: 'volunteer-signup', permission: 'submit_responses' },
            { packFormId: 'volunteer-signup', permission: 'view_all_responses' },
            { packFormId: 'volunteer-signup', permission: 'edit_responses' },
            { packFormId: 'volunteer-signup', permission: 'delete_responses' },
            { packFormId: 'volunteer-signup', permission: 'export_responses' },
            { packFormId: 'event-incident-log', permission: 'submit_responses' },
            { packFormId: 'event-incident-log', permission: 'view_all_responses' },
            { packFormId: 'event-incident-log', permission: 'edit_responses' },
            { packFormId: 'event-incident-log', permission: 'delete_responses' },
            { packFormId: 'event-incident-log', permission: 'export_responses' },
            { packFormId: 'budget-tracker', permission: 'submit_responses' },
            { packFormId: 'budget-tracker', permission: 'view_all_responses' },
            { packFormId: 'budget-tracker', permission: 'edit_responses' },
            { packFormId: 'budget-tracker', permission: 'delete_responses' },
            { packFormId: 'budget-tracker', permission: 'export_responses' },
            { packFormId: 'event-feedback', permission: 'submit_responses' },
            { packFormId: 'event-feedback', permission: 'view_all_responses' },
            { packFormId: 'event-feedback', permission: 'edit_responses' },
            { packFormId: 'event-feedback', permission: 'delete_responses' },
            { packFormId: 'event-feedback', permission: 'export_responses' },
          ],
        },
        {
          name: 'Coordinator',
          description: 'Event coordinators who manage day-to-day operations.',
          permissions: [
            { packFormId: 'event-registration', permission: 'submit_responses' },
            { packFormId: 'event-registration', permission: 'view_all_responses' },
            { packFormId: 'event-registration', permission: 'edit_responses' },
            { packFormId: 'speaker-submission', permission: 'view_all_responses' },
            { packFormId: 'speaker-submission', permission: 'edit_responses' },
            { packFormId: 'vendor-application', permission: 'view_all_responses' },
            { packFormId: 'vendor-application', permission: 'edit_responses' },
            { packFormId: 'volunteer-signup', permission: 'submit_responses' },
            { packFormId: 'volunteer-signup', permission: 'view_all_responses' },
            { packFormId: 'volunteer-signup', permission: 'edit_responses' },
            { packFormId: 'event-incident-log', permission: 'submit_responses' },
            { packFormId: 'event-incident-log', permission: 'view_all_responses' },
            { packFormId: 'event-incident-log', permission: 'edit_responses' },
            { packFormId: 'budget-tracker', permission: 'submit_responses' },
            { packFormId: 'budget-tracker', permission: 'view_all_responses' },
            { packFormId: 'budget-tracker', permission: 'edit_responses' },
            { packFormId: 'event-feedback', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Attendee',
          description: 'Event attendees who can register and provide feedback.',
          permissions: [
            { packFormId: 'event-registration', permission: 'submit_responses' },
            { packFormId: 'event-registration', permission: 'view_own_responses' },
            { packFormId: 'event-feedback', permission: 'submit_responses' },
            { packFormId: 'event-feedback', permission: 'view_own_responses' },
            { packFormId: 'speaker-submission', permission: 'submit_responses' },
            { packFormId: 'speaker-submission', permission: 'view_own_responses' },
            { packFormId: 'vendor-application', permission: 'submit_responses' },
            { packFormId: 'vendor-application', permission: 'view_own_responses' },
            { packFormId: 'volunteer-signup', permission: 'submit_responses' },
            { packFormId: 'volunteer-signup', permission: 'view_own_responses' },
          ],
        },
      ],
      reports: [
        {
          reportId: 'eh-registrations-by-ticket',
          kind: 'chart',
          name: 'Registrations by ticket type',
          description: 'Breakdown of attendee registrations grouped by ticket category.',
          spec: {
            formId: '@pack:event-registration',
            viz: 'bar',
            groupBy: { field: 'ticket_type' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'eh-registrations-over-time',
          kind: 'chart',
          name: 'Registrations over time',
          description: 'Monthly trend of attendee registrations.',
          spec: {
            formId: '@pack:event-registration',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'eh-avg-rating-by-ticket',
          kind: 'chart',
          name: 'Avg rating by ticket type',
          description: 'Average overall event rating broken down by the attendee ticket type (cross-form join).',
          spec: {
            formId: '@pack:event-feedback',
            viz: 'bar',
            joins: [{ via: 'attendee_record', formId: '@pack:event-registration', type: 'left' }],
            groupBy: { field: '@pack:event-registration::ticket_type' },
            measure: { fn: 'avg', field: 'overall_rating' },
            sort: 'desc',
          },
        },
        {
          reportId: 'eh-budget-by-category',
          kind: 'chart',
          name: 'Budget by category',
          description: 'Total estimated spend broken down by budget category.',
          spec: {
            formId: '@pack:budget-tracker',
            viz: 'bar',
            groupBy: { field: 'category' },
            measure: { fn: 'sum', field: 'estimated_cost' },
            sort: 'desc',
          },
        },
        {
          reportId: 'eh-incidents-by-type',
          kind: 'chart',
          name: 'Incidents by type',
          description: 'Distribution of logged incidents grouped by incident category.',
          spec: {
            formId: '@pack:event-incident-log',
            viz: 'donut',
            groupBy: { field: 'incident_type' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'eh-overview',
          kind: 'document',
          name: 'Event Hub overview',
          description: 'Executive summary covering registrations, satisfaction ratings, incidents, and budget.',
          blocks: [
            {
              kind: 'text',
              title: 'Event Hub overview',
              body: 'This report provides an operational snapshot of event activity: how attendees registered, how satisfied they were, what incidents were logged, and how the budget was allocated across categories.',
            },
            { kind: 'report', reportId: 'eh-registrations-by-ticket', caption: 'Ticket-type breakdown for all registered attendees.' },
            { kind: 'report', reportId: 'eh-avg-rating-by-ticket', caption: 'Average satisfaction score per ticket category, joined from feedback responses.' },
            { kind: 'report', reportId: 'eh-budget-by-category', caption: 'Estimated spend aggregated by budget line-item category.' },
          ],
        },
      ],
    },
  ],
};
