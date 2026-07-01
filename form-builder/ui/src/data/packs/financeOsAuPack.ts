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

export const financeOsAuPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'finance-os-au',
    name: 'Finance OS (Australia)',
    description:
      'Comprehensive advisory workflow for Australian Financial Services Licensees (AFSLs), covering client onboarding, Best Interest Duty compliance, superannuation, and AUSTRAC requirements.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['finance', 'compliance', 'onboarding', 'wealth-management', 'australia', 'afsl'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. New Client Onboarding ─────────────────────────────────────────
    {
      packFormId: 'au-client-intake',
      title: 'New Client Onboarding',
      icon: 'UserPlus',
      description:
        'Collect personal, financial, and regulatory information for new advisory clients under Australian regulations.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Welcome to Client Onboarding',
          description:
            'This form collects personal, financial, and regulatory information required to establish your advisory relationship. All data is handled in accordance with the Privacy Act 1988.',
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
          properties: { placeholder: 'you@example.com.au' },
        },
        {
          id: 'phone',
          type: 'phone',
          label: 'Phone Number',
          required: true,
          properties: { placeholder: '04XX XXX XXX' },
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
          id: 'tfn',
          type: 'short_text',
          label: 'Tax File Number (TFN)',
          required: true,
          properties: { placeholder: '###-###-###' },
          validation: [
            {
              id: 'tfn_pattern',
              type: 'pattern',
              value: '^\\d{3}-?\\d{3}-?\\d{3}$',
              message: 'Please enter a valid TFN (e.g. 123-456-789).',
            },
          ],
        },
        {
          id: 'address',
          type: 'long_text',
          label: 'Residential Address',
          required: true,
          properties: { placeholder: 'Street, Suburb, State, Postcode' },
        },
        {
          id: 'residency_status',
          type: 'dropdown',
          label: 'Residency Status',
          required: true,
          properties: {
            options: [
              { id: 'au_citizen', label: 'Australian Citizen', value: 'au_citizen' },
              { id: 'permanent_resident', label: 'Permanent Resident', value: 'permanent_resident' },
              { id: 'temporary_visa', label: 'Temporary Visa Holder', value: 'temporary_visa' },
              { id: 'non_resident', label: 'Non-Resident', value: 'non_resident' },
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
          label: 'Annual Income (AUD)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'net_assets',
          type: 'number',
          label: 'Net Assets (AUD)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'liquid_assets',
          type: 'number',
          label: 'Liquid Assets (AUD)',
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
          id: 'wholesale_status',
          type: 'calculated',
          label: 'Wholesale Client Status',
          description: 'Corporations Act s761G: gross income >= $250k OR net assets >= $2.5M.',
          required: false,
          properties: {
            calculationExpression: 'annual_income >= 250000 || net_assets >= 2500000 ? "Yes" : "No"',
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
          description:
            'Thank you for completing the onboarding form. Your adviser will review the information and reach out with next steps.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 2. Risk Profile Assessment ──────────────────────────────────────
    {
      packFormId: 'au-risk-questionnaire',
      title: 'Risk Profile Assessment',
      icon: 'Scale',
      description:
        'Assess client risk tolerance and generate a suitability profile for Best Interest Duty compliance.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'client_age',
          type: 'number',
          label: 'Client Age',
          description: "Confirm the client's current age for suitability calculations.",
          required: true,
          properties: { placeholder: 'Age', min: 18, max: 120 },
        },
        {
          id: 'client_income',
          type: 'number',
          label: 'Annual Income (AUD)',
          description: "Confirm the client's annual income for suitability analysis.",
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'client_net_assets',
          type: 'number',
          label: 'Net Assets (AUD)',
          description: "Confirm the client's total net assets.",
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
              { id: 'hold', label: 'Hold and wait', value: 'hold' },
              { id: 'buy', label: 'Buy more at the discount', value: 'buy' },
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
          id: 'recommended_profile',
          type: 'dropdown',
          label: 'Recommended Risk Profile',
          description: 'Select the recommended risk profile for this client.',
          required: true,
          properties: {
            options: [
              { id: 'defensive', label: 'Defensive', value: 'defensive' },
              { id: 'conservative', label: 'Conservative', value: 'conservative' },
              { id: 'balanced', label: 'Balanced', value: 'balanced' },
              { id: 'growth', label: 'Growth', value: 'growth' },
              { id: 'high_growth', label: 'High Growth', value: 'high_growth' },
            ],
          },
        },
        {
          id: 'risk_profile_score',
          type: 'calculated',
          label: 'Risk Profile Score',
          description:
            'Weighted suitability score (1-100) based on age, income, net assets, tolerance, and horizon.',
          required: false,
          properties: {
            calculationExpression: 'Math.round((loss_capacity * 5) + (time_horizon * 2) + ((120 - client_age) / 2))',
          },
        },
        {
          id: 'best_interest_statement',
          type: 'statement',
          label: 'Best Interest Duty',
          description:
            'Under s961B of the Corporations Act 2001 (Safe Harbour), the adviser must demonstrate that the advice is in the best interest of the client by taking reasonable steps to ascertain the client\'s relevant circumstances, objectives, and financial situation.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 3. Off-Market Transfer ───────────────────────────────────────────
    {
      packFormId: 'au-off-market-transfer',
      title: 'Off-Market Transfer',
      icon: 'Send',
      description:
        'Initiate an off-market transfer of securities between platforms.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'delivering_platform',
          type: 'dropdown',
          label: 'Delivering Platform',
          required: true,
          properties: {
            options: [
              { id: 'bt_panorama', label: 'BT Panorama', value: 'bt_panorama' },
              { id: 'macquarie', label: 'Macquarie Wrap', value: 'macquarie' },
              { id: 'netwealth', label: 'Netwealth', value: 'netwealth' },
              { id: 'cfs', label: 'CFS FirstChoice', value: 'cfs_firstchoice' },
              { id: 'hub24', label: 'HUB24', value: 'hub24' },
              { id: 'other_dp', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'hin_or_srn',
          type: 'short_text',
          label: 'HIN or SRN',
          required: true,
          properties: { placeholder: 'e.g. X0001234567 or 0001234567' },
          validation: [
            {
              id: 'hin_srn_pattern',
              type: 'pattern',
              value: '^[A-Z]?\\d{10}$',
              message: 'Please enter a valid HIN (X + 10 digits) or SRN (10 digits).',
            },
          ],
        },
        {
          id: 'account_reference',
          type: 'short_text',
          label: 'Account Reference',
          required: true,
          properties: { placeholder: 'Platform account reference' },
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
          properties: { placeholder: 'List specific securities/holdings to transfer' },
          conditionalLogic: {
            expression: 'transfer_type == "partial"',
            action: 'show',
          },
        },
        {
          id: 'estimated_value',
          type: 'number',
          label: 'Estimated Value (AUD)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'transfer_fee',
          type: 'calculated',
          label: 'Estimated Transfer Fee',
          required: false,
          properties: {
            calculationExpression: '54.50',
          },
        },
        {
          id: 'chess_sponsorship',
          type: 'multiple_choice',
          label: 'CHESS Sponsorship',
          required: true,
          properties: {
            options: [
              { id: 'broker_sponsored', label: 'Broker-Sponsored', value: 'broker_sponsored' },
              { id: 'issuer_sponsored', label: 'Issuer-Sponsored', value: 'issuer_sponsored' },
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

    // ── 4. Financial Services Guide Acknowledgement ──────────────────────
    {
      packFormId: 'au-fsg-acknowledgement',
      title: 'Financial Services Guide Acknowledgement',
      icon: 'FileCheck',
      description:
        'Client acknowledgement of the Financial Services Guide (FSG) as required under the Corporations Act 2001.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'fsg_intro_statement',
          type: 'statement',
          label: 'Financial Services Guide',
          description:
            'This Financial Services Guide (FSG) is designed to help you decide whether to use any of the financial services we offer. It contains important information about the services we provide, how we and our associates are paid, and how we handle complaints.',
          required: false,
          properties: {},
        },
        {
          id: 'services_statement',
          type: 'statement',
          label: 'Services We Provide',
          description:
            'We are authorised to provide personal financial product advice on superannuation, retirement planning, investment strategies, insurance, and wealth accumulation under our Australian Financial Services Licence (AFSL).',
          required: false,
          properties: {},
        },
        {
          id: 'fees_statement',
          type: 'statement',
          label: 'How We Are Paid',
          description:
            'Our fees are based on a percentage of funds under advice, charged monthly or quarterly in arrears. All fees are inclusive of GST. A detailed Fee Disclosure Statement will be provided separately.',
          required: false,
          properties: {},
        },
        {
          id: 'conflicts_statement',
          type: 'statement',
          label: 'Associations & Conflicts of Interest',
          description:
            'We may receive referral fees or commissions from product issuers. Any material associations, relationships, or conflicts of interest that could influence our advice will be disclosed in the Statement of Advice (SOA).',
          required: false,
          properties: {},
        },
        {
          id: 'complaints_statement',
          type: 'statement',
          label: 'Complaints',
          description:
            'If you have a complaint about our services, please contact us directly. If we are unable to resolve your complaint, you can lodge it with the Australian Financial Complaints Authority (AFCA): GPO Box 3, Melbourne VIC 3001 | 1800 931 678 | info@afca.org.au.',
          required: false,
          properties: {},
        },
        {
          id: 'privacy_statement',
          type: 'statement',
          label: 'Privacy',
          description:
            'We collect, use, and store your personal information in accordance with the Privacy Act 1988 and the Australian Privacy Principles. Your information will only be shared with third parties where required to provide our services or as required by law.',
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
      ],
    },

    // ── 5. Annual Client Review ──────────────────────────────────────────
    {
      packFormId: 'au-annual-review',
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
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'current_portfolio_value',
          type: 'number',
          label: 'Current Portfolio Value (AUD)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'current_annual_fee',
          type: 'calculated',
          label: 'Current Annual Fee',
          description: 'Tiered advisory fee based on current portfolio value (GST inclusive).',
          required: false,
          properties: {
            calculationExpression: 'current_portfolio_value <= 500000 ? (current_portfolio_value * 0.011) : current_portfolio_value <= 1000000 ? (current_portfolio_value * 0.0088) : (current_portfolio_value * 0.0077)',
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
              { id: 'child', label: 'New Child', value: 'child' },
              { id: 'retirement', label: 'Retirement', value: 'retirement' },
              { id: 'job', label: 'Job Change', value: 'job' },
              { id: 'inheritance', label: 'Inheritance', value: 'inheritance' },
              { id: 'super_event', label: 'Superannuation Event', value: 'superannuation_event' },
              { id: 'none_lc', label: 'None', value: 'none' },
            ],
          },
        },
        {
          id: 'updated_risk_tolerance',
          type: 'scale',
          label: 'Updated Risk Tolerance',
          description:
            '1 = Very conservative, 10 = Very aggressive. Leave unchanged if risk profile has not shifted.',
          required: false,
          properties: { min: 1, max: 10, step: 1 },
        },
        {
          id: 'soa_required',
          type: 'statement',
          label: 'Statement of Advice Requirement',
          description:
            'If life changes have occurred, a new Statement of Advice (SOA) may be required to ensure ongoing compliance with the Best Interest Duty under s961B of the Corporations Act.',
          required: false,
          properties: {},
        },
        {
          id: 'advisor_notes',
          type: 'long_text',
          label: 'Adviser Notes',
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

    // ── 6. Fee Disclosure Statement ──────────────────────────────────────
    {
      packFormId: 'au-fee-agreement',
      title: 'Fee Disclosure Statement',
      icon: 'DollarSign',
      description:
        'Establish advisory fee terms and ongoing fee consent as required under the Corporations Act.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'portfolio_value',
          type: 'number',
          label: 'Portfolio Value (AUD)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'fee_type',
          type: 'dropdown',
          label: 'Fee Type',
          required: true,
          properties: {
            options: [
              { id: 'percentage', label: 'Percentage of FUA', value: 'percentage' },
              { id: 'fixed', label: 'Fixed Fee', value: 'fixed' },
              { id: 'combination', label: 'Combination', value: 'combination' },
            ],
          },
        },
        {
          id: 'calculated_annual_fee',
          type: 'calculated',
          label: 'Calculated Annual Fee',
          description: 'Tiered advisory fee based on portfolio value (GST inclusive).',
          required: false,
          properties: {
            calculationExpression: 'portfolio_value <= 500000 ? (portfolio_value * 0.011) : portfolio_value <= 1000000 ? (portfolio_value * 0.0088) : (portfolio_value * 0.0077)',
          },
        },
        {
          id: 'ongoing_fee_consent',
          type: 'multiple_choice',
          label: 'Ongoing Fee Consent',
          description:
            'Under s962H of the Corporations Act, you must provide consent for ongoing fees to be charged.',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes, I consent', value: 'yes' },
              { id: 'no', label: 'No, I do not consent', value: 'no' },
            ],
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
          id: 'fee_disclosure_statement',
          type: 'statement',
          label: 'Fee Disclosure',
          description:
            'All fees shown are inclusive of GST. This Fee Disclosure Statement is provided in accordance with Division 3 of Part 7.7A of the Corporations Act 2001.',
          required: false,
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
      packFormId: 'au-document-vault',
      title: 'Document Vault',
      icon: 'Folder',
      description:
        'Securely store and organise client documents including SOAs, PDSs, tax returns, and insurance policies.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'document_type',
          type: 'dropdown',
          label: 'Document Type',
          required: true,
          properties: {
            options: [
              { id: 'tax_return', label: 'Tax Return', value: 'tax_return' },
              { id: 'soa', label: 'Statement of Advice', value: 'soa' },
              { id: 'pds', label: 'Product Disclosure Statement', value: 'pds' },
              { id: 'insurance', label: 'Insurance Policy', value: 'insurance' },
              { id: 'super_statement', label: 'Superannuation Statement', value: 'super_statement' },
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
          description: 'Applicable for insurance policies and other time-limited documents.',
          required: false,
          properties: {},
          conditionalLogic: {
            expression: 'document_type == "insurance" || document_type == "pds" || document_type == "soa"',
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

    // ── 8. TFN Declaration ───────────────────────────────────────────────
    {
      packFormId: 'au-tfn-declaration',
      title: 'TFN Declaration',
      icon: 'FileText',
      description:
        'Tax File Number declaration for superannuation and investment accounts.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'tfn',
          type: 'short_text',
          label: 'Tax File Number',
          required: true,
          properties: { placeholder: '###-###-###' },
          validation: [
            {
              id: 'tfn_pattern',
              type: 'pattern',
              value: '^\\d{3}-?\\d{3}-?\\d{3}$',
              message: 'Please enter a valid TFN (e.g. 123-456-789).',
            },
          ],
        },
        {
          id: 'tfn_exemption',
          type: 'dropdown',
          label: 'TFN Exemption',
          description: 'If you do not provide a TFN and have no exemption, tax may be withheld at the highest marginal rate (47%).',
          required: true,
          properties: {
            options: [
              { id: 'none', label: 'None (TFN provided)', value: 'none' },
              { id: 'under_18', label: 'Under 18', value: 'under_18' },
              { id: 'pensioner', label: 'Pensioner', value: 'pensioner' },
              { id: 'not_quoted', label: 'Not Quoted', value: 'not_quoted' },
            ],
          },
        },
        {
          id: 'withholding_warning',
          type: 'statement',
          label: 'Withholding Tax Warning',
          description:
            'If no TFN is quoted and no exemption applies, tax will be withheld at 47% on all investment income and employer contributions.',
          required: false,
          properties: {},
          conditionalLogic: {
            expression: 'tfn_exemption == "not_quoted"',
            action: 'show',
          },
        },
        {
          id: 'residency_for_tax',
          type: 'dropdown',
          label: 'Residency for Tax Purposes',
          required: true,
          properties: {
            options: [
              { id: 'au_resident', label: 'Australian Resident', value: 'au_resident' },
              { id: 'foreign_resident', label: 'Foreign Resident', value: 'foreign_resident' },
              { id: 'working_holiday', label: 'Working Holiday Maker', value: 'working_holiday' },
            ],
          },
        },
        {
          id: 'tax_free_threshold',
          type: 'multiple_choice',
          label: 'Do you want to claim the tax-free threshold?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'has_hecs_help',
          type: 'multiple_choice',
          label: 'Do you have a HECS-HELP, VSL, or other study/training loan?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'declaration_date',
          type: 'date',
          label: 'Declaration Date',
          required: true,
          properties: {},
        },
        {
          id: 'signature',
          type: 'signature',
          label: 'Signature',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 9. Binding Death Benefit Nomination ──────────────────────────────
    {
      packFormId: 'au-bdbn',
      title: 'Binding Death Benefit Nomination',
      icon: 'Heart',
      description:
        'Nominate binding beneficiaries for superannuation death benefits under the SIS Act.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'super_fund_name',
          type: 'short_text',
          label: 'Superannuation Fund Name',
          required: true,
          properties: { placeholder: 'Name of the super fund' },
        },
        {
          id: 'member_number',
          type: 'short_text',
          label: 'Member Number',
          required: true,
          properties: { placeholder: 'Your member number' },
        },
        // Primary beneficiaries
        {
          id: 'primary_name_1',
          type: 'short_text',
          label: 'Primary Beneficiary 1 \u2014 Name',
          required: true,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'primary_relationship_1',
          type: 'dropdown',
          label: 'Primary Beneficiary 1 \u2014 Relationship',
          required: true,
          properties: {
            options: [
              { id: 'spouse', label: 'Spouse', value: 'spouse' },
              { id: 'child', label: 'Child', value: 'child' },
              { id: 'financial_dependent', label: 'Financial Dependent', value: 'financial_dependent' },
              { id: 'interdependency', label: 'Interdependency Relationship', value: 'interdependency' },
              { id: 'lpr', label: 'Legal Personal Representative', value: 'lpr' },
            ],
          },
        },
        {
          id: 'primary_dob_1',
          type: 'date',
          label: 'Primary Beneficiary 1 \u2014 Date of Birth',
          required: true,
          properties: {},
        },
        {
          id: 'primary_percentage_1',
          type: 'number',
          label: 'Primary Beneficiary 1 \u2014 Percentage',
          required: true,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'primary_name_2',
          type: 'short_text',
          label: 'Primary Beneficiary 2 \u2014 Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'primary_relationship_2',
          type: 'dropdown',
          label: 'Primary Beneficiary 2 \u2014 Relationship',
          required: false,
          properties: {
            options: [
              { id: 'spouse', label: 'Spouse', value: 'spouse' },
              { id: 'child', label: 'Child', value: 'child' },
              { id: 'financial_dependent', label: 'Financial Dependent', value: 'financial_dependent' },
              { id: 'interdependency', label: 'Interdependency Relationship', value: 'interdependency' },
              { id: 'lpr', label: 'Legal Personal Representative', value: 'lpr' },
            ],
          },
        },
        {
          id: 'primary_dob_2',
          type: 'date',
          label: 'Primary Beneficiary 2 \u2014 Date of Birth',
          required: false,
          properties: {},
        },
        {
          id: 'primary_percentage_2',
          type: 'number',
          label: 'Primary Beneficiary 2 \u2014 Percentage',
          required: false,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'primary_name_3',
          type: 'short_text',
          label: 'Primary Beneficiary 3 \u2014 Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'primary_relationship_3',
          type: 'dropdown',
          label: 'Primary Beneficiary 3 \u2014 Relationship',
          required: false,
          properties: {
            options: [
              { id: 'spouse', label: 'Spouse', value: 'spouse' },
              { id: 'child', label: 'Child', value: 'child' },
              { id: 'financial_dependent', label: 'Financial Dependent', value: 'financial_dependent' },
              { id: 'interdependency', label: 'Interdependency Relationship', value: 'interdependency' },
              { id: 'lpr', label: 'Legal Personal Representative', value: 'lpr' },
            ],
          },
        },
        {
          id: 'primary_dob_3',
          type: 'date',
          label: 'Primary Beneficiary 3 \u2014 Date of Birth',
          required: false,
          properties: {},
        },
        {
          id: 'primary_percentage_3',
          type: 'number',
          label: 'Primary Beneficiary 3 \u2014 Percentage',
          required: false,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        // Contingent beneficiaries
        {
          id: 'contingent_name_1',
          type: 'short_text',
          label: 'Contingent Beneficiary 1 \u2014 Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'contingent_relationship_1',
          type: 'dropdown',
          label: 'Contingent Beneficiary 1 \u2014 Relationship',
          required: false,
          properties: {
            options: [
              { id: 'spouse', label: 'Spouse', value: 'spouse' },
              { id: 'child', label: 'Child', value: 'child' },
              { id: 'financial_dependent', label: 'Financial Dependent', value: 'financial_dependent' },
              { id: 'interdependency', label: 'Interdependency Relationship', value: 'interdependency' },
              { id: 'lpr', label: 'Legal Personal Representative', value: 'lpr' },
            ],
          },
        },
        {
          id: 'contingent_percentage_1',
          type: 'number',
          label: 'Contingent Beneficiary 1 \u2014 Percentage',
          required: false,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'contingent_name_2',
          type: 'short_text',
          label: 'Contingent Beneficiary 2 \u2014 Name',
          required: false,
          properties: { placeholder: 'Full legal name' },
        },
        {
          id: 'contingent_relationship_2',
          type: 'dropdown',
          label: 'Contingent Beneficiary 2 \u2014 Relationship',
          required: false,
          properties: {
            options: [
              { id: 'spouse', label: 'Spouse', value: 'spouse' },
              { id: 'child', label: 'Child', value: 'child' },
              { id: 'financial_dependent', label: 'Financial Dependent', value: 'financial_dependent' },
              { id: 'interdependency', label: 'Interdependency Relationship', value: 'interdependency' },
              { id: 'lpr', label: 'Legal Personal Representative', value: 'lpr' },
            ],
          },
        },
        {
          id: 'contingent_percentage_2',
          type: 'number',
          label: 'Contingent Beneficiary 2 \u2014 Percentage',
          required: false,
          properties: { min: 0, max: 100, placeholder: '%' },
        },
        {
          id: 'validity_statement',
          type: 'statement',
          label: 'BDBN Validity',
          description:
            'This Binding Death Benefit Nomination is valid for 3 years from the date of signature and must be renewed before expiry to remain in effect.',
          required: false,
          properties: {},
        },
        {
          id: 'witness_1_name',
          type: 'short_text',
          label: 'Witness 1 \u2014 Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'witness_1_signature',
          type: 'signature',
          label: 'Witness 1 \u2014 Signature',
          required: true,
          properties: {},
        },
        {
          id: 'witness_1_over_18',
          type: 'checkboxes',
          label: 'Witness 1 \u2014 Confirmation',
          required: true,
          properties: {
            options: [
              { id: 'over_18', label: 'I confirm I am over 18 years of age', value: 'over_18' },
            ],
          },
        },
        {
          id: 'witness_2_name',
          type: 'short_text',
          label: 'Witness 2 \u2014 Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'witness_2_signature',
          type: 'signature',
          label: 'Witness 2 \u2014 Signature',
          required: true,
          properties: {},
        },
        {
          id: 'witness_2_over_18',
          type: 'checkboxes',
          label: 'Witness 2 \u2014 Confirmation',
          required: true,
          properties: {
            options: [
              { id: 'over_18', label: 'I confirm I am over 18 years of age', value: 'over_18' },
            ],
          },
        },
        {
          id: 'member_signature',
          type: 'signature',
          label: 'Member Signature',
          required: true,
          properties: {},
        },
        {
          id: 'nomination_date',
          type: 'date',
          label: 'Nomination Date',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 10. Superannuation Rollover ──────────────────────────────────────
    {
      packFormId: 'au-super-rollover',
      title: 'Superannuation Rollover',
      icon: 'Wallet',
      description:
        'Initiate a rollover of superannuation benefits between funds.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:au-client-intake' },
        },
        {
          id: 'from_fund_name',
          type: 'short_text',
          label: 'From Fund Name',
          required: true,
          properties: { placeholder: 'Name of the current super fund' },
        },
        {
          id: 'from_fund_abn',
          type: 'short_text',
          label: 'From Fund ABN',
          required: true,
          properties: { placeholder: 'e.g. 12345678901' },
          validation: [
            {
              id: 'abn_pattern',
              type: 'pattern',
              value: '^\\d{11}$',
              message: 'Please enter a valid 11-digit ABN.',
            },
          ],
        },
        {
          id: 'from_member_number',
          type: 'short_text',
          label: 'From Member Number',
          required: true,
          properties: { placeholder: 'Member number at current fund' },
        },
        {
          id: 'to_fund_name',
          type: 'short_text',
          label: 'To Fund Name',
          required: true,
          properties: { placeholder: 'Name of the receiving super fund' },
        },
        {
          id: 'to_fund_abn',
          type: 'short_text',
          label: 'To Fund ABN',
          required: true,
          properties: { placeholder: 'e.g. 12345678901' },
          validation: [
            {
              id: 'to_abn_pattern',
              type: 'pattern',
              value: '^\\d{11}$',
              message: 'Please enter a valid 11-digit ABN.',
            },
          ],
        },
        {
          id: 'to_member_number',
          type: 'short_text',
          label: 'To Member Number',
          required: true,
          properties: { placeholder: 'Member number at receiving fund' },
        },
        {
          id: 'rollover_type',
          type: 'multiple_choice',
          label: 'Rollover Type',
          required: true,
          properties: {
            options: [
              { id: 'full', label: 'Full Rollover', value: 'full' },
              { id: 'partial', label: 'Partial Rollover', value: 'partial' },
            ],
          },
        },
        {
          id: 'partial_amount',
          type: 'number',
          label: 'Partial Rollover Amount (AUD)',
          required: false,
          properties: { placeholder: '0', min: 0 },
          conditionalLogic: {
            expression: 'rollover_type == "partial"',
            action: 'show',
          },
        },
        {
          id: 'estimated_balance',
          type: 'number',
          label: 'Estimated Balance (AUD)',
          required: true,
          properties: { placeholder: '0', min: 0 },
        },
        {
          id: 'insurance_warning',
          type: 'statement',
          label: 'Insurance Warning',
          description:
            'Rolling over your superannuation may cancel any existing insurance cover (life, TPD, income protection) held within your current fund. Please confirm your insurance arrangements before proceeding.',
          required: false,
          properties: {},
        },
        {
          id: 'preservation_status',
          type: 'dropdown',
          label: 'Preservation Status',
          required: true,
          properties: {
            options: [
              { id: 'preserved', label: 'Preserved', value: 'preserved' },
              { id: 'restricted', label: 'Restricted Non-preserved', value: 'restricted' },
              { id: 'unrestricted', label: 'Unrestricted Non-preserved', value: 'unrestricted' },
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
    // ── 1. Client Onboarding (Australia) ─────────────────────────────────
    {
      packAppId: 'au-onboarding',
      name: 'Client Onboarding (Australia)',
      description:
        'Guide new clients through the full Australian onboarding workflow: intake, risk assessment, FSG disclosure, document collection, TFN declaration, and death benefit nominations.',
      settings: {},
      theme: {
        primaryColor: '#4f46e5',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'au-client-intake', displayName: 'New Client Onboarding', sortOrder: 1, isVisible: true },
        { packFormId: 'au-risk-questionnaire', displayName: 'Risk Profile Assessment', sortOrder: 2, isVisible: true },
        { packFormId: 'au-fsg-acknowledgement', displayName: 'FSG Acknowledgement', sortOrder: 3, isVisible: true },
        { packFormId: 'au-document-vault', displayName: 'Document Vault', sortOrder: 4, isVisible: true },
        { packFormId: 'au-tfn-declaration', displayName: 'TFN Declaration', sortOrder: 5, isVisible: true },
        { packFormId: 'au-bdbn', displayName: 'Binding Death Benefit Nomination', sortOrder: 6, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading onboarding dashboard…</div></div></div>`,
        css: `:root{--accent:#4f46e5;--accent2:#818cf8;--glow1:rgba(79,70,229,.20);--glow2:rgba(129,140,248,.10);}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
.wrap{min-height:100vh;padding:26px clamp(16px,4vw,40px) 44px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;background:radial-gradient(1100px 560px at 12% -12%,var(--glow1),transparent 60%),radial-gradient(900px 480px at 108% -6%,var(--glow2),transparent 55%),#0b1120;}
.empty{color:#94a3b8;padding:64px 20px;text-align:center;font-size:15px;}
.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px;}
.hdr h1{font-size:22px;font-weight:700;margin:0 0 4px;letter-spacing:-.01em;color:#f8fafc;}
.hdr .sub{color:#94a3b8;font-size:13px;}
.hdr .who{color:var(--accent2);font-weight:600;}
.btn{cursor:pointer;border:0;border-radius:10px;font-family:inherit;font-size:13px;font-weight:600;padding:10px 16px;transition:transform .12s ease,filter .12s ease;}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px);}
.btn-primary{background:var(--accent);color:#fff;box-shadow:0 8px 20px -8px var(--accent);}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px;}
.card{background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.14);border-radius:14px;padding:16px 18px;}
.stat .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.stat .ic{font-size:15px;opacity:.9;}
.stat .v{font-size:26px;font-weight:750;color:#f8fafc;letter-spacing:-.02em;line-height:1.05;}
.stat .l{font-size:11.5px;color:#94a3b8;margin-top:6px;text-transform:uppercase;letter-spacing:.05em;}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}
@media(max-width:820px){.panels{grid-template-columns:1fr;}}
.panel h2{font-size:14px;font-weight:700;margin:0 0 15px;color:#f1f5f9;}
.bar-row{display:grid;grid-template-columns:132px 1fr 48px;align-items:center;gap:10px;margin-bottom:11px;}
.bar-row:last-child{margin-bottom:0;}
.bar-name{font-size:12.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bar-track{height:9px;background:rgba(148,163,184,.12);border-radius:6px;overflow:hidden;}
.bar-fill{height:100%;border-radius:6px;transition:width .9s cubic-bezier(.22,1,.36,1);}
.bar-val{font-size:12.5px;color:#e2e8f0;font-weight:600;text-align:right;}
.list .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid rgba(148,163,184,.1);}
.list .row:first-child{border-top:0;padding-top:0;}
.list .nm{font-size:13.5px;color:#f1f5f9;font-weight:600;}
.list .meta{font-size:12px;color:#94a3b8;margin-top:2px;}
.badge{font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;}
.sec-title{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:700;margin:0 0 12px;}
.actions{display:flex;flex-wrap:wrap;gap:10px;}
.qa{cursor:pointer;border:1px solid rgba(148,163,184,.16);background:rgba(15,23,42,.6);color:#cbd5e1;border-radius:11px;padding:11px 15px;font-size:13px;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:9px;transition:border-color .14s,background .14s,transform .12s,color .14s;}
.qa:hover{border-color:var(--accent);background:var(--glow1);transform:translateY(-1px);color:#f8fafc;}
.qa .qi{color:var(--accent2);font-size:14px;}
.mini-empty{color:#64748b;font-size:13px;padding:14px 0;}`,
        js: `var FL=window.FormLogic;
function h(s){return FL.escapeHtml(s==null?'':String(s));}
function findForm(ctx,name){var t=String(name).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}return null;}
function optMap(form,fieldId){var m={};if(!form)return m;for(var i=0;i<form.fields.length;i++){var f=form.fields[i];if(f.id===fieldId&&f.properties&&f.properties.options){for(var j=0;j<f.properties.options.length;j++){var o=f.properties.options[j];m[o.value]=o.label;}}}return m;}
function fmtDate(v){if(!v)return '';var d=new Date(v);if(isNaN(d.getTime()))return String(v);return d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});}
function loadRecords(form){return form?FL.records(form.formId,{limit:500}).catch(function(){return [];}):Promise.resolve([]);}
function bar(label,count,max,color){var pct=(max>0&&count>0)?Math.max(4,Math.round(count/max*100)):0;return '<div class="bar-row"><span class="bar-name">'+h(label)+'</span><div class="bar-track"><div class="bar-fill" data-pct="'+pct+'" style="width:0;background:'+color+'"></div></div><span class="bar-val">'+count.toLocaleString()+'</span></div>';}
function breakdown(records,fieldId,map,palette){var order=[];var counts={};for(var k in map){order.push(k);counts[k]=0;}for(var i=0;i<records.length;i++){var a=records[i].answers||{};var v=a[fieldId];if(v==null||v==='')continue;if(Object.prototype.toString.call(v)==='[object Array]'){for(var q=0;q<v.length;q++){var vv=v[q];if(!(vv in counts)){counts[vv]=0;order.push(vv);}counts[vv]++;}}else{if(!(v in counts)){counts[v]=0;order.push(v);}counts[v]++;}}var max=0;for(var m=0;m<order.length;m++){if(counts[order[m]]>max)max=counts[order[m]];}var out='';for(var j=0;j<order.length;j++){var key=order[j];out+=bar(map[key]||key,counts[key],max,palette[j%palette.length]);}return out;}
function statCard(value,label,color,icon){return '<div class="card stat"><div class="top"><span class="dot" style="background:'+color+'"></span><span class="ic">'+icon+'</span></div><div class="v">'+value+'</div><div class="l">'+h(label)+'</div></div>';}
function qa(form,label,icon){if(!form)return '';return '<button class="qa" data-fid="'+h(form.formId)+'"><span class="qi">'+icon+'</span>'+h(label)+'</button>';}
function recentClients(records){if(!records.length)return '<div class="mini-empty">No clients onboarded yet.</div>';var out='';var n=Math.min(6,records.length);for(var i=0;i<n;i++){var a=records[i].answers||{};var name=((a.first_name||'')+' '+(a.last_name||'')).trim()||'Unnamed client';var rs=(a.risk_score!=null&&a.risk_score!=='')?('Risk score '+h(a.risk_score)):'Risk score n/a';var when=fmtDate(records[i].submittedAt);var ws=String(a.wholesale_status||'').toLowerCase()==='yes';var badge=ws?'<span class="badge" style="background:rgba(52,211,153,.15);color:#6ee7b7">Wholesale</span>':'<span class="badge" style="background:rgba(148,163,184,.14);color:#cbd5e1">Retail</span>';out+='<div class="row"><div><div class="nm">'+h(name)+'</div><div class="meta">'+rs+(when?(' · '+h(when)):'')+'</div></div>'+badge+'</div>';}return out;}
async function main(){var root=document.getElementById('app');var ctx;try{ctx=await FL.context();}catch(e){root.innerHTML='<div class="wrap"><div class="empty">Could not load dashboard.</div></div>';return;}var user=await FL.currentUser().catch(function(){return null;});var intake=findForm(ctx,'New Client Onboarding');var risk=findForm(ctx,'Risk Profile Assessment');var fsg=findForm(ctx,'FSG Acknowledgement');var vault=findForm(ctx,'Document Vault');var tfn=findForm(ctx,'TFN Declaration');var bdbn=findForm(ctx,'Binding Death Benefit Nomination');var res=await Promise.all([loadRecords(intake),loadRecords(risk),loadRecords(fsg),loadRecords(vault),loadRecords(tfn),loadRecords(bdbn)]);var rIntake=res[0],rRisk=res[1],rFsg=res[2],rVault=res[3],rTfn=res[4],rBdbn=res[5];var palette=['#4f46e5','#818cf8','#22d3ee','#34d399','#fbbf24','#f472b6'];var wholesale=0;for(var i=0;i<rIntake.length;i++){if(String((rIntake[i].answers||{}).wholesale_status||'').toLowerCase()==='yes')wholesale++;}var stages=[['Intake',rIntake.length],['Risk Profile',rRisk.length],['FSG',rFsg.length],['Documents',rVault.length],['TFN Decl.',rTfn.length],['Death Benefit',rBdbn.length]];var maxStage=0;for(var s=0;s<stages.length;s++){if(stages[s][1]>maxStage)maxStage=stages[s][1];}var pipeHtml='';for(var s2=0;s2<stages.length;s2++){pipeHtml+=bar(stages[s2][0],stages[s2][1],maxStage,palette[s2%palette.length]);}var objHtml=rIntake.length?breakdown(rIntake,'investment_objectives',optMap(intake,'investment_objectives'),palette):'<div class="mini-empty">No client data yet.</div>';var uname=user&&user.name?user.name:(user&&user.email?user.email:'');var whoHtml=uname?'<div class="sub">Signed in as <span class="who">'+h(uname)+'</span></div>':'<div class="sub">Australian advisory onboarding</div>';var newBtn=intake?'<button class="btn btn-primary" data-fid="'+h(intake.formId)+'">+ New Client</button>':'';var statsHtml=statCard(rIntake.length.toLocaleString(),'Clients',palette[0],'👥')+statCard(rRisk.length.toLocaleString(),'Risk Profiles',palette[1],'🧭')+statCard(rFsg.length.toLocaleString(),'FSG Signed',palette[2],'📄')+statCard(rVault.length.toLocaleString(),'Documents',palette[3],'🗂️')+statCard(wholesale.toLocaleString(),'Wholesale',palette[4],'🏦');var actionsHtml=qa(intake,'New Client','+')+qa(risk,'Risk Assessment','🧭')+qa(fsg,'FSG Acknowledgement','📄')+qa(vault,'Document Vault','🗂️')+qa(tfn,'TFN Declaration','🧾')+qa(bdbn,'Death Benefit Nomination','❤');root.innerHTML='<div class="wrap"><div class="hdr"><div><h1>'+h(ctx.appName||'Client Onboarding')+'</h1>'+whoHtml+'</div>'+newBtn+'</div><div class="stats">'+statsHtml+'</div><div class="panels"><div class="card panel"><h2>Onboarding Pipeline</h2>'+pipeHtml+'</div><div class="card panel"><h2>Investment Objectives</h2>'+objHtml+'</div></div><div class="card panel" style="margin-bottom:16px"><h2>Recent Clients</h2><div class="list">'+recentClients(rIntake)+'</div></div><div><p class="sec-title">Quick actions</p><div class="actions">'+actionsHtml+'</div></div></div>';var nav=root.querySelectorAll('[data-fid]');for(var n2=0;n2<nav.length;n2++){(function(el){el.addEventListener('click',function(){var id=el.getAttribute('data-fid');if(id)FL.navigate(id);});})(nav[n2]);}requestAnimationFrame(function(){requestAnimationFrame(function(){var b=root.querySelectorAll('.bar-fill');for(var i=0;i<b.length;i++){b[i].style.width=(b[i].getAttribute('data-pct')||0)+'%';}});});}
main();`,
      },
      roles: [
        {
          name: 'Adviser',
          description: 'Financial adviser managing client onboarding.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'submit_responses' },
            { packFormId: 'au-client-intake', permission: 'view_own_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'submit_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'view_own_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'submit_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'view_own_responses' },
            { packFormId: 'au-document-vault', permission: 'submit_responses' },
            { packFormId: 'au-document-vault', permission: 'view_own_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'submit_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'view_own_responses' },
            { packFormId: 'au-bdbn', permission: 'submit_responses' },
            { packFormId: 'au-bdbn', permission: 'view_own_responses' },
          ],
        },
        {
          name: 'Compliance',
          description: 'Compliance team responsible for reviewing and correcting submissions.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'view_all_responses' },
            { packFormId: 'au-client-intake', permission: 'edit_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'view_all_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'edit_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'view_all_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'edit_responses' },
            { packFormId: 'au-document-vault', permission: 'view_all_responses' },
            { packFormId: 'au-document-vault', permission: 'edit_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'view_all_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'edit_responses' },
            { packFormId: 'au-bdbn', permission: 'view_all_responses' },
            { packFormId: 'au-bdbn', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Operations',
          description: 'Operations team with full data management capabilities.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'view_all_responses' },
            { packFormId: 'au-client-intake', permission: 'edit_responses' },
            { packFormId: 'au-client-intake', permission: 'delete_responses' },
            { packFormId: 'au-client-intake', permission: 'export_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'view_all_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'edit_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'delete_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'export_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'view_all_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'edit_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'delete_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'export_responses' },
            { packFormId: 'au-document-vault', permission: 'view_all_responses' },
            { packFormId: 'au-document-vault', permission: 'edit_responses' },
            { packFormId: 'au-document-vault', permission: 'delete_responses' },
            { packFormId: 'au-document-vault', permission: 'export_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'view_all_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'edit_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'delete_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'export_responses' },
            { packFormId: 'au-bdbn', permission: 'view_all_responses' },
            { packFormId: 'au-bdbn', permission: 'edit_responses' },
            { packFormId: 'au-bdbn', permission: 'delete_responses' },
            { packFormId: 'au-bdbn', permission: 'export_responses' },
          ],
        },
        {
          name: 'Client',
          description: 'End client completing their own onboarding forms.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'submit_responses' },
            { packFormId: 'au-client-intake', permission: 'view_own_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'submit_responses' },
            { packFormId: 'au-risk-questionnaire', permission: 'view_own_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'submit_responses' },
            { packFormId: 'au-fsg-acknowledgement', permission: 'view_own_responses' },
            { packFormId: 'au-document-vault', permission: 'submit_responses' },
            { packFormId: 'au-document-vault', permission: 'view_own_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'submit_responses' },
            { packFormId: 'au-tfn-declaration', permission: 'view_own_responses' },
            { packFormId: 'au-bdbn', permission: 'submit_responses' },
            { packFormId: 'au-bdbn', permission: 'view_own_responses' },
          ],
        },
      ],
    },

    // ── 2. Portfolio Management Hub (Australia) ──────────────────────────
    {
      packAppId: 'au-portfolio-hub',
      name: 'Portfolio Management Hub (Australia)',
      description:
        'Manage all aspects of Australian portfolio management: client records, off-market transfers, annual reviews, fee agreements, death benefit nominations, and superannuation rollovers.',
      settings: {},
      theme: {
        primaryColor: '#0d9488',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'au-client-intake', displayName: 'New Client Onboarding', sortOrder: 1, isVisible: true },
        { packFormId: 'au-off-market-transfer', displayName: 'Off-Market Transfer', sortOrder: 2, isVisible: true },
        { packFormId: 'au-annual-review', displayName: 'Annual Client Review', sortOrder: 3, isVisible: true },
        { packFormId: 'au-fee-agreement', displayName: 'Fee Disclosure Statement', sortOrder: 4, isVisible: true },
        { packFormId: 'au-bdbn', displayName: 'Binding Death Benefit Nomination', sortOrder: 5, isVisible: true },
        { packFormId: 'au-super-rollover', displayName: 'Superannuation Rollover', sortOrder: 6, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading portfolio dashboard…</div></div></div>`,
        css: `:root{--accent:#0d9488;--accent2:#2dd4bf;--glow1:rgba(13,148,136,.20);--glow2:rgba(45,212,191,.10);}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
.wrap{min-height:100vh;padding:26px clamp(16px,4vw,40px) 44px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e2e8f0;background:radial-gradient(1100px 560px at 12% -12%,var(--glow1),transparent 60%),radial-gradient(900px 480px at 108% -6%,var(--glow2),transparent 55%),#0b1120;}
.empty{color:#94a3b8;padding:64px 20px;text-align:center;font-size:15px;}
.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px;}
.hdr h1{font-size:22px;font-weight:700;margin:0 0 4px;letter-spacing:-.01em;color:#f8fafc;}
.hdr .sub{color:#94a3b8;font-size:13px;}
.hdr .who{color:var(--accent2);font-weight:600;}
.btn{cursor:pointer;border:0;border-radius:10px;font-family:inherit;font-size:13px;font-weight:600;padding:10px 16px;transition:transform .12s ease,filter .12s ease;}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px);}
.btn-primary{background:var(--accent);color:#03201d;box-shadow:0 8px 20px -8px var(--accent);}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px;}
.card{background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.14);border-radius:14px;padding:16px 18px;}
.stat .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.stat .ic{font-size:15px;opacity:.9;}
.stat .v{font-size:24px;font-weight:750;color:#f8fafc;letter-spacing:-.02em;line-height:1.05;}
.stat .l{font-size:11.5px;color:#94a3b8;margin-top:6px;text-transform:uppercase;letter-spacing:.05em;}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}
@media(max-width:820px){.panels{grid-template-columns:1fr;}}
.panel h2{font-size:14px;font-weight:700;margin:0 0 15px;color:#f1f5f9;}
.bar-row{display:grid;grid-template-columns:132px 1fr 48px;align-items:center;gap:10px;margin-bottom:11px;}
.bar-row:last-child{margin-bottom:0;}
.bar-name{font-size:12.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bar-track{height:9px;background:rgba(148,163,184,.12);border-radius:6px;overflow:hidden;}
.bar-fill{height:100%;border-radius:6px;transition:width .9s cubic-bezier(.22,1,.36,1);}
.bar-val{font-size:12.5px;color:#e2e8f0;font-weight:600;text-align:right;}
.list .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid rgba(148,163,184,.1);}
.list .row:first-child{border-top:0;padding-top:0;}
.list .nm{font-size:13.5px;color:#f1f5f9;font-weight:600;}
.list .meta{font-size:12px;color:#94a3b8;margin-top:2px;}
.badge{font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;}
.sec-title{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:700;margin:0 0 12px;}
.actions{display:flex;flex-wrap:wrap;gap:10px;}
.qa{cursor:pointer;border:1px solid rgba(148,163,184,.16);background:rgba(15,23,42,.6);color:#cbd5e1;border-radius:11px;padding:11px 15px;font-size:13px;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:9px;transition:border-color .14s,background .14s,transform .12s,color .14s;}
.qa:hover{border-color:var(--accent);background:var(--glow1);transform:translateY(-1px);color:#f8fafc;}
.qa .qi{color:var(--accent2);font-size:14px;}
.mini-empty{color:#64748b;font-size:13px;padding:14px 0;}`,
        js: `var FL=window.FormLogic;
function h(s){return FL.escapeHtml(s==null?'':String(s));}
function findForm(ctx,name){var t=String(name).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}return null;}
function optMap(form,fieldId){var m={};if(!form)return m;for(var i=0;i<form.fields.length;i++){var f=form.fields[i];if(f.id===fieldId&&f.properties&&f.properties.options){for(var j=0;j<f.properties.options.length;j++){var o=f.properties.options[j];m[o.value]=o.label;}}}return m;}
function num(v){var n=parseFloat(v);return isNaN(n)?0:n;}
function aud(n){try{return new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}).format(n||0);}catch(e){return '$'+Math.round(n||0).toLocaleString();}}
function fmtDate(v){if(!v)return '';var d=new Date(v);if(isNaN(d.getTime()))return String(v);return d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});}
function loadRecords(form){return form?FL.records(form.formId,{limit:500}).catch(function(){return [];}):Promise.resolve([]);}
function bar(label,count,max,color){var pct=(max>0&&count>0)?Math.max(4,Math.round(count/max*100)):0;return '<div class="bar-row"><span class="bar-name">'+h(label)+'</span><div class="bar-track"><div class="bar-fill" data-pct="'+pct+'" style="width:0;background:'+color+'"></div></div><span class="bar-val">'+count.toLocaleString()+'</span></div>';}
function breakdown(records,fieldId,map,palette){var order=[];var counts={};for(var k in map){order.push(k);counts[k]=0;}for(var i=0;i<records.length;i++){var a=records[i].answers||{};var v=a[fieldId];if(v==null||v==='')continue;if(Object.prototype.toString.call(v)==='[object Array]'){for(var q=0;q<v.length;q++){var vv=v[q];if(!(vv in counts)){counts[vv]=0;order.push(vv);}counts[vv]++;}}else{if(!(v in counts)){counts[v]=0;order.push(v);}counts[v]++;}}var max=0;for(var m=0;m<order.length;m++){if(counts[order[m]]>max)max=counts[order[m]];}var out='';for(var j=0;j<order.length;j++){var key=order[j];out+=bar(map[key]||key,counts[key],max,palette[j%palette.length]);}return out;}
function statCard(value,label,color,icon){return '<div class="card stat"><div class="top"><span class="dot" style="background:'+color+'"></span><span class="ic">'+icon+'</span></div><div class="v">'+value+'</div><div class="l">'+h(label)+'</div></div>';}
function qa(form,label,icon){if(!form)return '';return '<button class="qa" data-fid="'+h(form.formId)+'"><span class="qi">'+icon+'</span>'+h(label)+'</button>';}
function recentReviews(records){if(!records.length)return '<div class="mini-empty">No annual reviews recorded yet.</div>';var out='';var n=Math.min(6,records.length);var today=new Date();today.setHours(0,0,0,0);for(var i=0;i<n;i++){var a=records[i].answers||{};var pv=aud(num(a.current_portfolio_value));var nrd=a.next_review_date;var nd=nrd?new Date(nrd):null;var overdue=nd&&!isNaN(nd.getTime())&&nd<today;var meta=nrd?('Next review '+h(fmtDate(nrd))):'Review completed';var gp=num(a.goal_progress);var badge;if(overdue){badge='<span class="badge" style="background:rgba(248,113,113,.15);color:#fca5a5">Overdue</span>';}else if(gp>=7){badge='<span class="badge" style="background:rgba(45,212,191,.15);color:#5eead4">On track</span>';}else if(gp>=4){badge='<span class="badge" style="background:rgba(251,191,36,.15);color:#fcd34d">Monitor</span>';}else if(gp>0){badge='<span class="badge" style="background:rgba(248,113,113,.15);color:#fca5a5">Behind</span>';}else{badge='<span class="badge" style="background:rgba(148,163,184,.14);color:#cbd5e1">Logged</span>';}out+='<div class="row"><div><div class="nm">'+h(pv)+'</div><div class="meta">'+meta+'</div></div>'+badge+'</div>';}return out;}
async function main(){var root=document.getElementById('app');var ctx;try{ctx=await FL.context();}catch(e){root.innerHTML='<div class="wrap"><div class="empty">Could not load dashboard.</div></div>';return;}var user=await FL.currentUser().catch(function(){return null;});var intake=findForm(ctx,'New Client Onboarding');var transfer=findForm(ctx,'Off-Market Transfer');var review=findForm(ctx,'Annual Client Review');var fee=findForm(ctx,'Fee Disclosure Statement');var bdbn=findForm(ctx,'Binding Death Benefit Nomination');var rollover=findForm(ctx,'Superannuation Rollover');var res=await Promise.all([loadRecords(intake),loadRecords(transfer),loadRecords(review),loadRecords(fee),loadRecords(bdbn),loadRecords(rollover)]);var rIntake=res[0],rTransfer=res[1],rReview=res[2],rFee=res[3],rBdbn=res[4],rRollover=res[5];var palette=['#0d9488','#2dd4bf','#22d3ee','#818cf8','#fbbf24','#f472b6'];var fua=0;for(var i=0;i<rReview.length;i++){fua+=num((rReview[i].answers||{}).current_portfolio_value);}var today=new Date();today.setHours(0,0,0,0);var reviewsDue=0;for(var i2=0;i2<rReview.length;i2++){var nrd=(rReview[i2].answers||{}).next_review_date;if(!nrd)continue;var nd=new Date(nrd);if(!isNaN(nd.getTime())&&nd<=today)reviewsDue++;}var transfersHtml=rTransfer.length?breakdown(rTransfer,'delivering_platform',optMap(transfer,'delivering_platform'),palette):'<div class="mini-empty">No transfers recorded yet.</div>';var presHtml=rRollover.length?breakdown(rRollover,'preservation_status',optMap(rollover,'preservation_status'),palette):'<div class="mini-empty">No rollovers recorded yet.</div>';var uname=user&&user.name?user.name:(user&&user.email?user.email:'');var whoHtml=uname?'<div class="sub">Signed in as <span class="who">'+h(uname)+'</span></div>':'<div class="sub">Australian portfolio operations</div>';var newBtn=intake?'<button class="btn btn-primary" data-fid="'+h(intake.formId)+'">+ New Client</button>':'';var statsHtml=statCard(aud(fua),'Funds Under Advice',palette[0],'💰')+statCard(rIntake.length.toLocaleString(),'Clients',palette[1],'👥')+statCard(rTransfer.length.toLocaleString(),'Transfers',palette[2],'🔁')+statCard(rRollover.length.toLocaleString(),'Rollovers',palette[3],'🏦')+statCard(reviewsDue.toLocaleString(),'Reviews Due',palette[4],'📅');var actionsHtml=qa(intake,'New Client','+')+qa(transfer,'Off-Market Transfer','🔁')+qa(review,'Annual Review','📅')+qa(fee,'Fee Disclosure','💵')+qa(bdbn,'Death Benefit Nomination','❤')+qa(rollover,'Super Rollover','🏦');root.innerHTML='<div class="wrap"><div class="hdr"><div><h1>'+h(ctx.appName||'Portfolio Management Hub')+'</h1>'+whoHtml+'</div>'+newBtn+'</div><div class="stats">'+statsHtml+'</div><div class="panels"><div class="card panel"><h2>Transfers by Platform</h2>'+transfersHtml+'</div><div class="card panel"><h2>Rollovers by Preservation</h2>'+presHtml+'</div></div><div class="card panel" style="margin-bottom:16px"><h2>Recent Annual Reviews</h2><div class="list">'+recentReviews(rReview)+'</div></div><div><p class="sec-title">Quick actions</p><div class="actions">'+actionsHtml+'</div></div></div>';var nav=root.querySelectorAll('[data-fid]');for(var n2=0;n2<nav.length;n2++){(function(el){el.addEventListener('click',function(){var id=el.getAttribute('data-fid');if(id)FL.navigate(id);});})(nav[n2]);}requestAnimationFrame(function(){requestAnimationFrame(function(){var b=root.querySelectorAll('.bar-fill');for(var i=0;i<b.length;i++){b[i].style.width=(b[i].getAttribute('data-pct')||0)+'%';}});});}
main();`,
      },
      roles: [
        {
          name: 'Senior Adviser',
          description: 'Senior adviser with full control over all portfolio management forms.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'submit_responses' },
            { packFormId: 'au-client-intake', permission: 'view_own_responses' },
            { packFormId: 'au-client-intake', permission: 'view_all_responses' },
            { packFormId: 'au-client-intake', permission: 'edit_responses' },
            { packFormId: 'au-client-intake', permission: 'delete_responses' },
            { packFormId: 'au-client-intake', permission: 'export_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'submit_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'view_own_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'view_all_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'edit_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'delete_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'export_responses' },
            { packFormId: 'au-annual-review', permission: 'submit_responses' },
            { packFormId: 'au-annual-review', permission: 'view_own_responses' },
            { packFormId: 'au-annual-review', permission: 'view_all_responses' },
            { packFormId: 'au-annual-review', permission: 'edit_responses' },
            { packFormId: 'au-annual-review', permission: 'delete_responses' },
            { packFormId: 'au-annual-review', permission: 'export_responses' },
            { packFormId: 'au-fee-agreement', permission: 'submit_responses' },
            { packFormId: 'au-fee-agreement', permission: 'view_own_responses' },
            { packFormId: 'au-fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'au-fee-agreement', permission: 'edit_responses' },
            { packFormId: 'au-fee-agreement', permission: 'delete_responses' },
            { packFormId: 'au-fee-agreement', permission: 'export_responses' },
            { packFormId: 'au-bdbn', permission: 'submit_responses' },
            { packFormId: 'au-bdbn', permission: 'view_own_responses' },
            { packFormId: 'au-bdbn', permission: 'view_all_responses' },
            { packFormId: 'au-bdbn', permission: 'edit_responses' },
            { packFormId: 'au-bdbn', permission: 'delete_responses' },
            { packFormId: 'au-bdbn', permission: 'export_responses' },
            { packFormId: 'au-super-rollover', permission: 'submit_responses' },
            { packFormId: 'au-super-rollover', permission: 'view_own_responses' },
            { packFormId: 'au-super-rollover', permission: 'view_all_responses' },
            { packFormId: 'au-super-rollover', permission: 'edit_responses' },
            { packFormId: 'au-super-rollover', permission: 'delete_responses' },
            { packFormId: 'au-super-rollover', permission: 'export_responses' },
          ],
        },
        {
          name: 'Paraplanner',
          description: 'Paraplanner managing day-to-day portfolio operations.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'submit_responses' },
            { packFormId: 'au-client-intake', permission: 'view_all_responses' },
            { packFormId: 'au-client-intake', permission: 'edit_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'submit_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'view_all_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'edit_responses' },
            { packFormId: 'au-annual-review', permission: 'submit_responses' },
            { packFormId: 'au-annual-review', permission: 'view_all_responses' },
            { packFormId: 'au-annual-review', permission: 'edit_responses' },
            { packFormId: 'au-fee-agreement', permission: 'submit_responses' },
            { packFormId: 'au-fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'au-fee-agreement', permission: 'edit_responses' },
            { packFormId: 'au-bdbn', permission: 'submit_responses' },
            { packFormId: 'au-bdbn', permission: 'view_all_responses' },
            { packFormId: 'au-bdbn', permission: 'edit_responses' },
            { packFormId: 'au-super-rollover', permission: 'submit_responses' },
            { packFormId: 'au-super-rollover', permission: 'view_all_responses' },
            { packFormId: 'au-super-rollover', permission: 'edit_responses' },
          ],
        },
        {
          name: 'Compliance',
          description: 'Compliance reviewer with read-only access across all forms.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'view_all_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'view_all_responses' },
            { packFormId: 'au-annual-review', permission: 'view_all_responses' },
            { packFormId: 'au-fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'au-bdbn', permission: 'view_all_responses' },
            { packFormId: 'au-super-rollover', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Operations',
          description: 'Operations team handling submissions, edits, deletions, and exports.',
          permissions: [
            { packFormId: 'au-client-intake', permission: 'submit_responses' },
            { packFormId: 'au-client-intake', permission: 'view_all_responses' },
            { packFormId: 'au-client-intake', permission: 'edit_responses' },
            { packFormId: 'au-client-intake', permission: 'delete_responses' },
            { packFormId: 'au-client-intake', permission: 'export_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'submit_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'view_all_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'edit_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'delete_responses' },
            { packFormId: 'au-off-market-transfer', permission: 'export_responses' },
            { packFormId: 'au-annual-review', permission: 'submit_responses' },
            { packFormId: 'au-annual-review', permission: 'view_all_responses' },
            { packFormId: 'au-annual-review', permission: 'edit_responses' },
            { packFormId: 'au-annual-review', permission: 'delete_responses' },
            { packFormId: 'au-annual-review', permission: 'export_responses' },
            { packFormId: 'au-fee-agreement', permission: 'submit_responses' },
            { packFormId: 'au-fee-agreement', permission: 'view_all_responses' },
            { packFormId: 'au-fee-agreement', permission: 'edit_responses' },
            { packFormId: 'au-fee-agreement', permission: 'delete_responses' },
            { packFormId: 'au-fee-agreement', permission: 'export_responses' },
            { packFormId: 'au-bdbn', permission: 'submit_responses' },
            { packFormId: 'au-bdbn', permission: 'view_all_responses' },
            { packFormId: 'au-bdbn', permission: 'edit_responses' },
            { packFormId: 'au-bdbn', permission: 'delete_responses' },
            { packFormId: 'au-bdbn', permission: 'export_responses' },
            { packFormId: 'au-super-rollover', permission: 'submit_responses' },
            { packFormId: 'au-super-rollover', permission: 'view_all_responses' },
            { packFormId: 'au-super-rollover', permission: 'edit_responses' },
            { packFormId: 'au-super-rollover', permission: 'delete_responses' },
            { packFormId: 'au-super-rollover', permission: 'export_responses' },
          ],
        },
      ],
    },
  ],
};
