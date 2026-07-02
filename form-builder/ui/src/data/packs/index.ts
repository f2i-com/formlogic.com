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
import { pawRoutePack } from './pawRoutePack';
import { brewDeskPack } from './brewDeskPack';
import { grillStackPack } from './grillStackPack';
import { counterFlowPack } from './counterFlowPack';
import { stayReadyPack } from './stayReadyPack';
import { repairBenchPack } from './repairBenchPack';
import { passMasterPack } from './passMasterPack';
import { caterCraftPack } from './caterCraftPack';
import { cleanShiftPack } from './cleanShiftPack';
import { tutorTrackPack } from './tutorTrackPack';
import { fitStudioPack } from './fitStudioPack';
import { venueOpsPack } from './venueOpsPack';
import { fleetFlowPack } from './fleetFlowPack';
import { sitePulsePack } from './sitePulsePack';
import { agriLogPack } from './agriLogPack';

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
    icon: 'DollarSign',
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
    icon: 'Wallet',
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
    icon: 'ShieldCheck',
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
    icon: 'Users',
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
    icon: 'Ticket',
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
    icon: 'LifeBuoy',
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
    icon: 'Wrench',
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
    icon: 'Receipt',
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
    icon: 'Scissors',
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
    icon: 'Car',
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
    icon: 'Home',
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
    icon: 'Stethoscope',
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
    icon: 'Package',
    pack: inventoryPurchaseOrdersPack as unknown as PackData,
  },
  {
    id: 'pawroute-pet-care',
    name: 'PawRoute — Dog Walking & Pet Care',
    description:
      'A studio manager for dog walkers and pet-care businesses: keep pet and client profiles, schedule walks, drop-in visits and pet sitting, dispatch walkers, and log incidents and care notes. Includes 5 forms and 1 app.',
    tags: ['pets', 'dog-walking', 'pet-care', 'scheduling', 'clients'],
    formCount: pawRoutePack.forms.length,
    appCount: pawRoutePack.apps?.length ?? 0,
    icon: 'PawPrint',
    pack: pawRoutePack as unknown as PackData,
  },
  {
    id: 'brewdesk-cafe-ops',
    name: 'BrewDesk — Cafe & Barista Ops',
    description:
      'A cafe operations hub: take dine-in and takeaway orders, run the barista queue, track beans and milk stock, manage the roster, and close out the day. Includes 6 forms and 1 app.',
    tags: ['cafe', 'coffee', 'orders', 'barista', 'hospitality'],
    formCount: brewDeskPack.forms.length,
    appCount: brewDeskPack.apps?.length ?? 0,
    icon: 'Coffee',
    pack: brewDeskPack as unknown as PackData,
  },
  {
    id: 'grillstack-burger-ops',
    name: 'GrillStack — Burger Shop Command Center',
    description:
      'A burger shop command center: run the order board and kitchen pass, track prep and stock, manage shifts, and reconcile the daily close. Includes 6 forms and 1 app.',
    tags: ['burgers', 'kitchen', 'orders', 'restaurant', 'hospitality'],
    formCount: grillStackPack.forms.length,
    appCount: grillStackPack.apps?.length ?? 0,
    icon: 'Flame',
    pack: grillStackPack as unknown as PackData,
  },
  {
    id: 'counterflow-retail-ops',
    name: 'CounterFlow — Retail Store Operations',
    description:
      'The operational layer around the till for boutiques and specialty retail: products and suppliers, stock movements, store tasks, staff and returns, with low-stock alerts and a stock-value estimate. Includes 6 forms and 1 app.',
    tags: ['retail', 'stock', 'store-ops', 'suppliers', 'tasks'],
    formCount: counterFlowPack.forms.length,
    appCount: counterFlowPack.apps?.length ?? 0,
    icon: 'Store',
    pack: counterFlowPack as unknown as PackData,
  },
  {
    id: 'stayready-short-stay',
    name: 'StayReady — Short-Stay Turnover',
    description:
      'A turnover manager for Airbnb and short-stay hosts: track properties and bookings, schedule cleaner turnovers between checkout and check-in, run inspections, and keep per-property supplies stocked. Includes 6 forms and 1 app.',
    tags: ['airbnb', 'short-stay', 'turnovers', 'cleaning', 'property'],
    formCount: stayReadyPack.forms.length,
    appCount: stayReadyPack.apps?.length ?? 0,
    icon: 'BedDouble',
    pack: stayReadyPack as unknown as PackData,
  },
  {
    id: 'repairbench-device-repair',
    name: 'RepairBench — Device Repair Shop',
    description:
      'An electronics repair shop workflow: intake devices and customers, run repair jobs through a full diagnosis-to-pickup pipeline, order parts, and sign off quality checks. Includes 6 forms and 1 app.',
    tags: ['repairs', 'devices', 'electronics', 'workshop', 'service'],
    formCount: repairBenchPack.forms.length,
    appCount: repairBenchPack.apps?.length ?? 0,
    icon: 'CircuitBoard',
    pack: repairBenchPack as unknown as PackData,
  },
  {
    id: 'passmaster-restaurant',
    name: 'PassMaster — Restaurant Kitchen & Table Service',
    description:
      'Front-of-house and kitchen pass for small restaurants: take reservations, run the floor and table status, fire kitchen tickets by course, work the prep list, and close the shift. Includes 6 forms and 1 app.',
    tags: ['restaurant', 'reservations', 'kitchen', 'tables', 'hospitality'],
    formCount: passMasterPack.forms.length,
    appCount: passMasterPack.apps?.length ?? 0,
    icon: 'ChefHat',
    pack: passMasterPack as unknown as PackData,
  },
  {
    id: 'catercraft-catering',
    name: 'CaterCraft — Catering & Event Orders',
    description:
      'Quote, plan, produce and deliver catering jobs: manage clients and menu packages, move jobs through an event pipeline, run the production board, dispatch deliveries, and track dietary requirements. Includes 6 forms and 1 app.',
    tags: ['catering', 'events', 'kitchen', 'delivery', 'hospitality'],
    formCount: caterCraftPack.forms.length,
    appCount: caterCraftPack.apps?.length ?? 0,
    icon: 'UtensilsCrossed',
    pack: caterCraftPack as unknown as PackData,
  },
  {
    id: 'cleanshift-cleaning',
    name: 'CleanShift — Cleaning Business Scheduler',
    description:
      'A scheduler for residential and commercial cleaning: manage clients and teams, book and dispatch jobs, run quality checks, keep supplies stocked, and resolve client issues. Includes 6 forms and 1 app.',
    tags: ['cleaning', 'scheduling', 'teams', 'quality', 'field-service'],
    formCount: cleanShiftPack.forms.length,
    appCount: cleanShiftPack.apps?.length ?? 0,
    icon: 'Sparkles',
    pack: cleanShiftPack as unknown as PackData,
  },
  {
    id: 'tutortrack-tutoring',
    name: 'TutorTrack — Tutoring & Lessons Manager',
    description:
      'A lessons manager for tutoring studios and music teachers: keep student and tutor profiles, schedule lessons, record progress notes, and raise invoices. Includes 5 forms and 1 app.',
    tags: ['tutoring', 'lessons', 'education', 'students', 'billing'],
    formCount: tutorTrackPack.forms.length,
    appCount: tutorTrackPack.apps?.length ?? 0,
    icon: 'GraduationCap',
    pack: tutorTrackPack as unknown as PackData,
  },
  {
    id: 'fitstudio-coaching',
    name: 'FitStudio — Personal Training & Gym Coaching',
    description:
      'A coaching manager for personal trainers and studios: manage clients and trainers, book sessions, log assessments, build training programs, and track payments. Includes 6 forms and 1 app.',
    tags: ['fitness', 'training', 'coaching', 'gym', 'clients'],
    formCount: fitStudioPack.forms.length,
    appCount: fitStudioPack.apps?.length ?? 0,
    icon: 'Dumbbell',
    pack: fitStudioPack as unknown as PackData,
  },
  {
    id: 'venueops-venue-hire',
    name: 'VenueOps — Venue Hire & Booking Manager',
    description:
      'A booking manager for halls, studios and community spaces: manage spaces and hirers, take bookings, plan setups, record payments, and log incidents and damage. Includes 6 forms and 1 app.',
    tags: ['venues', 'bookings', 'events', 'hire', 'facilities'],
    formCount: venueOpsPack.forms.length,
    appCount: venueOpsPack.apps?.length ?? 0,
    icon: 'DoorOpen',
    pack: venueOpsPack as unknown as PackData,
  },
  {
    id: 'fleetflow-fleet',
    name: 'FleetFlow — Vehicle Fleet & Driver Log',
    description:
      'A fleet and driver logbook for small fleets: track vehicles and drivers, log trips and fuel, schedule maintenance, and record incidents, with rego, insurance and licence expiry warnings. Includes 5 forms and 1 app.',
    tags: ['fleet', 'vehicles', 'drivers', 'maintenance', 'logistics'],
    formCount: fleetFlowPack.forms.length,
    appCount: fleetFlowPack.apps?.length ?? 0,
    icon: 'Truck',
    pack: fleetFlowPack as unknown as PackData,
  },
  {
    id: 'sitepulse-site-diary',
    name: 'SitePulse — Construction Site Diary',
    description:
      'A daily site diary for small builders and subcontractors: run projects, log daily diaries with weather and manpower, track deliveries, defects and variations, and keep subcontractor insurance current. Includes 6 forms and 1 app.',
    tags: ['construction', 'site-diary', 'builders', 'defects', 'projects'],
    formCount: sitePulsePack.forms.length,
    appCount: sitePulsePack.apps?.length ?? 0,
    icon: 'HardHat',
    pack: sitePulsePack as unknown as PackData,
  },
  {
    id: 'agrilog-farm',
    name: 'AgriLog — Farm Jobs & Harvest Tracker',
    description:
      'A farm operations tracker for small farms: manage paddocks and crop jobs, log harvests, keep a chemical application register with withholding periods, and track machinery and maintenance. Includes 6 forms and 1 app.',
    tags: ['farm', 'agriculture', 'harvest', 'paddocks', 'compliance'],
    formCount: agriLogPack.forms.length,
    appCount: agriLogPack.apps?.length ?? 0,
    icon: 'Tractor',
    pack: agriLogPack as unknown as PackData,
  },
];
