import type { PackData } from '../../lib/api';
import { financeOsPack } from './financeOsPack';
import { financeOsAuPack } from './financeOsAuPack';
import { ohsQmsPack } from './ohsQmsPack';
import { hrPeoplePack } from './hrPeoplePack';
import { eventManagementPack } from './eventManagementPack';
import { customerServicePack } from './customerServicePack';
import { plumbingFieldServicePack } from './plumbingFieldServicePack';
import { jobInvoicePack } from './jobInvoicePack';
import { salonBeautyPack } from './salonBeautyPack';
import { mechanicWorkshopPack } from './mechanicWorkshopPack';
import { propertyMaintenancePack } from './propertyMaintenancePack';
import { clinicIntakePack } from './clinicIntakePack';
import { inventoryPurchaseOrdersPack } from './inventoryPurchaseOrdersPack';

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
  {
    id: 'salon-beauty-studio',
    name: 'Hair Salon & Beauty Studio',
    description:
      'A booking and client manager for a hair salon or beauty studio: keep client profiles, a service menu and stylist roster, book and track appointments, and record retail product sales. Includes 5 forms and 1 app.',
    tags: ['salon', 'beauty', 'appointments', 'bookings', 'clients'],
    formCount: salonBeautyPack.forms.length,
    appCount: salonBeautyPack.apps?.length ?? 0,
    icon: '💇', // 💇
    pack: salonBeautyPack as unknown as PackData,
  },
  {
    id: 'mechanic-workshop',
    name: 'Mechanic Workshop Manager',
    description:
      'Run an auto mechanic workshop end to end: manage customers and their vehicles, track job cards through the bay, log parts used, and raise invoices from one linked dashboard. Includes 5 forms and 1 app.',
    tags: ['mechanic', 'automotive', 'workshop', 'repairs', 'vehicles'],
    formCount: mechanicWorkshopPack.forms.length,
    appCount: mechanicWorkshopPack.apps?.length ?? 0,
    icon: '🚗', // 🚗
    pack: mechanicWorkshopPack as unknown as PackData,
  },
  {
    id: 'property-maintenance',
    name: 'Property Maintenance & Handyman',
    description:
      'A maintenance-request and work-order tracker for property managers and handymen: manage properties and tenants, log maintenance requests, schedule and track work orders, and record inspections. Includes 5 forms and 1 app.',
    tags: ['property', 'maintenance', 'handyman', 'jobs', 'landlord'],
    formCount: propertyMaintenancePack.forms.length,
    appCount: propertyMaintenancePack.apps?.length ?? 0,
    icon: '🏠', // 🏠
    pack: propertyMaintenancePack as unknown as PackData,
  },
  {
    id: 'clinic-appointment-intake',
    name: 'Clinic Appointment & Intake',
    description:
      'A light front-desk toolkit for a small clinic: register patients, manage providers, book and track appointments, capture patient intake and consent, and schedule follow-ups from one linked dashboard. Includes 5 forms and 1 app.',
    tags: ['clinic', 'appointments', 'intake', 'patients', 'front-desk'],
    formCount: clinicIntakePack.forms.length,
    appCount: clinicIntakePack.apps?.length ?? 0,
    icon: '🩺', // 🩺
    pack: clinicIntakePack as unknown as PackData,
  },
  {
    id: 'inventory-purchase-orders',
    name: 'Inventory & Purchase Orders',
    description:
      'A stock-control and purchasing hub to manage products and suppliers, raise purchase orders with line items, and log every stock movement, with low-stock alerts and live stock value on a linked dashboard. Includes 5 forms and 1 app.',
    tags: ['inventory', 'purchasing', 'stock', 'suppliers', 'warehouse'],
    formCount: inventoryPurchaseOrdersPack.forms.length,
    appCount: inventoryPurchaseOrdersPack.apps?.length ?? 0,
    icon: '📦', // 📦
    pack: inventoryPurchaseOrdersPack as unknown as PackData,
  },
];
