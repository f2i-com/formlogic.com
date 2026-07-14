// Connector grant resolution for the SDK connector gate.
//
// A host-rendered screen may only call connector commands the app actually declares (matching the
// capabilities published in the signed client manifest). Those declarations live in the bundle-level
// AND script-level `permissions` of BOTH the app's customLogic and every form's customLogic delivered
// with the runtime config. This module unions those grant sets so the gate can't miss a form-level
// grant. Pure (no React / store / browser deps) so it is unit-testable on its own.
import { collectAllGrants } from '../logic/appLogicPermissions';
import type { AppRuntimeConfig } from '../../types/app';

/** The subset of the runtime config this resolver reads (app + forms customLogic). */
export type GrantSource = Pick<AppRuntimeConfig, 'app' | 'forms'> | null | undefined;

/**
 * Every connector/effect grant the app has declared, unioning:
 *   - the app-level customLogic grants (bundle + script permissions), and
 *   - the form-level customLogic grants.
 *
 * Scoping via `options.formId`:
 *   - `{ formId }`  → app-level grants ∪ that one form's grants, and
 *   - omitted       → app-level grants ∪ EVERY visible form's grants.
 *
 * The forms delivered in the runtime config are already permission-filtered by the server, so unioning
 * "all forms" only ever includes grants for forms the user may see.
 */
export function collectConnectorGrants(config: GrantSource, options?: { formId?: string }): Set<string> {
  const grants = new Set<string>();
  if (!config) return grants;

  // App-wide grants.
  for (const g of collectAllGrants(config.app?.customLogic)) grants.add(g);

  const forms = config.forms ?? [];
  if (options?.formId != null) {
    const form = forms.find((f) => f.formId === options.formId);
    if (form) for (const g of collectAllGrants(form.customLogic)) grants.add(g);
  } else {
    for (const f of forms) {
      for (const g of collectAllGrants(f.customLogic)) grants.add(g);
    }
  }
  return grants;
}
