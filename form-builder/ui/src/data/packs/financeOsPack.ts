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
  icon?: string;
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

/**
 * A report spec inside a pack. Form references are portable pack keys, NOT real ids:
 *  - `formId` / `joins[].formId` use `@pack:<packFormId>`
 *  - joined field refs use `@pack:<packFormId>::<fieldId>`; base-form field refs are the bare `<fieldId>`;
 *    `__submitted_at` / `__status` are pseudo-fields.
 * These are resolved to real form ids at install/import time (PackService::resolvePackReports).
 */
export interface PackReportSpec {
  formId: string;
  viz: 'table' | 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'kpi';
  joins?: Array<{ via: string; formId: string; type?: 'inner' | 'left' }>;
  filters?: Array<{ field: string; op: string; value?: string | number }>;
  groupBy?: { field: string; bucket?: 'none' | 'day' | 'month' | 'year' };
  measure?: { fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'; field?: string };
  columns?: string[];
  seriesSort?: 'value' | 'label';
  sort?: 'asc' | 'desc' | { by: string; dir: 'asc' | 'desc' };
  having?: { op: string; value: number };
  limit?: number;
}

/** A block in a pack PDF document: free text, or a chart that references a sibling PackReportItem by reportId. */
export type PackReportBlock =
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'report'; reportId: string; caption?: string };

/** A pack report item — a chart (`kind:'chart'`, has `spec`) or a PDF document (`kind:'document'`, has `blocks`). */
export interface PackReportItem {
  /** Pack-local stable id, referenced by document blocks. */
  reportId: string;
  kind: 'chart' | 'document';
  name: string;
  description?: string;
  spec?: PackReportSpec;
  blocks?: PackReportBlock[];
}

export interface PackApp {
  packAppId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  theme: Record<string, unknown>;
  forms: PackAppForm[];
  /** Optional sandboxed custom home screen (dashboard) shown instead of the form list. */
  customScreen?: { enabled?: boolean; html?: string; css?: string; js?: string };
  roles: PackAppRole[];
  /** Optional pre-configured chart reports + PDF documents shown in the app's Reports section. */
  reports?: PackReportItem[];
}

export interface PackData {
  formatVersion: number;
  packMeta: {
    id?: string;
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

/** Settings for compliance-sensitive forms with NIGO prevention dashboard enabled. */
const complianceSettings: Record<string, unknown> = {
  ...defaultSettings,
  showNigoDashboard: true,
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
    id: 'finance-os-us',
    name: 'Finance OS (United States)',
    description:
      'A comprehensive United States-focused pack for financial advisors covering client onboarding, compliance, account transfers, and ongoing client management.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['finance', 'advisory', 'compliance', 'onboarding', 'wealth-management', 'united-states'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. New Client Onboarding ─────────────────────────────────────────
    {
      packFormId: 'client-intake',
      title: 'New Client Onboarding',
      icon: 'UserPlus',
      description:
        'Collect personal, financial, and regulatory information for new advisory clients.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Welcome to Client Onboarding',
          description: 'This form collects personal, financial, and regulatory information required to open your advisory account. All data is kept confidential and secure.',
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
          id: 'dob',
          type: 'date',
          label: 'Date of Birth',
          required: true,
          properties: {},
        },
        {
          id: 'age',
          type: 'number',
          label: 'Age',
          description: 'Used for risk assessment and suitability calculations.',
          required: true,
          properties: { placeholder: 'Enter age', min: 18, max: 120 },
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
              { id: 'us', label: 'U.S. Citizen', value: 'us' },
              { id: 'permanent_resident', label: 'U.S. Permanent Resident', value: 'permanent_resident' },
              { id: 'non_resident_alien', label: 'Non-Resident Alien', value: 'non_resident_alien' },
              { id: 'dual', label: 'Dual Citizenship', value: 'dual' },
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
          description: '1 = Less than 1 year, 15 = Medium-term, 30 = 30+ years.',
          required: true,
          properties: { min: 1, max: 30, step: 1 },
        },
        {
          id: 'risk_tolerance',
          type: 'scale',
          label: 'Risk Tolerance',
          description: '1 = Very conservative (prefer safety), 10 = Very aggressive (accept high volatility).',
          required: true,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'risk_score',
          type: 'calculated',
          label: 'Risk Score',
          description: 'Weighted score (1-100) based on age, investment horizon, and risk tolerance.',
          required: false,
          properties: {
            calculationExpression: 'Math.round((risk_tolerance * 5) + (time_horizon * 2) + ((120 - age) / 2))',
          },
        },
        {
          id: 'accredited_investor',
          type: 'calculated',
          label: 'Accredited Investor Status',
          description: 'SEC Rule 501(a): income > $200k or net worth > $1M.',
          required: false,
          properties: {
            calculationExpression: 'annual_income > 200000 || net_worth > 1000000 ? "Yes" : "No"',
          },
        },
        {
          id: 'portfolio_allocation',
          type: 'calculated',
          label: 'Suggested Portfolio Allocation',
          description: 'Equity:Bond:Cash ratio based on risk score.',
          required: false,
          properties: {
            calculationExpression: 'risk_score >= 70 ? "80/15/5" : risk_score >= 40 ? "60/30/10" : "30/50/20"',
          },
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Client Signature',
          required: true,
          properties: {},
        },
        {
          id: 'thank_you',
          type: 'thank_you',
          label: 'Onboarding Complete',
          description: 'Thank you for completing the onboarding form. Your advisor will review the information and reach out with next steps.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 2. Risk Tolerance Questionnaire ──────────────────────────────────
    {
      packFormId: 'risk-questionnaire',
      title: 'Risk Tolerance Questionnaire',
      icon: 'Scale',
      description:
        'Assess client risk tolerance and generate a suitability profile for regulatory compliance.',
      settings: { ...complianceSettings },
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
          id: 'client_age',
          type: 'number',
          label: 'Client Age',
          description: 'Confirm the client\'s current age for suitability calculations.',
          required: true,
          properties: { placeholder: 'Age', min: 18, max: 120 },
        },
        {
          id: 'client_income',
          type: 'number',
          label: 'Annual Income ($)',
          description: 'Confirm the client\'s annual income for suitability analysis.',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'client_net_worth',
          type: 'number',
          label: 'Net Worth ($)',
          description: 'Confirm the client\'s total net worth.',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'time_horizon',
          type: 'scale',
          label: 'Investment Time Horizon (years)',
          description: '1 = Less than 1 year, 30 = 30+ years.',
          required: true,
          properties: { min: 1, max: 30, step: 1 },
        },
        {
          id: 'market_reaction',
          type: 'multiple_choice',
          label: 'If the market dropped 20% tomorrow, what would you do?',
          required: true,
          properties: {
            options: [
              { id: 'sell', label: 'Sell everything', value: 'sell' },
              { id: 'sell_some', label: 'Sell some holdings', value: 'sell_some' },
              { id: 'hold', label: 'Hold and wait', value: 'hold' },
              { id: 'buy_more', label: 'Buy more at the discount', value: 'buy_more' },
            ],
          },
        },
        {
          id: 'loss_capacity',
          type: 'scale',
          label: 'How much portfolio loss can you absorb without affecting your lifestyle?',
          description: '1 = Very little (< 5%), 10 = Significant (> 40%).',
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
              { id: 'none', label: 'None (0 years)', value: 'none' },
              { id: 'limited', label: 'Limited (1-3 years)', value: 'limited' },
              { id: 'moderate', label: 'Moderate (3-10 years)', value: 'moderate' },
              { id: 'extensive', label: 'Extensive (10+ years)', value: 'extensive' },
            ],
          },
        },
        {
          id: 'portfolio_type',
          type: 'dropdown',
          label: 'Recommended Portfolio Type',
          description: 'Select the portfolio type to validate against the suitability score.',
          required: true,
          properties: {
            options: [
              { id: 'conservative', label: 'Conservative', value: 'conservative' },
              { id: 'moderate', label: 'Moderate', value: 'moderate' },
              { id: 'aggressive', label: 'Aggressive', value: 'aggressive' },
              { id: 'speculative', label: 'Speculative', value: 'speculative' },
            ],
          },
        },
        {
          id: 'risk_profile_score',
          type: 'calculated',
          label: 'Risk Profile Score',
          description: 'Weighted suitability score (1-100) based on age, income, net worth, tolerance, and horizon.',
          required: false,
          properties: {
            calculationExpression: 'Math.round((loss_capacity * 5) + (time_horizon * 2) + ((120 - client_age) / 2))',
          },
        },
        {
          id: 'reg_bi_check',
          type: 'calculated',
          label: 'Reg BI Suitability Check',
          description: 'Validates that the selected portfolio type is suitable for this client\'s risk profile.',
          required: false,
          properties: {
            calculationExpression: 'risk_profile_score >= 70 && (portfolio_type == "conservative" || portfolio_type == "moderate") ? "Review needed" : risk_profile_score < 30 && (portfolio_type == "aggressive" || portfolio_type == "speculative") ? "Review needed" : "Suitable"',
          },
        },
      ],
    },

    // ── 3. ACAT / Transfer Form ──────────────────────────────────────────
    {
      packFormId: 'acat-transfer',
      title: 'ACAT / Transfer Form',
      icon: 'Send',
      description:
        'Initiate an Automated Customer Account Transfer (ACAT) from an external custodian.',
      settings: { ...complianceSettings },
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
              { id: 'etrade', label: 'E*TRADE', value: 'etrade' },
              { id: 'pershing', label: 'BNY Pershing', value: 'pershing' },
              { id: 'lpl', label: 'LPL Financial', value: 'lpl' },
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
            calculationExpression: '75',
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
      icon: 'FileCheck',
      description:
        'Client Relationship Summary disclosure required by SEC regulation.',
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
          id: 'firm_statement',
          type: 'statement',
          label: 'Introduction',
          description: 'This Client Relationship Summary ("Form CRS") is required by the SEC and provides important information about our firm, services, fees, conflicts of interest, and disciplinary history. Please review each section carefully before signing.',
          required: false,
          properties: {},
        },
        {
          id: 'services_statement',
          type: 'statement',
          label: 'What investment services and advice can you provide me?',
          description: 'We provide investment advisory services including portfolio management, financial planning, and retirement planning. We offer both discretionary and non-discretionary account management. Account minimums and other requirements may apply.',
          required: false,
          properties: {},
        },
        {
          id: 'fees_statement',
          type: 'statement',
          label: 'What fees will I pay?',
          description: 'Our fees are based on a percentage of assets under management (AUM), charged quarterly in arrears. The more assets you have in your account, the more you will pay in fees, giving us an incentive to encourage you to increase your account size. You may also incur brokerage, custody, and fund expense charges.',
          required: false,
          properties: {},
        },
        {
          id: 'conflicts_statement',
          type: 'statement',
          label: 'What are your legal obligations to me?',
          description: 'When we act as your investment adviser, we must act in your best interest and not place our interests ahead of yours. We are held to a fiduciary standard under the Investment Advisers Act of 1940.',
          required: false,
          properties: {},
        },
        {
          id: 'disciplinary_statement',
          type: 'statement',
          label: 'Do you or your financial professionals have legal or disciplinary history?',
          description: 'Visit Investor.gov/CRS to research our firm and financial professionals. You can also ask us: "As a financial professional, do you have any disciplinary history? If so, for what type of conduct?"',
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
      icon: 'Calendar',
      description:
        'Document annual portfolio review, updated goals, and any life changes for each client.',
      settings: { ...complianceSettings },
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
          id: 'current_annual_fee',
          type: 'calculated',
          label: 'Current Annual Fee',
          description: 'Tiered advisory fee based on current AUM.',
          required: false,
          properties: {
            calculationExpression: 'current_aum <= 500000 ? (current_aum * 0.01) : current_aum <= 1000000 ? (current_aum * 0.0085) : (current_aum * 0.007)',
          },
        },
        {
          id: 'goal_progress',
          type: 'scale',
          label: 'Goal Progress',
          description: '1 = Significantly behind, 5 = On track, 10 = Exceeding goals.',
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
          description: '1 = Very conservative, 10 = Very aggressive. Leave unchanged if risk profile has not shifted.',
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
      icon: 'DollarSign',
      description:
        'Establish advisory fee terms based on assets under management.',
      settings: { ...complianceSettings },
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
            calculationExpression: 'account_value <= 500000 ? (account_value * 0.01) : account_value <= 1000000 ? (account_value * 0.0085) : (account_value * 0.007)',
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
      icon: 'Folder',
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
          id: 'document_name',
          type: 'short_text',
          label: 'Document Name',
          required: true,
          properties: { placeholder: 'Enter a name for this document' },
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
          description: 'Applicable for documents with an expiration (insurance policies, legal agreements, etc.).',
          required: false,
          properties: {},
          conditionalLogic: {
            expression: 'document_type == "insurance" || document_type == "legal_document"',
            action: 'show',
          },
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
      icon: 'FileText',
      description:
        'Request for Taxpayer Identification Number and Certification.',
      settings: { ...complianceSettings },
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
      icon: 'Heart',
      description:
        'Designate primary and contingent beneficiaries for an investment account.',
      settings: { ...complianceSettings },
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
          id: 'primary_name_3',
          type: 'short_text',
          label: 'Primary Beneficiary 3 — Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'primary_relationship_3',
          type: 'short_text',
          label: 'Primary Beneficiary 3 — Relationship',
          required: false,
          properties: { placeholder: 'e.g. Spouse, Child' },
        },
        {
          id: 'primary_percentage_3',
          type: 'number',
          label: 'Primary Beneficiary 3 — Percentage',
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
          id: 'contingent_name_2',
          type: 'short_text',
          label: 'Contingent Beneficiary 2 — Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'contingent_relationship_2',
          type: 'short_text',
          label: 'Contingent Beneficiary 2 — Relationship',
          required: false,
          properties: { placeholder: 'e.g. Sibling, Trust' },
        },
        {
          id: 'contingent_percentage_2',
          type: 'number',
          label: 'Contingent Beneficiary 2 — Percentage',
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
      icon: 'Gavel',
      description:
        'Grant legal authority to an agent to act on the principal\'s behalf in specified matters.',
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
      icon: 'Receipt',
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
          id: 'estimated_value',
          type: 'number',
          label: 'Estimated Policy / Contract Value ($)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'has_surrender_charges',
          type: 'multiple_choice',
          label: 'Are there surrender charges on the existing policy?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
              { id: 'unknown', label: 'Unknown', value: 'unknown' },
            ],
          },
        },
        {
          id: 'surrender_charges',
          type: 'number',
          label: 'Surrender Charges ($)',
          description: 'Enter the estimated surrender charge amount if applicable.',
          required: false,
          properties: { placeholder: '0', min: 0 },
          conditionalLogic: {
            expression: 'has_surrender_charges == "yes"',
            action: 'show',
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

    // ── 12. Rollover Form ────────────────────────────────────────────────
    {
      packFormId: 'rollover-form',
      title: 'Rollover Form',
      icon: 'Wallet',
      description:
        'Initiate a rollover of retirement plan assets from an employer plan or existing IRA.',
      settings: { ...complianceSettings },
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
          id: 'roth_tax_warning',
          type: 'statement',
          label: 'Roth Conversion Tax Notice',
          description: 'Converting pre-tax retirement assets to a Roth account is a taxable event. The converted amount will be added to your gross income for the tax year. Please consult a tax professional before proceeding.',
          required: false,
          properties: {},
          conditionalLogic: {
            expression: 'rollover_type == "traditional_to_roth"',
            action: 'show',
          },
        },
        {
          id: 'current_custodian',
          type: 'short_text',
          label: 'Current Custodian / Plan Administrator',
          required: true,
          properties: { placeholder: 'Name of current plan custodian or administrator' },
        },
        {
          id: 'current_account_number',
          type: 'short_text',
          label: 'Current Account Number',
          required: true,
          properties: { placeholder: 'Account number at current custodian' },
        },
        {
          id: 'receiving_custodian',
          type: 'short_text',
          label: 'Receiving Custodian',
          required: true,
          properties: { placeholder: 'Name of custodian receiving the rollover' },
        },
        {
          id: 'receiving_account_number',
          type: 'short_text',
          label: 'Receiving Account Number',
          description: 'Leave blank if a new account will be opened.',
          required: false,
          properties: { placeholder: 'Account number at receiving custodian' },
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
          description: 'Direct: funds transfer custodian-to-custodian. Indirect: funds sent to you, must be redeposited within 60 days.',
          required: true,
          properties: {
            options: [
              { id: 'direct', label: 'Direct (trustee-to-trustee)', value: 'direct' },
              { id: 'indirect', label: 'Indirect (60-day rollover)', value: 'indirect' },
            ],
          },
        },
        {
          id: 'indirect_warning',
          type: 'statement',
          label: '60-Day Rollover Deadline',
          description: 'With an indirect rollover, you must deposit the funds into a qualifying retirement account within 60 calendar days. Failure to do so may result in the distribution being treated as taxable income plus a 10% early withdrawal penalty if under age 59½.',
          required: false,
          properties: {},
          conditionalLogic: {
            expression: 'direct_or_indirect == "indirect"',
            action: 'show',
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
      customScreen: {
        enabled: true,
        html: '<div id="app"><div class="wrap"><div class="empty">Loading onboarding dashboard…</div></div></div>',
        css: [
          ':root{--accent:var(--fl-accent);--accent2:var(--fl-accent);--ink:var(--fl-text);--muted:var(--fl-muted);--line:var(--fl-border);}',
          'html.fl-dark{--accent2:color-mix(in srgb, var(--fl-accent) 55%, #ffffff);}',
          '*{box-sizing:border-box;}html,body{margin:0;padding:0;}',
          'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;}',
          '.wrap{max-width:1080px;margin:0 auto;padding:30px 22px 60px;}',
          '.empty{text-align:center;padding:96px 20px;color:var(--muted);font-size:14px;}',
          '.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:26px;}',
          '.hdr-l{min-width:0;}',
          '.eyebrow{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent2);font-weight:700;margin-bottom:7px;}',
          '.title{margin:0;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.02em;color:var(--fl-text);}',
          '.who{margin-top:9px;font-size:13px;color:var(--muted);}.who b{color:var(--fl-text);font-weight:600;}',
          '.btn{appearance:none;border:0;cursor:pointer;font:inherit;border-radius:11px;padding:11px 17px;font-weight:650;font-size:14px;}',
          '.btn-primary{background:var(--accent);color:var(--fl-accent-contrast);box-shadow:0 8px 22px -8px color-mix(in srgb, var(--fl-accent) 65%, transparent);}.btn-primary:hover{filter:brightness(1.08);}',
          '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:13px;margin-bottom:22px;}',
          '.stat{background:var(--fl-surface);border:1px solid var(--line);border-radius:15px;padding:16px 15px;box-shadow:var(--fl-shadow);}',
          '.stat-val{font-size:25px;font-weight:800;letter-spacing:-0.02em;color:var(--fl-text);line-height:1.1;}',
          '.stat-label{margin-top:7px;font-size:12.5px;font-weight:600;color:var(--fl-muted);}',
          '.stat-sub{margin-top:3px;font-size:11px;color:var(--fl-faint);}',
          '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}',
          '.panel{background:var(--fl-surface);border:1px solid var(--line);border-radius:16px;padding:18px 18px 20px;box-shadow:var(--fl-shadow);}',
          '.panel h3{margin:0 0 15px;font-size:13.5px;font-weight:700;color:var(--fl-text);}',
          '.bar-row{display:grid;grid-template-columns:132px 1fr 40px;align-items:center;gap:10px;margin-bottom:11px;}.bar-row:last-child{margin-bottom:0;}',
          '.bar-name{font-size:12.5px;color:var(--fl-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
          '.bar-track{height:9px;border-radius:6px;background:var(--fl-track);overflow:hidden;}',
          '.bar-fill{height:100%;width:0;border-radius:6px;transition:width 1s cubic-bezier(.22,1,.36,1);}',
          '.bar-val{font-size:12.5px;font-weight:700;color:var(--ink);text-align:right;}',
          '.rows{display:flex;flex-direction:column;}',
          '.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--fl-border);}.row:first-child{border-top:0;padding-top:0;}',
          '.row-main{min-width:0;}',
          '.row-title{font-size:13.5px;font-weight:600;color:var(--fl-text);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
          '.row-sub{margin-top:3px;font-size:11.5px;color:var(--muted);}',
          '.row-r{text-align:right;white-space:nowrap;}',
          '.amt{font-size:13.5px;font-weight:700;color:var(--fl-text);margin-bottom:4px;}',
          '.badge{display:inline-block;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;}',
          '.act-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}',
          '.act{display:flex;align-items:center;gap:11px;text-align:left;background:var(--fl-surface);border:1px solid var(--line);color:var(--ink);border-radius:12px;padding:13px 14px;cursor:pointer;font:inherit;font-weight:600;font-size:13.5px;transition:border-color .15s ease,transform .05s ease;}',
          '.act:hover{border-color:var(--accent);}.act:active{transform:translateY(1px);}',
          '.act .ico{width:32px;height:32px;flex:none;display:grid;place-items:center;border-radius:9px;background:color-mix(in srgb, var(--fl-accent) 16%, transparent);font-size:16px;}',
          '.empty-sm{color:var(--muted);font-size:13px;padding:12px 0;}',
          '.empty-cta{padding-top:6px;}',
          '.link-btn{background:none;border:0;color:var(--accent2);cursor:pointer;font:inherit;font-weight:650;font-size:13px;padding:6px 0;}.link-btn:hover{text-decoration:underline;}',
          '@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr);}.grid2{grid-template-columns:1fr;}}',
          '@media(max-width:620px){.stats{grid-template-columns:repeat(2,1fr);}.act-grid{grid-template-columns:1fr 1fr;}}',
        ].join('\n'),
        js: [
          "var FL = window.FormLogic;",
          "function h(s){ return FL.escapeHtml(s == null ? '' : String(s)); }",
          "function findForm(ctx, name){ var t = String(name).toLowerCase(); for (var i=0;i<ctx.forms.length;i++){ if (String(ctx.forms[i].displayName||'').toLowerCase() === t) return ctx.forms[i]; } return null; }",
          "function optionMap(form, fieldId){ var m = {}; if (!form || !form.fields) return m; for (var i=0;i<form.fields.length;i++){ var f = form.fields[i]; if (f.id === fieldId && f.properties && f.properties.options){ var o = f.properties.options; for (var j=0;j<o.length;j++){ m[o[j].value] = o[j].label; } } } return m; }",
          "function labelFor(map, v){ if (v == null || v === '') return '\\u2014'; return map[v] || String(v); }",
          "function fmtDate(s){ if (!s) return '\\u2014'; var d = new Date(s); if (isNaN(d.getTime())) return '\\u2014'; return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }); }",
          "async function recs(form){ if (!form) return []; try { return await FL.records(form.formId, { limit: 500 }); } catch (e){ return []; } }",
          "function bar(label, count, max, color){ var pct = max>0 ? Math.max(3, Math.round(count/max*100)) : 0; return '<div class=\"bar-row\"><span class=\"bar-name\" title=\"'+h(label)+'\">'+h(label)+'</span><div class=\"bar-track\"><div class=\"bar-fill\" data-pct=\"'+pct+'\" style=\"background:'+color+'\"></div></div><span class=\"bar-val\">'+Number(count).toLocaleString()+'</span></div>'; }",
          "function renderBreakdown(records, fieldId, map, color){ var counts = {}; for (var i=0;i<records.length;i++){ var v = records[i].answers ? records[i].answers[fieldId] : null; if (Array.isArray(v)){ for (var k=0;k<v.length;k++){ counts[v[k]] = (counts[v[k]]||0)+1; } } else if (v != null && v !== ''){ counts[v] = (counts[v]||0)+1; } } var keys = []; for (var key in map){ if (Object.prototype.hasOwnProperty.call(map,key)) keys.push(key); } for (var vk in counts){ if (Object.prototype.hasOwnProperty.call(counts,vk) && keys.indexOf(vk) === -1) keys.push(vk); } var max = 0; for (var a=0;a<keys.length;a++){ if ((counts[keys[a]]||0) > max) max = counts[keys[a]]||0; } if (max === 0) return '<div class=\"empty-sm\">No data to chart yet.</div>'; keys.sort(function(x,y){ return (counts[y]||0)-(counts[x]||0); }); var out = ''; for (var b=0;b<keys.length;b++){ var c = counts[keys[b]]||0; if (c === 0) continue; out += bar(labelFor(map, keys[b]), c, max, color); } return out; }",
          "function badge(text, color, bg){ return '<span class=\"badge\" style=\"color:'+color+';background:'+bg+'\">'+h(text)+'</span>'; }",
          "function stat(value, label, sub){ return '<div class=\"stat\"><div class=\"stat-val\">'+value+'</div><div class=\"stat-label\">'+h(label)+'</div>'+(sub ? '<div class=\"stat-sub\">'+h(sub)+'</div>' : '')+'</div>'; }",
          "function emptyCta(msg, form){ var b = form ? '<div class=\"empty-cta\"><button class=\"link-btn\" data-nav=\"'+h(form.formId)+'\">+ Add the first one</button></div>' : ''; return '<div class=\"empty-sm\">'+h(msg)+'</div>'+b; }",
          "function actions(items){ var out = '<div class=\"panel\"><h3>Quick Actions</h3><div class=\"act-grid\">'; for (var i=0;i<items.length;i++){ var it = items[i]; if (!it.form) continue; out += '<button class=\"act\" data-nav=\"'+h(it.form.formId)+'\"><span class=\"ico\">'+it.icon+'</span><span>'+h(it.label)+'</span></button>'; } out += '</div></div>'; return out; }",
          "function wire(root){ var nav = root.querySelectorAll('[data-nav]'); for (var i=0;i<nav.length;i++){ (function(el){ el.addEventListener('click', function(){ var id = el.getAttribute('data-nav'); if (id) FL.navigate(id); }); })(nav[i]); } requestAnimationFrame(function(){ requestAnimationFrame(function(){ var f = root.querySelectorAll('.bar-fill'); for (var i=0;i<f.length;i++){ f[i].style.width = (f[i].getAttribute('data-pct')||0)+'%'; } }); }); }",
          "async function main(){",
          "  var root = document.getElementById('app');",
          "  var ctx; try { ctx = await FL.context(); } catch (e){ root.innerHTML = '<div class=\"wrap\"><div class=\"empty\">Could not load this dashboard.</div></div>'; return; }",
          "  var user = null; try { user = await FL.currentUser(); } catch (e){}",
          "  var fClient = findForm(ctx, 'New Client Onboarding');",
          "  var fRisk = findForm(ctx, 'Risk Tolerance Questionnaire');",
          "  var fCrs = findForm(ctx, 'Form CRS & Relationship Summary');",
          "  var fDocs = findForm(ctx, 'Document Vault');",
          "  var fW9 = findForm(ctx, 'W-9 Form');",
          "  var fBene = findForm(ctx, 'Beneficiary Designation');",
          "  var clients = await recs(fClient);",
          "  var risks = await recs(fRisk);",
          "  var crs = await recs(fCrs);",
          "  var docs = await recs(fDocs);",
          "  var accredited = 0; for (var i=0;i<clients.length;i++){ if (String((clients[i].answers||{}).accredited_investor||'').toLowerCase() === 'yes') accredited++; }",
          "  var reviewNeeded = 0; for (var r=0;r<risks.length;r++){ if (String((risks[r].answers||{}).reg_bi_check||'').toLowerCase().indexOf('review') === 0) reviewNeeded++; }",
          "  var ACC = 'var(--fl-accent)';",
          "  var objMap = optionMap(fClient, 'investment_objectives');",
          "  var html = '<div class=\"wrap\">';",
          "  html += '<div class=\"hdr\"><div class=\"hdr-l\"><div class=\"eyebrow\">Client Onboarding</div><h1 class=\"title\">'+h(ctx.appName || 'Onboarding Navigator')+'</h1><div class=\"who\">'+(user ? 'Signed in as <b>'+h(user.name || user.email || 'Advisor')+'</b>' : 'Advisor workspace')+'</div></div>';",
          "  if (fClient) html += '<button class=\"btn btn-primary\" data-nav=\"'+h(fClient.formId)+'\">+ New Client</button>';",
          "  html += '</div>';",
          "  var pctAcc = clients.length ? (Math.round(accredited/clients.length*100)+'% of clients') : 'No clients yet';",
          "  html += '<div class=\"stats\">' + stat(clients.length.toLocaleString(), 'Clients Onboarded', '') + stat(accredited.toLocaleString(), 'Accredited Investors', pctAcc) + stat(risks.length.toLocaleString(), 'Risk Assessments', reviewNeeded ? (reviewNeeded+' need review') : 'All suitable') + stat(docs.length.toLocaleString(), 'Documents on File', '') + stat(crs.length.toLocaleString(), 'CRS Disclosures', '') + '</div>';",
          "  html += '<div class=\"grid2\">';",
          "  html += '<div class=\"panel\"><h3>Clients by Investment Objective</h3>' + (clients.length ? renderBreakdown(clients, 'investment_objectives', objMap, ACC) : emptyCta('No clients onboarded yet.', fClient)) + '</div>';",
          "  var recent = '';",
          "  if (!clients.length){ recent = emptyCta('No clients onboarded yet.', fClient); } else {",
          "    recent = '<div class=\"rows\">'; var n = Math.min(6, clients.length);",
          "    for (var c=0;c<n;c++){ var a = clients[c].answers || {}; var nm = ((a.first_name||'')+' '+(a.last_name||'')).trim() || 'Unnamed client'; var isAcc = String(a.accredited_investor||'').toLowerCase() === 'yes'; var rs = a.risk_score; var bdg = isAcc ? badge('Accredited', 'var(--fl-good)', 'color-mix(in srgb, var(--fl-good) 16%, transparent)') : badge('Standard', 'var(--fl-muted)', 'var(--fl-surface-2)'); var sub = fmtDate(clients[c].submittedAt) + ((rs != null && rs !== '') ? (' \\u00b7 Risk '+h(rs)) : ''); recent += '<div class=\"row\"><div class=\"row-main\"><div class=\"row-title\">'+h(nm)+'</div><div class=\"row-sub\">'+sub+'</div></div><div class=\"row-r\">'+bdg+'</div></div>'; }",
          "    recent += '</div>';",
          "  }",
          "  html += '<div class=\"panel\"><h3>Recent Clients</h3>' + recent + '</div>';",
          "  html += '</div>';",
          "  html += actions([ { form: fClient, label: 'New Client Onboarding', icon: '\\ud83d\\udc64' }, { form: fRisk, label: 'Risk Questionnaire', icon: '\\ud83d\\udcca' }, { form: fCrs, label: 'Form CRS Disclosure', icon: '\\ud83d\\udcc4' }, { form: fDocs, label: 'Document Vault', icon: '\\ud83d\\udd12' }, { form: fW9, label: 'W-9 Form', icon: '\\ud83e\\uddfe' }, { form: fBene, label: 'Beneficiary Designation', icon: '\\ud83d\\udc6a' } ]);",
          "  html += '</div>';",
          "  root.innerHTML = html;",
          "  wire(root);",
          "}",
          "main();",
        ].join('\n'),
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
      reports: [
        {
          reportId: 'onb-by-objective',
          kind: 'chart',
          name: 'Clients by Investment Objective',
          description: 'Count of onboarded clients grouped by their stated investment objective.',
          spec: {
            formId: '@pack:client-intake',
            viz: 'bar',
            groupBy: { field: 'investment_objectives' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'onb-monthly-intakes',
          kind: 'chart',
          name: 'Monthly Intake — Total Annual Income',
          description: 'Sum of annual income reported by clients onboarded each month, showing pipeline growth over time.',
          spec: {
            formId: '@pack:client-intake',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'sum', field: 'annual_income' },
          },
        },
        {
          reportId: 'onb-total-net-worth',
          kind: 'chart',
          name: 'Total Client Net Worth',
          description: 'Aggregate net worth across all onboarded clients — a high-level measure of book depth.',
          spec: {
            formId: '@pack:client-intake',
            viz: 'kpi',
            measure: { fn: 'sum', field: 'net_worth' },
          },
        },
        {
          reportId: 'onb-risk-by-objective',
          kind: 'chart',
          name: 'Risk Assessments by Client Investment Objective',
          description: 'Cross-form: risk questionnaire submissions broken down by the linked client\'s investment objective.',
          spec: {
            formId: '@pack:risk-questionnaire',
            viz: 'bar',
            joins: [{ via: 'client_record', formId: '@pack:client-intake', type: 'left' }],
            groupBy: { field: '@pack:client-intake::investment_objectives' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'onb-overview',
          kind: 'document',
          name: 'Onboarding Overview',
          description: 'Executive summary of the client onboarding pipeline.',
          blocks: [
            {
              kind: 'text',
              title: 'Onboarding Overview',
              body: 'This report summarises the performance of the Client Onboarding Navigator. It tracks the volume and composition of newly onboarded clients, their aggregate wealth profile, and how risk assessments align with stated investment objectives — key inputs for regulatory suitability reviews.',
            },
            { kind: 'report', reportId: 'onb-by-objective', caption: 'Client distribution by investment objective' },
            { kind: 'report', reportId: 'onb-monthly-intakes', caption: 'Monthly income capacity of new clients' },
            { kind: 'report', reportId: 'onb-total-net-worth', caption: 'Aggregate net worth across all clients' },
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
      customScreen: {
        enabled: true,
        html: '<div id="app"><div class="wrap"><div class="empty">Loading transition dashboard…</div></div></div>',
        css: [
          ':root{--accent:var(--fl-accent);--accent2:var(--fl-accent);--ink:var(--fl-text);--muted:var(--fl-muted);--line:var(--fl-border);}',
          'html.fl-dark{--accent2:color-mix(in srgb, var(--fl-accent) 55%, #ffffff);}',
          '*{box-sizing:border-box;}html,body{margin:0;padding:0;}',
          'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;}',
          '.wrap{max-width:1080px;margin:0 auto;padding:30px 22px 60px;}',
          '.empty{text-align:center;padding:96px 20px;color:var(--muted);font-size:14px;}',
          '.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:26px;}',
          '.hdr-l{min-width:0;}',
          '.eyebrow{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent2);font-weight:700;margin-bottom:7px;}',
          '.title{margin:0;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.02em;color:var(--fl-text);}',
          '.who{margin-top:9px;font-size:13px;color:var(--muted);}.who b{color:var(--fl-text);font-weight:600;}',
          '.btn{appearance:none;border:0;cursor:pointer;font:inherit;border-radius:11px;padding:11px 17px;font-weight:650;font-size:14px;}',
          '.btn-primary{background:var(--accent);color:var(--fl-accent-contrast);box-shadow:0 8px 22px -8px color-mix(in srgb, var(--fl-accent) 65%, transparent);}.btn-primary:hover{filter:brightness(1.08);}',
          '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:13px;margin-bottom:22px;}',
          '.stat{background:var(--fl-surface);border:1px solid var(--line);border-radius:15px;padding:16px 15px;box-shadow:var(--fl-shadow);}',
          '.stat-val{font-size:25px;font-weight:800;letter-spacing:-0.02em;color:var(--fl-text);line-height:1.1;}',
          '.stat-label{margin-top:7px;font-size:12.5px;font-weight:600;color:var(--fl-muted);}',
          '.stat-sub{margin-top:3px;font-size:11px;color:var(--fl-faint);}',
          '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}',
          '.panel{background:var(--fl-surface);border:1px solid var(--line);border-radius:16px;padding:18px 18px 20px;box-shadow:var(--fl-shadow);}',
          '.panel h3{margin:0 0 15px;font-size:13.5px;font-weight:700;color:var(--fl-text);}',
          '.bar-row{display:grid;grid-template-columns:132px 1fr 40px;align-items:center;gap:10px;margin-bottom:11px;}.bar-row:last-child{margin-bottom:0;}',
          '.bar-name{font-size:12.5px;color:var(--fl-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
          '.bar-track{height:9px;border-radius:6px;background:var(--fl-track);overflow:hidden;}',
          '.bar-fill{height:100%;width:0;border-radius:6px;transition:width 1s cubic-bezier(.22,1,.36,1);}',
          '.bar-val{font-size:12.5px;font-weight:700;color:var(--ink);text-align:right;}',
          '.rows{display:flex;flex-direction:column;}',
          '.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--fl-border);}.row:first-child{border-top:0;padding-top:0;}',
          '.row-main{min-width:0;}',
          '.row-title{font-size:13.5px;font-weight:600;color:var(--fl-text);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
          '.row-sub{margin-top:3px;font-size:11.5px;color:var(--muted);}',
          '.row-r{text-align:right;white-space:nowrap;}',
          '.amt{font-size:13.5px;font-weight:700;color:var(--fl-text);margin-bottom:4px;}',
          '.badge{display:inline-block;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;}',
          '.act-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}',
          '.act{display:flex;align-items:center;gap:11px;text-align:left;background:var(--fl-surface);border:1px solid var(--line);color:var(--ink);border-radius:12px;padding:13px 14px;cursor:pointer;font:inherit;font-weight:600;font-size:13.5px;transition:border-color .15s ease,transform .05s ease;}',
          '.act:hover{border-color:var(--accent);}.act:active{transform:translateY(1px);}',
          '.act .ico{width:32px;height:32px;flex:none;display:grid;place-items:center;border-radius:9px;background:color-mix(in srgb, var(--fl-accent) 16%, transparent);font-size:16px;}',
          '.empty-sm{color:var(--muted);font-size:13px;padding:12px 0;}',
          '.empty-cta{padding-top:6px;}',
          '.link-btn{background:none;border:0;color:var(--accent2);cursor:pointer;font:inherit;font-weight:650;font-size:13px;padding:6px 0;}.link-btn:hover{text-decoration:underline;}',
          '@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr);}.grid2{grid-template-columns:1fr;}}',
          '@media(max-width:620px){.stats{grid-template-columns:repeat(2,1fr);}.act-grid{grid-template-columns:1fr 1fr;}}',
        ].join('\n'),
        js: [
          "var FL = window.FormLogic;",
          "function h(s){ return FL.escapeHtml(s == null ? '' : String(s)); }",
          "function findForm(ctx, name){ var t = String(name).toLowerCase(); for (var i=0;i<ctx.forms.length;i++){ if (String(ctx.forms[i].displayName||'').toLowerCase() === t) return ctx.forms[i]; } return null; }",
          "function optionMap(form, fieldId){ var m = {}; if (!form || !form.fields) return m; for (var i=0;i<form.fields.length;i++){ var f = form.fields[i]; if (f.id === fieldId && f.properties && f.properties.options){ var o = f.properties.options; for (var j=0;j<o.length;j++){ m[o[j].value] = o[j].label; } } } return m; }",
          "function labelFor(map, v){ if (v == null || v === '') return '\\u2014'; return map[v] || String(v); }",
          "function moneyC(n){ n = Number(n) || 0; if (n >= 1e9) return '$'+(n/1e9).toFixed(1)+'B'; if (n >= 1e6) return '$'+(n/1e6).toFixed(1)+'M'; if (n >= 1e3) return '$'+Math.round(n/1e3)+'K'; return '$'+Math.round(n).toLocaleString(); }",
          "function fmtDate(s){ if (!s) return '\\u2014'; var d = new Date(s); if (isNaN(d.getTime())) return '\\u2014'; return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }); }",
          "async function recs(form){ if (!form) return []; try { return await FL.records(form.formId, { limit: 500 }); } catch (e){ return []; } }",
          "function bar(label, count, max, color){ var pct = max>0 ? Math.max(3, Math.round(count/max*100)) : 0; return '<div class=\"bar-row\"><span class=\"bar-name\" title=\"'+h(label)+'\">'+h(label)+'</span><div class=\"bar-track\"><div class=\"bar-fill\" data-pct=\"'+pct+'\" style=\"background:'+color+'\"></div></div><span class=\"bar-val\">'+Number(count).toLocaleString()+'</span></div>'; }",
          "function renderBreakdown(records, fieldId, map, color){ var counts = {}; for (var i=0;i<records.length;i++){ var v = records[i].answers ? records[i].answers[fieldId] : null; if (Array.isArray(v)){ for (var k=0;k<v.length;k++){ counts[v[k]] = (counts[v[k]]||0)+1; } } else if (v != null && v !== ''){ counts[v] = (counts[v]||0)+1; } } var keys = []; for (var key in map){ if (Object.prototype.hasOwnProperty.call(map,key)) keys.push(key); } for (var vk in counts){ if (Object.prototype.hasOwnProperty.call(counts,vk) && keys.indexOf(vk) === -1) keys.push(vk); } var max = 0; for (var a=0;a<keys.length;a++){ if ((counts[keys[a]]||0) > max) max = counts[keys[a]]||0; } if (max === 0) return '<div class=\"empty-sm\">No data to chart yet.</div>'; keys.sort(function(x,y){ return (counts[y]||0)-(counts[x]||0); }); var out = ''; for (var b=0;b<keys.length;b++){ var c = counts[keys[b]]||0; if (c === 0) continue; out += bar(labelFor(map, keys[b]), c, max, color); } return out; }",
          "function badge(text, color, bg){ return '<span class=\"badge\" style=\"color:'+color+';background:'+bg+'\">'+h(text)+'</span>'; }",
          "function stat(value, label, sub){ return '<div class=\"stat\"><div class=\"stat-val\">'+value+'</div><div class=\"stat-label\">'+h(label)+'</div>'+(sub ? '<div class=\"stat-sub\">'+h(sub)+'</div>' : '')+'</div>'; }",
          "function emptyCta(msg, form){ var b = form ? '<div class=\"empty-cta\"><button class=\"link-btn\" data-nav=\"'+h(form.formId)+'\">+ Add the first one</button></div>' : ''; return '<div class=\"empty-sm\">'+h(msg)+'</div>'+b; }",
          "function actions(items){ var out = '<div class=\"panel\"><h3>Quick Actions</h3><div class=\"act-grid\">'; for (var i=0;i<items.length;i++){ var it = items[i]; if (!it.form) continue; out += '<button class=\"act\" data-nav=\"'+h(it.form.formId)+'\"><span class=\"ico\">'+it.icon+'</span><span>'+h(it.label)+'</span></button>'; } out += '</div></div>'; return out; }",
          "function wire(root){ var nav = root.querySelectorAll('[data-nav]'); for (var i=0;i<nav.length;i++){ (function(el){ el.addEventListener('click', function(){ var id = el.getAttribute('data-nav'); if (id) FL.navigate(id); }); })(nav[i]); } requestAnimationFrame(function(){ requestAnimationFrame(function(){ var f = root.querySelectorAll('.bar-fill'); for (var i=0;i<f.length;i++){ f[i].style.width = (f[i].getAttribute('data-pct')||0)+'%'; } }); }); }",
          "async function main(){",
          "  var root = document.getElementById('app');",
          "  var ctx; try { ctx = await FL.context(); } catch (e){ root.innerHTML = '<div class=\"wrap\"><div class=\"empty\">Could not load this dashboard.</div></div>'; return; }",
          "  var user = null; try { user = await FL.currentUser(); } catch (e){}",
          "  var fClient = findForm(ctx, 'New Client Onboarding');",
          "  var fAcat = findForm(ctx, 'ACAT / Transfer Form');",
          "  var fReview = findForm(ctx, 'Annual Client Review');",
          "  var fFee = findForm(ctx, 'Fee Agreement');",
          "  var fExch = findForm(ctx, '1035 Exchange');",
          "  var fRoll = findForm(ctx, 'Rollover Form');",
          "  var clients = await recs(fClient);",
          "  var acat = await recs(fAcat);",
          "  var reviews = await recs(fReview);",
          "  var fees = await recs(fFee);",
          "  var exch = await recs(fExch);",
          "  var roll = await recs(fRoll);",
          "  function sum(records, field){ var s = 0; for (var i=0;i<records.length;i++){ s += Number((records[i].answers||{})[field]) || 0; } return s; }",
          "  var transferAssets = sum(acat, 'estimated_value');",
          "  var aum = sum(fees, 'account_value');",
          "  var rollValue = sum(roll, 'estimated_value');",
          "  var ACC = 'var(--fl-accent)';",
          "  var custMap = optionMap(fAcat, 'custodian');",
          "  var ttMap = optionMap(fAcat, 'transfer_type');",
          "  var html = '<div class=\"wrap\">';",
          "  html += '<div class=\"hdr\"><div class=\"hdr-l\"><div class=\"eyebrow\">Book Transition</div><h1 class=\"title\">'+h(ctx.appName || 'Advisor Transition Hub')+'</h1><div class=\"who\">'+(user ? 'Signed in as <b>'+h(user.name || user.email || 'Advisor')+'</b>' : 'Advisor workspace')+'</div></div>';",
          "  var primary = fAcat || fClient;",
          "  if (primary) html += '<button class=\"btn btn-primary\" data-nav=\"'+h(primary.formId)+'\">+ New Transfer</button>';",
          "  html += '</div>';",
          "  html += '<div class=\"stats\">' + stat(clients.length.toLocaleString(), 'Clients Transitioned', '') + stat(moneyC(transferAssets), 'Assets in Transfer', acat.length+' transfers') + stat(moneyC(aum), 'AUM Under Agreement', fees.length+' agreements') + stat(roll.length.toLocaleString(), 'Rollovers', moneyC(rollValue)+' moved') + stat(exch.length.toLocaleString(), '1035 Exchanges', reviews.length+' reviews done') + '</div>';",
          "  html += '<div class=\"grid2\">';",
          "  html += '<div class=\"panel\"><h3>Transfers by Custodian</h3>' + (acat.length ? renderBreakdown(acat, 'custodian', custMap, ACC) : emptyCta('No transfers initiated yet.', fAcat)) + '</div>';",
          "  var recent = '';",
          "  if (!acat.length){ recent = emptyCta('No transfers initiated yet.', fAcat); } else {",
          "    recent = '<div class=\"rows\">'; var n = Math.min(6, acat.length);",
          "    for (var c=0;c<n;c++){ var a = acat[c].answers || {}; var cust = labelFor(custMap, a.custodian); var tt = String(a.transfer_type||'').toLowerCase(); var bdg = tt === 'full' ? badge('Full', 'var(--fl-good)', 'color-mix(in srgb, var(--fl-good) 16%, transparent)') : (tt === 'partial' ? badge('Partial', 'var(--fl-warn)', 'color-mix(in srgb, var(--fl-warn) 16%, transparent)') : badge(labelFor(ttMap, a.transfer_type), 'var(--fl-muted)', 'var(--fl-surface-2)')); recent += '<div class=\"row\"><div class=\"row-main\"><div class=\"row-title\">'+h(cust)+'</div><div class=\"row-sub\">'+fmtDate(acat[c].submittedAt)+'</div></div><div class=\"row-r\"><div class=\"amt\">'+moneyC(Number(a.estimated_value)||0)+'</div>'+bdg+'</div></div>'; }",
          "    recent += '</div>';",
          "  }",
          "  html += '<div class=\"panel\"><h3>Recent Transfers</h3>' + recent + '</div>';",
          "  html += '</div>';",
          "  html += actions([ { form: fClient, label: 'New Client Onboarding', icon: '\\ud83d\\udc64' }, { form: fAcat, label: 'ACAT / Transfer', icon: '\\ud83d\\udd01' }, { form: fFee, label: 'Fee Agreement', icon: '\\ud83d\\udcb5' }, { form: fExch, label: '1035 Exchange', icon: '\\ud83e\\uddfe' }, { form: fRoll, label: 'Rollover Form', icon: '\\ud83d\\udc5b' }, { form: fReview, label: 'Annual Client Review', icon: '\\ud83d\\udcc5' } ]);",
          "  html += '</div>';",
          "  root.innerHTML = html;",
          "  wire(root);",
          "}",
          "main();",
        ].join('\n'),
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
      reports: [
        {
          reportId: 'trans-by-custodian',
          kind: 'chart',
          name: 'Transfers by Custodian',
          description: 'Count of ACAT transfers initiated, broken down by delivering custodian.',
          spec: {
            formId: '@pack:acat-transfer',
            viz: 'bar',
            groupBy: { field: 'custodian' },
            measure: { fn: 'count' },
            seriesSort: 'value',
            sort: 'desc',
          },
        },
        {
          reportId: 'trans-value-trend',
          kind: 'chart',
          name: 'Transfer Value — Monthly Trend',
          description: 'Total estimated asset value of transfers initiated each month.',
          spec: {
            formId: '@pack:acat-transfer',
            viz: 'line',
            groupBy: { field: '__submitted_at', bucket: 'month' },
            measure: { fn: 'sum', field: 'estimated_value' },
          },
        },
        {
          reportId: 'trans-total-assets',
          kind: 'chart',
          name: 'Total Assets in Transfer',
          description: 'Aggregate estimated value of all ACAT transfers — the total book of business in motion.',
          spec: {
            formId: '@pack:acat-transfer',
            viz: 'kpi',
            measure: { fn: 'sum', field: 'estimated_value' },
          },
        },
        {
          reportId: 'trans-by-client-objective',
          kind: 'chart',
          name: 'Transfers by Client Investment Objective',
          description: 'Cross-form: ACAT transfers broken down by the linked client\'s investment objective.',
          spec: {
            formId: '@pack:acat-transfer',
            viz: 'pie',
            joins: [{ via: 'client_record', formId: '@pack:client-intake', type: 'left' }],
            groupBy: { field: '@pack:client-intake::investment_objectives' },
            measure: { fn: 'count' },
          },
        },
        {
          reportId: 'trans-overview',
          kind: 'document',
          name: 'Transition Hub Overview',
          description: 'Executive summary of the advisor book-of-business transition.',
          blocks: [
            {
              kind: 'text',
              title: 'Advisor Transition Hub — Overview',
              body: 'This report provides a high-level view of in-progress and completed book-of-business transitions. It covers the volume and aggregate value of ACAT transfers by custodian, tracks monthly asset-transfer momentum, and shows how the transferred book maps to client investment objectives — enabling management to assess transition risk and pipeline health at a glance.',
            },
            { kind: 'report', reportId: 'trans-by-custodian', caption: 'ACAT transfers by delivering custodian' },
            { kind: 'report', reportId: 'trans-value-trend', caption: 'Monthly asset transfer volume' },
            { kind: 'report', reportId: 'trans-total-assets', caption: 'Total book value in transit' },
          ],
        },
      ],
    },
  ],
};
