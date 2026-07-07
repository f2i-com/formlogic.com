// ── Type definitions ────────────────────────────────────────────────────────

import type { PackFlowBinding, PackFlowDefinition } from '../../types/flows';
import type { CustomAppLogicBundle } from '../../types/customAppLogic';

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
  /** Per-form section screen (renders on the form's view in-app and on its public link).
   *  allowNewResponses keeps the real form reachable via the runtime's "New record" button.
   *  kind 'sdk' renders a trusted first-party React screen from the sdkScreenRegistry. */
  customScreen?: {
    enabled?: boolean;
    allowNewResponses?: boolean;
    kind?: 'dashboard' | 'sdk';
    dashboard?: PackDashboardScreen;
    sdkScreen?: { screenId: string; title?: string; params?: Record<string, unknown> };
  };
  fields: PackFormField[];
}

export interface PackAppRole {
  name: string;
  description: string;
  /** packFormId null = an app-level permission string (declarative capability intent). */
  permissions: Array<{ packFormId: string | null; permission: string }>;
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

/** Grid placement for a dashboard widget on the 12-column grid. */
export interface PackWidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A single widget on a pack dashboard. Form references inside spec/list use portable
 *  `@pack:<packFormId>` keys (and `@pack:<packFormId>::<fieldId>` for joined fields),
 *  resolved to real ids at install/import time. */
export interface PackDashboardWidget {
  id: string;
  title?: string;
  layout: PackWidgetLayout;
  kind: 'report' | 'list' | 'text' | 'actions' | 'activity';
  spec?: PackReportSpec;
  list?: { formId: string; titleField?: string; subtitleField?: string; limit?: number };
  text?: { body: string };
}

/** A declarative widget dashboard stored on customScreen.dashboard (host-rendered recharts). */
export interface PackDashboardScreen {
  version: 1;
  cols?: number;
  widgets: PackDashboardWidget[];
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
  /** Optional host-rendered widget dashboard shown instead of the form list. */
  customScreen?: { enabled?: boolean; kind?: 'dashboard'; dashboard?: PackDashboardScreen };
  roles: PackAppRole[];
  /** Optional pre-configured chart reports + PDF documents shown in the app's Reports section. */
  reports?: PackReportItem[];
  /** Optional sandboxed QuickJS app-logic bundle (spec §31; imported to apps.custom_logic). */
  customLogic?: CustomAppLogicBundle;
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
  /** FormLogic Flows shipped with the pack (docs/FORMLOGIC_FLOWS.md §6). */
  flows?: PackFlowDefinition[];
  /** Event bindings for the pack's flows ('@pack:<formId>' refs remapped on import). */
  flowBindings?: PackFlowBinding[];
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Clients', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total net worth', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'sum', field: 'net_worth' } } },
            { id: 'k3', title: 'Avg annual income', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'avg', field: 'annual_income' } } },
            { id: 'k4', title: 'Avg risk tolerance', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'avg', field: 'risk_tolerance' } } },
            { id: 'c1', title: 'Clients by investment objective', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'bar', groupBy: { field: 'investment_objectives', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Citizenship mix', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'donut', groupBy: { field: 'citizenship', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'New clients over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent clients', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:client-intake', titleField: 'first_name', subtitleField: 'email', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Assessments', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Avg loss capacity', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'kpi', measure: { fn: 'avg', field: 'loss_capacity' } } },
            { id: 'k3', title: 'Avg time horizon', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'kpi', measure: { fn: 'avg', field: 'time_horizon' } } },
            { id: 'k4', title: 'Net worth assessed', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'kpi', measure: { fn: 'sum', field: 'client_net_worth' } } },
            { id: 'c1', title: 'By recommended portfolio', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'bar', groupBy: { field: 'portfolio_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'By investment experience', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'donut', groupBy: { field: 'investment_experience', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Market-drop reaction', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'bar', groupBy: { field: 'market_reaction', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent assessments', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:risk-questionnaire', titleField: 'portfolio_type', subtitleField: 'investment_experience', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Transfers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Assets in transit', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'k3', title: 'Avg transfer size', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'kpi', measure: { fn: 'avg', field: 'estimated_value' } } },
            { id: 'k4', title: 'Custodians', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'kpi', measure: { fn: 'countDistinct', field: 'custodian' } } },
            { id: 'c1', title: 'By delivering custodian', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'bar', groupBy: { field: 'custodian', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Full vs partial', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'donut', groupBy: { field: 'transfer_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Transfer value over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'sum', field: 'estimated_value' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent transfers', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:acat-transfer', titleField: 'custodian', subtitleField: 'account_number', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Disclosures delivered', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:form-crs', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Advisors delivering', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:form-crs', viz: 'kpi', measure: { fn: 'countDistinct', field: 'advisor_name' } } },
            { id: 'c1', title: 'By advisor', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:form-crs', viz: 'bar', groupBy: { field: 'advisor_name', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Acknowledgements over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:form-crs', viz: 'area', groupBy: { field: 'acknowledgement_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent acknowledgements', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:form-crs', titleField: 'advisor_name', subtitleField: 'acknowledgement_date', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Reviews', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Total AUM reviewed', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'kpi', measure: { fn: 'sum', field: 'current_aum' } } },
            { id: 'k3', title: 'Avg goal progress', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'kpi', measure: { fn: 'avg', field: 'goal_progress' } } },
            { id: 'k4', title: 'Avg AUM', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'kpi', measure: { fn: 'avg', field: 'current_aum' } } },
            { id: 'c1', title: 'Goal progress distribution', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'bar', groupBy: { field: 'goal_progress', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 10 } },
            { id: 'c2', title: 'Life changes since last review', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'bar', groupBy: { field: 'life_changes', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c3', title: 'Reviews over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent reviews', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:annual-review', titleField: 'client_name', subtitleField: 'next_review_date', limit: 6 } },
          ],
        },
      },
      fields: [
        {
          id: 'client_record',
          type: 'linked_record',
          label: 'Client',
          required: true,
          properties: { targetFormId: '@pack:client-intake' },
        },
        {
          id: 'client_name',
          type: 'short_text',
          label: 'Client Name',
          required: true,
          properties: { placeholder: 'Full name of the client under review' },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Agreements', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Under agreement', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'kpi', measure: { fn: 'sum', field: 'account_value' } } },
            { id: 'k3', title: 'Avg account value', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'kpi', measure: { fn: 'avg', field: 'account_value' } } },
            { id: 'k4', title: 'Tiers in use', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'kpi', measure: { fn: 'countDistinct', field: 'fee_tier' } } },
            { id: 'c1', title: 'By fee tier', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'bar', groupBy: { field: 'fee_tier', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Billing frequency', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'donut', groupBy: { field: 'billing_frequency', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'AUM under agreement over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'area', groupBy: { field: 'effective_date', bucket: 'month' }, measure: { fn: 'sum', field: 'account_value' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent agreements', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:fee-agreement', titleField: 'fee_tier', subtitleField: 'billing_frequency', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Documents on file', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:document-vault', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Categories', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:document-vault', viz: 'kpi', measure: { fn: 'countDistinct', field: 'document_type' } } },
            { id: 'c1', title: 'By document type', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:document-vault', viz: 'bar', groupBy: { field: 'document_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Documents added over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:document-vault', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent documents', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:document-vault', titleField: 'document_name', subtitleField: 'document_type', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'W-9s on file', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:w9-form', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Classifications', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:w9-form', viz: 'kpi', measure: { fn: 'countDistinct', field: 'tax_classification' } } },
            { id: 'c1', title: 'By tax classification', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:w9-form', viz: 'bar', groupBy: { field: 'tax_classification', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Collected over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:w9-form', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent W-9s', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:w9-form', titleField: 'legal_name', subtitleField: 'tax_classification', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Designations', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:beneficiary-designation', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Avg primary %', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:beneficiary-designation', viz: 'kpi', measure: { fn: 'avg', field: 'primary_percentage_1' } } },
            { id: 'c1', title: 'Primary relationships', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:beneficiary-designation', viz: 'bar', groupBy: { field: 'primary_relationship_1', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'New designations over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:beneficiary-designation', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent designations', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:beneficiary-designation', titleField: 'primary_name_1', subtitleField: 'account', limit: 6 } },
          ],
        },
      },
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
          type: 'dropdown',
          label: 'Primary Beneficiary 1 — Relationship',
          required: true,
          properties: {
            options: [
              { id: 'p1_spouse', label: 'Spouse', value: 'spouse' },
              { id: 'p1_child', label: 'Child', value: 'child' },
              { id: 'p1_parent', label: 'Parent', value: 'parent' },
              { id: 'p1_sibling', label: 'Sibling', value: 'sibling' },
              { id: 'p1_grandchild', label: 'Grandchild', value: 'grandchild' },
              { id: 'p1_trust', label: 'Trust', value: 'trust' },
              { id: 'p1_estate', label: 'Estate', value: 'estate' },
              { id: 'p1_charity', label: 'Charity', value: 'charity' },
              { id: 'p1_other', label: 'Other', value: 'other' },
            ],
          },
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
          type: 'dropdown',
          label: 'Primary Beneficiary 2 — Relationship',
          required: false,
          properties: {
            options: [
              { id: 'p2_spouse', label: 'Spouse', value: 'spouse' },
              { id: 'p2_child', label: 'Child', value: 'child' },
              { id: 'p2_parent', label: 'Parent', value: 'parent' },
              { id: 'p2_sibling', label: 'Sibling', value: 'sibling' },
              { id: 'p2_grandchild', label: 'Grandchild', value: 'grandchild' },
              { id: 'p2_trust', label: 'Trust', value: 'trust' },
              { id: 'p2_estate', label: 'Estate', value: 'estate' },
              { id: 'p2_charity', label: 'Charity', value: 'charity' },
              { id: 'p2_other', label: 'Other', value: 'other' },
            ],
          },
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
          type: 'dropdown',
          label: 'Primary Beneficiary 3 — Relationship',
          required: false,
          properties: {
            options: [
              { id: 'p3_spouse', label: 'Spouse', value: 'spouse' },
              { id: 'p3_child', label: 'Child', value: 'child' },
              { id: 'p3_parent', label: 'Parent', value: 'parent' },
              { id: 'p3_sibling', label: 'Sibling', value: 'sibling' },
              { id: 'p3_grandchild', label: 'Grandchild', value: 'grandchild' },
              { id: 'p3_trust', label: 'Trust', value: 'trust' },
              { id: 'p3_estate', label: 'Estate', value: 'estate' },
              { id: 'p3_charity', label: 'Charity', value: 'charity' },
              { id: 'p3_other', label: 'Other', value: 'other' },
            ],
          },
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
          type: 'dropdown',
          label: 'Contingent Beneficiary 1 — Relationship',
          required: false,
          properties: {
            options: [
              { id: 'c1_spouse', label: 'Spouse', value: 'spouse' },
              { id: 'c1_child', label: 'Child', value: 'child' },
              { id: 'c1_parent', label: 'Parent', value: 'parent' },
              { id: 'c1_sibling', label: 'Sibling', value: 'sibling' },
              { id: 'c1_grandchild', label: 'Grandchild', value: 'grandchild' },
              { id: 'c1_trust', label: 'Trust', value: 'trust' },
              { id: 'c1_estate', label: 'Estate', value: 'estate' },
              { id: 'c1_charity', label: 'Charity', value: 'charity' },
              { id: 'c1_other', label: 'Other', value: 'other' },
            ],
          },
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
          type: 'dropdown',
          label: 'Contingent Beneficiary 2 — Relationship',
          required: false,
          properties: {
            options: [
              { id: 'c2_spouse', label: 'Spouse', value: 'spouse' },
              { id: 'c2_child', label: 'Child', value: 'child' },
              { id: 'c2_parent', label: 'Parent', value: 'parent' },
              { id: 'c2_sibling', label: 'Sibling', value: 'sibling' },
              { id: 'c2_grandchild', label: 'Grandchild', value: 'grandchild' },
              { id: 'c2_trust', label: 'Trust', value: 'trust' },
              { id: 'c2_estate', label: 'Estate', value: 'estate' },
              { id: 'c2_charity', label: 'Charity', value: 'charity' },
              { id: 'c2_other', label: 'Other', value: 'other' },
            ],
          },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'POAs on file', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:power-of-attorney', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Agents named', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:power-of-attorney', viz: 'kpi', measure: { fn: 'countDistinct', field: 'agent_name' } } },
            { id: 'c1', title: 'Powers granted', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:power-of-attorney', viz: 'bar', groupBy: { field: 'powers_granted', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'New POAs over time', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:power-of-attorney', viz: 'area', groupBy: { field: 'effective_date', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent POAs', layout: { x: 0, y: 4, w: 12, h: 3 }, kind: 'list', list: { formId: '@pack:power-of-attorney', titleField: 'principal_name', subtitleField: 'agent_name', limit: 6 } },
          ],
        },
      },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Exchanges', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Contract value', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'k3', title: 'Surrender charges', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'kpi', measure: { fn: 'sum', field: 'surrender_charges' } } },
            { id: 'k4', title: 'Avg contract value', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'kpi', measure: { fn: 'avg', field: 'estimated_value' } } },
            { id: 'c1', title: 'Existing carriers', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'bar', groupBy: { field: 'existing_carrier', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Life vs annuity', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'donut', groupBy: { field: 'exchange_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'New carriers', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'bar', groupBy: { field: 'new_carrier', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'l1', title: 'Recent exchanges', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:1035-exchange', titleField: 'new_policy_type', subtitleField: 'exchange_type', limit: 6 } },
          ],
        },
      },
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
          type: 'dropdown',
          label: 'Existing Carrier',
          required: true,
          properties: {
            options: [
              { id: 'prudential_ec', label: 'Prudential', value: 'prudential' },
              { id: 'metlife_ec', label: 'MetLife', value: 'metlife' },
              { id: 'lincoln_ec', label: 'Lincoln Financial', value: 'lincoln_financial' },
              { id: 'nationwide_ec', label: 'Nationwide', value: 'nationwide' },
              { id: 'pacific_life_ec', label: 'Pacific Life', value: 'pacific_life' },
              { id: 'john_hancock_ec', label: 'John Hancock', value: 'john_hancock' },
              { id: 'allianz_ec', label: 'Allianz Life', value: 'allianz_life' },
              { id: 'other_ec', label: 'Other', value: 'other' },
            ],
          },
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
          type: 'dropdown',
          label: 'New Carrier',
          required: true,
          properties: {
            options: [
              { id: 'athene_nc', label: 'Athene', value: 'athene' },
              { id: 'jackson_nc', label: 'Jackson National', value: 'jackson_national' },
              { id: 'transamerica_nc', label: 'Transamerica', value: 'transamerica' },
              { id: 'brighthouse_nc', label: 'Brighthouse Financial', value: 'brighthouse' },
              { id: 'corebridge_nc', label: 'Corebridge Financial', value: 'corebridge' },
              { id: 'equitable_nc', label: 'Equitable', value: 'equitable' },
              { id: 'other_nc', label: 'Other', value: 'other' },
            ],
          },
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
      customScreen: {
        enabled: true,
        allowNewResponses: true,
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Rollovers', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Assets moving', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'k3', title: 'Avg rollover', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'kpi', measure: { fn: 'avg', field: 'estimated_value' } } },
            { id: 'k4', title: 'Receiving custodians', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'kpi', measure: { fn: 'countDistinct', field: 'receiving_custodian' } } },
            { id: 'c1', title: 'Rollover types', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'bar', groupBy: { field: 'rollover_type', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Direct vs indirect', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'donut', groupBy: { field: 'direct_or_indirect', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'c3', title: 'Rollover value over time', layout: { x: 0, y: 4, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'sum', field: 'estimated_value' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent rollovers', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'list', list: { formId: '@pack:rollover-form', titleField: 'receiving_custodian', subtitleField: 'rollover_type', limit: 6 } },
          ],
        },
      },
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
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Clients', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Risk profiles', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:risk-questionnaire', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'CRS delivered', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:form-crs', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Documents', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:document-vault', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k5', title: 'W-9s on file', layout: { x: 0, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:w9-form', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k6', title: 'Beneficiary designations', layout: { x: 3, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:beneficiary-designation', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k7', title: 'Book net worth', layout: { x: 6, y: 1, w: 6, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'sum', field: 'net_worth' } } },
            { id: 'c1', title: 'Clients by investment objective', layout: { x: 0, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'bar', groupBy: { field: 'investment_objectives', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'New clients over time', layout: { x: 6, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'count' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent clients', layout: { x: 0, y: 5, w: 4, h: 3 }, kind: 'list', list: { formId: '@pack:client-intake', titleField: 'first_name', subtitleField: 'email', limit: 6 } },
            { id: 'a1', title: 'Recent activity', layout: { x: 4, y: 5, w: 4, h: 3 }, kind: 'activity' },
            { id: 'c3', title: 'Citizenship mix', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'donut', groupBy: { field: 'citizenship', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'act1', title: 'Quick actions', layout: { x: 0, y: 8, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
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
        kind: 'dashboard',
        dashboard: {
          version: 1,
          cols: 12,
          widgets: [
            { id: 'k1', title: 'Clients', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:client-intake', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k2', title: 'Transfers', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k3', title: 'Annual reviews', layout: { x: 6, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:annual-review', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k4', title: 'Fee agreements', layout: { x: 9, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:fee-agreement', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k5', title: 'Exchanges', layout: { x: 0, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:1035-exchange', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k6', title: 'Rollovers', layout: { x: 3, y: 1, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:rollover-form', viz: 'kpi', measure: { fn: 'count' } } },
            { id: 'k7', title: 'Assets in transit', layout: { x: 6, y: 1, w: 6, h: 1 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'kpi', measure: { fn: 'sum', field: 'estimated_value' } } },
            { id: 'c1', title: 'Transfers by custodian', layout: { x: 0, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'bar', groupBy: { field: 'custodian', bucket: 'none' }, measure: { fn: 'count' }, seriesSort: 'value', sort: 'desc', limit: 8 } },
            { id: 'c2', title: 'Transfer value over time', layout: { x: 6, y: 2, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'area', groupBy: { field: '__submitted_at', bucket: 'month' }, measure: { fn: 'sum', field: 'estimated_value' }, seriesSort: 'label', limit: 12 } },
            { id: 'l1', title: 'Recent transfers', layout: { x: 0, y: 5, w: 4, h: 3 }, kind: 'list', list: { formId: '@pack:acat-transfer', titleField: 'custodian', subtitleField: 'account_number', limit: 6 } },
            { id: 'a1', title: 'Recent activity', layout: { x: 4, y: 5, w: 4, h: 3 }, kind: 'activity' },
            { id: 'c3', title: 'Full vs partial', layout: { x: 8, y: 5, w: 4, h: 3 }, kind: 'report', spec: { formId: '@pack:acat-transfer', viz: 'donut', groupBy: { field: 'transfer_type', bucket: 'none' }, measure: { fn: 'count' }, limit: 6 } },
            { id: 'act1', title: 'Quick actions', layout: { x: 0, y: 8, w: 12, h: 1 }, kind: 'actions' },
          ],
        },
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
