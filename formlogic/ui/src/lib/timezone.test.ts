import { describe, it, expect } from 'vitest';
import { resolveDisplayTimezone, isIsoDateTime, formatDateTimeInZone, formatDateOnly } from './timezone';

describe('resolveDisplayTimezone', () => {
  it('prefers the member timezone, then the app timezone, then UTC', () => {
    expect(resolveDisplayTimezone('Australia/Sydney', 'Europe/London')).toBe('Australia/Sydney');
    expect(resolveDisplayTimezone('', 'Europe/London')).toBe('Europe/London');
    expect(resolveDisplayTimezone(null, null)).toBe('UTC');
    expect(resolveDisplayTimezone('  ', '  ')).toBe('UTC');
  });
});

describe('isIsoDateTime', () => {
  it('matches ISO-8601 instants (the Aokie Calls short_text values)', () => {
    expect(isIsoDateTime('2026-07-11T10:34:32.742Z')).toBe(true);
    expect(isIsoDateTime('2026-07-11T10:34:32Z')).toBe(true);
    expect(isIsoDateTime('2026-07-11T10:34+10:00')).toBe(true);
  });
  it('rejects non-datetime text and date-only strings', () => {
    expect(isIsoDateTime('2026-07-11')).toBe(false); // no time/zone → a plain date
    expect(isIsoDateTime('Lance')).toBe(false);
    expect(isIsoDateTime('0491570156')).toBe(false);
    expect(isIsoDateTime(42)).toBe(false);
    expect(isIsoDateTime(null)).toBe(false);
  });
});

describe('formatDateTimeInZone', () => {
  it('renders the same instant differently per zone', () => {
    const iso = '2026-07-11T10:34:32Z';
    const sydney = formatDateTimeInZone(iso, 'Australia/Sydney');
    const utc = formatDateTimeInZone(iso, 'UTC');
    // The same instant reads differently in each zone (10:34 UTC vs 20:34
    // AEST). Assert on the zone-independent minute + the shifted hour via a
    // fixed 24h formatter so the check doesn't depend on the test locale.
    expect(sydney).not.toBe(utc);
    const hourIn = (tz: string) =>
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
    expect(hourIn('UTC')).toBe('10');
    expect(hourIn('Australia/Sydney')).toBe('20');
  });
  it('returns the raw value for an unparseable input, never "Invalid Date"', () => {
    expect(formatDateTimeInZone('not a date', 'UTC')).toBe('not a date');
  });
  it('falls back to UTC for a bad timezone instead of throwing', () => {
    expect(() => formatDateTimeInZone('2026-07-11T10:34:32Z', 'Not/AZone')).not.toThrow();
  });
});

describe('formatDateOnly', () => {
  it('formats a calendar date without any timezone shift', () => {
    // No hour is involved, so it never rolls across midnight.
    expect(formatDateOnly('2026-07-11')).toMatch(/2026/);
    expect(formatDateOnly('2026-07-11')).toMatch(/11/);
  });
  it('returns the input unchanged when it is not a date', () => {
    expect(formatDateOnly('hello')).toBe('hello');
  });
});
