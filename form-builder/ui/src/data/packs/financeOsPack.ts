// ── Type definitions ────────────────────────────────────────────────────────

export interface PackFormField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  properties: Record<string, unknown>;
  conditionalLogic?: { expression: string; action: string };
  validation?: Array<{
    id: string;
    type: string;
    value?: string | number;
    message: string;
    expression?: string;
  }>;
}

export interface PackForm {
  packFormId: string;
  title: string;
  description: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  logicScript?: string;
  fields: PackFormField[];
}

export interface PackAppRole {
  name: string;
  description: string;
  permissions: Array<{ packFormId: string; permission: string }>;
}

export interface PackAppForm {
  packFormId: string;
  displayName: string;
  sortOrder: number;
  isVisible: boolean;
}

export interface PackApp {
  packAppId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  forms: PackAppForm[];
  roles: PackAppRole[];
}

export interface PackData {
  formatVersion: number;
  packMeta: {
    name: string;
    description: string;
    version: string;
    author: string;
    tags: string[];
  };
  forms: PackForm[];
  apps: PackApp[];
}

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
  primaryColor: '#6366f1',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const financeOsPack: PackData = {
  formatVersion: 1,
  packMeta: {
    name: 'Finance OS',
    description:
      'A comprehensive pack for financial advisors covering client onboarding, compliance, account transfers, and ongoing client management.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['finance', 'advisory', 'compliance', 'onboarding', 'wealth-management'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. New Client Onboarding ─────────────────────────────────────────
    {
      packFormId: 'client-intake',
      title: 'New Client Onboarding',
      description:
        'Collect personal, financial, and regulatory information for new advisory clients.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
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
          id: 'dob',
          type: 'date',
          label: 'Date of Birth',
          required: true,
          properties: {},
        },
        {
          id: 'ssn',
          type: 'short_text',
          label: 'Social Security Number',
          required: true,
          properties: { placeholder: '###-##-####' },
          validation: [
            {
              id: 'ssn_pattern',
              type: 'pattern',
              value: '^\\d{3}-?\\d{2}-?\\d{4}$',
              message: 'Please enter a valid SSN (e.g. 123-45-6789).',
            },
          ],
        },
        {
          id: 'address',
          type: 'long_text',
          label: 'Mailing Address',
          required: true,
          properties: { placeholder: 'Street, City, State, ZIP' },
        },
        {
          id: 'citizenship',
          type: 'dropdown',
          label: 'Citizenship Status',
          required: true,
          properties: {
            options: [
              { id: 'us', label: 'US', value: 'us' },
              { id: 'non-us', label: 'Non-US', value: 'non-us' },
              { id: 'dual', label: 'Dual', value: 'dual' },
            ],
          },
        },
        {
          id: 'employer',
          type: 'short_text',
          label: 'Employer',
          required: false,
          properties: { placeholder: 'Current employer' },
        },
        {
          id: 'occupation',
          type: 'short_text',
          label: 'Occupation',
          required: false,
          properties: { placeholder: 'Current occupation' },
        },
        {
          id: 'annual_income',
          type: 'number',
          label: 'Annual Income ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'net_worth',
          type: 'number',
          label: 'Net Worth ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'liquid_net_worth',
          type: 'number',
          label: 'Liquid Net Worth ($)',
          required: false,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'investment_objectives',
          type: 'dropdown',
          label: 'Investment Objectives',
          required: true,
          properties: {
            options: [
              { id: 'growth', label: 'Growth', value: 'growth' },
              { id: 'income', label: 'Income', value: 'income' },
              { id: 'capital_preservation', label: 'Capital Preservation', value: 'capital_preservation' },
              { id: 'speculation', label: 'Speculation', value: 'speculation' },
              { id: 'balanced', label: 'Balanced', value: 'balanced' },
            ],
          },
        },
        {
          id: 'time_horizon',
          type: 'scale',
          label: 'Investment Time Horizon (years)',
          required: true,
          properties: { min: 1, max: 30, step: 1 },
        },
        {
          id: 'risk_tolerance',
          type: 'scale',
          label: 'Risk Tolerance',
          required: true,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'risk_score',
          type: 'calculated',
          label: 'Risk Score',
          required: false,
          properties: {
            calculationExpression: 'finance.riskScore(dob, time_horizon, risk_tolerance)',
          },
        },
        {
          id: 'kyc_status',
          type: 'calculated',
          label: 'KYC Status',
          required: false,
          properties: {
            calculationExpression:
              'compliance.kycComplete(first_name, last_name, email, dob, ssn, address)',
          },
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 2. Risk Tolerance Questionnaire ──────────────────────────────────
    {
      packFormId: 'risk-questionnaire',
      title: 'Risk Tolerance Questionnaire',
      description:
        'Assess client risk tolerance and generate a suitability profile for regulatory compliance.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'market_reaction',
          type: 'multiple_choice',
          label: 'If the market dropped 20% tomorrow, what would you do?',
          required: true,
          properties: {
            options: [
              { id: 'sell', label: 'Sell', value: 'sell' },
              { id: 'hold', label: 'Hold', value: 'hold' },
              { id: 'buy_more', label: 'Buy More', value: 'buy_more' },
            ],
          },
        },
        {
          id: 'loss_capacity',
          type: 'scale',
          label: 'How much loss can you absorb without affecting your lifestyle?',
          required: true,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'investment_experience',
          type: 'dropdown',
          label: 'Investment Experience',
          required: true,
          properties: {
            options: [
              { id: 'none', label: 'None', value: 'none' },
              { id: 'limited', label: 'Limited', value: 'limited' },
              { id: 'moderate', label: 'Moderate', value: 'moderate' },
              { id: 'extensive', label: 'Extensive', value: 'extensive' },
            ],
          },
        },
        {
          id: 'risk_profile_score',
          type: 'calculated',
          label: 'Risk Profile Score',
          required: false,
          properties: {
            calculationExpression:
              'compliance.suitabilityScore(35, annual_income, net_worth, risk_tolerance, time_horizon)',
          },
        },
        {
          id: 'reg_bi_check',
          type: 'calculated',
          label: 'Reg BI Check',
          required: false,
          properties: {
            calculationExpression: 'compliance.regBICheck(risk_profile_score, "moderate")',
          },
        },
      ],
    },

    // ── 3. ACAT / Transfer Form ──────────────────────────────────────────
    {
      packFormId: 'acat-transfer',
      title: 'ACAT / Transfer Form',
      description:
        'Initiate an Automated Customer Account Transfer (ACAT) from an external custodian.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'custodian',
          type: 'dropdown',
          label: 'Delivering Custodian',
          required: true,
          properties: {
            options: [
              { id: 'schwab', label: 'Schwab', value: 'schwab' },
              { id: 'fidelity', label: 'Fidelity', value: 'fidelity' },
              { id: 'vanguard', label: 'Vanguard', value: 'vanguard' },
              { id: 'td_ameritrade', label: 'TD Ameritrade', value: 'td_ameritrade' },
              { id: 'other', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'account_number',
          type: 'short_text',
          label: 'Account Number',
          required: true,
          properties: { placeholder: 'External account number' },
        },
        {
          id: 'transfer_type',
          type: 'multiple_choice',
          label: 'Transfer Type',
          required: true,
          properties: {
            options: [
              { id: 'full', label: 'Full', value: 'full' },
              { id: 'partial', label: 'Partial', value: 'partial' },
            ],
          },
        },
        {
          id: 'assets_to_transfer',
          type: 'long_text',
          label: 'Assets to Transfer',
          required: false,
          properties: { placeholder: 'List specific assets to transfer' },
          conditionalLogic: {
            expression: 'transfer_type == "partial"',
            action: 'show',
          },
        },
        {
          id: 'estimated_value',
          type: 'number',
          label: 'Estimated Value ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'transfer_fee',
          type: 'calculated',
          label: 'Estimated Transfer Fee',
          required: false,
          properties: {
            calculationExpression: 'finance.transferFee(estimated_value, custodian)',
          },
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 4. Form CRS & Relationship Summary ───────────────────────────────
    {
      packFormId: 'form-crs',
      title: 'Form CRS & Relationship Summary',
      description:
        'Client Relationship Summary disclosure required by SEC regulation.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'firm_statement',
          type: 'statement',
          label: 'Firm Statement',
          description: 'This document describes our services, fees, and conflicts of interest',
          required: false,
          properties: {},
        },
        {
          id: 'services_statement',
          type: 'statement',
          label: 'Services',
          description: 'We provide investment advisory services including...',
          required: false,
          properties: {},
        },
        {
          id: 'fees_statement',
          type: 'statement',
          label: 'Fees',
          description: 'Our fees are based on a percentage of assets under management...',
          required: false,
          properties: {},
        },
        {
          id: 'acknowledgement_date',
          type: 'date',
          label: 'Acknowledgement Date',
          required: true,
          properties: {},
        },
        {
          id: 'client_signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
        {
          id: 'advisor_name',
          type: 'short_text',
          label: 'Advisor Name',
          required: true,
          properties: { placeholder: 'Full name of advising representative' },
        },
      ],
    },

    // ── 5. Annual Client Review ──────────────────────────────────────────
    {
      packFormId: 'annual-review',
      title: 'Annual Client Review',
      description:
        'Document annual portfolio review, updated goals, and any life changes for each client.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'current_aum',
          type: 'number',
          label: 'Current AUM ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'goal_progress',
          type: 'scale',
          label: 'Goal Progress',
          required: true,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'life_changes',
          type: 'checkboxes',
          label: 'Life Changes Since Last Review',
          required: false,
          properties: {
            options: [
              { id: 'marriage', label: 'Marriage', value: 'marriage' },
              { id: 'divorce', label: 'Divorce', value: 'divorce' },
              { id: 'new_child', label: 'New Child', value: 'new_child' },
              { id: 'retirement', label: 'Retirement', value: 'retirement' },
              { id: 'job_change', label: 'Job Change', value: 'job_change' },
              { id: 'inheritance', label: 'Inheritance', value: 'inheritance' },
              { id: 'none_lc', label: 'None', value: 'none' },
            ],
          },
        },
        {
          id: 'updated_risk_tolerance',
          type: 'scale',
          label: 'Updated Risk Tolerance',
          required: false,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'advisor_notes',
          type: 'long_text',
          label: 'Advisor Notes',
          required: false,
          properties: { placeholder: 'Notes from the review session' },
        },
        {
          id: 'next_review_date',
          type: 'date',
          label: 'Next Review Date',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 6. Fee Agreement ─────────────────────────────────────────────────
    {
      packFormId: 'fee-agreement',
      title: 'Fee Agreement',
      description:
        'Establish advisory fee terms based on assets under management.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'account_value',
          type: 'number',
          label: 'Account Value ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'fee_tier',
          type: 'dropdown',
          label: 'Fee Tier',
          required: false,
          properties: {
            options: [
              { id: 'standard', label: 'Standard', value: 'standard' },
              { id: 'premium', label: 'Premium', value: 'premium' },
              { id: 'institutional', label: 'Institutional', value: 'institutional' },
            ],
          },
        },
        {
          id: 'calculated_annual_fee',
          type: 'calculated',
          label: 'Calculated Annual Fee',
          required: false,
          properties: {
            calculationExpression: 'finance.aumFee(account_value)',
          },
        },
        {
          id: 'billing_frequency',
          type: 'dropdown',
          label: 'Billing Frequency',
          required: true,
          properties: {
            options: [
              { id: 'monthly', label: 'Monthly', value: 'monthly' },
              { id: 'quarterly', label: 'Quarterly', value: 'quarterly' },
              { id: 'annually', label: 'Annually', value: 'annually' },
            ],
          },
        },
        {
          id: 'client_signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
        {
          id: 'effective_date',
          type: 'date',
          label: 'Effective Date',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 7. Document Vault ────────────────────────────────────────────────
    {
      packFormId: 'document-vault',
      title: 'Document Vault',
      description:
        'Securely store and organize client documents such as tax returns, statements, and legal files.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'document_type',
          type: 'dropdown',
          label: 'Document Type',
          required: true,
          properties: {
            options: [
              { id: 'tax_return', label: 'Tax Return', value: 'tax_return' },
              { id: 'legal_document', label: 'Legal Document', value: 'legal_document' },
              { id: 'statement', label: 'Statement', value: 'statement' },
              { id: 'insurance', label: 'Insurance', value: 'insurance' },
              { id: 'other_dt', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'document_file',
          type: 'file_upload',
          label: 'Document File',
          required: true,
          properties: {
            acceptedFileTypes: ['.pdf', '.doc', '.docx', '.jpg', '.png'],
          },
        },
        {
          id: 'expiry_date',
          type: 'date',
          label: 'Expiry Date',
          required: false,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Additional notes about this document' },
        },
      ],
    },

    // ── 8. W-9 Form ─────────────────────────────────────────────────────
    {
      packFormId: 'w9-form',
      title: 'W-9 Form',
      description:
        'Request for Taxpayer Identification Number and Certification.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'legal_name',
          type: 'short_text',
          label: 'Legal Name',
          required: true,
          properties: { placeholder: 'Name as shown on your income tax return' },
        },
        {
          id: 'business_name',
          type: 'short_text',
          label: 'Business Name',
          required: false,
          properties: {
            placeholder: 'Business name / disregarded entity name, if different',
          },
        },
        {
          id: 'tax_classification',
          type: 'dropdown',
          label: 'Federal Tax Classification',
          required: true,
          properties: {
            options: [
              { id: 'individual', label: 'Individual', value: 'individual' },
              { id: 'llc', label: 'LLC', value: 'llc' },
              { id: 'corporation', label: 'Corporation', value: 'corporation' },
              { id: 'partnership', label: 'Partnership', value: 'partnership' },
              { id: 'trust', label: 'Trust', value: 'trust' },
              { id: 'other_tc', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'ssn_ein',
          type: 'short_text',
          label: 'SSN or EIN',
          required: true,
          properties: { placeholder: 'SSN or EIN' },
          validation: [
            {
              id: 'ssn_ein_pattern',
              type: 'pattern',
              value: '^\\d{3}-?\\d{2}-?\\d{4}$|^\\d{2}-?\\d{7}$',
              message:
                'Please enter a valid SSN (###-##-####) or EIN (##-#######).',
            },
          ],
        },
        {
          id: 'address',
          type: 'long_text',
          label: 'Address',
          required: true,
          properties: { placeholder: 'Number, street, city, state, ZIP code' },
        },
        {
          id: 'certification_signature',
          type: 'signature',
          label: 'Certification Signature',
          required: true,
          properties: {},
        },
        {
          id: 'date',
          type: 'date',
          label: 'Date',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 9. Beneficiary Designation ───────────────────────────────────────
    {
      packFormId: 'beneficiary-designation',
      title: 'Beneficiary Designation',
      description:
        'Designate primary and contingent beneficiaries for an investment account.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'account',
          type: 'short_text',
          label: 'Account',
          required: true,
          properties: { placeholder: 'Account number or name' },
        },
        {
          id: 'primary_name_1',
          type: 'short_text',
          label: 'Primary Beneficiary 1 — Name',
          required: true,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'primary_relationship_1',
          type: 'short_text',
          label: 'Primary Beneficiary 1 — Relationship',
          required: true,
          properties: { placeholder: 'e.g. Spouse, Child' },
        },
        {
          id: 'primary_percentage_1',
          type: 'number',
          label: 'Primary Beneficiary 1 — Percentage',
          required: true,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'primary_name_2',
          type: 'short_text',
          label: 'Primary Beneficiary 2 — Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'primary_relationship_2',
          type: 'short_text',
          label: 'Primary Beneficiary 2 — Relationship',
          required: false,
          properties: { placeholder: 'e.g. Spouse, Child' },
        },
        {
          id: 'primary_percentage_2',
          type: 'number',
          label: 'Primary Beneficiary 2 — Percentage',
          required: false,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'contingent_name_1',
          type: 'short_text',
          label: 'Contingent Beneficiary 1 — Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'contingent_relationship_1',
          type: 'short_text',
          label: 'Contingent Beneficiary 1 — Relationship',
          required: false,
          properties: { placeholder: 'e.g. Sibling, Trust' },
        },
        {
          id: 'contingent_percentage_1',
          type: 'number',
          label: 'Contingent Beneficiary 1 — Percentage',
          required: false,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 10. Power of Attorney ────────────────────────────────────────────
    {
      packFormId: 'power-of-attorney',
      title: 'Power of Attorney',
      description:
        'Grant legal authority to an agent to act on the principal\'s behalf in specified matters.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'principal_name',
          type: 'short_text',
          label: 'Principal Name',
          required: true,
          properties: { placeholder: 'Full legal name of the principal' },
        },
        {
          id: 'agent_name',
          type: 'short_text',
          label: 'Agent Name',
          required: true,
          properties: { placeholder: 'Full legal name of the agent' },
        },
        {
          id: 'powers_granted',
          type: 'checkboxes',
          label: 'Powers Granted',
          required: true,
          properties: {
            options: [
              { id: 'financial', label: 'Financial', value: 'financial' },
              { id: 'healthcare', label: 'Healthcare', value: 'healthcare' },
              { id: 'real_estate', label: 'Real Estate', value: 'real_estate' },
              { id: 'legal', label: 'Legal', value: 'legal' },
              { id: 'all', label: 'All', value: 'all' },
            ],
          },
        },
        {
          id: 'effective_date',
          type: 'date',
          label: 'Effective Date',
          required: true,
          properties: {},
        },
        {
          id: 'principal_signature',
          type: 'signature',
          label: 'Principal Signature',
          required: true,
          properties: {},
        },
        {
          id: 'witness_1_name',
          type: 'short_text',
          label: 'Witness 1 — Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'witness_1_signature',
          type: 'signature',
          label: 'Witness 1 — Signature',
          required: true,
          properties: {},
        },
        {
          id: 'witness_2_name',
          type: 'short_text',
          label: 'Witness 2 — Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'witness_2_signature',
          type: 'signature',
          label: 'Witness 2 — Signature',
          required: true,
          properties: {},
        },
        {
          id: 'notary',
          type: 'file_upload',
          label: 'Notary Document',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 11. 1035 Exchange ────────────────────────────────────────────────
    {
      packFormId: '1035-exchange',
      title: '1035 Exchange',
      description:
        'Facilitate a tax-free exchange of an existing life insurance or annuity policy for a new one.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'existing_policy_number',
          type: 'short_text',
          label: 'Existing Policy Number',
          required: true,
          properties: { placeholder: 'Policy number to exchange' },
        },
        {
          id: 'existing_carrier',
          type: 'short_text',
          label: 'Existing Carrier',
          required: true,
          properties: { placeholder: 'Current insurance company' },
        },
        {
          id: 'exchange_type',
          type: 'dropdown',
          label: 'Exchange Type',
          required: true,
          properties: {
            options: [
              { id: 'life_insurance', label: 'Life Insurance', value: 'life_insurance' },
              { id: 'annuity', label: 'Annuity', value: 'annuity' },
            ],
          },
        },
        {
          id: 'new_carrier',
          type: 'short_text',
          label: 'New Carrier',
          required: true,
          properties: { placeholder: 'New insurance company' },
        },
        {
          id: 'new_policy_type',
          type: 'short_text',
          label: 'New Policy Type',
          required: true,
          properties: { placeholder: 'e.g. Term, Whole Life, Variable Annuity' },
        },
        {
          id: 'surrender_charges',
          type: 'number',
          label: 'Surrender Charges ($)',
          required: false,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 12. Rollover Form ────────────────────────────────────────────────
    {
      packFormId: 'rollover-form',
      title: 'Rollover Form',
      description:
        'Initiate a rollover of retirement plan assets from an employer plan or existing IRA.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'rollover_type',
          type: 'multiple_choice',
          label: 'Rollover Type',
          required: true,
          properties: {
            options: [
              { id: 'traditional_to_traditional', label: 'Traditional to Traditional', value: 'traditional_to_traditional' },
              { id: 'traditional_to_roth', label: 'Traditional to Roth', value: 'traditional_to_roth' },
              { id: '401k_to_ira', label: '401k to IRA', value: '401k_to_ira' },
              { id: '403b_to_ira', label: '403b to IRA', value: '403b_to_ira' },
            ],
          },
        },
        {
          id: 'current_custodian',
          type: 'short_text',
          label: 'Current Custodian',
          required: true,
          properties: { placeholder: 'Name of current plan custodian' },
        },
        {
          id: 'current_account_number',
          type: 'short_text',
          label: 'Current Account Number',
          required: true,
          properties: { placeholder: 'Account number at current custodian' },
        },
        {
          id: 'estimated_value',
          type: 'number',
          label: 'Estimated Value ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'direct_or_indirect',
          type: 'multiple_choice',
          label: 'Direct or Indirect Rollover',
          required: true,
          properties: {
            options: [
              { id: 'direct', label: 'Direct', value: 'direct' },
              { id: 'indirect', label: 'Indirect', value: 'indirect' },
            ],
          },
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    // ── 1. Client Onboarding Navigator ───────────────────────────────────
    {
      packAppId: 'onboarding-nav',
      name: 'Client Onboarding Navigator',
      description:
        'Guide new clients through the full onboarding workflow: intake, risk assessment, disclosures, document collection, tax forms, and beneficiary designations.',
      settings: {},
      theme: {
        primaryColor: '#4f46e5',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'client-intake', displayName: 'New Client Onboarding', sortOrder: 1, isVisible: true },
        { packFormId: 'risk-questionnaire', displayName: 'Risk Tolerance Questionnaire', sortOrder: 2, isVisible: true },
        { packFormId: 'form-crs', displayName: 'Form CRS & Relationship Summary', sortOrder: 3, isVisible: true },
        { packFormId: 'document-vault', displayName: 'Document Vault', sortOrder: 4, isVisible: true },
        { packFormId: 'w9-form', displayName: 'W-9 Form', sortOrder: 5, isVisible: true },
        { packFormId: 'beneficiary-designation', displayName: 'Beneficiary Designation', sortOrder: 6, isVisible: true },
      ],
      roles: [
        {
          name: 'Advisor',
          description: 'Financial advisor managing client onboarding.',
          permissions: [
            { packFormId: 'client-intake', permission: 'submit_responses' },
            { packFormId: 'client-intake', permission: 'view_own_responses' },
            { packFormId: 'risk-questionnaire', permission: 'submit_responses' },
            { packFormId: 'risk-questionnaire', permission: 'view_own_responses' },
            { packFormId: 'form-crs', permission: 'submit_responses' },
            { packFormId: 'form-crs', permission: 'view_own_responses' },
            { packFormId: 'document-vault', permission: 'submit_responses' },
            { packFormId: 'document-vault', permission: 'view_own_responses' },
            { packFormId: 'w9-form', permission: 'submit_responses' },
            { packFormId: 'w9-form', permission: 'view_own_responses' },
            { packFormId: 'beneficiary-designation', permission: 'submit_responses' },
            { packFormId: 'beneficiary-designation', permission: 'view_own_responses' },
          ],
        },
        {
          name: 'Compliance Officer',
          description: 'Compliance team member responsible for reviewing and correcting submissions.',
          permissions: [
            { packFormId: 'client-intake', permission: 'view_all_responses' },
            { packFormId: 'client-intake', permission: 'edit_responses' },
            { packFormId: 'risk-questionnaire', permission: 'view_all_responses' },
            { packFormId: 'risk-questionnaire', permission: 'edit_responses' },
            { packFormId: 'form-crs', permission: 'view_all_responses' },
            { packFormId: 'form-crs', permission: 'edit_responses' },
            { packFormId: 'document-vault', permission: 'view_all_responses' },
            { packFormId: 'document-vault', permission: 'edit_responses' },
            { packFormId: 'w9-form', permission: 'view_all_responses' },
            { packFormId: 'w9-form', permission: 'edit_responses' },
            { packFormId: 'beneficiary-designation', permission: 'view_all_responses' },
            { packFormId: 'beneficiary-designation', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Operations',
          description: 'Operations team with full data management capabilities.',
          permissions: [
            { packFormId: 'client-intake', permission: 'view_all_responses' },
            { packFormId: 'client-intake', permission: 'edit_responses' },
            { packFormId: 'client-intake', permission: 'delete_responses' },
            { packFormId: 'client-intake', permission: 'export_responses' },
            { packFormId: 'risk-questionnaire', permission: 'view_all_responses' },
            { packFormId: 'risk-questionnaire', permission: 'edit_responses' },
            { packFormId: 'risk-questionnaire', permission: 'delete_responses' },
            { packFormId: 'risk-questionnaire', permission: 'export_responses' },
            { packFormId: 'form-crs', permission: 'view_all_responses' },
            { packFormId: 'form-crs', permission: 'edit_responses' },
            { packFormId: 'form-crs', permission: 'delete_responses' },
            { packFormId: 'form-crs', permission: 'export_responses' },
            { packFormId: 'document-vault', permission: 'view_all_responses' },
            { packFormId: 'document-vault', permission: 'edit_responses' },
            { packFormId: 'document-vault', permission: 'delete_responses' },
            { packFormId: 'document-vault', permission: 'export_responses' },
            { packFormId: 'w9-form', permission: 'view_all_responses' },
            { packFormId: 'w9-form', permission: 'edit_responses' },
            { packFormId: 'w9-form', permission: 'delete_responses' },
            { packFormId: 'w9-form', permission: 'export_responses' },
            { packFormId: 'beneficiary-designation', permission: 'view_all_responses' },
            { packFormId: 'beneficiary-designation', permission: 'edit_responses' },
            { packFormId: 'beneficiary-designation', permission: 'delete_responses' },
            { packFormId: 'beneficiary-designation', permission: 'export_responses' },
          ],
        },
        {
          name: 'Client',
          description: 'End client completing their own onboarding forms.',
          permissions: [
            { packFormId: 'client-intake', permission: 'submit_responses' },
            { packFormId: 'client-intake', permission: 'view_own_responses' },
            { packFormId: 'risk-questionnaire', permission: 'submit_responses' },
            { packFormId: 'risk-questionnaire', permission: 'view_own_responses' },
            { packFormId: 'form-crs', permission: 'submit_responses' },
            { packFormId: 'form-crs', permission: 'view_own_responses' },
            { packFormId: 'document-vault', permission: 'submit_responses' },
            { packFormId: 'document-vault', permission: 'view_own_responses' },
            { packFormId: 'w9-form', permission: 'submit_responses' },
            { packFormId: 'w9-form', permission: 'view_own_responses' },
            { packFormId: 'beneficiary-designation', permission: 'submit_responses' },
            { packFormId: 'beneficiary-designation', permission: 'view_own_responses' },
          ],
        },
      ],
    },

    // ── 2. Advisor Transition Hub ────────────────────────────────────────
    {
      packAppId: 'transition-hub',
      name: 'Advisor Transition Hub',
      description:
        'Manage all aspects of an advisor book-of-business transition: client re-papering, account transfers, fee agreements, exchanges, and rollovers.',
      settings: {},
      theme: {
        primaryColor: '#059669',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'client-intake', displayName: 'New Client Onboarding', sortOrder: 1, isVisible: true },
        { packFormId: 'acat-transfer', displayName: 'ACAT / Transfer Form', sortOrder: 2, isVisible: true },
        { packFormId: 'annual-review', displayName: 'Annual Client Review', sortOrder: 3, isVisible: true },
        { packFormId: 'fee-agreement', displayName: 'Fee Agreement', sortOrder: 4, isVisible: true },
        { packFormId: '1035-exchange', displayName: '1035 Exchange', sortOrder: 5, isVisible: true },
        { packFormId: 'rollover-form', displayName: 'Rollover Form', sortOrder: 6, isVisible: true },
      ],
      roles: [
        {
          name: 'Managing Advisor',
          description: 'Lead advisor with full control over all transition forms.',
          permissions: [
            { packFormId: 'client-intake', permission: 'submit_responses' },
            { packFormId: 'client-intake', permission: 'view_own_responses' },
            { packFormId: 'client-intake', permission: 'view_all_responses' },
            { packFormId: 'client-intake', permission: 'edit_responses' },
            { packFormId: 'client-intake', permission: 'delete_responses' },
            { packFormId: 'client-intake', permission: 'export_responses' },
            { packFormId: 'acat-transfer', permission: 'submit_responses' },
            { packFormId: 'acat-transfer', permission: 'view_own_responses' },
            { packFormId: 'acat-transfer', permission: 'view_all_responses' },
            { packFormId: 'acat-transfer', permission: 'edit_responses' },
            { packFormId: 'acat-transfer', permission: 'delete_responses' },
            { packFormId: 'acat-transfer', permission: 'export_responses' },
            { packFormId: 'annual-review', permission: 'submit_responses' },
            { packFormId: 'annual-review', permission: 'view_own_responses' },
            { packFormId: 'annual-review', permission: 'view_all_responses' },
            { packFormId: 'annual-review', permission: 'edit_responses' },
            { packFormId: 'annual-review', permission: 'delete_responses' },
            { packFormId: 'annual-review', permission: 'export_responses' },
            { packFormId: 'fee-agreement', permission: 'submit_responses' },
            { packFormId: 'fee-agreement', permission: 'view_own_responses' },
            { packFormId: 'fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'fee-agreement', permission: 'edit_responses' },
            { packFormId: 'fee-agreement', permission: 'delete_responses' },
            { packFormId: 'fee-agreement', permission: 'export_responses' },
            { packFormId: '1035-exchange', permission: 'submit_responses' },
            { packFormId: '1035-exchange', permission: 'view_own_responses' },
            { packFormId: '1035-exchange', permission: 'view_all_responses' },
            { packFormId: '1035-exchange', permission: 'edit_responses' },
            { packFormId: '1035-exchange', permission: 'delete_responses' },
            { packFormId: '1035-exchange', permission: 'export_responses' },
            { packFormId: 'rollover-form', permission: 'submit_responses' },
            { packFormId: 'rollover-form', permission: 'view_own_responses' },
            { packFormId: 'rollover-form', permission: 'view_all_responses' },
            { packFormId: 'rollover-form', permission: 'edit_responses' },
            { packFormId: 'rollover-form', permission: 'delete_responses' },
            { packFormId: 'rollover-form', permission: 'export_responses' },
          ],
        },
        {
          name: 'Transition Coordinator',
          description: 'Coordinator managing the day-to-day logistics of the transition.',
          permissions: [
            { packFormId: 'client-intake', permission: 'submit_responses' },
            { packFormId: 'client-intake', permission: 'view_all_responses' },
            { packFormId: 'client-intake', permission: 'edit_responses' },
            { packFormId: 'acat-transfer', permission: 'submit_responses' },
            { packFormId: 'acat-transfer', permission: 'view_all_responses' },
            { packFormId: 'acat-transfer', permission: 'edit_responses' },
            { packFormId: 'annual-review', permission: 'submit_responses' },
            { packFormId: 'annual-review', permission: 'view_all_responses' },
            { packFormId: 'annual-review', permission: 'edit_responses' },
            { packFormId: 'fee-agreement', permission: 'submit_responses' },
            { packFormId: 'fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'fee-agreement', permission: 'edit_responses' },
            { packFormId: '1035-exchange', permission: 'submit_responses' },
            { packFormId: '1035-exchange', permission: 'view_all_responses' },
            { packFormId: '1035-exchange', permission: 'edit_responses' },
            { packFormId: 'rollover-form', permission: 'submit_responses' },
            { packFormId: 'rollover-form', permission: 'view_all_responses' },
            { packFormId: 'rollover-form', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Compliance',
          description: 'Compliance reviewer with read-only access across all forms.',
          permissions: [
            { packFormId: 'client-intake', permission: 'view_all_responses' },
            { packFormId: 'acat-transfer', permission: 'view_all_responses' },
            { packFormId: 'annual-review', permission: 'view_all_responses' },
            { packFormId: 'fee-agreement', permission: 'view_all_responses' },
            { packFormId: '1035-exchange', permission: 'view_all_responses' },
            { packFormId: 'rollover-form', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Operations',
          description: 'Operations team handling submissions, edits, deletions, and exports.',
          permissions: [
            { packFormId: 'client-intake', permission: 'submit_responses' },
            { packFormId: 'client-intake', permission: 'view_all_responses' },
            { packFormId: 'client-intake', permission: 'edit_responses' },
            { packFormId: 'client-intake', permission: 'delete_responses' },
            { packFormId: 'client-intake', permission: 'export_responses' },
            { packFormId: 'acat-transfer', permission: 'submit_responses' },
            { packFormId: 'acat-transfer', permission: 'view_all_responses' },
            { packFormId: 'acat-transfer', permission: 'edit_responses' },
            { packFormId: 'acat-transfer', permission: 'delete_responses' },
            { packFormId: 'acat-transfer', permission: 'export_responses' },
            { packFormId: 'annual-review', permission: 'submit_responses' },
            { packFormId: 'annual-review', permission: 'view_all_responses' },
            { packFormId: 'annual-review', permission: 'edit_responses' },
            { packFormId: 'annual-review', permission: 'delete_responses' },
            { packFormId: 'annual-review', permission: 'export_responses' },
            { packFormId: 'fee-agreement', permission: 'submit_responses' },
            { packFormId: 'fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'fee-agreement', permission: 'edit_responses' },
            { packFormId: 'fee-agreement', permission: 'delete_responses' },
            { packFormId: 'fee-agreement', permission: 'export_responses' },
            { packFormId: '1035-exchange', permission: 'submit_responses' },
            { packFormId: '1035-exchange', permission: 'view_all_responses' },
            { packFormId: '1035-exchange', permission: 'edit_responses' },
            { packFormId: '1035-exchange', permission: 'delete_responses' },
            { packFormId: '1035-exchange', permission: 'export_responses' },
            { packFormId: 'rollover-form', permission: 'submit_responses' },
            { packFormId: 'rollover-form', permission: 'view_all_responses' },
            { packFormId: 'rollover-form', permission: 'edit_responses' },
            { packFormId: 'rollover-form', permission: 'delete_responses' },
            { packFormId: 'rollover-form', permission: 'export_responses' },
          ],
        },
      ],
    },
  ],
};
