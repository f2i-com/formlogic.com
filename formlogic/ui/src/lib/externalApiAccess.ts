// Which route prefixes, default path prefix, browser origins and rate limit an app's External API
// keeps.
//
// The server decides, when the settings are saved: AppService::sanitizeExternalApi
// (formlogic/backend/src/Services/AppService.php), with SessionOriginPolicy::normalizeOrigin
// (formlogic/backend/src/Support/SessionOriginPolicy.php) for an origin. It drops what it will not
// keep without a word, so the owner saw a prefix in the box that was never blocked, or an origin
// that was never allowed; and with every allowed prefix dropped, every route was allowed. This says
// what will not be kept, and why, before it is saved (the custom headers: lib/externalApiHeaders).
//
// The limits, prefixes and patterns below are those methods' and must stay identical to them:
// change one, change the other. externalApiAccess.test.ts reads the PHP and fails when they differ.

/** A route prefix's longest, in bytes (`strlen($p) > 200`), and how many of each list are kept. */
export const MAX_PATH_BYTES = 200;
export const MAX_PATHS = 30;
/** The routes FormLogic alone calls on an app's backend (`'/api/site/'`): never one an outside caller may be let to. */
export const SITE_ROUTES = '/api/site/';
/** The default path prefix's longest, in bytes, the characters it is made of, and what it may not begin with. */
export const MAX_PREFIX_BYTES = 64;
export const PREFIX_CHARACTERS = 'A-Za-z0-9/_-';
export const SITE_PREFIX = '/api/site';
/** How many browser origins are kept. */
export const MAX_ORIGINS = 20;
/** SessionOriginPolicy::normalizeOrigin's patterns: the whole origin, then a host name's labels. */
export const ORIGIN_PATTERN = /^https?:\/\/(?:\[[a-f0-9:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/i;
export const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/;
export const MAX_HOST_LENGTH = 253;
/** The rate limit a minute: what is kept when none is given (`$rateLimit = 120`), and the least and most kept. */
export const DEFAULT_RATE_LIMIT = 120;
export const MIN_RATE_LIMIT = 1;
export const MAX_RATE_LIMIT = 600;

const PREFIX_PATTERN = new RegExp(`^/[${PREFIX_CHARACTERS}]+$`);

const WHY = {
  pathLong: `it is longer than ${MAX_PATH_BYTES} bytes`,
  dots: 'it holds “..”',
  // The server's \s, as PCRE reads it without UTF-8: a space, a tab and the other ASCII line breaks.
  pathSpace: 'it has a space or a control character',
  siteRoute: `routes under ${SITE_ROUTES} are FormLogic’s own to call`,
  tooManyPaths: `only the first ${MAX_PATHS} are kept`,
  prefixLong: `it is longer than ${MAX_PREFIX_BYTES} characters`,
  prefixCharacters: 'a prefix is letters, digits, “/”, “_” and “-”',
  sitePrefix: `routes under ${SITE_PREFIX} are FormLogic’s own to call`,
  origin: 'an origin is http:// or https://, a host and at most a port, and nothing after it',
  host: 'its host is not a domain name or an IP address',
  port: 'its port is not between 1 and 65535',
  tooManyOrigins: `only the first ${MAX_ORIGINS} are kept`,
  rateRange: (kept: number) => `a rate limit is from ${MIN_RATE_LIMIT} to ${MAX_RATE_LIMIT} requests a minute, so ${kept} is kept`,
  rateWhole: (kept: number) => `a rate limit is a whole number of requests, so ${kept} is kept`,
  rateNone: `no number is given, so the default, ${DEFAULT_RATE_LIMIT}, is kept`,
} as const;

export interface NotKept {
  /** The entry as typed. */
  name: string;
  /** Why it is not kept, to follow the name and a colon. */
  why: string;
}

export interface CheckedEntries {
  /** What is sent to the server: each entry as typed. It still decides. */
  sent: string[];
  /** What the server keeps of that, as it stores it, by its rule as copied here. */
  kept: string[];
  /** What it does not, in the order typed. */
  dropped: NotKept[];
}

/** A box's entries as the page sends them: one a line or between commas, trimmed, none empty. */
export function entriesOf(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

/** strtolower: PHP's, which changes A to Z and nothing else. */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The server's [\x00-\x1f\x7f\s]: a control character, DEL, or what PCRE's \s is without UTF-8
 * (a space, a tab and the ASCII line breaks, all of them at or below 0x20).
 */
function hasSpaceOrControl(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The prefix as the server stores it, or why it does not ($cleanPaths). */
function cleanPath(entry: string): { path: string } | { why: string } {
  const path = entry.startsWith('/') ? entry : `/${entry}`;
  if (bytes(path) > MAX_PATH_BYTES) return { why: WHY.pathLong };
  if (path.includes('..')) return { why: WHY.dots };
  if (hasSpaceOrControl(path)) return { why: WHY.pathSpace };
  if (asciiLower(path).startsWith(SITE_ROUTES)) return { why: WHY.siteRoute };
  return { path };
}

/**
 * A list of entries as the server keeps them: each in its stored form, an entry it already has
 * kept once, and none after the limit. An entry that comes again (`api/x` after `/api/x`) is not
 * a loss and is not named, and one that is not kept is named once.
 */
function checkEntries(text: string, clean: (entry: string) => { value: string } | { why: string }, limit: number, tooMany: string): CheckedEntries {
  const sent = entriesOf(text);
  const kept: string[] = [];
  const dropped: NotKept[] = [];
  for (const entry of sent) {
    const cleaned = clean(entry);
    if (('value' in cleaned && kept.includes(cleaned.value)) || dropped.some((named) => named.name === entry)) continue;
    if (kept.length >= limit) dropped.push({ name: entry, why: tooMany });
    else if ('why' in cleaned) dropped.push({ name: entry, why: cleaned.why });
    else kept.push(cleaned.value);
  }
  return { sent, kept, dropped };
}

/** Allowed or Blocked Route Prefixes as they are sent, what the server keeps of them, and what it drops and why. */
export function checkPaths(text: string): CheckedEntries {
  return checkEntries(text, (entry) => {
    const cleaned = cleanPath(entry);
    return 'path' in cleaned ? { value: cleaned.path } : cleaned;
  }, MAX_PATHS, WHY.tooManyPaths);
}

/** The Default Path Prefix as it is sent, as the server keeps it ('' for none), and why not when it does not. */
export function checkDefaultPrefix(text: string): { sent: string; kept: string; dropped: NotKept[] } {
  const sent = text.trim();
  if (sent === '') return { sent, kept: '', dropped: [] };
  // "/" is no prefix, as an empty box is.
  const prefix = (sent.startsWith('/') ? sent : `/${sent}`).replace(/\/+$/, '');
  if (prefix === '') return { sent, kept: '', dropped: [] };
  const why = bytes(prefix) > MAX_PREFIX_BYTES ? WHY.prefixLong
    : prefix.includes('..') || !PREFIX_PATTERN.test(prefix) ? WHY.prefixCharacters
    : asciiLower(prefix).startsWith(SITE_PREFIX) ? WHY.sitePrefix
    : null;
  return why ? { sent, kept: '', dropped: [{ name: sent, why }] } : { sent, kept: prefix, dropped: [] };
}

/** An IPv4 address as PHP's filter reads one inside an IPv6 address: four numbers to 255, none with a leading 0. */
function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * PHP's FILTER_VALIDATE_IP with FILTER_FLAG_IPV6 (ext/filter, _php_filter_validate_ipv6): up to
 * eight groups of one to four hex digits, one "::" for any run of empty ones, and an IPv4 address
 * in place of the last two.
 */
export function isIpv6(text: string): boolean {
  if (!text.includes(':')) return false;
  let rest = text;
  let blocks = 0;
  const dot = text.indexOf('.');
  if (dot >= 0) {
    const start = text.lastIndexOf(':', dot) + 1;
    if (!isIpv4(text.slice(start))) return false;
    if (start < 2) return false;
    // The ':' before the IPv4 address belongs to it unless it ends a '::'.
    rest = text.slice(0, text[start - 2] === ':' ? start : start - 1);
    blocks = 2;
  }
  let compressed = false;
  let at = 0;
  while (at < rest.length) {
    if (rest[at] === ':') {
      if (++at >= rest.length) return false;
      if (rest[at] === ':') {
        if (compressed) return false;
        compressed = true;
        blocks++;
        if (++at === rest.length) return blocks <= 8;
      } else if (at - 1 === 0) {
        return false;
      }
    }
    const start = at;
    while (at < rest.length && /[0-9a-fA-F]/.test(rest[at])) at++;
    if (at - start < 1 || at - start > 4) return false;
    if (++blocks > 8) return false;
  }
  return (compressed && blocks <= 8) || blocks === 8;
}

/** SessionOriginPolicy::normalizeOrigin: the origin as it is kept, or why not. */
export function normalizeOrigin(origin: string): { origin: string } | { why: string } {
  if (!ORIGIN_PATTERN.test(origin)) return { why: WHY.origin };
  const [, scheme, host, port] = /^([a-z]+):\/\/(\[[^\]]*\]|[^:]+)(?::([0-9]+))?$/i.exec(origin) ?? [];
  const lowerScheme = asciiLower(scheme ?? '');
  const lowerHost = asciiLower(host ?? '');
  if (lowerHost.startsWith('[')) {
    if (!lowerHost.endsWith(']') || !isIpv6(lowerHost.slice(1, -1))) return { why: WHY.host };
  } else if (lowerHost.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(lowerHost)) {
    return { why: WHY.host };
  }
  const defaultPort = lowerScheme === 'https' ? 443 : 80;
  const number = port === undefined ? defaultPort : Number(port);
  if (number < 1 || number > 65535) return { why: WHY.port };
  return { origin: `${lowerScheme}://${lowerHost}${number === defaultPort ? '' : `:${number}`}` };
}

/** Allowed Browser CORS Origins as they are sent, what the server keeps of them, and what it drops and why. */
export function checkCorsOrigins(text: string): CheckedEntries {
  return checkEntries(text, (entry) => {
    if (entry === '*') return { value: '*' };
    const normalized = normalizeOrigin(entry.replace(/\/+$/, ''));
    return 'origin' in normalized ? { value: normalized.origin } : normalized;
  }, MAX_ORIGINS, WHY.tooManyOrigins);
}

/**
 * The Rate Limit box as it is sent, what the server keeps of it, and why when that is not what was
 * typed: the server holds a number to whole requests from 1 to 600 a minute (`(int)`, then
 * `max(1, min(600, …))`), and keeps 120 when it is given none. The page sent 120 for a 0, which
 * the server would have kept as 1, and neither said so. What is sent is the number as typed, as the
 * other boxes send theirs: the server still decides.
 */
export function checkRateLimit(text: string): { sent: number; kept: number; dropped: NotKept[] } {
  const typed = text.trim();
  const number = typed === '' ? Number.NaN : Number(typed);
  if (!Number.isFinite(number)) {
    return { sent: DEFAULT_RATE_LIMIT, kept: DEFAULT_RATE_LIMIT, dropped: [{ name: typed || '(empty)', why: WHY.rateNone }] };
  }
  const kept = Math.max(MIN_RATE_LIMIT, Math.min(MAX_RATE_LIMIT, Math.trunc(number)));
  if (kept === number) return { sent: number, kept, dropped: [] };
  const inRange = number >= MIN_RATE_LIMIT && number <= MAX_RATE_LIMIT;
  return { sent: number, kept, dropped: [{ name: typed, why: inRange ? WHY.rateWhole(kept) : WHY.rateRange(kept) }] };
}

/** The prefix or origin each entry sent is stored as, by the rule above, or null where it is none. */
function storedForm(field: 'paths' | 'origins', entry: string): string | null {
  if (field === 'paths') {
    const cleaned = cleanPath(entry);
    return 'path' in cleaned ? cleaned.path : null;
  }
  if (entry === '*') return '*';
  const normalized = normalizeOrigin(entry.replace(/\/+$/, ''));
  return 'origin' in normalized ? normalized.origin : null;
}

/** The entries sent that the server's answer did not store, in the form it stores them. */
export function entriesNotStored(field: 'paths' | 'origins', sent: string[], stored: unknown): string[] {
  const list = Array.isArray(stored) ? stored : [];
  return sent.filter((entry) => {
    const form = storedForm(field, entry);
    return form === null || !list.includes(form);
  });
}

/** Whether a default path prefix that was sent is not the one the server's answer stored. */
export function prefixNotStored(sent: string, stored: unknown): boolean {
  const checked = checkDefaultPrefix(sent);
  if (checked.sent === '' || (checked.kept === '' && checked.dropped.length === 0)) return false;
  return checked.kept === '' || stored !== checked.kept;
}

/** Up to four names, and how many more. */
export function namesInWords(names: string[]): string {
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
}
