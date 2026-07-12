import { parseServerDate } from './utils';
import { useAppRuntimeStore } from '../stores/appRuntimeStore';
import { useAuthStore } from '../stores/authStore';

/**
 * Timezone-aware datetime display for record views.
 *
 * Times are always STORED as UTC (ISO-8601). What differs per account is how
 * they're SHOWN: an owner in Sydney and a member in London viewing the same
 * call should each see it in their own clock. The display zone resolves in a
 * clear order — the viewing member's own account timezone wins, else the app's
 * configured timezone (set by / defaulted from its creator), else UTC.
 */

/** Resolve the timezone to render in: member override → app default → UTC. */
export function resolveDisplayTimezone(
  memberTz?: string | null,
  appTz?: string | null,
): string {
  const m = (memberTz ?? '').trim();
  if (m) return m;
  const a = (appTz ?? '').trim();
  if (a) return a;
  return 'UTC';
}

/**
 * The timezone the CURRENT app-runtime member should see record times in:
 * their own account timezone, else the app's configured timezone, else UTC.
 * A hook so record views re-render if either changes (profile edit / settings).
 */
export function useDisplayTimezone(): string {
  // The live account timezone (updates reactively when the member saves it in
  // their profile) takes precedence over the bootstrap snapshot.
  const liveTz = useAuthStore((s) => s.user?.timezone);
  const memberTz = useAppRuntimeStore((s) => s.memberTimezone);
  const appTz = useAppRuntimeStore((s) => s.config?.app?.settings?.timezone);
  return resolveDisplayTimezone(liveTz ?? memberTz, appTz);
}

// ISO-8601 with a time component AND an explicit zone (Z or ±hh:mm). This is
// the shape the Aokie Calls pack stores in its short_text started_at /
// answered_at / ended_at fields, so those raw-looking values still render in
// the viewer's timezone instead of as "2026-07-11T10:34:32.742Z".
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** True when `v` is a string that looks like a full ISO-8601 datetime. */
export function isIsoDateTime(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATETIME_RE.test(v.trim());
}

/** The browser's own IANA timezone (e.g. "Australia/Sydney"), or '' if unknown. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** The IANA timezone list for a picker; falls back to a small common set on
 *  older engines that lack `Intl.supportedValuesOf`. */
export function listTimezones(): string[] {
  try {
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    if (typeof anyIntl.supportedValuesOf === 'function') {
      return anyIntl.supportedValuesOf('timeZone');
    }
  } catch {
    /* fall through */
  }
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Perth',
    'Australia/Sydney',
    'Pacific/Auckland',
  ];
}

const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
};

/**
 * Format a UTC datetime (ISO string or Date) in `tz`. A bad/unsupported tz
 * falls back to UTC rather than throwing; an unparseable value is returned
 * verbatim (never "Invalid Date").
 */
export function formatDateTimeInZone(value: string | Date, tz: string): string {
  const d = parseServerDate(value);
  if (isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  try {
    return new Intl.DateTimeFormat(undefined, { ...DATETIME_OPTS, timeZone: tz }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...DATETIME_OPTS, timeZone: 'UTC' }).format(d);
  }
}

/**
 * The timezone for PLATFORM CHROME pages (Settings, the recycle bin, the
 * admin panel): the signed-in user's own account timezone, else their
 * browser's zone, else UTC. The app-runtime member→app chain doesn't apply —
 * these pages aren't a member view of someone's app.
 */
export function useAccountTimezone(): string {
  const tz = useAuthStore((s) => s.user?.timezone);
  return resolveDisplayTimezone(tz, browserTimezone());
}

/** The admin panel's display zone — same account→browser→UTC chain. */
export function useAdminTimezone(): string {
  return useAccountTimezone();
}

/**
 * Date-only display of a UTC TIMESTAMP in `tz` ("11 Jul 2026") — for moments
 * like "joined" where the time of day is noise but the zone still decides
 * which calendar day the moment falls on. Distinct from formatDateOnly, which
 * renders zone-less calendar dates verbatim.
 */
export function formatDateInZone(value: string | Date, tz: string): string {
  const d = parseServerDate(value);
  if (isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(d);
  }
}

/**
 * Date-only display ("11 Jul 2026"). A calendar date carries no time, so it's
 * NOT shifted between zones — showing it in a viewer's tz would wrongly roll a
 * date-of-birth across midnight. Rendered from the literal Y-M-D.
 */
export function formatDateOnly(value: string): string {
  const s = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
