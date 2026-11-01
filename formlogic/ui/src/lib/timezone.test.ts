import { describe, it, expect } from 'vitest';
import { resolveDisplayTimezone, isIsoDateTime, formatAnswerDateTime, formatDateTimeInZone, formatDateOnly } from './timezone';

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

describe('formatAnswerDateTime', () => {
  const inZone = (zone: string, read: () => void) => {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try {
      read();
    } finally {
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  };

  it('shows a zone-less value as written, in every browser and for every viewer', () => {
    const shown = new Set<string>();
    for (const browser of ['Australia/Sydney', 'Australia/Perth', 'Europe/London', 'America/New_York']) {
      inZone(browser, () => {
        for (const viewer of ['Australia/Sydney', 'UTC', 'Pacific/Auckland']) {
          shown.add(formatAnswerDateTime('2026-03-31T14:30', viewer));
        }
      });
    }
    expect(shown.size).toBe(1);
    const [text] = [...shown];
    expect(text).toMatch(/31 Mar 2026|Mar 31, 2026/);
    expect(text).toMatch(/0?2:30/);
    expect(text).not.toMatch(/AEDT|GMT|UTC/); // a wall clock has no zone to name
  });

  it('keeps a time inside the hour the browser\'s own clocks skip', () => {
    // 02:30 doesn't exist in New York on 8 March 2026, and Date would make it 03:30.
    inZone('America/New_York', () => {
      expect(formatAnswerDateTime('2026-03-08T02:30', 'UTC')).toMatch(/0?2:30/);
    });
  });

  it('reads the spellings a datetime answer can have', () => {
    expect(formatAnswerDateTime('2026-03-31 14:30:15', 'UTC')).toMatch(/0?2:30:15/);
    expect(formatAnswerDateTime('2026-03-31T09:05:00', 'UTC')).toMatch(/0?9:05:00/);
    expect(formatAnswerDateTime('2026-03-31 9:05', 'UTC')).toMatch(/0?9:05/);
  });

  it('treats a value that names a zone as an instant', () => {
    expect(formatAnswerDateTime('2026-03-31T23:30:00Z', 'Australia/Sydney')).toMatch(/1 Apr|Apr 1/);
  });

  it('leaves anything else as it stands, never "Invalid Date"', () => {
    expect(formatAnswerDateTime('next Tuesday', 'UTC')).toBe('next Tuesday');
    expect(formatAnswerDateTime('2026-03-31 14:30+10:00', 'UTC')).toBe('2026-03-31 14:30+10:00');
    expect(formatAnswerDateTime('2026-13-99T99:99', 'UTC')).toBe('2026-13-99T99:99');
    expect(formatAnswerDateTime('2026-02-31T10:00', 'UTC')).toBe('2026-02-31T10:00');
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
