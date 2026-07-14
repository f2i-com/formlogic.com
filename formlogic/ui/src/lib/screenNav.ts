/**
 * Resolve a `FormLogic.navigate(target)` request from a sandboxed app custom screen to a SAFE
 * app-relative route, or null to reject it. Imported/community screen code must not be able to send a
 * viewer to arbitrary internal routes (settings/billing/admin) or off-site. Allowed targets:
 *   - a bare known formId               → start a new record for it
 *   - records | reports                 → the app's records/reports hubs
 *   - form/<formId>[?new=1]             → open that form (optionally straight into new-record entry)
 *   - form/<formId>/responses[/<id>]    → that form's records grid / one record
 * Everything else (absolute/protocol-relative/`..`/scheme URLs, unknown or non-app routes) is rejected.
 */
export function safeAppNavTarget(target: string, formIds: Set<string>): string | null {
  const t = (target || '').trim();
  if (!t) return null;
  if (formIds.has(t)) return `form/${t}?new=1`; // bare formId → new record
  // Block anything that could escape the app scope (schemes, absolute/UNC/protocol-relative, parent refs).
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('\\') || t.includes('..') || t.includes('//')) {
    return null;
  }
  if (t === 'records' || t === 'reports') return t;
  const m = t.match(/^form\/([A-Za-z0-9_-]+)(?:\?new=1|\/responses(?:\/[A-Za-z0-9_-]+)?)?$/);
  if (m && formIds.has(m[1])) return t;
  return null;
}
