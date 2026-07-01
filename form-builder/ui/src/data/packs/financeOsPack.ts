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
      settings: { icon: 'Briefcase' },
      theme: {
        primaryColor: '#4f46e5',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      customScreen: {
        enabled: true,
        html: '<div id="app"><div class="wrap"><div class="load">Loading dashboard…</div></div></div>',
        css: [
          '@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:200 800;font-display:swap;src:url(https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}',
          ':root{--ax:var(--fl-accent);}',
          'html.fl-dark{--ax:color-mix(in srgb,var(--fl-accent) 62%,#fff);}',
          '*{box-sizing:border-box;}html,body{margin:0;padding:0;}',
          'body{font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(1000px 320px at 12% -100px,color-mix(in srgb,var(--fl-accent) 7%,transparent),transparent) var(--fl-bg);}',
          '.wrap{max-width:1120px;margin:0 auto;padding:28px 24px 64px;}',
          '.num{font-variant-numeric:tabular-nums lining-nums;}',
          ':focus-visible{outline:2px solid var(--fl-accent);outline-offset:2px;border-radius:4px;}',
          '.load{padding:90px 20px;text-align:center;color:var(--fl-muted);font-size:13.5px;}',
          '.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px;}',
          '.hdr-l{display:flex;gap:14px;min-width:0;align-items:flex-start;flex:1;}',
          '.glyph{width:40px;height:40px;flex:none;display:grid;place-items:center;border-radius:12px;color:var(--ax);background:color-mix(in srgb,var(--fl-accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--fl-accent) 22%,transparent);}',
          '.glyph svg{width:22px;height:22px;}',
          '.title{margin:1px 0 0;font-size:24px;line-height:1.12;font-weight:750;letter-spacing:-0.02em;color:var(--fl-text);}',
          '.brief{margin-top:7px;font-size:13px;line-height:1.55;color:var(--fl-muted);}',
          '.brief b{color:var(--fl-text);font-weight:650;font-variant-numeric:tabular-nums;}',
          '.brief .dot{margin:0 7px;color:var(--fl-faint);}',
          '.hdr-r{display:flex;gap:10px;flex:none;align-items:center;padding-top:2px;}',
          '.btn{appearance:none;cursor:pointer;border-radius:11px;padding:10px 16px;font-weight:650;font-size:13.5px;font-family:inherit;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;transition:filter .15s ease,transform .06s ease,border-color .15s ease;}',
          '.btn:active{transform:translateY(1px);}.btn svg{width:16px;height:16px;}',
          '.btn-primary{border:0;background:var(--fl-accent);color:var(--fl-accent-contrast);box-shadow:0 8px 20px -10px color-mix(in srgb,var(--fl-accent) 70%,transparent);}.btn-primary:hover{filter:brightness(1.07);}',
          '.btn-ghost{background:transparent;border:1px solid var(--fl-border);color:var(--fl-text);}.btn-ghost:hover{border-color:color-mix(in srgb,var(--fl-accent) 45%,transparent);}',
          '.kpis{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:14px;}',
          '.kpi{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;padding:16px 18px;box-shadow:var(--fl-shadow);min-width:0;display:flex;flex-direction:column;}.kpi:not(.kpi-hero){justify-content:center;}',
          '.kpi-label{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--fl-muted);}',
          '.kpi-val{margin-top:7px;font-size:25px;font-weight:800;letter-spacing:-0.02em;line-height:1.05;color:var(--fl-text);font-variant-numeric:tabular-nums;}',
          '.kpi-hero .kpi-val{font-size:33px;}',
          '.kpi-sub{margin-top:5px;font-size:12px;color:var(--fl-faint);}.kpi-sub b{color:var(--fl-muted);font-weight:650;}',
          '.kpi-spark{margin-top:auto;padding-top:10px;}.kpi-spark svg{display:block;width:100%;height:42px;}',
          '.sec{display:flex;align-items:center;gap:10px;margin:24px 0 12px;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--fl-muted);}',
          '.sec::after{content:"";flex:1;height:1px;background:var(--fl-border);}',
          '.grid{display:grid;gap:14px;align-items:start;}.g21{grid-template-columns:2fr 1fr;}.g12{grid-template-columns:1fr 2fr;}.g11{grid-template-columns:1fr 1fr;}.g111{grid-template-columns:1fr 1fr 1fr;}',
          '.panel{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;box-shadow:var(--fl-shadow);padding:16px 18px;min-width:0;}',
          '.panel-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px;}',
          '.panel-t{font-size:13.5px;font-weight:700;color:var(--fl-text);}',
          '.panel-link{background:none;border:0;padding:0;cursor:pointer;font-family:inherit;font-size:12px;font-weight:650;color:var(--ax);}.panel-link:hover{text-decoration:underline;}',
          '.rows{display:flex;flex-direction:column;}',
          '.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--fl-border);}.row:first-child{border-top:0;padding-top:2px;}.rows .row:last-child{padding-bottom:2px;}',
          '.row-main{min-width:0;flex:1;}',
          '.row-title{font-size:13.5px;font-weight:600;color:var(--fl-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
          '.row-sub{margin-top:2px;font-size:12px;color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
          '.row-r{text-align:right;flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;}',
          '.amt{font-size:13.5px;font-weight:700;color:var(--fl-text);font-variant-numeric:tabular-nums;}',
          '.pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;}',
          '.chip{font-size:11.5px;font-weight:650;color:var(--fl-faint);white-space:nowrap;font-variant-numeric:tabular-nums;}',
          '.bar-row{display:grid;grid-template-columns:minmax(90px,150px) 1fr 46px;align-items:center;gap:10px;padding:5px 0;}',
          '.bar-name{font-size:12.5px;color:var(--fl-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
          '.bar-track{height:8px;border-radius:5px;background:var(--fl-track);overflow:hidden;}',
          '.bar-fill{height:100%;width:0;border-radius:5px;background:var(--fl-accent);transition:width .9s cubic-bezier(.22,1,.36,1);}',
          '.bar-val{font-size:12.5px;font-weight:700;color:var(--fl-text);text-align:right;font-variant-numeric:tabular-nums;}',
          '.q-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;border:1px solid var(--fl-border);background:var(--fl-surface-2);margin-top:8px;position:relative;overflow:hidden;}',
          '.q-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--q,var(--fl-accent));}',
          '.day{margin-top:14px;}.day:first-child{margin-top:0;}',
          '.day-h{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--fl-faint);padding-bottom:4px;}',
          '.sch{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--fl-border);}',
          '.sch-t{flex:none;width:58px;font-size:12.5px;font-weight:700;color:var(--ax);font-variant-numeric:tabular-nums;}',
          '.acts{display:flex;flex-wrap:wrap;gap:10px;}',
          '.act{display:inline-flex;align-items:center;gap:9px;background:var(--fl-surface);border:1px solid var(--fl-border);color:var(--fl-text);border-radius:12px;padding:10px 14px;cursor:pointer;font-family:inherit;font-weight:600;font-size:13px;transition:border-color .15s ease,transform .06s ease,box-shadow .15s ease;}',
          '.act:hover{border-color:color-mix(in srgb,var(--fl-accent) 50%,transparent);box-shadow:var(--fl-shadow);}.act:active{transform:translateY(1px);}',
          '.act svg{width:16px;height:16px;color:var(--ax);}',
          '.empty{padding:22px 12px;text-align:center;color:var(--fl-muted);font-size:13px;line-height:1.5;}',
          '.empty svg{width:22px;height:22px;color:var(--fl-faint);display:block;margin:0 auto 8px;}',
          '.link-btn{background:none;border:0;padding:4px 0;color:var(--ax);cursor:pointer;font-family:inherit;font-weight:650;font-size:13px;}.link-btn:hover{text-decoration:underline;}',
          '.reveal{opacity:0;transform:translateY(10px);animation:flin .55s cubic-bezier(.22,1,.36,1) forwards;}',
          '@keyframes flin{to{opacity:1;transform:none;}}',
          '@media (prefers-reduced-motion:reduce){.reveal{animation:none;opacity:1;transform:none;}.bar-fill{transition:none;}}',
          '@media(max-width:960px){.kpis{grid-template-columns:1fr 1fr;}.g21,.g12,.g11,.g111{grid-template-columns:1fr;}}',
          '@media(max-width:600px){.wrap{padding:20px 14px 48px;}.kpi-hero{grid-column:1/-1;}.kpis .kpi:last-child:nth-child(even){grid-column:1/-1;}.hdr-r{width:100%;flex-wrap:wrap;}.hdr-r .btn{flex:1;justify-content:center;}.bar-row{grid-template-columns:minmax(76px,110px) 1fr 40px;}.title{font-size:21px;}}',
          '.steps{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;}',
          '.st{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2.5px 8px;border-radius:999px;background:var(--fl-track);color:var(--fl-faint);}',
          '.st svg{width:9px;height:9px;}',
          '.st-on{background:color-mix(in srgb,var(--fl-good) 15%,transparent);color:var(--fl-good);}',
        ].join('\n'),
        js: [
          "var FL=window.FormLogic;",
          "var RM=false;try{RM=window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}",
          "function h(v){return FL.escapeHtml(v==null?'':String(v));}",
          "function num(v){var x=parseFloat(v);return isNaN(x)?0:x;}",
          "function fmtInt(v){return num(v).toLocaleString();}",
          "function mny(v,c){return (c||'$')+num(v).toLocaleString(undefined,{maximumFractionDigits:0});}",
          "function mnyC(v,c){var x=num(v);if(Math.abs(x)>=1000000)return (c||'$')+(x/1000000).toFixed(1).replace(/\\.0$/,'')+'M';if(Math.abs(x)>=10000)return (c||'$')+Math.round(x/1000)+'k';return mny(x,c);}",
          "function pd(s){if(!s)return null;var d=new Date(s);return isNaN(d.getTime())?null:d;}",
          "function fmtDate(s){var d=pd(s);return d?d.toLocaleDateString(undefined,{month:'short',day:'numeric'}):'\\u2014';}",
          "function fmtDateY(s){var d=pd(s);return d?d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'\\u2014';}",
          "function sot(){var d=new Date();d.setHours(0,0,0,0);return d.getTime();}",
          "function dayDiff(s){var d=pd(s);if(!d)return null;var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();return Math.round((x-sot())/86400000);}",
          "function ago(s){var dd=dayDiff(s);if(dd==null)return '';if(dd===0)return 'today';if(dd<0)return (-dd)+'d ago';return 'in '+dd+'d';}",
          "function fmtTime(s){if(!s)return '';var m=String(s).match(/^(\\d{1,2}):(\\d{2})/);if(!m)return String(s);var hh=parseInt(m[1],10);var ap=hh>=12?'pm':'am';hh=hh%12;if(hh===0)hh=12;return hh+':'+m[2]+ap;}",
          "function findForm(ctx,name){var t=String(name).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}return null;}",
          "function optionMap(form,fieldId){var m={};if(!form||!form.fields)return m;for(var i=0;i<form.fields.length;i++){var f=form.fields[i];if(f.id===fieldId&&f.properties&&f.properties.options){var o=f.properties.options;for(var j=0;j<o.length;j++){m[o[j].value]=o[j].label;}}}return m;}",
          "function labelFor(map,v){if(v==null||v==='')return '\\u2014';return map[v]||String(v);}",
          "async function recs(form,limit){if(!form)return [];try{return await FL.records(form.formId,{limit:limit||500});}catch(e){return [];}}",
          "function nameMap(records,fn){var m={};for(var i=0;i<records.length;i++){var r=records[i];m[r.id]=fn(r.answers||{},r)||'';}return m;}",
          "function refName(map,v){if(v==null||v==='')return '';if(Array.isArray(v))v=v[0];return map[v]||'';}",
          "function countBy(records,fieldId){var c={};for(var i=0;i<records.length;i++){var v=(records[i].answers||{})[fieldId];if(Array.isArray(v)){for(var k=0;k<v.length;k++){if(v[k]!=null&&v[k]!=='')c[v[k]]=(c[v[k]]||0)+1;}}else if(v!=null&&v!==''){c[v]=(c[v]||0)+1;}}return c;}",
          "function sumBy(records,fieldId){var t=0;for(var i=0;i<records.length;i++){t+=num((records[i].answers||{})[fieldId]);}return t;}",
          "function weekly(records,weeks){weeks=weeks||8;var out=[];for(var i=0;i<weeks;i++)out.push(0);var now=Date.now();for(var r=0;r<records.length;r++){var d=pd(records[r].submittedAt);if(!d)continue;var wk=Math.floor((now-d.getTime())/604800000);if(wk>=0&&wk<weeks)out[weeks-1-wk]++;}return out;}",
          "function icoSvg(d){return '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">'+d+'</svg>';}",
          "var I={};",
          "I.plus=icoSvg('<path d=\"M12 5v14M5 12h14\"/>');",
          "I.user=icoSvg('<circle cx=\"12\" cy=\"8\" r=\"3.5\"/><path d=\"M4.5 20.5c.7-3.4 3.7-5 7.5-5s6.8 1.6 7.5 5\"/>');",
          "I.users=icoSvg('<circle cx=\"9\" cy=\"8.5\" r=\"3.25\"/><path d=\"M2.5 20c.6-3 3.2-4.5 6.5-4.5s5.9 1.5 6.5 4.5\"/><path d=\"M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17.6 15.9c2 .6 3.5 1.9 3.9 4.1\"/>');",
          "I.doc=icoSvg('<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5M9 13h6M9 17h4\"/>');",
          "I.cal=icoSvg('<rect x=\"4\" y=\"5\" width=\"16\" height=\"15.5\" rx=\"2.5\"/><path d=\"M8 3v4M16 3v4M4 10.5h16\"/>');",
          "I.clock=icoSvg('<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/>');",
          "I.chart=icoSvg('<path d=\"M5 20v-7M11 20V6M17 20v-4\"/><path d=\"M3 20h18\"/>');",
          "I.check=icoSvg('<path d=\"M4.5 12.5l4.7 4.7L19.5 6.9\"/>');",
          "I.alert=icoSvg('<path d=\"M12 4 2.8 19.5h18.4z\"/><path d=\"M12 10v4M12 16.8h.01\"/>');",
          "I.arrow=icoSvg('<path d=\"M5 12h14M13 6l6 6-6 6\"/>');",
          "I.money=icoSvg('<path d=\"M12 2.5v19\"/><path d=\"M16.5 6H9.75a3.25 3.25 0 0 0 0 6.5h4.5a3.25 3.25 0 0 1 0 6.5H7\"/>');",
          "I.box=icoSvg('<path d=\"M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2z\"/><path d=\"M3.3 8.3 12 13.3l8.7-5M12 13.3V21\"/>');",
          "I.wrench=icoSvg('<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>');",
          "I.shield=icoSvg('<path d=\"M12 3l7.5 2.8v5.4c0 4.3-3 7.7-7.5 9-4.5-1.3-7.5-4.7-7.5-9V5.8z\"/>');",
          "I.home=icoSvg('<path d=\"M4 11.5 12 4l8 7.5\"/><path d=\"M6 10v10h12V10\"/>');",
          "I.tag=icoSvg('<path d=\"M3.5 11.3V4.5a1 1 0 0 1 1-1h6.8a1 1 0 0 1 .7.3l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0L3.8 12a1 1 0 0 1-.3-.7z\"/><circle cx=\"8\" cy=\"8\" r=\"1.25\"/>');",
          "function spark(vals,w,hh){w=w||220;hh=hh||42;if(!vals||vals.length<2)return '';var mx=0,mn=Infinity;for(var i=0;i<vals.length;i++){if(vals[i]>mx)mx=vals[i];if(vals[i]<mn)mn=vals[i];}if(mx===0)return '';if(mn===mx)mn=0;var rng=mx-mn||1;var pts=[];for(var j=0;j<vals.length;j++){var x=2+(j/(vals.length-1))*(w-4);var y=(hh-5)-((vals[j]-mn)/rng)*(hh-12);pts.push(x.toFixed(1)+','+y.toFixed(1));}var line=pts.join(' ');return '<svg viewBox=\"0 0 '+w+' '+hh+'\" preserveAspectRatio=\"none\" aria-hidden=\"true\"><polygon points=\"2,'+(hh-2)+' '+line+' '+(w-2)+','+(hh-2)+'\" fill=\"color-mix(in srgb, var(--fl-accent) 12%, transparent)\" stroke=\"none\"/><polyline points=\"'+line+'\" fill=\"none\" stroke=\"var(--fl-accent)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>';}",
          "function pill(text,kind){var c=kind==='good'?'var(--fl-good)':kind==='warn'?'var(--fl-warn)':kind==='bad'?'var(--fl-bad)':kind==='accent'?'var(--ax)':'var(--fl-muted)';var bg=(kind==='neutral'||!kind)?'var(--fl-track)':'color-mix(in srgb, '+c+' 15%, transparent)';return '<span class=\"pill\" style=\"color:'+c+';background:'+bg+'\">'+h(text)+'</span>';}",
          "function kpi(label,val,sub,opts){opts=opts||{};var v=(typeof val==='number')?'<span data-count=\"'+val+'\">'+fmtInt(val)+'</span>':val;return '<div class=\"kpi'+(opts.hero?' kpi-hero':'')+'\"><div class=\"kpi-label\">'+h(label)+'</div><div class=\"kpi-val\">'+v+'</div>'+(sub?'<div class=\"kpi-sub\">'+sub+'</div>':'')+(opts.spark?'<div class=\"kpi-spark\">'+opts.spark+'</div>':'')+'</div>';}",
          "function sec(label){return '<div class=\"sec\">'+h(label)+'</div>';}",
          "function panel(title,body,nav,navLabel){return '<div class=\"panel\">'+(title?'<div class=\"panel-h\"><div class=\"panel-t\">'+h(title)+'</div>'+(nav?'<button class=\"panel-link\" data-nav=\"'+h(nav)+'\">'+h(navLabel||'View all')+'</button>':'')+'</div>':'')+body+'</div>';}",
          "function barRow(label,count,max,color){var pct=max>0?Math.max(3,Math.round(count/max*100)):0;return '<div class=\"bar-row\"><span class=\"bar-name\" title=\"'+h(label)+'\">'+h(label)+'</span><div class=\"bar-track\"><div class=\"bar-fill\" data-pct=\"'+pct+'\" style=\"background:'+(color||'var(--fl-accent)')+'\"></div></div><span class=\"bar-val\">'+fmtInt(count)+'</span></div>';}",
          "function breakdown(records,fieldId,map,opts){opts=opts||{};var counts=countBy(records,fieldId);var keys=Object.keys(map);for(var k in counts){if(keys.indexOf(k)===-1)keys.push(k);}var max=0,total=0;for(var i=0;i<keys.length;i++){var c=counts[keys[i]]||0;if(c>max)max=c;total+=c;}if(total===0)return '';keys.sort(function(a,b){return (counts[b]||0)-(counts[a]||0);});var out='';for(var j=0;j<keys.length;j++){var n2=counts[keys[j]]||0;if(n2===0)continue;out+=barRow(labelFor(map,keys[j]),n2,max,opts.color);}return out;}",
          "function rowItem(title,sub,right){return '<div class=\"row\"><div class=\"row-main\"><div class=\"row-title\">'+title+'</div>'+(sub?'<div class=\"row-sub\">'+sub+'</div>':'')+'</div>'+(right?'<div class=\"row-r\">'+right+'</div>':'')+'</div>';}",
          "function qRow(color,title,sub,right){return '<div class=\"q-row\" style=\"--q:'+color+'\"><div class=\"row-main\"><div class=\"row-title\">'+title+'</div>'+(sub?'<div class=\"row-sub\">'+sub+'</div>':'')+'</div>'+(right?'<div class=\"row-r\">'+right+'</div>':'')+'</div>';}",
          "function emptyBlock(ic,msg,nav,cta){return '<div class=\"empty\">'+(ic||'')+h(msg)+(nav?'<div><button class=\"link-btn\" data-nav=\"'+h(nav)+'\">'+h(cta||'+ Add one')+'</button></div>':'')+'</div>';}",
          "function acts(items){var out='<div class=\"acts\">';for(var i=0;i<items.length;i++){var it=items[i];if(!it||!it.nav)continue;out+='<button class=\"act\" data-nav=\"'+h(it.nav)+'\">'+(it.icon||I.plus)+'<span>'+h(it.label)+'</span></button>';}out+='</div>';return out;}",
          "function brief(clauses){var cs=[];for(var i=0;i<clauses.length;i++){if(clauses[i])cs.push(clauses[i]);}return cs.join('<span class=\"dot\">\\u00b7</span>');}",
          "function headerBlock(glyph,titleText,briefHtml,ctas){var out='<div class=\"hdr\"><div class=\"hdr-l\"><div class=\"glyph\">'+glyph+'</div><div style=\"min-width:0\"><h1 class=\"title\">'+h(titleText)+'</h1>'+(briefHtml?'<div class=\"brief\">'+briefHtml+'</div>':'')+'</div></div>';if(ctas&&ctas.length){out+='<div class=\"hdr-r\">';for(var i=0;i<ctas.length;i++){var c2=ctas[i];if(!c2||!c2.nav)continue;out+='<button class=\"btn '+(c2.ghost?'btn-ghost':'btn-primary')+'\" data-nav=\"'+h(c2.nav)+'\">'+(c2.icon||'')+'<span>'+h(c2.label)+'</span></button>';}out+='</div>';}out+='</div>';return out;}",
          "function countUp(el){var target=parseFloat(el.getAttribute('data-count'));if(isNaN(target)||target<=0)return;var t0=null,dur=700;function step(ts){if(t0===null)t0=ts;var p=Math.min(1,(ts-t0)/dur);var e=1-Math.pow(1-p,3);el.textContent=Math.round(target*e).toLocaleString();if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}",
          "function wire(root){var nav=root.querySelectorAll('[data-nav]');for(var i=0;i<nav.length;i++){(function(el){el.addEventListener('click',function(){var t=el.getAttribute('data-nav');if(t)FL.navigate(t);});})(nav[i]);}var kids=root.querySelectorAll('.wrap > *');for(var k2=0;k2<kids.length;k2++){kids[k2].classList.add('reveal');kids[k2].style.animationDelay=(Math.min(k2,8)*60)+'ms';}requestAnimationFrame(function(){requestAnimationFrame(function(){var f=root.querySelectorAll('.bar-fill');for(var j2=0;j2<f.length;j2++){f[j2].style.width=(f[j2].getAttribute('data-pct')||0)+'%';}});});if(!RM){var cs2=root.querySelectorAll('[data-count]');for(var m2=0;m2<cs2.length;m2++){countUp(cs2[m2]);}}}",
          "function fatal(root,msg){root.innerHTML='<div class=\"wrap\"><div class=\"load\">'+h(msg)+'</div></div>';}",
          "var GLYPH=icoSvg('<rect x=\"3.5\" y=\"7\" width=\"17\" height=\"13\" rx=\"2.5\"/><path d=\"M9 7V5.5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2V7M3.5 12.5h17M12 11v3\"/>');",
          "I.folder=icoSvg('<path d=\"M3.5 6.5a2 2 0 0 1 2-2h4.2l2 2.5h6.8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z\"/>');",
          "I.clip=icoSvg('<path d=\"M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2\"/><rect x=\"9\" y=\"2.5\" width=\"6\" height=\"3\" rx=\"1\"/><path d=\"M8.75 13.25l2.3 2.3 4.2-4.8\"/>');",
          "async function main(){",
          "  var root=document.getElementById('app');",
          "  var ctx;try{ctx=await FL.context();}catch(e){return fatal(root,'Could not load this dashboard.');}",
          "  var fClient=findForm(ctx,'New Client Onboarding');var fRisk=findForm(ctx,'Risk Tolerance Questionnaire');var fCrs=findForm(ctx,'Form CRS & Relationship Summary');var fDocs=findForm(ctx,'Document Vault');var fW9=findForm(ctx,'W-9 Form');var fBene=findForm(ctx,'Beneficiary Designation');",
          "  var d=await Promise.all([recs(fClient),recs(fRisk),recs(fCrs),recs(fDocs),recs(fW9),recs(fBene)]);",
          "  var clients=d[0],risks=d[1],crs=d[2],docs=d[3],w9s=d[4],benes=d[5];",
          "  var accredited=0;for(var i=0;i<clients.length;i++){if(String((clients[i].answers||{}).accredited_investor||'').toLowerCase()==='yes')accredited++;}",
          "  var flagged=0;for(var r2=0;r2<risks.length;r2++){if(String((risks[r2].answers||{}).reg_bi_check||'').toLowerCase().indexOf('review')===0)flagged++;}",
          "  var book=sumBy(clients,'net_worth');",
          "  var cliMap=nameMap(clients,function(a){return ((a.first_name||'')+' '+(a.last_name||'')).trim();});",
          "  function linkSet(rows){var s={};for(var x=0;x<rows.length;x++){var v=(rows[x].answers||{}).client_record;if(Array.isArray(v)){for(var y=0;y<v.length;y++){if(v[y])s[v[y]]=1;}}else if(v){s[v]=1;}}return s;}",
          "  var stepDefs=[['Risk',linkSet(risks)],['CRS',linkSet(crs)],['W-9',linkSet(w9s)],['Beneficiary',linkSet(benes)],['Docs',linkSet(docs)]];",
          "  var pipe='';var np=Math.min(6,clients.length);",
          "  for(var p=0;p<np;p++){var c=clients[p];var a=c.answers||{};var nm=((a.first_name||'')+' '+(a.last_name||'')).trim()||'Unnamed client';var chips='';var done=0;for(var s2=0;s2<stepDefs.length;s2++){var on=!!stepDefs[s2][1][c.id];if(on)done++;chips+='<span class=\"st'+(on?' st-on':'')+'\">'+(on?I.check:'')+h(stepDefs[s2][0])+'</span>';}pipe+='<div class=\"row\"><div class=\"row-main\"><div class=\"row-title\">'+h(nm)+'</div><div class=\"steps\">'+chips+'</div></div><div class=\"row-r\"><span class=\"amt\">'+done+'/5</span><span class=\"chip\">'+fmtDate(c.submittedAt)+'</span></div></div>';}",
          "  pipe=np?'<div class=\"rows\">'+pipe+'</div>':emptyBlock(I.user,'New clients will appear here with their onboarding checklist.',fClient?fClient.formId:'','+ Onboard a client');",
          "  var objMap=optionMap(fClient,'investment_objectives');",
          "  var objBody=breakdown(clients,'investment_objectives',objMap)||emptyBlock(I.chart,'Objective mix charts here once clients are onboarded.',fClient?fClient.formId:'','+ Onboard a client');",
          "  var rec='';var nr=Math.min(5,clients.length);",
          "  for(var q=0;q<nr;q++){var rc=clients[q];var ra=rc.answers||{};var rnm=((ra.first_name||'')+' '+(ra.last_name||'')).trim()||'Unnamed client';var isAcc=String(ra.accredited_investor||'').toLowerCase()==='yes';var rs=ra.risk_score;rec+=rowItem(h(rnm),fmtDate(rc.submittedAt)+((rs!=null&&rs!=='')?' \\u00b7 Risk '+h(rs):''),'<span class=\"amt\">'+h(mnyC(ra.net_worth))+'</span>'+pill(isAcc?'Accredited':'Standard',isAcc?'good':'neutral'));}",
          "  rec=nr?'<div class=\"rows\">'+rec+'</div>':emptyBlock(I.user,'Your book of business builds here.',fClient?fClient.formId:'','+ Onboard a client');",
          "  var dtMap=optionMap(fDocs,'document_type');",
          "  var expRows=[];for(var e2=0;e2<docs.length;e2++){var dd=dayDiff((docs[e2].answers||{}).expiry_date);if(dd!=null&&dd<=60)expRows.push([dd,docs[e2]]);}expRows.sort(function(x,y){return x[0]-y[0];});",
          "  var vault='';",
          "  if(expRows.length){for(var v2=0;v2<Math.min(5,expRows.length);v2++){var er=expRows[v2][1];var ea=er.answers||{};var edd=expRows[v2][0];var who=refName(cliMap,ea.client_record);vault+=qRow(edd<0?'var(--fl-bad)':'var(--fl-warn)',h(ea.document_name||labelFor(dtMap,ea.document_type)),h(labelFor(dtMap,ea.document_type))+(who?' \\u00b7 '+h(who):''),'<span class=\"chip\">'+(edd<0?'expired '+(-edd)+'d ago':(edd===0?'expires today':'expires in '+edd+'d'))+'</span>');}}",
          "  else if(docs.length){vault=breakdown(docs,'document_type',dtMap);}",
          "  else{vault=emptyBlock(I.folder,'Client documents and their expiry dates are tracked here.',fDocs?fDocs.formId:'','+ Upload a document');}",
          "  var wk=weekly(clients);var tw=wk[wk.length-1];",
          "  var kp='';",
          "  kp+=kpi('Clients onboarded',clients.length,clients.length?'<b>'+tw+'</b> this week \\u00b7 <b>'+risks.length+'</b> risk profiles on file':'No clients yet \\u00b7 onboard your first',{hero:true,spark:spark(wk)});",
          "  kp+=kpi('Accredited investors',accredited,clients.length?'<b>'+Math.round(accredited/clients.length*100)+'%</b> of book':'\\u2014');",
          "  kp+=kpi('Book net worth',h(mnyC(book)),'across <b>'+clients.length+'</b> client'+(clients.length===1?'':'s'));",
          "  kp+=kpi('Risk reviews flagged',flagged,flagged>0?pill('Needs attention','warn'):'All suitable');",
          "  var html='<div class=\"wrap\">';",
          "  html+=headerBlock(GLYPH,ctx.appName||'Client Onboarding Navigator',brief(['<b>'+fmtInt(clients.length)+'</b> clients','<b>'+fmtInt(accredited)+'</b> accredited','<b>'+h(mnyC(book))+'</b> book net worth','<b>'+fmtInt(flagged)+'</b> risk review'+(flagged===1?'':'s')+' flagged']),[fClient?{nav:fClient.formId,label:'New client',icon:I.plus}:null,fDocs?{nav:fDocs.formId,label:'Upload document',icon:I.folder,ghost:true}:null]);",
          "  html+='<div class=\"kpis\">'+kp+'</div>';",
          "  html+=sec('Onboarding pipeline')+'<div class=\"grid g21\">'+panel('Checklist by client',pipe,fClient?'form/'+fClient.formId+'/responses':'')+panel('By investment objective',objBody,fClient?'form/'+fClient.formId+'/responses':'')+'</div>';",
          "  html+=sec('Book of business')+'<div class=\"grid g11\">'+panel('Recent clients',rec,fClient?'form/'+fClient.formId+'/responses':'')+panel('Document vault',vault,fDocs?'form/'+fDocs.formId+'/responses':'')+'</div>';",
          "  html+=sec('Quick actions')+acts([fClient?{nav:fClient.formId,label:'Onboard client',icon:I.user}:null,fRisk?{nav:fRisk.formId,label:'Risk questionnaire',icon:I.chart}:null,fCrs?{nav:fCrs.formId,label:'CRS disclosure',icon:I.clip}:null,fDocs?{nav:fDocs.formId,label:'Upload document',icon:I.folder}:null,fW9?{nav:fW9.formId,label:'W-9 form',icon:I.doc}:null,fBene?{nav:fBene.formId,label:'Beneficiary designation',icon:I.users}:null]);",
          "  html+='</div>';root.innerHTML=html;wire(root);",
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
      settings: { icon: 'Send' },
      theme: {
        primaryColor: '#059669',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      customScreen: {
        enabled: true,
        html: '<div id="app"><div class="wrap"><div class="load">Loading dashboard…</div></div></div>',
        css: [
          '@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:200 800;font-display:swap;src:url(https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}',
          ':root{--ax:var(--fl-accent);}',
          'html.fl-dark{--ax:color-mix(in srgb,var(--fl-accent) 62%,#fff);}',
          '*{box-sizing:border-box;}html,body{margin:0;padding:0;}',
          'body{font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(1000px 320px at 12% -100px,color-mix(in srgb,var(--fl-accent) 7%,transparent),transparent) var(--fl-bg);}',
          '.wrap{max-width:1120px;margin:0 auto;padding:28px 24px 64px;}',
          '.num{font-variant-numeric:tabular-nums lining-nums;}',
          ':focus-visible{outline:2px solid var(--fl-accent);outline-offset:2px;border-radius:4px;}',
          '.load{padding:90px 20px;text-align:center;color:var(--fl-muted);font-size:13.5px;}',
          '.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px;}',
          '.hdr-l{display:flex;gap:14px;min-width:0;align-items:flex-start;flex:1;}',
          '.glyph{width:40px;height:40px;flex:none;display:grid;place-items:center;border-radius:12px;color:var(--ax);background:color-mix(in srgb,var(--fl-accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--fl-accent) 22%,transparent);}',
          '.glyph svg{width:22px;height:22px;}',
          '.title{margin:1px 0 0;font-size:24px;line-height:1.12;font-weight:750;letter-spacing:-0.02em;color:var(--fl-text);}',
          '.brief{margin-top:7px;font-size:13px;line-height:1.55;color:var(--fl-muted);}',
          '.brief b{color:var(--fl-text);font-weight:650;font-variant-numeric:tabular-nums;}',
          '.brief .dot{margin:0 7px;color:var(--fl-faint);}',
          '.hdr-r{display:flex;gap:10px;flex:none;align-items:center;padding-top:2px;}',
          '.btn{appearance:none;cursor:pointer;border-radius:11px;padding:10px 16px;font-weight:650;font-size:13.5px;font-family:inherit;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;transition:filter .15s ease,transform .06s ease,border-color .15s ease;}',
          '.btn:active{transform:translateY(1px);}.btn svg{width:16px;height:16px;}',
          '.btn-primary{border:0;background:var(--fl-accent);color:var(--fl-accent-contrast);box-shadow:0 8px 20px -10px color-mix(in srgb,var(--fl-accent) 70%,transparent);}.btn-primary:hover{filter:brightness(1.07);}',
          '.btn-ghost{background:transparent;border:1px solid var(--fl-border);color:var(--fl-text);}.btn-ghost:hover{border-color:color-mix(in srgb,var(--fl-accent) 45%,transparent);}',
          '.kpis{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:14px;}',
          '.kpi{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;padding:16px 18px;box-shadow:var(--fl-shadow);min-width:0;display:flex;flex-direction:column;}.kpi:not(.kpi-hero){justify-content:center;}',
          '.kpi-label{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--fl-muted);}',
          '.kpi-val{margin-top:7px;font-size:25px;font-weight:800;letter-spacing:-0.02em;line-height:1.05;color:var(--fl-text);font-variant-numeric:tabular-nums;}',
          '.kpi-hero .kpi-val{font-size:33px;}',
          '.kpi-sub{margin-top:5px;font-size:12px;color:var(--fl-faint);}.kpi-sub b{color:var(--fl-muted);font-weight:650;}',
          '.kpi-spark{margin-top:auto;padding-top:10px;}.kpi-spark svg{display:block;width:100%;height:42px;}',
          '.sec{display:flex;align-items:center;gap:10px;margin:24px 0 12px;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--fl-muted);}',
          '.sec::after{content:"";flex:1;height:1px;background:var(--fl-border);}',
          '.grid{display:grid;gap:14px;align-items:start;}.g21{grid-template-columns:2fr 1fr;}.g12{grid-template-columns:1fr 2fr;}.g11{grid-template-columns:1fr 1fr;}.g111{grid-template-columns:1fr 1fr 1fr;}',
          '.panel{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;box-shadow:var(--fl-shadow);padding:16px 18px;min-width:0;}',
          '.panel-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px;}',
          '.panel-t{font-size:13.5px;font-weight:700;color:var(--fl-text);}',
          '.panel-link{background:none;border:0;padding:0;cursor:pointer;font-family:inherit;font-size:12px;font-weight:650;color:var(--ax);}.panel-link:hover{text-decoration:underline;}',
          '.rows{display:flex;flex-direction:column;}',
          '.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--fl-border);}.row:first-child{border-top:0;padding-top:2px;}.rows .row:last-child{padding-bottom:2px;}',
          '.row-main{min-width:0;flex:1;}',
          '.row-title{font-size:13.5px;font-weight:600;color:var(--fl-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
          '.row-sub{margin-top:2px;font-size:12px;color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
          '.row-r{text-align:right;flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;}',
          '.amt{font-size:13.5px;font-weight:700;color:var(--fl-text);font-variant-numeric:tabular-nums;}',
          '.pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;}',
          '.chip{font-size:11.5px;font-weight:650;color:var(--fl-faint);white-space:nowrap;font-variant-numeric:tabular-nums;}',
          '.bar-row{display:grid;grid-template-columns:minmax(90px,150px) 1fr 46px;align-items:center;gap:10px;padding:5px 0;}',
          '.bar-name{font-size:12.5px;color:var(--fl-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
          '.bar-track{height:8px;border-radius:5px;background:var(--fl-track);overflow:hidden;}',
          '.bar-fill{height:100%;width:0;border-radius:5px;background:var(--fl-accent);transition:width .9s cubic-bezier(.22,1,.36,1);}',
          '.bar-val{font-size:12.5px;font-weight:700;color:var(--fl-text);text-align:right;font-variant-numeric:tabular-nums;}',
          '.q-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;border:1px solid var(--fl-border);background:var(--fl-surface-2);margin-top:8px;position:relative;overflow:hidden;}',
          '.q-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--q,var(--fl-accent));}',
          '.day{margin-top:14px;}.day:first-child{margin-top:0;}',
          '.day-h{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--fl-faint);padding-bottom:4px;}',
          '.sch{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--fl-border);}',
          '.sch-t{flex:none;width:58px;font-size:12.5px;font-weight:700;color:var(--ax);font-variant-numeric:tabular-nums;}',
          '.acts{display:flex;flex-wrap:wrap;gap:10px;}',
          '.act{display:inline-flex;align-items:center;gap:9px;background:var(--fl-surface);border:1px solid var(--fl-border);color:var(--fl-text);border-radius:12px;padding:10px 14px;cursor:pointer;font-family:inherit;font-weight:600;font-size:13px;transition:border-color .15s ease,transform .06s ease,box-shadow .15s ease;}',
          '.act:hover{border-color:color-mix(in srgb,var(--fl-accent) 50%,transparent);box-shadow:var(--fl-shadow);}.act:active{transform:translateY(1px);}',
          '.act svg{width:16px;height:16px;color:var(--ax);}',
          '.empty{padding:22px 12px;text-align:center;color:var(--fl-muted);font-size:13px;line-height:1.5;}',
          '.empty svg{width:22px;height:22px;color:var(--fl-faint);display:block;margin:0 auto 8px;}',
          '.link-btn{background:none;border:0;padding:4px 0;color:var(--ax);cursor:pointer;font-family:inherit;font-weight:650;font-size:13px;}.link-btn:hover{text-decoration:underline;}',
          '.reveal{opacity:0;transform:translateY(10px);animation:flin .55s cubic-bezier(.22,1,.36,1) forwards;}',
          '@keyframes flin{to{opacity:1;transform:none;}}',
          '@media (prefers-reduced-motion:reduce){.reveal{animation:none;opacity:1;transform:none;}.bar-fill{transition:none;}}',
          '@media(max-width:960px){.kpis{grid-template-columns:1fr 1fr;}.g21,.g12,.g11,.g111{grid-template-columns:1fr;}}',
          '@media(max-width:600px){.wrap{padding:20px 14px 48px;}.kpi-hero{grid-column:1/-1;}.kpis .kpi:last-child:nth-child(even){grid-column:1/-1;}.hdr-r{width:100%;flex-wrap:wrap;}.hdr-r .btn{flex:1;justify-content:center;}.bar-row{grid-template-columns:minmax(76px,110px) 1fr 40px;}.title{font-size:21px;}}',
        ].join('\n'),
        js: [
          "var FL=window.FormLogic;",
          "var RM=false;try{RM=window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}",
          "function h(v){return FL.escapeHtml(v==null?'':String(v));}",
          "function num(v){var x=parseFloat(v);return isNaN(x)?0:x;}",
          "function fmtInt(v){return num(v).toLocaleString();}",
          "function mny(v,c){return (c||'$')+num(v).toLocaleString(undefined,{maximumFractionDigits:0});}",
          "function mnyC(v,c){var x=num(v);if(Math.abs(x)>=1000000)return (c||'$')+(x/1000000).toFixed(1).replace(/\\.0$/,'')+'M';if(Math.abs(x)>=10000)return (c||'$')+Math.round(x/1000)+'k';return mny(x,c);}",
          "function pd(s){if(!s)return null;var d=new Date(s);return isNaN(d.getTime())?null:d;}",
          "function fmtDate(s){var d=pd(s);return d?d.toLocaleDateString(undefined,{month:'short',day:'numeric'}):'\\u2014';}",
          "function fmtDateY(s){var d=pd(s);return d?d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'\\u2014';}",
          "function sot(){var d=new Date();d.setHours(0,0,0,0);return d.getTime();}",
          "function dayDiff(s){var d=pd(s);if(!d)return null;var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();return Math.round((x-sot())/86400000);}",
          "function ago(s){var dd=dayDiff(s);if(dd==null)return '';if(dd===0)return 'today';if(dd<0)return (-dd)+'d ago';return 'in '+dd+'d';}",
          "function fmtTime(s){if(!s)return '';var m=String(s).match(/^(\\d{1,2}):(\\d{2})/);if(!m)return String(s);var hh=parseInt(m[1],10);var ap=hh>=12?'pm':'am';hh=hh%12;if(hh===0)hh=12;return hh+':'+m[2]+ap;}",
          "function findForm(ctx,name){var t=String(name).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}return null;}",
          "function optionMap(form,fieldId){var m={};if(!form||!form.fields)return m;for(var i=0;i<form.fields.length;i++){var f=form.fields[i];if(f.id===fieldId&&f.properties&&f.properties.options){var o=f.properties.options;for(var j=0;j<o.length;j++){m[o[j].value]=o[j].label;}}}return m;}",
          "function labelFor(map,v){if(v==null||v==='')return '\\u2014';return map[v]||String(v);}",
          "async function recs(form,limit){if(!form)return [];try{return await FL.records(form.formId,{limit:limit||500});}catch(e){return [];}}",
          "function nameMap(records,fn){var m={};for(var i=0;i<records.length;i++){var r=records[i];m[r.id]=fn(r.answers||{},r)||'';}return m;}",
          "function refName(map,v){if(v==null||v==='')return '';if(Array.isArray(v))v=v[0];return map[v]||'';}",
          "function countBy(records,fieldId){var c={};for(var i=0;i<records.length;i++){var v=(records[i].answers||{})[fieldId];if(Array.isArray(v)){for(var k=0;k<v.length;k++){if(v[k]!=null&&v[k]!=='')c[v[k]]=(c[v[k]]||0)+1;}}else if(v!=null&&v!==''){c[v]=(c[v]||0)+1;}}return c;}",
          "function sumBy(records,fieldId){var t=0;for(var i=0;i<records.length;i++){t+=num((records[i].answers||{})[fieldId]);}return t;}",
          "function weekly(records,weeks){weeks=weeks||8;var out=[];for(var i=0;i<weeks;i++)out.push(0);var now=Date.now();for(var r=0;r<records.length;r++){var d=pd(records[r].submittedAt);if(!d)continue;var wk=Math.floor((now-d.getTime())/604800000);if(wk>=0&&wk<weeks)out[weeks-1-wk]++;}return out;}",
          "function icoSvg(d){return '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">'+d+'</svg>';}",
          "var I={};",
          "I.plus=icoSvg('<path d=\"M12 5v14M5 12h14\"/>');",
          "I.user=icoSvg('<circle cx=\"12\" cy=\"8\" r=\"3.5\"/><path d=\"M4.5 20.5c.7-3.4 3.7-5 7.5-5s6.8 1.6 7.5 5\"/>');",
          "I.users=icoSvg('<circle cx=\"9\" cy=\"8.5\" r=\"3.25\"/><path d=\"M2.5 20c.6-3 3.2-4.5 6.5-4.5s5.9 1.5 6.5 4.5\"/><path d=\"M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17.6 15.9c2 .6 3.5 1.9 3.9 4.1\"/>');",
          "I.doc=icoSvg('<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5M9 13h6M9 17h4\"/>');",
          "I.cal=icoSvg('<rect x=\"4\" y=\"5\" width=\"16\" height=\"15.5\" rx=\"2.5\"/><path d=\"M8 3v4M16 3v4M4 10.5h16\"/>');",
          "I.clock=icoSvg('<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/>');",
          "I.chart=icoSvg('<path d=\"M5 20v-7M11 20V6M17 20v-4\"/><path d=\"M3 20h18\"/>');",
          "I.check=icoSvg('<path d=\"M4.5 12.5l4.7 4.7L19.5 6.9\"/>');",
          "I.alert=icoSvg('<path d=\"M12 4 2.8 19.5h18.4z\"/><path d=\"M12 10v4M12 16.8h.01\"/>');",
          "I.arrow=icoSvg('<path d=\"M5 12h14M13 6l6 6-6 6\"/>');",
          "I.money=icoSvg('<path d=\"M12 2.5v19\"/><path d=\"M16.5 6H9.75a3.25 3.25 0 0 0 0 6.5h4.5a3.25 3.25 0 0 1 0 6.5H7\"/>');",
          "I.box=icoSvg('<path d=\"M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2z\"/><path d=\"M3.3 8.3 12 13.3l8.7-5M12 13.3V21\"/>');",
          "I.wrench=icoSvg('<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>');",
          "I.shield=icoSvg('<path d=\"M12 3l7.5 2.8v5.4c0 4.3-3 7.7-7.5 9-4.5-1.3-7.5-4.7-7.5-9V5.8z\"/>');",
          "I.home=icoSvg('<path d=\"M4 11.5 12 4l8 7.5\"/><path d=\"M6 10v10h12V10\"/>');",
          "I.tag=icoSvg('<path d=\"M3.5 11.3V4.5a1 1 0 0 1 1-1h6.8a1 1 0 0 1 .7.3l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0L3.8 12a1 1 0 0 1-.3-.7z\"/><circle cx=\"8\" cy=\"8\" r=\"1.25\"/>');",
          "function spark(vals,w,hh){w=w||220;hh=hh||42;if(!vals||vals.length<2)return '';var mx=0,mn=Infinity;for(var i=0;i<vals.length;i++){if(vals[i]>mx)mx=vals[i];if(vals[i]<mn)mn=vals[i];}if(mx===0)return '';if(mn===mx)mn=0;var rng=mx-mn||1;var pts=[];for(var j=0;j<vals.length;j++){var x=2+(j/(vals.length-1))*(w-4);var y=(hh-5)-((vals[j]-mn)/rng)*(hh-12);pts.push(x.toFixed(1)+','+y.toFixed(1));}var line=pts.join(' ');return '<svg viewBox=\"0 0 '+w+' '+hh+'\" preserveAspectRatio=\"none\" aria-hidden=\"true\"><polygon points=\"2,'+(hh-2)+' '+line+' '+(w-2)+','+(hh-2)+'\" fill=\"color-mix(in srgb, var(--fl-accent) 12%, transparent)\" stroke=\"none\"/><polyline points=\"'+line+'\" fill=\"none\" stroke=\"var(--fl-accent)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>';}",
          "function pill(text,kind){var c=kind==='good'?'var(--fl-good)':kind==='warn'?'var(--fl-warn)':kind==='bad'?'var(--fl-bad)':kind==='accent'?'var(--ax)':'var(--fl-muted)';var bg=(kind==='neutral'||!kind)?'var(--fl-track)':'color-mix(in srgb, '+c+' 15%, transparent)';return '<span class=\"pill\" style=\"color:'+c+';background:'+bg+'\">'+h(text)+'</span>';}",
          "function kpi(label,val,sub,opts){opts=opts||{};var v=(typeof val==='number')?'<span data-count=\"'+val+'\">'+fmtInt(val)+'</span>':val;return '<div class=\"kpi'+(opts.hero?' kpi-hero':'')+'\"><div class=\"kpi-label\">'+h(label)+'</div><div class=\"kpi-val\">'+v+'</div>'+(sub?'<div class=\"kpi-sub\">'+sub+'</div>':'')+(opts.spark?'<div class=\"kpi-spark\">'+opts.spark+'</div>':'')+'</div>';}",
          "function sec(label){return '<div class=\"sec\">'+h(label)+'</div>';}",
          "function panel(title,body,nav,navLabel){return '<div class=\"panel\">'+(title?'<div class=\"panel-h\"><div class=\"panel-t\">'+h(title)+'</div>'+(nav?'<button class=\"panel-link\" data-nav=\"'+h(nav)+'\">'+h(navLabel||'View all')+'</button>':'')+'</div>':'')+body+'</div>';}",
          "function barRow(label,count,max,color){var pct=max>0?Math.max(3,Math.round(count/max*100)):0;return '<div class=\"bar-row\"><span class=\"bar-name\" title=\"'+h(label)+'\">'+h(label)+'</span><div class=\"bar-track\"><div class=\"bar-fill\" data-pct=\"'+pct+'\" style=\"background:'+(color||'var(--fl-accent)')+'\"></div></div><span class=\"bar-val\">'+fmtInt(count)+'</span></div>';}",
          "function breakdown(records,fieldId,map,opts){opts=opts||{};var counts=countBy(records,fieldId);var keys=Object.keys(map);for(var k in counts){if(keys.indexOf(k)===-1)keys.push(k);}var max=0,total=0;for(var i=0;i<keys.length;i++){var c=counts[keys[i]]||0;if(c>max)max=c;total+=c;}if(total===0)return '';keys.sort(function(a,b){return (counts[b]||0)-(counts[a]||0);});var out='';for(var j=0;j<keys.length;j++){var n2=counts[keys[j]]||0;if(n2===0)continue;out+=barRow(labelFor(map,keys[j]),n2,max,opts.color);}return out;}",
          "function rowItem(title,sub,right){return '<div class=\"row\"><div class=\"row-main\"><div class=\"row-title\">'+title+'</div>'+(sub?'<div class=\"row-sub\">'+sub+'</div>':'')+'</div>'+(right?'<div class=\"row-r\">'+right+'</div>':'')+'</div>';}",
          "function qRow(color,title,sub,right){return '<div class=\"q-row\" style=\"--q:'+color+'\"><div class=\"row-main\"><div class=\"row-title\">'+title+'</div>'+(sub?'<div class=\"row-sub\">'+sub+'</div>':'')+'</div>'+(right?'<div class=\"row-r\">'+right+'</div>':'')+'</div>';}",
          "function emptyBlock(ic,msg,nav,cta){return '<div class=\"empty\">'+(ic||'')+h(msg)+(nav?'<div><button class=\"link-btn\" data-nav=\"'+h(nav)+'\">'+h(cta||'+ Add one')+'</button></div>':'')+'</div>';}",
          "function acts(items){var out='<div class=\"acts\">';for(var i=0;i<items.length;i++){var it=items[i];if(!it||!it.nav)continue;out+='<button class=\"act\" data-nav=\"'+h(it.nav)+'\">'+(it.icon||I.plus)+'<span>'+h(it.label)+'</span></button>';}out+='</div>';return out;}",
          "function brief(clauses){var cs=[];for(var i=0;i<clauses.length;i++){if(clauses[i])cs.push(clauses[i]);}return cs.join('<span class=\"dot\">\\u00b7</span>');}",
          "function headerBlock(glyph,titleText,briefHtml,ctas){var out='<div class=\"hdr\"><div class=\"hdr-l\"><div class=\"glyph\">'+glyph+'</div><div style=\"min-width:0\"><h1 class=\"title\">'+h(titleText)+'</h1>'+(briefHtml?'<div class=\"brief\">'+briefHtml+'</div>':'')+'</div></div>';if(ctas&&ctas.length){out+='<div class=\"hdr-r\">';for(var i=0;i<ctas.length;i++){var c2=ctas[i];if(!c2||!c2.nav)continue;out+='<button class=\"btn '+(c2.ghost?'btn-ghost':'btn-primary')+'\" data-nav=\"'+h(c2.nav)+'\">'+(c2.icon||'')+'<span>'+h(c2.label)+'</span></button>';}out+='</div>';}out+='</div>';return out;}",
          "function countUp(el){var target=parseFloat(el.getAttribute('data-count'));if(isNaN(target)||target<=0)return;var t0=null,dur=700;function step(ts){if(t0===null)t0=ts;var p=Math.min(1,(ts-t0)/dur);var e=1-Math.pow(1-p,3);el.textContent=Math.round(target*e).toLocaleString();if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}",
          "function wire(root){var nav=root.querySelectorAll('[data-nav]');for(var i=0;i<nav.length;i++){(function(el){el.addEventListener('click',function(){var t=el.getAttribute('data-nav');if(t)FL.navigate(t);});})(nav[i]);}var kids=root.querySelectorAll('.wrap > *');for(var k2=0;k2<kids.length;k2++){kids[k2].classList.add('reveal');kids[k2].style.animationDelay=(Math.min(k2,8)*60)+'ms';}requestAnimationFrame(function(){requestAnimationFrame(function(){var f=root.querySelectorAll('.bar-fill');for(var j2=0;j2<f.length;j2++){f[j2].style.width=(f[j2].getAttribute('data-pct')||0)+'%';}});});if(!RM){var cs2=root.querySelectorAll('[data-count]');for(var m2=0;m2<cs2.length;m2++){countUp(cs2[m2]);}}}",
          "function fatal(root,msg){root.innerHTML='<div class=\"wrap\"><div class=\"load\">'+h(msg)+'</div></div>';}",
          "var GLYPH=icoSvg('<path d=\"M16.5 3.5 20 7l-3.5 3.5\"/><path d=\"M20 7H8.5A4.5 4.5 0 0 0 4 11.5\"/><path d=\"M7.5 20.5 4 17l3.5-3.5\"/><path d=\"M4 17h11.5A4.5 4.5 0 0 0 20 12.5\"/>');",
          "I.swap=GLYPH;",
          "I.roll=icoSvg('<path d=\"M20 12a8 8 0 1 1-2.34-5.66\"/><path d=\"M20 3.5V8h-4.5\"/>');",
          "I.receipt=icoSvg('<path d=\"M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z\"/><path d=\"M9 8.5h6M9 12h6\"/>');",
          "async function main(){",
          "  var root=document.getElementById('app');",
          "  var ctx;try{ctx=await FL.context();}catch(e){return fatal(root,'Could not load this dashboard.');}",
          "  var fClient=findForm(ctx,'New Client Onboarding');var fAcat=findForm(ctx,'ACAT / Transfer Form');var fReview=findForm(ctx,'Annual Client Review');var fFee=findForm(ctx,'Fee Agreement');var fExch=findForm(ctx,'1035 Exchange');var fRoll=findForm(ctx,'Rollover Form');",
          "  var d=await Promise.all([recs(fClient),recs(fAcat),recs(fReview),recs(fFee),recs(fExch),recs(fRoll)]);",
          "  var clients=d[0],acat=d[1],reviews=d[2],fees=d[3],exch=d[4],roll=d[5];",
          "  var cliMap=nameMap(clients,function(a){return ((a.first_name||'')+' '+(a.last_name||'')).trim();});",
          "  var inTransfer=sumBy(acat,'estimated_value');var aum=sumBy(fees,'account_value');var rollVal=sumBy(roll,'estimated_value');var exchVal=sumBy(exch,'estimated_value');var surr=sumBy(exch,'surrender_charges');",
          "  var moving=acat.length+roll.length+exch.length;var inMotion=inTransfer+rollVal+exchVal;",
          "  var due45=0;for(var i=0;i<reviews.length;i++){var dd0=dayDiff((reviews[i].answers||{}).next_review_date);if(dd0!=null&&dd0>=0&&dd0<=45)due45++;}",
          "  var custMap=optionMap(fAcat,'custodian');var ttMap=optionMap(fAcat,'transfer_type');var rtMap=optionMap(fRoll,'rollover_type');var exMap=optionMap(fExch,'exchange_type');",
          "  var moves=[];",
          "  for(var a2=0;a2<acat.length;a2++){var aa=acat[a2].answers||{};moves.push({when:acat[a2].submittedAt,kind:'ACAT',k:'accent',who:refName(cliMap,aa.client_record)||'Client',sub:labelFor(custMap,aa.custodian)+' \\u00b7 '+labelFor(ttMap,aa.transfer_type)+' transfer',amt:num(aa.estimated_value)});}",
          "  for(var b2=0;b2<roll.length;b2++){var ba=roll[b2].answers||{};moves.push({when:roll[b2].submittedAt,kind:'Rollover',k:'good',who:refName(cliMap,ba.client_record)||'Client',sub:labelFor(rtMap,ba.rollover_type)+' \\u00b7 to '+(ba.receiving_custodian?String(ba.receiving_custodian):'new custodian'),amt:num(ba.estimated_value)});}",
          "  for(var c2=0;c2<exch.length;c2++){var ca=exch[c2].answers||{};moves.push({when:exch[c2].submittedAt,kind:'1035',k:'warn',who:refName(cliMap,ca.client_record)||'Client',sub:labelFor(exMap,ca.exchange_type)+' \\u00b7 to '+(ca.new_carrier?String(ca.new_carrier):'new carrier'),amt:num(ca.estimated_value)});}",
          "  moves.sort(function(x,y){var xd=pd(x.when),yd=pd(y.when);return (yd?yd.getTime():0)-(xd?xd.getTime():0);});",
          "  var mv='';var nm2=Math.min(8,moves.length);",
          "  for(var m2=0;m2<nm2;m2++){var mo=moves[m2];mv+=rowItem(h(mo.who),h(mo.sub)+' \\u00b7 '+fmtDate(mo.when),'<span class=\"amt\">'+h(mnyC(mo.amt))+'</span>'+pill(mo.kind,mo.k));}",
          "  mv=nm2?'<div class=\"rows\">'+mv+'</div>':emptyBlock(I.arrow,'ACAT transfers, rollovers, and 1035 exchanges land here as they are filed.',fAcat?fAcat.formId:'','+ Start a transfer');",
          "  var custBody=breakdown(acat,'custodian',custMap)||emptyBlock(I.chart,'Custodian mix charts here once transfers are filed.',fAcat?fAcat.formId:'','+ Start a transfer');",
          "  var dueRows=[];for(var r2=0;r2<reviews.length;r2++){var rr=reviews[r2].answers||{};var dd2=dayDiff(rr.next_review_date);if(dd2!=null&&dd2<=60)dueRows.push([dd2,reviews[r2]]);}dueRows.sort(function(x,y){return x[0]-y[0];});",
          "  var rq='';",
          "  if(dueRows.length){for(var u=0;u<Math.min(5,dueRows.length);u++){var dr=dueRows[u][1];var da=dr.answers||{};var ddx=dueRows[u][0];rq+=qRow(ddx<0?'var(--fl-bad)':(ddx<14?'var(--fl-warn)':'var(--fl-accent)'),h(refName(cliMap,da.client_record)||'Client'),(ddx<0?'Overdue '+(-ddx)+'d':(ddx===0?'Due today':'Due in '+ddx+'d'))+' \\u00b7 '+fmtDate(da.next_review_date),'<span class=\"amt\">'+h(mnyC(da.current_aum))+'</span>');}}",
          "  else if(reviews.length){for(var u2=0;u2<Math.min(5,reviews.length);u2++){var da2=reviews[u2].answers||{};rq+=qRow('var(--fl-accent)',h(refName(cliMap,da2.client_record)||'Client'),'Reviewed '+fmtDate(reviews[u2].submittedAt)+' \\u00b7 next '+fmtDate(da2.next_review_date),'<span class=\"amt\">'+h(mnyC(da2.current_aum))+'</span>');}}",
          "  else{rq=emptyBlock(I.cal,'Annual review deadlines queue here.',fReview?fReview.formId:'','+ Log a review');}",
          "  var tierMap=optionMap(fFee,'fee_tier');var billMap=optionMap(fFee,'billing_frequency');",
          "  var fa='';var nf=Math.min(5,fees.length);",
          "  for(var v2=0;v2<nf;v2++){var fr=fees[v2].answers||{};var tier=String(fr.fee_tier||'');fa+=rowItem(h(refName(cliMap,fr.client_record)||'Client'),h(labelFor(billMap,fr.billing_frequency))+' billing \\u00b7 effective '+fmtDate(fr.effective_date),'<span class=\"amt\">'+h(mnyC(fr.account_value))+'</span>'+pill(labelFor(tierMap,fr.fee_tier),tier==='institutional'?'good':(tier==='premium'?'accent':'neutral')));}",
          "  fa=nf?'<div class=\"rows\">'+fa+'</div>':emptyBlock(I.money,'Signed fee agreements list here with AUM and tier.',fFee?fFee.formId:'','+ New fee agreement');",
          "  var kp='';",
          "  kp+=kpi('Assets in transfer',h(mnyC(inTransfer)),acat.length?'<b>'+acat.length+'</b> ACAT transfer'+(acat.length===1?'':'s')+' in flight':'No transfers yet',{hero:true,spark:spark(weekly(acat))});",
          "  kp+=kpi('AUM under agreement',h(mnyC(aum)),'<b>'+fees.length+'</b> agreement'+(fees.length===1?'':'s')+' signed');",
          "  kp+=kpi('Rollovers',roll.length,'<b>'+h(mnyC(rollVal))+'</b> moving');",
          "  kp+=kpi('1035 exchanges',exch.length,surr>0?'<span style=\"color:var(--fl-warn);font-weight:650\">'+h(mnyC(surr))+' in surrender charges</span>':'No surrender charges');",
          "  var html='<div class=\"wrap\">';",
          "  html+=headerBlock(GLYPH,ctx.appName||'Advisor Transition Hub',brief(['<b>'+fmtInt(moving)+'</b> movement'+(moving===1?'':'s')+' in flight','<b>'+h(mnyC(inMotion))+'</b> in motion','<b>'+fmtInt(due45)+'</b> review'+(due45===1?'':'s')+' due in 45d']),[fAcat?{nav:fAcat.formId,label:'New transfer',icon:I.plus}:null,fReview?{nav:fReview.formId,label:'Log review',icon:I.cal,ghost:true}:null]);",
          "  html+='<div class=\"kpis\">'+kp+'</div>';",
          "  html+=sec('Assets in motion')+'<div class=\"grid g21\">'+panel('Latest movements',mv,fAcat?'form/'+fAcat.formId+'/responses':'')+panel('Transfers by custodian',custBody,fAcat?'form/'+fAcat.formId+'/responses':'')+'</div>';",
          "  html+=sec('Re-papering & reviews')+'<div class=\"grid g11\">'+panel('Reviews due',rq,fReview?'form/'+fReview.formId+'/responses':'')+panel('Recent fee agreements',fa,fFee?'form/'+fFee.formId+'/responses':'')+'</div>';",
          "  html+=sec('Quick actions')+acts([fAcat?{nav:fAcat.formId,label:'New ACAT transfer',icon:I.swap}:null,fRoll?{nav:fRoll.formId,label:'New rollover',icon:I.roll}:null,fExch?{nav:fExch.formId,label:'New 1035 exchange',icon:I.receipt}:null,fFee?{nav:fFee.formId,label:'New fee agreement',icon:I.money}:null,fReview?{nav:fReview.formId,label:'Log annual review',icon:I.cal}:null,fClient?{nav:fClient.formId,label:'Onboard client',icon:I.user}:null]);",
          "  html+='</div>';root.innerHTML=html;wire(root);",
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
