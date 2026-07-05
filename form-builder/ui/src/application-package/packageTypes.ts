// FormLogic Application Package (.formlogic-app) — type definitions.
//
// An Application Package is the portable, runtime-aware superset of today's Pack
// (spec §29): the app + forms + screens + dashboards + reports, PLUS the new
// custom app-logic, launch/native config, connector requirements and assets.
// These types describe the on-disk/JSON shape; the existing Pack import path is
// reused for the forms/screens/app payload, so this envelope only adds the new
// runtime metadata around it.
import type { CustomAppLogicBundle } from '../types/customAppLogic';

export const APPLICATION_PACKAGE_KIND = 'formlogic.applicationPackage' as const;
export const APPLICATION_PACKAGE_VERSION = 1 as const;

export interface ApplicationPackageAuthor {
  name: string;
  url?: string;
}

export interface ApplicationPackageManifest {
  version: typeof APPLICATION_PACKAGE_VERSION;
  kind: typeof APPLICATION_PACKAGE_KIND;
  /** Stable package id (also the app slug it installs as). */
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  author?: ApplicationPackageAuthor;
  runtime?: {
    requires?: { formlogic?: string; sdk?: string };
    /** Deployment targets this package supports. */
    supports?: Array<'browser-pwa' | 'native-android'>;
  };
  entry?: {
    /** Home screen key/id shown first (spec §29.3). */
    homeScreen?: string;
  };
  capabilities?: {
    offline?: boolean;
    native?: boolean;
    connectors?: string[];
    quickjs?: boolean;
  };
}

/** Launch/landing config for a custom domain (spec §21) — MVP: metadata only. */
export interface ApplicationPackageLaunchConfig {
  headline?: string;
  subheadline?: string;
  description?: string;
  logoUrl?: string;
  showOpenWebApp?: boolean;
  showInstallPwa?: boolean;
  showInstallNative?: boolean;
  supportEmail?: string;
  privacyUrl?: string;
  termsUrl?: string;
  showPoweredBy?: boolean;
}

/** Declared native connector capability the app needs (spec §50). */
export interface ApplicationPackageNativeCapability {
  connector: string;
  commands: string[];
  required?: boolean;
  reason?: string;
}

export interface ApplicationPackageNativeConfig {
  enabled?: boolean;
  packageName?: string;
  minVersion?: string;
  capabilities?: ApplicationPackageNativeCapability[];
}

/**
 * The full package envelope. `pack` carries the existing Pack payload (forms,
 * screens, app, reports, sample data) so import reuses the current atomic pack
 * importer verbatim; the sibling fields add the runtime-aware layers.
 */
export interface ApplicationPackage {
  manifest: ApplicationPackageManifest;
  /** Existing Pack payload (opaque here to avoid coupling; validated on import). */
  pack: unknown;
  customLogic?: CustomAppLogicBundle;
  launch?: ApplicationPackageLaunchConfig;
  native?: ApplicationPackageNativeConfig;
  /** Optional inline assets as data URIs, keyed by logical name. */
  assets?: Record<string, string>;
}

/** A signed package wrapper (spec §29.6) — signature verification is post-MVP. */
export interface SignedApplicationPackage {
  package: ApplicationPackage;
  signature?: string;
  alg?: 'Ed25519';
  keyId?: string;
}
