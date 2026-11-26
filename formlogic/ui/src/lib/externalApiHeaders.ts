// Which custom response headers an app's External API keeps.
//
// The server decides, when the settings are saved and again on every request:
// AppService::sanitizeExternalApi (formlogic/backend/src/Services/AppService.php). It keeps a name
// only when it is known to speak for the one answer it is on, and drops every other without a
// word, so the owner saw a header in the box that was never sent. This says which lines will not
// be kept, and why, before they are saved.
//
// The three lists and the three limits below are that method's and must stay identical to it:
// change one, change the other. externalApiHeaders.test.ts reads the PHP and fails when they differ.

/** `$responseHeaders` there: what an API states about its own answer. */
export const RESPONSE_HEADERS = ['cache-control', 'expires', 'pragma', 'content-language', 'deprecation', 'sunset'] as const;

/** `$actedOnHeaders` there: X- names a browser or the server in front of PHP acts on. */
export const ACTED_ON_HEADERS = [
  'x-frame-options', 'x-content-type-options', 'x-xss-protection', 'x-dns-prefetch-control',
  'x-permitted-cross-domain-policies', 'x-ua-compatible', 'x-download-options',
  'x-content-security-policy', 'x-webkit-csp', 'x-real-ip', 'x-original-url', 'x-rewrite-url',
  'x-http-method-override', 'x-method-override',
] as const;

/** `$actedOnPrefixes` there: the same, by how the name begins, and the ones this host writes. */
export const ACTED_ON_PREFIXES = ['x-formlogic-', 'x-forwarded-', 'x-ratelimit-', 'x-accel-', 'x-sendfile', 'x-lighttpd-', 'x-litespeed-', 'x-reproxy-'] as const;

/** A name's longest, in characters; a value's longest, in bytes; and how many headers are kept. */
export const MAX_HEADER_NAME = 64;
export const MAX_HEADER_VALUE_BYTES = 256;
export const MAX_HEADERS = 12;

const WHY = {
  line: 'it is not written as “Header: Value”',
  name: `a header’s name is letters, digits and hyphens, ${MAX_HEADER_NAME} at most`,
  wholeSite: 'a browser or a proxy keeps it for more than the one answer, so only Cache-Control, Expires, Pragma, Content-Language, Deprecation, Sunset and your own X- headers are sent',
  actedOn: 'browsers or the web server act on this X- header, or FormLogic sets it itself',
  long: `its value is longer than ${MAX_HEADER_VALUE_BYTES} bytes`,
  control: 'its value has a control character',
  tooMany: `only the first ${MAX_HEADERS} headers are kept`,
} as const;

export interface DroppedHeader {
  /** The header's name, or the line as typed when it has none. */
  name: string;
  /** Why it is not kept, to follow the name and a colon. */
  why: string;
}

export interface CheckedHeaders {
  /** What is sent to the server: every line that reads as a header. It still decides. */
  sent: Record<string, string>;
  /** What the server keeps of that, by its rule as copied here. */
  kept: Record<string, string>;
  /** What it does not, in the order typed. */
  dropped: DroppedHeader[];
}

/** Why the server will not send a header of this name, or null when it will. */
function nameRefusal(name: string): string | null {
  if (name.length > MAX_HEADER_NAME || !/^[A-Za-z0-9-]+$/.test(name)) return WHY.name;
  const lower = name.toLowerCase();
  if ((RESPONSE_HEADERS as readonly string[]).includes(lower)) return null;
  if (!lower.startsWith('x-') || lower === 'x-') return WHY.wholeSite;
  if ((ACTED_ON_HEADERS as readonly string[]).includes(lower) || ACTED_ON_PREFIXES.some((prefix) => lower.startsWith(prefix))) return WHY.actedOn;
  return null;
}

function valueRefusal(value: string): string | null {
  if (new TextEncoder().encode(value).length > MAX_HEADER_VALUE_BYTES) return WHY.long;
  // A tab is the one control character a header's value may hold.
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return WHY.control;
  }
  return null;
}

/** The box's text ("Header: Value", one a line) as it is sent, what the server keeps of it, and what it drops and why. */
export function checkCustomHeaders(text: string): CheckedHeaders {
  const sent: Record<string, string> = {};
  const dropped: DroppedHeader[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    const value = colon > 0 ? line.slice(colon + 1).trim() : '';
    if (!name || !value) {
      dropped.push({ name: line.trim(), why: WHY.line });
      continue;
    }
    // A name given twice is one header: the later value, in the earlier place, as the server reads it.
    sent[name] = value;
  }
  const kept: Record<string, string> = {};
  let full = false;
  for (const [name, value] of Object.entries(sent)) {
    const why = full ? WHY.tooMany : nameRefusal(name) ?? valueRefusal(value);
    if (why) {
      dropped.push({ name, why });
      continue;
    }
    kept[name] = value;
    full = Object.keys(kept).length >= MAX_HEADERS;
  }
  return { sent, kept, dropped };
}

/** The headers sent that are not among those the server says it stored. */
export function headersNotStored(sent: Record<string, string>, stored: unknown): string[] {
  const has = (name: string) => !!stored && typeof stored === 'object' && Object.prototype.hasOwnProperty.call(stored, name);
  return Object.keys(sent).filter((name) => !has(name));
}
