// Shared value/timestamp helpers for the Device Setup console.
//
// Zone-less 'YYYY-MM-DD HH:MM:SS' timestamps are stored UTC -> stamp the Z
// before parsing. Character checks (not a regex) keep the rule obvious and
// byte-for-byte equivalent to the original embedded-JS implementation.

/** Coerce an unknown value to a plain object (never an array), else {}. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function utcify(s: string): string {
  if (s.length === 19 && s.charAt(4) === '-' && s.charAt(10) === ' ' && s.charAt(13) === ':') {
    return s.slice(0, 10) + 'T' + s.slice(11) + 'Z';
  }
  return s;
}

export interface WhenLabel {
  short: string;
  full: string;
}

/** Locale short label + full tooltip for a stored timestamp, or null when unparsable. */
export function whenLabel(iso: string | null | undefined): WhenLabel | null {
  const ms = Date.parse(utcify(iso || ''));
  if (isNaN(ms)) return null;
  const d = new Date(ms);
  return {
    short: d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    full: d.toLocaleString(),
  };
}

/** Coarse relative-age label ('just now' / 'N min ago' / ...), or null when unparsable. */
export function agoLabel(iso: string | null | undefined): string | null {
  const ms = Date.parse(utcify(iso || ''));
  if (isNaN(ms)) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
