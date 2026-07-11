// Relative timestamp labels are shared by the overview and run history panels.
import { describe, expect, it } from 'vitest';
import { formatAbsoluteTimeTitle, formatRelativeTime } from './relativeTime';

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');

  it('uses compact labels for recent times', () => {
    expect(formatRelativeTime('2026-07-09T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-09T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2026-07-09T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-07T12:00:00Z', now)).toBe('2d ago');
  });

  it('keeps unknown and invalid values readable', () => {
    expect(formatRelativeTime(null, now)).toBe('Unknown time');
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date');
  });

  it('reads offsetless MySQL datetimes as UTC (the API wire format)', () => {
    // Regression: "2026-07-09 09:00:00" parsed as LOCAL time made last night's call
    // runs read as "21h ago" instead of "3h ago" on a UTC+10 machine (and Safari
    // failed to parse the space-separated form at all).
    expect(formatRelativeTime('2026-07-09 09:00:00', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-07-09 11:55:00', now)).toBe('5m ago');
  });
});

describe('formatAbsoluteTimeTitle', () => {
  it('returns undefined for empty values and the raw value for invalid dates', () => {
    expect(formatAbsoluteTimeTitle(null)).toBeUndefined();
    expect(formatAbsoluteTimeTitle('not-a-date')).toBe('not-a-date');
  });
});
