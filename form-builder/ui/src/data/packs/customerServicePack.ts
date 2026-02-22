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
  primaryColor: '#059669',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const customerServicePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'customer-service',
    name: 'Customer Service',
    description:
      'Complete customer service and support workflow covering support tickets, bug reports, feature requests, customer feedback, refund requests, escalation management, and knowledge base entries.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['customer-service', 'support', 'crm', 'tickets', 'feedback', 'helpdesk'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Support Ticket ─────────────────────────────────────────────────
    {
      packFormId: 'support-ticket',
      title: 'Support Ticket',
      icon: 'LifeBuoy',
      description:
        'Submit customer support requests with category, priority, and attachment support.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Submit a Support Request',
          description:
            'Please describe your issue and our support team will respond as soon as possible.',
          required: false,
          properties: {},
        },
        {
          id: 'customer_name',
          type: 'short_text',
          label: 'Your Name',
          required: true,
          properties: { placeholder: 'Full name' },
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
          required: false,
          properties: { placeholder: '(555) 555-5555' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'billing', label: 'Billing', value: 'billing' },
              { id: 'technical', label: 'Technical', value: 'technical' },
              { id: 'general', label: 'General Inquiry', value: 'general' },
              { id: 'account', label: 'Account', value: 'account' },
              { id: 'shipping', label: 'Shipping / Delivery', value: 'shipping' },
              { id: 'other_cat', label: 'Other', value: 'other' },
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
          id: 'subject',
          type: 'short_text',
          label: 'Subject',
          required: true,
          properties: { placeholder: 'Brief summary of your issue' },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Please describe your issue in detail...' },
        },
        {
          id: 'attachments',
          type: 'file_upload',
          label: 'Attachments',
          required: false,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png', '.doc', '.docx'],
            allowMultiple: true,
          },
        },
        {
          id: 'thank_you',
          type: 'thank_you',
          label: 'Ticket Submitted',
          description:
            'Thank you for contacting support. You will receive a confirmation email with your ticket number shortly.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 2. Bug Report ─────────────────────────────────────────────────────
    {
      packFormId: 'bug-report',
      title: 'Bug Report',
      icon: 'Bug',
      description:
        'Report software bugs with steps to reproduce, expected vs. actual behavior, and screenshots.',
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
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
          properties: { placeholder: 'you@example.com' },
        },
        {
          id: 'product',
          type: 'dropdown',
          label: 'Product',
          required: true,
          properties: {
            options: [
              { id: 'web_app', label: 'Web Application', value: 'web_app' },
              { id: 'mobile_ios', label: 'Mobile App (iOS)', value: 'mobile_ios' },
              { id: 'mobile_android', label: 'Mobile App (Android)', value: 'mobile_android' },
              { id: 'desktop', label: 'Desktop Application', value: 'desktop' },
              { id: 'api', label: 'API', value: 'api' },
              { id: 'other_product', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'severity',
          type: 'dropdown',
          label: 'Severity',
          required: true,
          properties: {
            options: [
              { id: 'critical', label: 'Critical (system down)', value: 'critical' },
              { id: 'high', label: 'High (major feature broken)', value: 'high' },
              { id: 'medium', label: 'Medium (workaround available)', value: 'medium' },
              { id: 'low', label: 'Low (cosmetic / minor)', value: 'low' },
            ],
          },
        },
        {
          id: 'bug_title',
          type: 'short_text',
          label: 'Bug Title',
          required: true,
          properties: { placeholder: 'Brief description of the bug' },
        },
        {
          id: 'steps_to_reproduce',
          type: 'long_text',
          label: 'Steps to Reproduce',
          required: true,
          properties: { placeholder: '1. Go to...\n2. Click on...\n3. Observe...' },
        },
        {
          id: 'expected_behavior',
          type: 'long_text',
          label: 'Expected Behavior',
          required: true,
          properties: { placeholder: 'What should happen?' },
        },
        {
          id: 'actual_behavior',
          type: 'long_text',
          label: 'Actual Behavior',
          required: true,
          properties: { placeholder: 'What actually happens?' },
        },
        {
          id: 'browser_os',
          type: 'short_text',
          label: 'Browser / OS',
          required: false,
          properties: { placeholder: 'e.g. Chrome 120, Windows 11' },
        },
        {
          id: 'screenshots',
          type: 'file_upload',
          label: 'Screenshots',
          required: false,
          properties: {
            acceptedFileTypes: ['.jpg', '.png', '.gif'],
            allowMultiple: true,
          },
        },
      ],
    },

    // ── 3. Feature Request ────────────────────────────────────────────────
    {
      packFormId: 'feature-request',
      title: 'Feature Request',
      icon: 'Lightbulb',
      description:
        'Collect and prioritize feature requests from customers and internal teams.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'submitter_name',
          type: 'short_text',
          label: 'Your Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
          properties: { placeholder: 'you@example.com' },
        },
        {
          id: 'feature_title',
          type: 'short_text',
          label: 'Feature Title',
          required: true,
          properties: { placeholder: 'Brief title for the feature' },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Describe the feature you would like to see' },
        },
        {
          id: 'use_case',
          type: 'long_text',
          label: 'Use Case',
          description: 'How would this feature help you?',
          required: true,
          properties: { placeholder: 'Describe the problem this feature would solve' },
        },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: true,
          properties: {
            options: [
              { id: 'nice_to_have', label: 'Nice to Have', value: 'nice_to_have' },
              { id: 'important', label: 'Important', value: 'important' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'impact',
          type: 'scale',
          label: 'Business Impact',
          description: '1 = Low impact, 10 = Transformative',
          required: true,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'additional_context',
          type: 'long_text',
          label: 'Additional Context',
          required: false,
          properties: { placeholder: 'Any other information, links, or mockups' },
        },
      ],
    },

    // ── 4. Customer Feedback Survey ───────────────────────────────────────
    {
      packFormId: 'customer-feedback',
      title: 'Customer Feedback Survey',
      icon: 'Star',
      description:
        'Measure customer satisfaction with NPS scoring, response quality ratings, and open feedback.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'ticket_record',
          type: 'linked_record',
          label: 'Related Support Ticket',
          required: false,
          properties: { targetFormId: '@pack:support-ticket' },
        },
        {
          id: 'overall_satisfaction',
          type: 'rating',
          label: 'Overall Satisfaction',
          required: true,
          properties: { max: 5 },
        },
        {
          id: 'response_time_rating',
          type: 'scale',
          label: 'Response Time',
          description: '1 = Very Slow, 5 = Very Fast',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'resolution_rating',
          type: 'scale',
          label: 'Resolution Quality',
          description: '1 = Not Resolved, 5 = Fully Resolved',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'agent_rating',
          type: 'scale',
          label: 'Support Agent Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'nps_score',
          type: 'scale',
          label: 'How likely are you to recommend us? (NPS)',
          description: '0 = Not at all likely, 10 = Extremely likely',
          required: true,
          properties: { min: 0, max: 10, step: 1 },
        },
        {
          id: 'nps_category',
          type: 'calculated',
          label: 'NPS Category',
          description: 'Detractor (0-6), Passive (7-8), Promoter (9-10)',
          required: false,
          properties: {
            calculationExpression: 'nps_score >= 9 ? "Promoter" : nps_score >= 7 ? "Passive" : "Detractor"',
          },
        },
        {
          id: 'comments',
          type: 'long_text',
          label: 'Comments',
          required: false,
          properties: { placeholder: 'Any additional feedback or comments' },
        },
        {
          id: 'would_recommend',
          type: 'multiple_choice',
          label: 'Would you use our support again?',
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

    // ── 5. Refund / Return Request ────────────────────────────────────────
    {
      packFormId: 'refund-request',
      title: 'Refund / Return Request',
      icon: 'RotateCcw',
      description:
        'Process customer refund and return requests with order verification and receipt uploads.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'customer_name',
          type: 'short_text',
          label: 'Customer Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Email Address',
          required: true,
          properties: { placeholder: 'you@example.com' },
        },
        {
          id: 'order_number',
          type: 'short_text',
          label: 'Order Number',
          required: true,
          properties: { placeholder: 'e.g. ORD-12345' },
        },
        {
          id: 'purchase_date',
          type: 'date',
          label: 'Purchase Date',
          required: true,
          properties: {},
        },
        {
          id: 'items',
          type: 'long_text',
          label: 'Items',
          required: true,
          properties: { placeholder: 'List the items you want to return/refund' },
        },
        {
          id: 'reason',
          type: 'dropdown',
          label: 'Reason',
          required: true,
          properties: {
            options: [
              { id: 'defective', label: 'Defective / Damaged', value: 'defective' },
              { id: 'wrong_item', label: 'Wrong Item Received', value: 'wrong_item' },
              { id: 'not_as_described', label: 'Not as Described', value: 'not_as_described' },
              { id: 'no_longer_needed', label: 'No Longer Needed', value: 'no_longer_needed' },
              { id: 'billing_error', label: 'Billing Error', value: 'billing_error' },
              { id: 'other_reason', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'refund_method',
          type: 'dropdown',
          label: 'Preferred Refund Method',
          required: true,
          properties: {
            options: [
              { id: 'original_payment', label: 'Original Payment Method', value: 'original_payment' },
              { id: 'store_credit', label: 'Store Credit', value: 'store_credit' },
              { id: 'bank_transfer', label: 'Bank Transfer', value: 'bank_transfer' },
              { id: 'check', label: 'Check', value: 'check' },
            ],
          },
        },
        {
          id: 'amount',
          type: 'number',
          label: 'Refund Amount ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'receipt',
          type: 'file_upload',
          label: 'Receipt / Proof of Purchase',
          required: false,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png'],
          },
        },
        {
          id: 'additional_details',
          type: 'long_text',
          label: 'Additional Details',
          required: false,
          properties: { placeholder: 'Any additional context for your refund request' },
        },
      ],
    },

    // ── 6. Escalation Form ────────────────────────────────────────────────
    {
      packFormId: 'escalation-form',
      title: 'Escalation Form',
      icon: 'ArrowUpCircle',
      description:
        'Escalate unresolved support tickets to senior staff with urgency and resolution tracking.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'ticket_record',
          type: 'linked_record',
          label: 'Original Support Ticket',
          required: true,
          properties: { targetFormId: '@pack:support-ticket' },
        },
        {
          id: 'escalation_reason',
          type: 'dropdown',
          label: 'Escalation Reason',
          required: true,
          properties: {
            options: [
              { id: 'sla_breach', label: 'SLA Breach', value: 'sla_breach' },
              { id: 'customer_dissatisfied', label: 'Customer Dissatisfied', value: 'customer_dissatisfied' },
              { id: 'complex_issue', label: 'Complex Technical Issue', value: 'complex_issue' },
              { id: 'repeated_contact', label: 'Repeated Contact', value: 'repeated_contact' },
              { id: 'legal_compliance', label: 'Legal / Compliance', value: 'legal_compliance' },
              { id: 'vip_customer', label: 'VIP Customer', value: 'vip_customer' },
              { id: 'other_esc', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'current_status',
          type: 'long_text',
          label: 'Current Status',
          required: true,
          properties: { placeholder: 'Describe the current state of the issue and what has been tried' },
        },
        {
          id: 'desired_outcome',
          type: 'long_text',
          label: 'Desired Outcome',
          required: true,
          properties: { placeholder: 'What resolution is the customer seeking?' },
        },
        {
          id: 'urgency',
          type: 'dropdown',
          label: 'Urgency',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low (within 48h)', value: 'low' },
              { id: 'medium', label: 'Medium (within 24h)', value: 'medium' },
              { id: 'high', label: 'High (within 4h)', value: 'high' },
              { id: 'critical', label: 'Critical (immediate)', value: 'critical' },
            ],
          },
        },
        {
          id: 'escalated_to',
          type: 'short_text',
          label: 'Escalated To',
          required: true,
          properties: { placeholder: 'Name or team receiving the escalation' },
        },
        {
          id: 'escalated_by',
          type: 'short_text',
          label: 'Escalated By',
          required: true,
          properties: { placeholder: 'Your name' },
        },
        {
          id: 'escalation_date',
          type: 'date',
          label: 'Escalation Date',
          required: true,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Additional Notes',
          required: false,
          properties: { placeholder: 'Any additional context or history' },
        },
      ],
    },

    // ── 7. Knowledge Base Entry ───────────────────────────────────────────
    {
      packFormId: 'knowledge-base-entry',
      title: 'Knowledge Base Entry',
      icon: 'BookOpen',
      description:
        'Create and maintain knowledge base articles for self-service support and internal reference.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'title',
          type: 'short_text',
          label: 'Article Title',
          required: true,
          properties: { placeholder: 'Clear, descriptive title' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'getting_started', label: 'Getting Started', value: 'getting_started' },
              { id: 'account', label: 'Account Management', value: 'account' },
              { id: 'billing', label: 'Billing & Payments', value: 'billing' },
              { id: 'technical', label: 'Technical', value: 'technical' },
              { id: 'troubleshooting', label: 'Troubleshooting', value: 'troubleshooting' },
              { id: 'how_to', label: 'How-To Guide', value: 'how_to' },
              { id: 'faq', label: 'FAQ', value: 'faq' },
              { id: 'policy', label: 'Policy', value: 'policy' },
            ],
          },
        },
        {
          id: 'question',
          type: 'short_text',
          label: 'Question',
          description: 'The question this article answers.',
          required: true,
          properties: { placeholder: 'e.g. How do I reset my password?' },
        },
        {
          id: 'answer',
          type: 'long_text',
          label: 'Answer / Content',
          required: true,
          properties: { placeholder: 'Write the full article content here...' },
        },
        {
          id: 'keywords',
          type: 'short_text',
          label: 'Keywords',
          description: 'Comma-separated keywords for search.',
          required: false,
          properties: { placeholder: 'e.g. password, reset, login, account' },
        },
        {
          id: 'related_articles',
          type: 'short_text',
          label: 'Related Articles',
          required: false,
          properties: { placeholder: 'Titles or IDs of related KB articles' },
        },
        {
          id: 'author',
          type: 'short_text',
          label: 'Author',
          required: true,
          properties: { placeholder: 'Your name' },
        },
        {
          id: 'last_reviewed',
          type: 'date',
          label: 'Last Reviewed',
          required: true,
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
              { id: 'published', label: 'Published', value: 'published' },
              { id: 'archived', label: 'Archived', value: 'archived' },
              { id: 'needs_review', label: 'Needs Review', value: 'needs_review' },
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
      packAppId: 'service-desk',
      name: 'Service Desk',
      description:
        'Centralised customer service platform covering support tickets, bug reports, feature requests, escalation management, refund processing, customer feedback, and knowledge base.',
      settings: {},
      theme: {
        primaryColor: '#059669',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'support-ticket', displayName: 'Support Tickets', sortOrder: 1, isVisible: true },
        { packFormId: 'bug-report', displayName: 'Bug Reports', sortOrder: 2, isVisible: true },
        { packFormId: 'feature-request', displayName: 'Feature Requests', sortOrder: 3, isVisible: true },
        { packFormId: 'escalation-form', displayName: 'Escalations', sortOrder: 4, isVisible: true },
        { packFormId: 'refund-request', displayName: 'Refund Requests', sortOrder: 5, isVisible: true },
        { packFormId: 'customer-feedback', displayName: 'Customer Feedback', sortOrder: 6, isVisible: true },
        { packFormId: 'knowledge-base-entry', displayName: 'Knowledge Base', sortOrder: 7, isVisible: true },
      ],
      roles: [
        {
          name: 'Support Manager',
          description: 'Full access to all customer service forms.',
          permissions: [
            { packFormId: 'support-ticket', permission: 'submit_responses' },
            { packFormId: 'support-ticket', permission: 'view_all_responses' },
            { packFormId: 'support-ticket', permission: 'edit_responses' },
            { packFormId: 'support-ticket', permission: 'delete_responses' },
            { packFormId: 'support-ticket', permission: 'export_responses' },
            { packFormId: 'bug-report', permission: 'submit_responses' },
            { packFormId: 'bug-report', permission: 'view_all_responses' },
            { packFormId: 'bug-report', permission: 'edit_responses' },
            { packFormId: 'bug-report', permission: 'delete_responses' },
            { packFormId: 'bug-report', permission: 'export_responses' },
            { packFormId: 'feature-request', permission: 'submit_responses' },
            { packFormId: 'feature-request', permission: 'view_all_responses' },
            { packFormId: 'feature-request', permission: 'edit_responses' },
            { packFormId: 'feature-request', permission: 'delete_responses' },
            { packFormId: 'feature-request', permission: 'export_responses' },
            { packFormId: 'escalation-form', permission: 'submit_responses' },
            { packFormId: 'escalation-form', permission: 'view_all_responses' },
            { packFormId: 'escalation-form', permission: 'edit_responses' },
            { packFormId: 'escalation-form', permission: 'delete_responses' },
            { packFormId: 'escalation-form', permission: 'export_responses' },
            { packFormId: 'refund-request', permission: 'submit_responses' },
            { packFormId: 'refund-request', permission: 'view_all_responses' },
            { packFormId: 'refund-request', permission: 'edit_responses' },
            { packFormId: 'refund-request', permission: 'delete_responses' },
            { packFormId: 'refund-request', permission: 'export_responses' },
            { packFormId: 'customer-feedback', permission: 'submit_responses' },
            { packFormId: 'customer-feedback', permission: 'view_all_responses' },
            { packFormId: 'customer-feedback', permission: 'edit_responses' },
            { packFormId: 'customer-feedback', permission: 'delete_responses' },
            { packFormId: 'customer-feedback', permission: 'export_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'submit_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'view_all_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'edit_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'delete_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'export_responses' },
          ],
        },
        {
          name: 'Support Agent',
          description: 'Support agents who handle tickets, escalations, and knowledge base.',
          permissions: [
            { packFormId: 'support-ticket', permission: 'submit_responses' },
            { packFormId: 'support-ticket', permission: 'view_all_responses' },
            { packFormId: 'support-ticket', permission: 'edit_responses' },
            { packFormId: 'bug-report', permission: 'view_all_responses' },
            { packFormId: 'bug-report', permission: 'edit_responses' },
            { packFormId: 'feature-request', permission: 'view_all_responses' },
            { packFormId: 'feature-request', permission: 'edit_responses' },
            { packFormId: 'escalation-form', permission: 'submit_responses' },
            { packFormId: 'escalation-form', permission: 'view_all_responses' },
            { packFormId: 'escalation-form', permission: 'edit_responses' },
            { packFormId: 'refund-request', permission: 'submit_responses' },
            { packFormId: 'refund-request', permission: 'view_all_responses' },
            { packFormId: 'refund-request', permission: 'edit_responses' },
            { packFormId: 'customer-feedback', permission: 'view_all_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'submit_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'view_all_responses' },
            { packFormId: 'knowledge-base-entry', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Customer',
          description: 'Customers who can submit tickets, reports, and feedback.',
          permissions: [
            { packFormId: 'support-ticket', permission: 'submit_responses' },
            { packFormId: 'support-ticket', permission: 'view_own_responses' },
            { packFormId: 'bug-report', permission: 'submit_responses' },
            { packFormId: 'bug-report', permission: 'view_own_responses' },
            { packFormId: 'feature-request', permission: 'submit_responses' },
            { packFormId: 'feature-request', permission: 'view_own_responses' },
            { packFormId: 'refund-request', permission: 'submit_responses' },
            { packFormId: 'refund-request', permission: 'view_own_responses' },
            { packFormId: 'customer-feedback', permission: 'submit_responses' },
            { packFormId: 'customer-feedback', permission: 'view_own_responses' },
          ],
        },
      ],
    },
  ],
};
