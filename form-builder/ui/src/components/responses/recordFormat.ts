// Shared owner-scoped record formatting + edit-input helpers, extracted from FormResponses
// so the responses table, the CSV export, the full-page record view (FormResponseView) and
// the linked-record peek all render answers identically. Components live in recordDisplay.tsx
// (kept separate so react fast-refresh sees component-only modules).
import { browserTimezone, formatDateTimeInZone, isIsoDateTime } from '../../lib/timezone';
// A linked_record value resolved server-side into a human label. `targetFormId` lets the
// UI open the referenced record on demand (the owner owns it, so it's fetchable directly).
export type ResolvedLink = { id: string; display: string; targetFormId?: string };

export const STATUS_OPTIONS = ['submitted', 'reviewed', 'approved', 'rejected', 'archived'] as const;

// Format a single answer for display. Pure over its args (no component state) so it's shared
// by the table, the CSV export, the record view, and the linked-record peek. `tz` is the
// viewer's display timezone for TRUE instants (ISO datetimes with a zone); zone-less
// datetime-local answers are a wall clock the respondent picked and are never shifted.
export function formatValue(value: unknown, fieldType?: string, options?: Array<{ value: string; label?: string }>, tz?: string): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // File upload: show filenames
  if (fieldType === 'file_upload' && Array.isArray(value)) {
    return value.map((f: unknown) => (f && typeof f === 'object' && 'originalFilename' in f) ? (f as Record<string, unknown>).originalFilename : 'File').join(', ') || '-';
  }
  // Signature: a typed signature is stored as "typed:<name>" — show the name; a drawn
  // signature is a data:image URL — show a marker, never the raw base64.
  if (fieldType === 'signature') {
    if (typeof value === 'string' && value.startsWith('typed:')) {
      const name = value.slice(6).trim();
      return name || '-';
    }
    return value ? '[signature]' : '-';
  }
  // Linked record: stored as the target response id(s). Prefer resolved labels at the call
  // site (see linkedText); this fallback only fires when nothing was resolved.
  if (fieldType === 'linked_record') {
    const n = Array.isArray(value) ? value.length : (value ? 1 : 0);
    return n === 0 ? '-' : n === 1 ? '[linked record]' : `[${n} linked records]`;
  }
  // Choice fields: map stored option values (e.g. "option_2") to their human labels.
  if (options && options.length && (fieldType === 'dropdown' || fieldType === 'multiple_choice' || fieldType === 'checkboxes')) {
    const labelFor = (v: unknown) => options.find((o) => o.value === v)?.label ?? String(v);
    return Array.isArray(value) ? value.map(labelFor).join(', ') : labelFor(value);
  }
  // Location: show coordinates
  if (fieldType === 'location' && value && typeof value === 'object' && 'latitude' in (value as Record<string, unknown>)) {
    const loc = value as Record<string, number>;
    return `${loc.latitude?.toFixed(6)}, ${loc.longitude?.toFixed(6)}`;
  }
  // Date/time locale formatting (guard against Invalid Date rather than swallowing it)
  if (typeof value === 'string' && value) {
    if (fieldType === 'date') {
      const d = new Date(value + 'T00:00:00');
      return isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } else if (fieldType === 'time') {
      const [h, m] = value.split(':').map(Number);
      const d = new Date(2000, 0, 1, h, m);
      return isNaN(d.getTime()) ? value : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } else if (fieldType === 'datetime') {
      // A full ISO instant (explicit zone) renders in the viewer's timezone;
      // a zone-less datetime-local value is a wall clock — formatted verbatim.
      if (isIsoDateTime(value)) {
        return formatDateTimeInZone(value, tz || browserTimezone() || 'UTC');
      }
      const d = new Date(value);
      return isNaN(d.getTime()) ? value : d.toLocaleString();
    }
  }
  if (Array.isArray(value)) return value.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Normalize the server's _resolved value (single object or array) into a list.
export function asResolvedList(v: ResolvedLink | ResolvedLink[] | undefined): ResolvedLink[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Plain-text join of resolved linked-record labels — for tooltips, CSV, and non-interactive rows.
export function linkedText(items: ResolvedLink[]): string {
  return items.length ? items.map((i) => i.display).join(', ') : '-';
}

