// Permission model for sandboxed custom app-logic effects.
//
// The QuickJS script itself can do nothing but return a description of effects.
// EVERY outward effect (connector call, response write, storage, navigation,
// setValues, toast) must map to a permission that the app/script was granted,
// or the trusted host drops it. Advisory-only results (reject / warnings /
// message) affect only the local submit gate and need no permission.
//
// Grants support three wildcard shapes (see CustomAppLogicPermission):
//   '*'                    → everything
//   'connector.vehicle.*'  → any command under connector.vehicle
//   'ui.*'                 → any ui.* effect
import type {
  CustomAppLogicBundle,
  CustomAppLogicEffect,
  CustomAppLogicPermission,
  CustomAppLogicScript,
} from '../../types/customAppLogic';

/**
 * The permission an effect requires, or null when the effect is inherently safe
 * (never happens today — every effect below maps to a permission).
 */
export function effectRequiredPermission(effect: CustomAppLogicEffect): string | null {
  switch (effect.type) {
    case 'ui.toast':
      return 'ui.toast';
    case 'ui.navigate':
      return 'ui.navigate';
    case 'ui.setValues':
      return 'ui.setValues';
    case 'ui.reject':
      return 'ui.reject';
    case 'storage.get':
    case 'storage.set':
    case 'storage.remove':
      return 'storage.local';
    case 'formlogic.submitResponse':
      return 'formlogic.responses.write';
    case 'formlogic.listResponses':
      return 'formlogic.responses.read';
    case 'connector.request':
      // e.g. connector.vehicle.status.read  (command itself may contain a dot)
      return `connector.${effect.connectorId}.${effect.command}`;
    default:
      return null;
  }
}

/**
 * Effects allowed WITHOUT an explicit grant when a bundle opts out of strict permissions
 * (bundle.strictPermissions === false). Deliberately limited to purely-local, non-sensitive UI
 * effects — NEVER connector.*, response writes, storage, or navigation, which always require a grant
 * regardless of strict mode. In strict mode (the default) even these need an explicit grant.
 */
const DEFAULT_SAFE_EFFECTS = new Set<CustomAppLogicEffect['type']>(['ui.setValues', 'ui.toast']);

export function isDefaultSafeEffect(effect: CustomAppLogicEffect): boolean {
  return DEFAULT_SAFE_EFFECTS.has(effect.type);
}

/** Does one granted permission cover the required permission string? */
function grantCovers(grant: string, required: string): boolean {
  if (grant === '*') return true;
  if (grant === required) return true;
  if (grant.endsWith('.*')) {
    const prefix = grant.slice(0, -2); // strip '.*'
    return required === prefix || required.startsWith(prefix + '.');
  }
  return false;
}

/** Is `required` granted by any permission in `grants`? */
export function isPermissionGranted(required: string, grants: Iterable<string>): boolean {
  for (const grant of grants) {
    if (grantCovers(grant, required)) return true;
  }
  return false;
}

/**
 * The effective grant set for a script = app-level grants ∪ script-level grants.
 * Script-level permissions are additive (spec §33): "script-level permissions are
 * added on top" of the app-wide grants.
 */
export function collectGrants(
  bundle: Pick<CustomAppLogicBundle, 'permissions'>,
  script?: Pick<CustomAppLogicScript, 'permissions'>
): Set<string> {
  const grants = new Set<string>();
  for (const p of bundle.permissions ?? []) grants.add(p as string);
  for (const p of script?.permissions ?? []) grants.add(p as string);
  return grants;
}

/**
 * Every permission string declared anywhere in a bundle — bundle-level grants plus every script's
 * grants. Used by the SDK connector gate so a host-rendered screen can only call connector commands
 * the app actually declares (matching the capabilities published in the signed client manifest).
 */
export function collectAllGrants(
  bundle: Pick<CustomAppLogicBundle, 'permissions' | 'scripts'> | null | undefined
): Set<string> {
  const grants = new Set<string>();
  if (!bundle) return grants;
  for (const p of bundle.permissions ?? []) grants.add(p as string);
  for (const s of bundle.scripts ?? []) {
    for (const p of s?.permissions ?? []) grants.add(p as string);
  }
  return grants;
}

/** Normalize a permission list (dedupe, drop blanks) for storage/validation. */
export function cleanPermissions(
  permissions: unknown
): CustomAppLogicPermission[] {
  if (!Array.isArray(permissions)) return [];
  const out = new Set<string>();
  for (const p of permissions) {
    if (typeof p === 'string' && p.trim()) out.add(p.trim());
  }
  return Array.from(out) as CustomAppLogicPermission[];
}
