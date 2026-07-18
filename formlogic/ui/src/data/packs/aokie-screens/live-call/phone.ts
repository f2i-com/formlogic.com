// Digit + time helpers for the Live Call console. Ported 1:1 from the previous
// embedded-JS screen: the digit scans are deliberately character checks (no regex)
// and the zone-less timestamp fixup matches the documented "YYYY-MM-DD HH:MM:SS is
// UTC on the wire" rule.

/** Every ASCII digit in the value, in order (character scan, no regex). */
export function digits(s: unknown): string {
  let out = '';
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charAt(i);
    if (c >= '0' && c <= '9') out += c;
  }
  return out;
}

/** Last-9-digit suffix: the phone-number match key used across the platform. */
export function tail9(s: unknown): string {
  const d = digits(s);
  return d.length > 9 ? d.slice(-9) : d;
}

/** Zone-less "YYYY-MM-DD HH:MM:SS" strings are UTC on the wire; tag them so
 *  Date.parse cannot read them as local wall-clock time. */
export function utcify(s: string): string {
  if (typeof s !== 'string') return s;
  if (s.length === 19 && s.charAt(4) === '-' && s.charAt(10) === ' ' && s.charAt(13) === ':') {
    return s.slice(0, 10) + 'T' + s.slice(11) + 'Z';
  }
  return s;
}

/** Epoch millis for a timestamp string, or null when unparseable. */
export function ms(s: string | null | undefined): number | null {
  const t = Date.parse(utcify(s || ''));
  return isNaN(t) ? null : t;
}

/** Local HH:MM:SS for a timestamp, or null when unparseable. */
export function clock(s: string | null | undefined): string | null {
  const t = ms(s);
  if (t === null) return null;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Local HH:MM for a timestamp, or null when unparseable. */
export function hhmm(s: string | null | undefined): string | null {
  const t = ms(s);
  if (t === null) return null;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pad(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

/** Elapsed-call formatting: M:SS, or H:MM:SS past the hour. */
export function dur(msSpan: number): string {
  const s = Math.max(0, Math.floor(msSpan / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
}
