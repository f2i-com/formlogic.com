import type { PackData } from './api';

/**
 * Trust-surface detectors for a pack, shared by the upload preview AND the marketplace install flow so
 * a user sees the same warning either way. A pack can carry code that runs with SDK/data access:
 *   - logicScript: server-side onSubmit code (runs on your server, can make outbound requests).
 *   - custom CODE screens (customScreen.kind !== 'dashboard' with html/js/ts/files): sandboxed
 *     HTML/CSS/JS that can read data the viewer is allowed to see. (No-code widget dashboards,
 *     kind:'dashboard', carry no code and are ignored here.)
 */
export function packHasLogicScript(pack: PackData): boolean {
  return (pack.forms ?? []).some((f) => {
    const s = (f as Record<string, unknown>).logicScript;
    return typeof s === 'string' && s.trim() !== '';
  });
}

export function packHasCodeScreen(pack: PackData): boolean {
  return [
    ...((pack.forms ?? []) as Record<string, unknown>[]),
    ...((pack.apps ?? []) as Record<string, unknown>[]),
  ].some((entity) => {
    const cs = entity.customScreen as Record<string, unknown> | undefined;
    if (!cs || !cs.enabled || cs.kind === 'dashboard') return false;
    return !!(cs.html || cs.js || cs.ts || (Array.isArray(cs.files) && cs.files.length > 0));
  });
}
