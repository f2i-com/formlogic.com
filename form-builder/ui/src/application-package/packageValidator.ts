// Application Package validation (MVP: shape + safety, no signature yet).
//
// Validates the .formlogic envelope before it is handed to the existing
// atomic Pack importer. Signature verification, marketplace trust levels, and
// full asset extraction are later milestones (spec §29.6/§30.3); this pass just
// makes sure the manifest is well-formed and nothing obviously abusive (path
// traversal in asset keys, oversized payloads) gets through.
import {
  APPLICATION_PACKAGE_KIND,
  APPLICATION_PACKAGE_VERSION,
  type ApplicationPackage,
  type ApplicationPackageManifest,
} from './packageTypes';

export interface PackageValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5MB per inline asset (data URI)
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A safe asset key: no path traversal, no absolute paths, no backslashes. */
function isSafeAssetKey(key: string): boolean {
  if (!key || key.length > 200) return false;
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) return false;
  if (key.includes('\0')) return false;
  return true;
}

function validateManifest(manifest: unknown, errors: string[]): manifest is ApplicationPackageManifest {
  if (!isRecord(manifest)) {
    errors.push('manifest is missing or not an object');
    return false;
  }
  if (manifest.kind !== APPLICATION_PACKAGE_KIND) {
    errors.push(`manifest.kind must be "${APPLICATION_PACKAGE_KIND}"`);
  }
  if (manifest.version !== APPLICATION_PACKAGE_VERSION) {
    errors.push(`manifest.version must be ${APPLICATION_PACKAGE_VERSION}`);
  }
  if (typeof manifest.id !== 'string' || !SLUG_RE.test(manifest.id)) {
    errors.push('manifest.id must be a slug (lowercase letters, digits, hyphens)');
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    errors.push('manifest.name is required');
  }
  return errors.length === 0;
}

/** Validate an Application Package envelope. Does not validate the inner Pack — the
 *  server's validatePack handles that on import. */
export function validateApplicationPackage(pkg: unknown): PackageValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(pkg)) {
    return { valid: false, errors: ['package is not an object'], warnings };
  }

  validateManifest(pkg.manifest, errors);

  if (pkg.pack == null) {
    errors.push('package.pack (the forms/screens/app payload) is required');
  }

  if (pkg.assets !== undefined) {
    if (!isRecord(pkg.assets)) {
      errors.push('package.assets must be an object of name → data URI');
    } else {
      for (const [key, value] of Object.entries(pkg.assets)) {
        if (!isSafeAssetKey(key)) {
          errors.push(`unsafe asset key: ${key}`);
        }
        if (typeof value !== 'string') {
          errors.push(`asset "${key}" must be a data-URI string`);
        } else if (value.length > MAX_ASSET_BYTES) {
          errors.push(`asset "${key}" exceeds ${MAX_ASSET_BYTES} bytes`);
        }
      }
    }
  }

  if (pkg.customLogic !== undefined && !isRecord(pkg.customLogic)) {
    errors.push('package.customLogic must be a CustomAppLogicBundle object');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Narrowing helper: is this a structurally valid ApplicationPackage? */
export function isApplicationPackage(pkg: unknown): pkg is ApplicationPackage {
  return validateApplicationPackage(pkg).valid;
}
