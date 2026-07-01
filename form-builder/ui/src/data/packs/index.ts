import type { PackData } from '../../lib/api';
import { financeOsPack } from './financeOsPack';
import { financeOsAuPack } from './financeOsAuPack';
import { ohsQmsPack } from './ohsQmsPack';
import { hrPeoplePack } from './hrPeoplePack';
import { eventManagementPack } from './eventManagementPack';
import { customerServicePack } from './customerServicePack';
import { plumbingFieldServicePack } from './plumbingFieldServicePack';
import { jobInvoicePack } from './jobInvoicePack';

export interface PackCatalogEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  formCount: number;
  appCount: number;
  icon: string;
  pack: PackData;
}

export const packCatalog: PackCatalogEntry[] = [
  {
    id: 'finance-os-us',
    name: 'Finance OS (United States)',
    description:
      'Complete United States-focused onboarding, compliance, and advisory workflow for RIAs, broker-dealers, and wealth managers. Includes 12 forms and 2 apps.',
    tags: ['finance', 'compliance', 'onboarding', 'united-states'],
    formCount: financeOsPack.forms.length,
    appCount: financeOsPack.apps?.length ?? 0,
    icon: '\uD83C\uDFE6', // 🏦
    pack: financeOsPack as unknown as PackData,
  },
  {
    id: 'finance-os-au',
    name: 'Finance OS (Australia)',
    description:
      'Comprehensive advisory workflow for Australian AFSLs, covering client onboarding, Best Interest Duty compliance, superannuation, and AUSTRAC requirements. Includes 10 forms and 2 apps.',
    tags: ['finance', 'compliance', 'onboarding', 'australia', 'afsl'],
    formCount: financeOsAuPack.forms.length,
    appCount: financeOsAuPack.apps?.length ?? 0,
    icon: '\uD83E\uDD98', // 🦘
    pack: financeOsAuPack as unknown as PackData,
  },
  {
    id: 'ohs-qms',
    name: 'OHS & Quality Management',
    description:
      'Complete occupational health & safety and quality management system covering incident reporting, hazard identification, audits, corrective actions, NCRs, and training records. Aligned with ISO 45001 and ISO 9001. Includes 12 forms and 2 apps.',
    tags: ['safety', 'quality', 'ohs', 'iso-45001', 'iso-9001', 'compliance'],
    formCount: ohsQmsPack.forms.length,
    appCount: ohsQmsPack.apps?.length ?? 0,
    icon: '\u26D1\uFE0F', // ⛑️
    pack: ohsQmsPack as unknown as PackData,
  },
  {
    id: 'hr-people',
    name: 'HR & People Management',
    description:
      'Complete human resources workflow covering recruitment, onboarding, leave management, performance reviews, expense claims, training requests, and exit interviews. Includes 8 forms and 1 app.',
    tags: ['hr', 'people', 'recruitment', 'onboarding', 'leave', 'performance'],
    formCount: hrPeoplePack.forms.length,
    appCount: hrPeoplePack.apps?.length ?? 0,
    icon: '\uD83D\uDC65', // 👥
    pack: hrPeoplePack as unknown as PackData,
  },
  {
    id: 'event-management',
    name: 'Event Management',
    description:
      'Complete event management workflow covering registration, speaker submissions, vendor applications, volunteer coordination, incident logging, budget tracking, and post-event feedback. Includes 7 forms and 1 app.',
    tags: ['events', 'registration', 'speakers', 'vendors', 'volunteers', 'feedback'],
    formCount: eventManagementPack.forms.length,
    appCount: eventManagementPack.apps?.length ?? 0,
    icon: '\uD83C\uDF89', // 🎉
    pack: eventManagementPack as unknown as PackData,
  },
  {
    id: 'customer-service',
    name: 'Customer Service',
    description:
      'Complete customer service and support workflow covering support tickets, bug reports, feature requests, customer feedback, refund requests, escalation management, and knowledge base. Includes 7 forms and 1 app.',
    tags: ['customer-service', 'support', 'crm', 'tickets', 'feedback', 'helpdesk'],
    formCount: customerServicePack.forms.length,
    appCount: customerServicePack.apps?.length ?? 0,
    icon: '\uD83C\uDFA7', // 🎧
    pack: customerServicePack as unknown as PackData,
  },
  {
    id: 'plumbing-field-service',
    name: 'Plumbing & Trades Field Service',
    description:
      'Field-service operations for a plumbing or trades business: manage customers, schedule and track jobs, log on-site work orders, raise invoices, and request parts and materials — all linked together. Includes 5 forms and 1 app.',
    tags: ['plumbing', 'trades', 'field-service', 'jobs', 'scheduling'],
    formCount: plumbingFieldServicePack.forms.length,
    appCount: plumbingFieldServicePack.apps?.length ?? 0,
    icon: '🔧', // 🔧
    pack: plumbingFieldServicePack as unknown as PackData,
  },
  {
    id: 'job-invoice-management',
    name: 'Job & Invoice Management',
    description:
      'A universal job-to-quote-to-invoice-to-payment pipeline for any service business, with clients, jobs, quotes, invoices, and payments plus a live billing dashboard. Includes 5 forms and 1 app.',
    tags: ['invoicing', 'jobs', 'quotes', 'billing', 'operations'],
    formCount: jobInvoicePack.forms.length,
    appCount: jobInvoicePack.apps?.length ?? 0,
    icon: '🧾', // 🧾
    pack: jobInvoicePack as unknown as PackData,
  },
];
