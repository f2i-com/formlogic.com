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
  primaryColor: '#7c3aed',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const hrPeoplePack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'hr-people',
    name: 'HR & People Management',
    description:
      'Complete human resources workflow covering recruitment, onboarding, leave management, performance reviews, expense claims, training requests, and exit interviews.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['hr', 'people', 'recruitment', 'onboarding', 'leave', 'performance', 'expenses'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Job Application ────────────────────────────────────────────────
    {
      packFormId: 'job-application',
      title: 'Job Application',
      icon: 'FileText',
      description:
        'Collect candidate information, resume, and availability for open positions.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Job Application',
          description:
            'Thank you for your interest in joining our team. Please complete the following form to apply for a position.',
          required: false,
          properties: {},
        },
        {
          id: 'first_name',
          type: 'short_text',
          label: 'First Name',
          required: true,
          properties: { placeholder: 'Enter first name' },
        },
        {
          id: 'last_name',
          type: 'short_text',
          label: 'Last Name',
          required: true,
          properties: { placeholder: 'Enter last name' },
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
          id: 'position',
          type: 'dropdown',
          label: 'Position Applied For',
          required: true,
          properties: {
            options: [
              { id: 'engineering', label: 'Engineering', value: 'engineering' },
              { id: 'design', label: 'Design', value: 'design' },
              { id: 'marketing', label: 'Marketing', value: 'marketing' },
              { id: 'sales', label: 'Sales', value: 'sales' },
              { id: 'operations', label: 'Operations', value: 'operations' },
              { id: 'finance', label: 'Finance', value: 'finance' },
              { id: 'hr', label: 'Human Resources', value: 'hr' },
              { id: 'other_pos', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'resume',
          type: 'file_upload',
          label: 'Resume / CV',
          required: true,
          properties: {
            acceptedFileTypes: ['.pdf', '.doc', '.docx'],
          },
        },
        {
          id: 'cover_letter',
          type: 'long_text',
          label: 'Cover Letter',
          required: false,
          properties: { placeholder: 'Tell us why you are a great fit for this role...' },
        },
        {
          id: 'availability_date',
          type: 'date',
          label: 'Earliest Available Start Date',
          required: true,
          properties: {},
        },
        {
          id: 'salary_expectations',
          type: 'number',
          label: 'Salary Expectations ($)',
          required: false,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'referral_source',
          type: 'dropdown',
          label: 'How did you hear about us?',
          required: false,
          properties: {
            options: [
              { id: 'job_board', label: 'Job Board', value: 'job_board' },
              { id: 'linkedin', label: 'LinkedIn', value: 'linkedin' },
              { id: 'referral', label: 'Employee Referral', value: 'referral' },
              { id: 'website', label: 'Company Website', value: 'website' },
              { id: 'other_ref', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'thank_you',
          type: 'thank_you',
          label: 'Application Submitted',
          description:
            'Thank you for applying. Our team will review your application and get back to you shortly.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 2. Interview Scorecard ────────────────────────────────────────────
    {
      packFormId: 'interview-scorecard',
      title: 'Interview Scorecard',
      icon: 'ClipboardCheck',
      description:
        'Structured interview evaluation form for consistent and fair candidate assessment.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'candidate_record',
          type: 'linked_record',
          label: 'Candidate',
          required: true,
          properties: { targetFormId: '@pack:job-application' },
        },
        {
          id: 'interviewer_name',
          type: 'short_text',
          label: 'Interviewer Name',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'interview_date',
          type: 'date',
          label: 'Interview Date',
          required: true,
          properties: {},
        },
        {
          id: 'interview_type',
          type: 'dropdown',
          label: 'Interview Type',
          required: true,
          properties: {
            options: [
              { id: 'phone_screen', label: 'Phone Screen', value: 'phone_screen' },
              { id: 'technical', label: 'Technical', value: 'technical' },
              { id: 'behavioral', label: 'Behavioral', value: 'behavioral' },
              { id: 'panel', label: 'Panel', value: 'panel' },
              { id: 'final', label: 'Final', value: 'final' },
            ],
          },
        },
        {
          id: 'technical_skills',
          type: 'scale',
          label: 'Technical Skills',
          description: '1 = Poor, 5 = Exceptional',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'communication',
          type: 'scale',
          label: 'Communication',
          description: '1 = Poor, 5 = Exceptional',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'culture_fit',
          type: 'scale',
          label: 'Culture Fit',
          description: '1 = Poor, 5 = Exceptional',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'problem_solving',
          type: 'scale',
          label: 'Problem Solving',
          description: '1 = Poor, 5 = Exceptional',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'overall_score',
          type: 'calculated',
          label: 'Overall Score',
          description: 'Average of all rating dimensions (1-5).',
          required: false,
          properties: {
            calculationExpression: 'Math.round(((technical_skills + communication + culture_fit + problem_solving) / 4) * 10) / 10',
          },
        },
        {
          id: 'overall_recommendation',
          type: 'dropdown',
          label: 'Overall Recommendation',
          required: true,
          properties: {
            options: [
              { id: 'strong_hire', label: 'Strong Hire', value: 'strong_hire' },
              { id: 'hire', label: 'Hire', value: 'hire' },
              { id: 'no_hire', label: 'No Hire', value: 'no_hire' },
              { id: 'strong_no_hire', label: 'Strong No Hire', value: 'strong_no_hire' },
            ],
          },
        },
        {
          id: 'strengths',
          type: 'long_text',
          label: 'Strengths',
          required: false,
          properties: { placeholder: 'Key strengths observed during the interview' },
        },
        {
          id: 'concerns',
          type: 'long_text',
          label: 'Concerns',
          required: false,
          properties: { placeholder: 'Any concerns or areas of weakness' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Additional Notes',
          required: false,
          properties: { placeholder: 'Any other observations or comments' },
        },
      ],
    },

    // ── 3. Employee Onboarding ────────────────────────────────────────────
    {
      packFormId: 'employee-onboarding',
      title: 'Employee Onboarding Checklist',
      icon: 'UserPlus',
      description:
        'Track new employee onboarding tasks including IT setup, policy acknowledgement, and emergency contacts.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'email',
          type: 'email',
          label: 'Work Email',
          required: true,
          properties: { placeholder: 'employee@company.com' },
        },
        {
          id: 'start_date',
          type: 'date',
          label: 'Start Date',
          required: true,
          properties: {},
        },
        {
          id: 'department',
          type: 'dropdown',
          label: 'Department',
          required: true,
          properties: {
            options: [
              { id: 'engineering', label: 'Engineering', value: 'engineering' },
              { id: 'design', label: 'Design', value: 'design' },
              { id: 'marketing', label: 'Marketing', value: 'marketing' },
              { id: 'sales', label: 'Sales', value: 'sales' },
              { id: 'operations', label: 'Operations', value: 'operations' },
              { id: 'finance', label: 'Finance', value: 'finance' },
              { id: 'hr', label: 'Human Resources', value: 'hr' },
              { id: 'other_dept', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'manager',
          type: 'short_text',
          label: 'Manager',
          required: true,
          properties: { placeholder: 'Direct manager name' },
        },
        {
          id: 'it_setup',
          type: 'checkboxes',
          label: 'IT Setup',
          required: false,
          properties: {
            options: [
              { id: 'laptop', label: 'Laptop / Workstation', value: 'laptop' },
              { id: 'email_account', label: 'Email Account', value: 'email_account' },
              { id: 'vpn', label: 'VPN Access', value: 'vpn' },
              { id: 'software', label: 'Required Software', value: 'software' },
              { id: 'badge', label: 'Access Badge / Key Card', value: 'badge' },
              { id: 'phone_setup', label: 'Phone / Extension', value: 'phone' },
            ],
          },
        },
        {
          id: 'policy_acknowledgement',
          type: 'checkboxes',
          label: 'Policy Acknowledgement',
          required: true,
          properties: {
            options: [
              { id: 'handbook', label: 'Employee Handbook', value: 'handbook' },
              { id: 'code_of_conduct', label: 'Code of Conduct', value: 'code_of_conduct' },
              { id: 'data_privacy', label: 'Data Privacy Policy', value: 'data_privacy' },
              { id: 'safety', label: 'Workplace Safety Policy', value: 'safety' },
              { id: 'anti_harassment', label: 'Anti-Harassment Policy', value: 'anti_harassment' },
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
          id: 'emergency_contact_relationship',
          type: 'short_text',
          label: 'Emergency Contact Relationship',
          required: true,
          properties: { placeholder: 'e.g. Spouse, Parent, Sibling' },
        },
        {
          id: 'bank_account',
          type: 'short_text',
          label: 'Bank Account (for payroll)',
          required: false,
          properties: { placeholder: 'Account number for direct deposit' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Any additional onboarding notes' },
        },
      ],
    },

    // ── 4. Leave Request ──────────────────────────────────────────────────
    {
      packFormId: 'leave-request',
      title: 'Leave Request',
      icon: 'Calendar',
      description:
        'Submit and track employee leave requests with automatic day calculation.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'employee_email',
          type: 'email',
          label: 'Email',
          required: true,
          properties: { placeholder: 'you@company.com' },
        },
        {
          id: 'leave_type',
          type: 'dropdown',
          label: 'Leave Type',
          required: true,
          properties: {
            options: [
              { id: 'annual', label: 'Annual Leave', value: 'annual' },
              { id: 'sick', label: 'Sick Leave', value: 'sick' },
              { id: 'personal', label: 'Personal Leave', value: 'personal' },
              { id: 'parental', label: 'Parental Leave', value: 'parental' },
              { id: 'bereavement', label: 'Bereavement', value: 'bereavement' },
              { id: 'unpaid', label: 'Unpaid Leave', value: 'unpaid' },
            ],
          },
        },
        {
          id: 'start_date',
          type: 'date',
          label: 'Start Date',
          required: true,
          properties: {},
        },
        {
          id: 'end_date',
          type: 'date',
          label: 'End Date',
          required: true,
          properties: {},
        },
        {
          id: 'total_days',
          type: 'number',
          label: 'Total Days',
          description: 'Enter the number of business days requested.',
          required: true,
          properties: { placeholder: '0', min: 0.5 },
        },
        {
          id: 'reason',
          type: 'long_text',
          label: 'Reason',
          required: false,
          properties: { placeholder: 'Reason for leave (optional)' },
        },
        {
          id: 'manager_name',
          type: 'short_text',
          label: 'Manager',
          required: true,
          properties: { placeholder: 'Your manager\'s name' },
        },
        {
          id: 'medical_certificate',
          type: 'file_upload',
          label: 'Medical Certificate',
          description: 'Required for sick leave exceeding 2 consecutive days.',
          required: false,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png'],
          },
          conditionalLogic: {
            expression: 'leave_type == "sick"',
            action: 'show',
          },
        },
      ],
    },

    // ── 5. Performance Review ─────────────────────────────────────────────
    {
      packFormId: 'performance-review',
      title: 'Performance Review',
      icon: 'TrendingUp',
      description:
        'Conduct structured performance evaluations with goal tracking and development planning.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_record',
          type: 'linked_record',
          label: 'Employee',
          required: true,
          properties: { targetFormId: '@pack:employee-onboarding' },
        },
        {
          id: 'review_period',
          type: 'dropdown',
          label: 'Review Period',
          required: true,
          properties: {
            options: [
              { id: 'q1', label: 'Q1 (Jan-Mar)', value: 'q1' },
              { id: 'q2', label: 'Q2 (Apr-Jun)', value: 'q2' },
              { id: 'q3', label: 'Q3 (Jul-Sep)', value: 'q3' },
              { id: 'q4', label: 'Q4 (Oct-Dec)', value: 'q4' },
              { id: 'annual', label: 'Annual', value: 'annual' },
              { id: 'probation', label: 'Probation', value: 'probation' },
            ],
          },
        },
        {
          id: 'reviewer_name',
          type: 'short_text',
          label: 'Reviewer Name',
          required: true,
          properties: { placeholder: 'Manager / reviewer name' },
        },
        {
          id: 'review_date',
          type: 'date',
          label: 'Review Date',
          required: true,
          properties: {},
        },
        {
          id: 'job_knowledge',
          type: 'scale',
          label: 'Job Knowledge',
          description: '1 = Below Expectations, 3 = Meets Expectations, 5 = Exceeds Expectations',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'quality_of_work',
          type: 'scale',
          label: 'Quality of Work',
          description: '1 = Below Expectations, 3 = Meets Expectations, 5 = Exceeds Expectations',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'productivity',
          type: 'scale',
          label: 'Productivity',
          description: '1 = Below Expectations, 3 = Meets Expectations, 5 = Exceeds Expectations',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'teamwork',
          type: 'scale',
          label: 'Teamwork & Collaboration',
          description: '1 = Below Expectations, 3 = Meets Expectations, 5 = Exceeds Expectations',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'initiative',
          type: 'scale',
          label: 'Initiative & Leadership',
          description: '1 = Below Expectations, 3 = Meets Expectations, 5 = Exceeds Expectations',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'overall_rating',
          type: 'calculated',
          label: 'Overall Rating',
          description: 'Average of all performance dimensions (1-5).',
          required: false,
          properties: {
            calculationExpression: 'Math.round(((job_knowledge + quality_of_work + productivity + teamwork + initiative) / 5) * 10) / 10',
          },
        },
        {
          id: 'goals_met',
          type: 'dropdown',
          label: 'Goals Met',
          required: true,
          properties: {
            options: [
              { id: 'exceeded', label: 'Exceeded All Goals', value: 'exceeded' },
              { id: 'met', label: 'Met All Goals', value: 'met' },
              { id: 'partially_met', label: 'Partially Met Goals', value: 'partially_met' },
              { id: 'not_met', label: 'Did Not Meet Goals', value: 'not_met' },
            ],
          },
        },
        {
          id: 'strengths',
          type: 'long_text',
          label: 'Strengths',
          required: false,
          properties: { placeholder: 'Key strengths demonstrated during the review period' },
        },
        {
          id: 'areas_for_improvement',
          type: 'long_text',
          label: 'Areas for Improvement',
          required: false,
          properties: { placeholder: 'Areas where the employee can develop further' },
        },
        {
          id: 'goals_next_period',
          type: 'long_text',
          label: 'Goals for Next Period',
          required: false,
          properties: { placeholder: 'Specific goals and objectives for the next review period' },
        },
      ],
    },

    // ── 6. Exit Interview ─────────────────────────────────────────────────
    {
      packFormId: 'exit-interview',
      title: 'Exit Interview',
      icon: 'LogOut',
      description:
        'Gather feedback from departing employees to improve retention and workplace culture.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'department',
          type: 'dropdown',
          label: 'Department',
          required: true,
          properties: {
            options: [
              { id: 'engineering', label: 'Engineering', value: 'engineering' },
              { id: 'design', label: 'Design', value: 'design' },
              { id: 'marketing', label: 'Marketing', value: 'marketing' },
              { id: 'sales', label: 'Sales', value: 'sales' },
              { id: 'operations', label: 'Operations', value: 'operations' },
              { id: 'finance', label: 'Finance', value: 'finance' },
              { id: 'hr', label: 'Human Resources', value: 'hr' },
              { id: 'other_dept', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'last_day',
          type: 'date',
          label: 'Last Day of Employment',
          required: true,
          properties: {},
        },
        {
          id: 'tenure_years',
          type: 'number',
          label: 'Years of Service',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'reason_for_leaving',
          type: 'dropdown',
          label: 'Primary Reason for Leaving',
          required: true,
          properties: {
            options: [
              { id: 'new_opportunity', label: 'New Opportunity', value: 'new_opportunity' },
              { id: 'compensation', label: 'Compensation', value: 'compensation' },
              { id: 'career_growth', label: 'Career Growth', value: 'career_growth' },
              { id: 'work_life_balance', label: 'Work-Life Balance', value: 'work_life_balance' },
              { id: 'management', label: 'Management', value: 'management' },
              { id: 'relocation', label: 'Relocation', value: 'relocation' },
              { id: 'retirement', label: 'Retirement', value: 'retirement' },
              { id: 'personal', label: 'Personal Reasons', value: 'personal' },
              { id: 'other_reason', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'overall_satisfaction',
          type: 'scale',
          label: 'Overall Satisfaction',
          description: '1 = Very Dissatisfied, 5 = Very Satisfied',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'management_rating',
          type: 'scale',
          label: 'Management Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'culture_rating',
          type: 'scale',
          label: 'Company Culture Rating',
          description: '1 = Very Poor, 5 = Excellent',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'what_enjoyed',
          type: 'long_text',
          label: 'What did you enjoy most about working here?',
          required: false,
          properties: { placeholder: 'Share what you valued' },
        },
        {
          id: 'suggestions',
          type: 'long_text',
          label: 'Suggestions for Improvement',
          required: false,
          properties: { placeholder: 'What could the company do better?' },
        },
        {
          id: 'would_return',
          type: 'multiple_choice',
          label: 'Would you consider returning in the future?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'maybe', label: 'Maybe', value: 'maybe' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'would_recommend',
          type: 'multiple_choice',
          label: 'Would you recommend this company to others?',
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

    // ── 7. Expense Claim ──────────────────────────────────────────────────
    {
      packFormId: 'expense-claim',
      title: 'Expense Claim',
      icon: 'Receipt',
      description:
        'Submit expense reimbursement claims with receipt uploads and automatic total calculation.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'employee_email',
          type: 'email',
          label: 'Email',
          required: true,
          properties: { placeholder: 'you@company.com' },
        },
        {
          id: 'expense_date',
          type: 'date',
          label: 'Expense Date',
          required: true,
          properties: {},
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Expense Category',
          required: true,
          properties: {
            options: [
              { id: 'travel', label: 'Travel', value: 'travel' },
              { id: 'meals', label: 'Meals & Entertainment', value: 'meals' },
              { id: 'accommodation', label: 'Accommodation', value: 'accommodation' },
              { id: 'supplies', label: 'Office Supplies', value: 'supplies' },
              { id: 'training', label: 'Training & Development', value: 'training' },
              { id: 'technology', label: 'Technology / Software', value: 'technology' },
              { id: 'client', label: 'Client Entertainment', value: 'client' },
              { id: 'other_cat', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'description',
          type: 'short_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Brief description of the expense' },
        },
        {
          id: 'amount',
          type: 'number',
          label: 'Amount ($)',
          required: true,
          properties: { placeholder: '0.00', min: 0 },
        },
        {
          id: 'receipt',
          type: 'file_upload',
          label: 'Receipt',
          required: true,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png'],
          },
        },
        {
          id: 'project_code',
          type: 'short_text',
          label: 'Project / Cost Centre Code',
          required: false,
          properties: { placeholder: 'e.g. PRJ-001' },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Additional Notes',
          required: false,
          properties: { placeholder: 'Any additional context for this expense' },
        },
      ],
    },

    // ── 8. Training Request ───────────────────────────────────────────────
    {
      packFormId: 'training-request',
      title: 'Training Request',
      icon: 'GraduationCap',
      description:
        'Request approval for professional development courses, certifications, and training programs.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'employee_email',
          type: 'email',
          label: 'Email',
          required: true,
          properties: { placeholder: 'you@company.com' },
        },
        {
          id: 'training_type',
          type: 'dropdown',
          label: 'Training Type',
          required: true,
          properties: {
            options: [
              { id: 'course', label: 'Online Course', value: 'course' },
              { id: 'certification', label: 'Certification', value: 'certification' },
              { id: 'conference', label: 'Conference', value: 'conference' },
              { id: 'workshop', label: 'Workshop', value: 'workshop' },
              { id: 'degree', label: 'Degree Program', value: 'degree' },
              { id: 'other_tt', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'course_name',
          type: 'short_text',
          label: 'Course / Program Name',
          required: true,
          properties: { placeholder: 'Name of the training program' },
        },
        {
          id: 'provider',
          type: 'short_text',
          label: 'Training Provider',
          required: true,
          properties: { placeholder: 'e.g. Coursera, AWS, University' },
        },
        {
          id: 'start_date',
          type: 'date',
          label: 'Start Date',
          required: true,
          properties: {},
        },
        {
          id: 'end_date',
          type: 'date',
          label: 'End Date',
          required: false,
          properties: {},
        },
        {
          id: 'cost',
          type: 'number',
          label: 'Estimated Cost ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'justification',
          type: 'long_text',
          label: 'Business Justification',
          description: 'Explain how this training will benefit your role and the company.',
          required: true,
          properties: { placeholder: 'Why is this training important?' },
        },
        {
          id: 'manager_name',
          type: 'short_text',
          label: 'Manager',
          required: true,
          properties: { placeholder: 'Your manager\'s name for approval' },
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    {
      packAppId: 'people-hub',
      name: 'People Hub',
      description:
        'Centralised HR management platform covering recruitment, employee onboarding, leave management, performance reviews, expenses, training, and exit processes.',
      settings: {},
      theme: {
        primaryColor: '#7c3aed',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'job-application', displayName: 'Job Applications', sortOrder: 1, isVisible: true },
        { packFormId: 'interview-scorecard', displayName: 'Interview Scorecards', sortOrder: 2, isVisible: true },
        { packFormId: 'employee-onboarding', displayName: 'Employee Onboarding', sortOrder: 3, isVisible: true },
        { packFormId: 'leave-request', displayName: 'Leave Requests', sortOrder: 4, isVisible: true },
        { packFormId: 'performance-review', displayName: 'Performance Reviews', sortOrder: 5, isVisible: true },
        { packFormId: 'expense-claim', displayName: 'Expense Claims', sortOrder: 6, isVisible: true },
        { packFormId: 'training-request', displayName: 'Training Requests', sortOrder: 7, isVisible: true },
        { packFormId: 'exit-interview', displayName: 'Exit Interviews', sortOrder: 8, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading your people dashboard…</div></div></div>`,
        css: `
*{box-sizing:border-box;margin:0;padding:0}
#app{min-height:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;
  background:radial-gradient(1200px 600px at 12% -12%,rgba(124,58,237,.20),transparent 60%),radial-gradient(900px 520px at 112% 8%,rgba(34,211,238,.12),transparent 55%),#0f172a}
.wrap{max-width:1140px;margin:0 auto;padding:28px 24px 52px}
.empty{padding:72px 20px;text-align:center;color:#94a3b8;font-size:14px}
.hd{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:26px;flex-wrap:wrap}
.hd-l{display:flex;align-items:center;gap:14px}
.logo{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;color:#fff;
  background:linear-gradient(135deg,#7c3aed,#a855f7);box-shadow:0 8px 24px rgba(124,58,237,.42)}
.logo svg{width:25px;height:25px}
.hd h1{font-size:22px;font-weight:700;letter-spacing:-.02em;color:#f8fafc}
.sub{font-size:13px;color:#94a3b8;margin-top:2px}
.btn{border:0;cursor:pointer;font:inherit;font-weight:600;border-radius:10px;padding:11px 18px;font-size:14px;transition:transform .12s ease,box-shadow .2s ease}
.btn.primary{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;box-shadow:0 6px 18px rgba(124,58,237,.42)}
.btn.primary:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(124,58,237,.52)}
.card{background:rgba(30,41,59,.6);border:1px solid rgba(148,163,184,.14);border-radius:16px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:20px}
.stat{padding:18px}
.stat-ic{width:34px;height:34px;margin-bottom:11px}
.stat-ic svg{width:27px;height:27px}
.stat-v{font-size:27px;font-weight:750;color:#f8fafc;letter-spacing:-.02em;line-height:1}
.stat-l{font-size:13px;color:#cbd5e1;margin-top:7px;font-weight:600}
.stat-s{font-size:11.5px;color:#8598ad;margin-top:3px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.panel{padding:18px 20px 20px}
.panel-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:10px}
.panel-h h2{font-size:14px;font-weight:700;color:#f1f5f9;letter-spacing:-.01em}
.link{background:none;border:0;color:#a78bfa;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;padding:0}
.link:hover{color:#c4b5fd;text-decoration:underline}
.bars{display:flex;flex-direction:column;gap:11px}
.bar-row{display:grid;grid-template-columns:112px 1fr 52px;align-items:center;gap:12px}
.bar-name{font-size:12.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{height:9px;background:rgba(148,163,184,.14);border-radius:6px;overflow:hidden}
.bar-fill{height:100%;width:0;border-radius:6px;transition:width .95s cubic-bezier(.22,1,.36,1)}
.bar-val{font-size:12.5px;color:#e2e8f0;font-weight:600;text-align:right}
.list{list-style:none;display:flex;flex-direction:column}
.li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.10)}
.li:last-child{border-bottom:0}
.li-main{display:flex;align-items:center;gap:9px;min-width:0}
.li-title{font-size:13.5px;color:#f1f5f9;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:rgba(124,58,237,.18);color:#c4b5fd;white-space:nowrap}
.li-date{font-size:12px;color:#94a3b8;white-space:nowrap}
.empty-sm{padding:24px 6px;text-align:center;color:#8598ad;font-size:13px}
.qa{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
.qa-btn{display:flex;flex-direction:column;align-items:center;gap:9px;padding:16px 8px;cursor:pointer;font:inherit;
  background:rgba(30,41,59,.5);border:1px solid rgba(148,163,184,.14);border-radius:14px;color:#cbd5e1;font-size:12.5px;font-weight:600;text-align:center;transition:transform .12s ease,border-color .2s ease,background .2s ease}
.qa-btn:hover{transform:translateY(-2px);border-color:rgba(124,58,237,.5);background:rgba(124,58,237,.10);color:#f1f5f9}
.qa-ic{width:22px;height:22px}
.qa-ic svg{width:22px;height:22px}
@media (max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.panels{grid-template-columns:1fr}.qa{grid-template-columns:repeat(3,1fr)}}
@media (max-width:520px){.stats{grid-template-columns:1fr}.qa{grid-template-columns:repeat(2,1fr)}}
`,
        js: `
var FL = window.FormLogic;
var PRIMARY = '#7c3aed', ACCENT = '#22d3ee';
var PALETTE = ['#7c3aed','#a855f7','#22d3ee','#38bdf8','#34d399','#f59e0b','#f472b6','#fb7185'];
var IC = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
};
function h(s){ return FL.escapeHtml(s == null ? '' : String(s)); }
function findForm(ctx, name){
  var t = String(name).toLowerCase();
  for (var i=0;i<ctx.forms.length;i++){ if (String(ctx.forms[i].displayName||'').toLowerCase()===t) return ctx.forms[i]; }
  return null;
}
function labelMap(form, fieldId){
  var m = {}; if(!form) return m;
  for (var i=0;i<form.fields.length;i++){ var f=form.fields[i];
    if(f.id===fieldId && f.properties && f.properties.options){
      for (var j=0;j<f.properties.options.length;j++){ m[f.properties.options[j].value]=f.properties.options[j].label; } } }
  return m;
}
function fmtDate(v){
  if(!v) return '';
  var d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}
function money(n){ return '$' + (Number(n)||0).toLocaleString(undefined, { maximumFractionDigits:0 }); }
function num(n){ return (Number(n)||0).toLocaleString(); }
function monthCount(records){
  var now=new Date(), m=now.getMonth(), y=now.getFullYear(), c=0;
  for (var i=0;i<records.length;i++){ var d=new Date(records[i].submittedAt); if(!isNaN(d.getTime()) && d.getMonth()===m && d.getFullYear()===y) c++; }
  return c;
}
function countBy(records, fieldId){
  var m={}; for (var i=0;i<records.length;i++){ var a=records[i].answers||{}; var v=a[fieldId]; if(v==null||v==='') continue; m[v]=(m[v]||0)+1; }
  return m;
}
function sumBy(records, keyField, valField){
  var m={}; for (var i=0;i<records.length;i++){ var a=records[i].answers||{}; var k=a[keyField]; if(k==null||k==='') continue; m[k]=(m[k]||0)+(Number(a[valField])||0); }
  return m;
}
function bars(counts, lm, fmt){
  var keys=Object.keys(counts);
  keys.sort(function(a,b){ return counts[b]-counts[a]; });
  var max=0; for (var i=0;i<keys.length;i++){ if(counts[keys[i]]>max) max=counts[keys[i]]; }
  if(!keys.length) return '<div class="empty-sm">No data yet</div>';
  var html='';
  for (var i=0;i<keys.length;i++){
    var k=keys[i], c=counts[k];
    var pct = max>0 ? Math.max(6, Math.round(c/max*100)) : 0;
    var color = PALETTE[i % PALETTE.length];
    var label = lm[k] || k;
    var val = fmt ? fmt(c) : num(c);
    html += '<div class="bar-row"><span class="bar-name" title="'+h(label)+'">'+h(label)+'</span>'
      + '<div class="bar-track"><div class="bar-fill" data-pct="'+pct+'" style="background:'+color+'"></div></div>'
      + '<span class="bar-val">'+h(val)+'</span></div>';
  }
  return html;
}
function stat(icon, value, label, sub, accent){
  return '<div class="card stat"><div class="stat-ic" style="color:'+accent+'">'+icon+'</div>'
    + '<div class="stat-v">'+h(value)+'</div><div class="stat-l">'+h(label)+'</div>'
    + (sub ? '<div class="stat-s">'+h(sub)+'</div>' : '') + '</div>';
}
function qa(f, label, icon, accent){
  if(!f) return '';
  return '<button class="qa-btn" data-nav="'+h(f.formId)+'"><span class="qa-ic" style="color:'+accent+'">'+icon+'</span><span>'+h(label)+'</span></button>';
}
function panel(title, body, navForm, navLabel){
  var head = '<div class="panel-h"><h2>'+h(title)+'</h2>'
    + (navForm ? '<button class="link" data-nav="'+h(navForm.formId)+'">'+h(navLabel||'View all')+'</button>' : '') + '</div>';
  return '<div class="card panel">'+head+body+'</div>';
}
async function main(){
  var root = document.getElementById('app');
  var ctx;
  try { ctx = await FL.context(); } catch(e){ root.innerHTML = '<div class="wrap"><div class="empty">Could not load the dashboard.</div></div>'; return; }
  var user = await FL.currentUser().catch(function(){ return null; });

  var fApp = findForm(ctx, 'Job Applications');
  var fOnb = findForm(ctx, 'Employee Onboarding');
  var fLeave = findForm(ctx, 'Leave Requests');
  var fPerf = findForm(ctx, 'Performance Reviews');
  var fExp = findForm(ctx, 'Expense Claims');
  var fTrain = findForm(ctx, 'Training Requests');

  async function load(f){ return f ? await FL.records(f.formId, { limit: 500 }).catch(function(){ return []; }) : []; }
  var apps = await load(fApp);
  var onb = await load(fOnb);
  var leave = await load(fLeave);
  var perf = await load(fPerf);
  var exp = await load(fExp);

  var totalExpense=0; for (var i=0;i<exp.length;i++){ totalExpense += Number((exp[i].answers||{}).amount)||0; }
  var totalLeaveDays=0; for (var i=0;i<leave.length;i++){ totalLeaveDays += Number((leave[i].answers||{}).total_days)||0; }
  var ratingSum=0, ratingN=0;
  for (var i=0;i<perf.length;i++){ var r=Number((perf[i].answers||{}).overall_rating); if(!isNaN(r)&&r>0){ ratingSum+=r; ratingN++; } }
  var avgRating = ratingN ? Math.round(ratingSum/ratingN*10)/10 : 0;

  var posLm = labelMap(fApp, 'position');
  var leaveLm = labelMap(fLeave, 'leave_type');
  var catLm = labelMap(fExp, 'category');

  var uname = (user && user.name) ? user.name : 'there';
  var html = '<div class="wrap">';

  html += '<header class="hd"><div class="hd-l"><div class="logo">'+IC.users+'</div>'
    + '<div><h1>'+h(ctx.appName||'People Hub')+'</h1><p class="sub">Welcome back, '+h(uname)+'</p></div></div>'
    + '<div class="hd-r">' + (fApp ? '<button class="btn primary" data-nav="'+h(fApp.formId)+'">+ New Application</button>' : '') + '</div></header>';

  html += '<div class="stats">'
    + stat(IC.doc, num(apps.length), 'Applicants', monthCount(apps)+' this month', PRIMARY)
    + stat(IC.check, num(onb.length), 'Onboarding', monthCount(onb)+' new this month', ACCENT)
    + stat(IC.cal, num(leave.length), 'Leave Requests', num(totalLeaveDays)+' days total', '#f59e0b')
    + stat(IC.star, num(perf.length), 'Reviews', (avgRating ? avgRating+' avg rating' : 'no ratings yet'), '#34d399')
    + stat(IC.receipt, money(totalExpense), 'Expenses', num(exp.length)+' claims', '#f472b6')
    + '</div>';

  html += '<div class="panels">';

  html += panel('Applications by position',
    '<div class="bars">' + (apps.length ? bars(countBy(apps,'position'), posLm, null) : '<div class="empty-sm">No applications yet</div>') + '</div>',
    fApp, 'View all');

  var recent = '';
  if (apps.length){
    recent = '<ul class="list">';
    for (var i=0;i<Math.min(apps.length,6);i++){
      var a = apps[i].answers||{};
      var nm = ((a.first_name||'')+' '+(a.last_name||'')).trim() || 'Candidate';
      var pos = posLm[a.position] || a.position || '';
      recent += '<li class="li"><div class="li-main"><span class="li-title">'+h(nm)+'</span>'
        + (pos ? '<span class="badge">'+h(pos)+'</span>' : '') + '</div>'
        + '<span class="li-date">'+h(fmtDate(apps[i].submittedAt))+'</span></li>';
    }
    recent += '</ul>';
  } else {
    recent = '<div class="empty-sm">No applications yet' + (fApp ? ' — <button class="link" data-nav="'+h(fApp.formId)+'">add one</button>' : '') + '</div>';
  }
  html += panel('Recent applications', recent, null, null);

  html += panel('Leave by type',
    '<div class="bars">' + (leave.length ? bars(countBy(leave,'leave_type'), leaveLm, null) : '<div class="empty-sm">No leave requests yet</div>') + '</div>',
    fLeave, 'View all');

  html += panel('Expense spend by category',
    '<div class="bars">' + (exp.length ? bars(sumBy(exp,'category','amount'), catLm, money) : '<div class="empty-sm">No expense claims yet</div>') + '</div>',
    fExp, 'View all');

  html += '</div>';

  html += '<div class="qa">'
    + qa(fApp, 'New application', IC.doc, PRIMARY)
    + qa(fOnb, 'Onboard employee', IC.check, ACCENT)
    + qa(fLeave, 'Log leave', IC.cal, '#f59e0b')
    + qa(fExp, 'Submit expense', IC.receipt, '#f472b6')
    + qa(fTrain, 'Request training', IC.book, '#38bdf8')
    + qa(fPerf, 'Performance review', IC.star, '#34d399')
    + '</div>';

  html += '</div>';
  root.innerHTML = html;

  var navs = root.querySelectorAll('[data-nav]');
  for (var i=0;i<navs.length;i++){ (function(el){ el.addEventListener('click', function(){ FL.navigate(el.getAttribute('data-nav')); }); })(navs[i]); }

  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    var fills = root.querySelectorAll('.bar-fill');
    for (var i=0;i<fills.length;i++){ fills[i].style.width = (fills[i].getAttribute('data-pct')||0) + '%'; }
  }); });
}
main();
`,
      },
      roles: [
        {
          name: 'HR Manager',
          description: 'Full access to all HR forms for managing the entire people lifecycle.',
          permissions: [
            { packFormId: 'job-application', permission: 'submit_responses' },
            { packFormId: 'job-application', permission: 'view_all_responses' },
            { packFormId: 'job-application', permission: 'edit_responses' },
            { packFormId: 'job-application', permission: 'delete_responses' },
            { packFormId: 'job-application', permission: 'export_responses' },
            { packFormId: 'interview-scorecard', permission: 'submit_responses' },
            { packFormId: 'interview-scorecard', permission: 'view_all_responses' },
            { packFormId: 'interview-scorecard', permission: 'edit_responses' },
            { packFormId: 'interview-scorecard', permission: 'delete_responses' },
            { packFormId: 'interview-scorecard', permission: 'export_responses' },
            { packFormId: 'employee-onboarding', permission: 'submit_responses' },
            { packFormId: 'employee-onboarding', permission: 'view_all_responses' },
            { packFormId: 'employee-onboarding', permission: 'edit_responses' },
            { packFormId: 'employee-onboarding', permission: 'delete_responses' },
            { packFormId: 'employee-onboarding', permission: 'export_responses' },
            { packFormId: 'leave-request', permission: 'submit_responses' },
            { packFormId: 'leave-request', permission: 'view_all_responses' },
            { packFormId: 'leave-request', permission: 'edit_responses' },
            { packFormId: 'leave-request', permission: 'delete_responses' },
            { packFormId: 'leave-request', permission: 'export_responses' },
            { packFormId: 'performance-review', permission: 'submit_responses' },
            { packFormId: 'performance-review', permission: 'view_all_responses' },
            { packFormId: 'performance-review', permission: 'edit_responses' },
            { packFormId: 'performance-review', permission: 'delete_responses' },
            { packFormId: 'performance-review', permission: 'export_responses' },
            { packFormId: 'expense-claim', permission: 'submit_responses' },
            { packFormId: 'expense-claim', permission: 'view_all_responses' },
            { packFormId: 'expense-claim', permission: 'edit_responses' },
            { packFormId: 'expense-claim', permission: 'delete_responses' },
            { packFormId: 'expense-claim', permission: 'export_responses' },
            { packFormId: 'training-request', permission: 'submit_responses' },
            { packFormId: 'training-request', permission: 'view_all_responses' },
            { packFormId: 'training-request', permission: 'edit_responses' },
            { packFormId: 'training-request', permission: 'delete_responses' },
            { packFormId: 'training-request', permission: 'export_responses' },
            { packFormId: 'exit-interview', permission: 'submit_responses' },
            { packFormId: 'exit-interview', permission: 'view_all_responses' },
            { packFormId: 'exit-interview', permission: 'edit_responses' },
            { packFormId: 'exit-interview', permission: 'delete_responses' },
            { packFormId: 'exit-interview', permission: 'export_responses' },
          ],
        },
        {
          name: 'Manager',
          description: 'Department managers with access to team-related HR forms.',
          permissions: [
            { packFormId: 'interview-scorecard', permission: 'submit_responses' },
            { packFormId: 'interview-scorecard', permission: 'view_own_responses' },
            { packFormId: 'employee-onboarding', permission: 'view_all_responses' },
            { packFormId: 'employee-onboarding', permission: 'edit_responses' },
            { packFormId: 'leave-request', permission: 'view_all_responses' },
            { packFormId: 'leave-request', permission: 'edit_responses' },
            { packFormId: 'performance-review', permission: 'submit_responses' },
            { packFormId: 'performance-review', permission: 'view_all_responses' },
            { packFormId: 'performance-review', permission: 'edit_responses' },
            { packFormId: 'expense-claim', permission: 'view_all_responses' },
            { packFormId: 'expense-claim', permission: 'edit_responses' },
            { packFormId: 'training-request', permission: 'view_all_responses' },
            { packFormId: 'training-request', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Employee',
          description: 'Employees who can submit their own forms and view their own records.',
          permissions: [
            { packFormId: 'job-application', permission: 'submit_responses' },
            { packFormId: 'job-application', permission: 'view_own_responses' },
            { packFormId: 'leave-request', permission: 'submit_responses' },
            { packFormId: 'leave-request', permission: 'view_own_responses' },
            { packFormId: 'expense-claim', permission: 'submit_responses' },
            { packFormId: 'expense-claim', permission: 'view_own_responses' },
            { packFormId: 'training-request', permission: 'submit_responses' },
            { packFormId: 'training-request', permission: 'view_own_responses' },
            { packFormId: 'exit-interview', permission: 'submit_responses' },
            { packFormId: 'exit-interview', permission: 'view_own_responses' },
            { packFormId: 'performance-review', permission: 'view_own_responses' },
          ],
        },
      ],
    },
  ],
};
