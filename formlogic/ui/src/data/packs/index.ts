// The marketplace pack catalog. Each pack is a SELF-CONTAINED FOLDER (<id>/manifest.json +
// <id>/pack.ts + its screens/sources), and the catalog is LAZY: only the tiny manifests load
// statically — pack payloads are dynamic imports, so Vite code-splits one chunk per pack and the
// store/import surfaces fetch a pack's data only when it is actually opened or installed.
// Node tooling (emit-marketplace.mjs) bundles this same module; esbuild inlines the dynamic
// imports there, so loadAllPacks() works in both worlds from ONE source of truth.
import type { PackData } from '../../lib/api';
import financeOsUsManifest from './finance-os-us/manifest.json';
import financeOsAuManifest from './finance-os-au/manifest.json';
import ohsQmsManifest from './ohs-qms/manifest.json';
import hrPeopleManifest from './hr-people/manifest.json';
import eventManagementManifest from './event-management/manifest.json';
import customerServiceManifest from './customer-service/manifest.json';
import plumbingFieldServiceManifest from './plumbing-field-service/manifest.json';
import jobInvoiceManagementManifest from './job-invoice-management/manifest.json';
import salonBeautyStudioManifest from './salon-beauty-studio/manifest.json';
import mechanicWorkshopManifest from './mechanic-workshop/manifest.json';
import propertyMaintenanceManifest from './property-maintenance/manifest.json';
import clinicAppointmentIntakeManifest from './clinic-appointment-intake/manifest.json';
import inventoryPurchaseOrdersManifest from './inventory-purchase-orders/manifest.json';
import pawroutePetCareManifest from './pawroute-pet-care/manifest.json';
import brewdeskCafeOpsManifest from './brewdesk-cafe-ops/manifest.json';
import grillstackBurgerOpsManifest from './grillstack-burger-ops/manifest.json';
import counterflowRetailOpsManifest from './counterflow-retail-ops/manifest.json';
import stayreadyShortStayManifest from './stayready-short-stay/manifest.json';
import repairbenchDeviceRepairManifest from './repairbench-device-repair/manifest.json';
import passmasterRestaurantManifest from './passmaster-restaurant/manifest.json';
import catercraftCateringManifest from './catercraft-catering/manifest.json';
import cleanshiftCleaningManifest from './cleanshift-cleaning/manifest.json';
import tutortrackTutoringManifest from './tutortrack-tutoring/manifest.json';
import fitstudioCoachingManifest from './fitstudio-coaching/manifest.json';
import venueopsVenueHireManifest from './venueops-venue-hire/manifest.json';
import fleetflowFleetManifest from './fleetflow-fleet/manifest.json';
import sitepulseSiteDiaryManifest from './sitepulse-site-diary/manifest.json';
import agrilogFarmManifest from './agrilog-farm/manifest.json';
import aokieReceptionistManifest from './aokie-receptionist/manifest.json';

/** The store-listing metadata every pack folder declares in its manifest.json. */
export interface PackManifest {
  id: string;
  name: string;
  description: string;
  tags: string[];
  icon: string;
}

export interface PackCatalogEntry extends PackManifest {
  formCount: number;
  appCount: number;
  pack: PackData;
}

/** Light catalog metadata (bundled statically — a few KB, no pack payloads). */
export const packManifests: PackManifest[] = [
  financeOsUsManifest,
  financeOsAuManifest,
  ohsQmsManifest,
  hrPeopleManifest,
  eventManagementManifest,
  customerServiceManifest,
  plumbingFieldServiceManifest,
  jobInvoiceManagementManifest,
  salonBeautyStudioManifest,
  mechanicWorkshopManifest,
  propertyMaintenanceManifest,
  clinicAppointmentIntakeManifest,
  inventoryPurchaseOrdersManifest,
  pawroutePetCareManifest,
  brewdeskCafeOpsManifest,
  grillstackBurgerOpsManifest,
  counterflowRetailOpsManifest,
  stayreadyShortStayManifest,
  repairbenchDeviceRepairManifest,
  passmasterRestaurantManifest,
  catercraftCateringManifest,
  cleanshiftCleaningManifest,
  tutortrackTutoringManifest,
  fitstudioCoachingManifest,
  venueopsVenueHireManifest,
  fleetflowFleetManifest,
  sitepulseSiteDiaryManifest,
  agrilogFarmManifest,
  aokieReceptionistManifest,
];

// Literal dynamic imports so Vite can code-split each pack into its own chunk.
const loaders: Record<string, () => Promise<{ default: unknown }>> = {
  'finance-os-us': () => import('./finance-os-us/pack'),
  'finance-os-au': () => import('./finance-os-au/pack'),
  'ohs-qms': () => import('./ohs-qms/pack'),
  'hr-people': () => import('./hr-people/pack'),
  'event-management': () => import('./event-management/pack'),
  'customer-service': () => import('./customer-service/pack'),
  'plumbing-field-service': () => import('./plumbing-field-service/pack'),
  'job-invoice-management': () => import('./job-invoice-management/pack'),
  'salon-beauty-studio': () => import('./salon-beauty-studio/pack'),
  'mechanic-workshop': () => import('./mechanic-workshop/pack'),
  'property-maintenance': () => import('./property-maintenance/pack'),
  'clinic-appointment-intake': () => import('./clinic-appointment-intake/pack'),
  'inventory-purchase-orders': () => import('./inventory-purchase-orders/pack'),
  'pawroute-pet-care': () => import('./pawroute-pet-care/pack'),
  'brewdesk-cafe-ops': () => import('./brewdesk-cafe-ops/pack'),
  'grillstack-burger-ops': () => import('./grillstack-burger-ops/pack'),
  'counterflow-retail-ops': () => import('./counterflow-retail-ops/pack'),
  'stayready-short-stay': () => import('./stayready-short-stay/pack'),
  'repairbench-device-repair': () => import('./repairbench-device-repair/pack'),
  'passmaster-restaurant': () => import('./passmaster-restaurant/pack'),
  'catercraft-catering': () => import('./catercraft-catering/pack'),
  'cleanshift-cleaning': () => import('./cleanshift-cleaning/pack'),
  'tutortrack-tutoring': () => import('./tutortrack-tutoring/pack'),
  'fitstudio-coaching': () => import('./fitstudio-coaching/pack'),
  'venueops-venue-hire': () => import('./venueops-venue-hire/pack'),
  'fleetflow-fleet': () => import('./fleetflow-fleet/pack'),
  'sitepulse-site-diary': () => import('./sitepulse-site-diary/pack'),
  'agrilog-farm': () => import('./agrilog-farm/pack'),
  'aokie-receptionist': () => import('./aokie-receptionist/pack'),
};

async function entryFor(manifest: PackManifest): Promise<PackCatalogEntry> {
  const mod = await loaders[manifest.id]();
  const pack = mod.default as PackData;
  return {
    ...manifest,
    formCount: pack.forms?.length ?? 0,
    appCount: pack.apps?.length ?? 0,
    pack,
  };
}

/** Load ONE pack's full payload (dynamic chunk) with its catalog metadata. */
export async function loadPack(id: string): Promise<PackCatalogEntry | null> {
  const manifest = packManifests.find((m) => m.id === id);
  if (!manifest || !loaders[id]) return null;
  return entryFor(manifest);
}

/** Load EVERY pack payload (catalog seeding / tooling) — still lazy relative to the app bundle. */
export async function loadAllPacks(): Promise<PackCatalogEntry[]> {
  return Promise.all(packManifests.map(entryFor));
}
