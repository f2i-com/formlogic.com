import { describe, expect, it } from 'vitest';
import { formatValue } from './recordFormat';

// ISO instants must render in the viewer's timezone in EVERY field type — the
// Aokie Calls pack stores started_at/answered_at/ended_at in short_text fields,
// which used to fall through to the raw "2026-07-09T23:59:32.874Z" string.
describe('formatValue ISO instants', () => {
  it('renders a short_text ISO instant in the given timezone', () => {
    const out = formatValue('2026-07-09T23:59:32.874Z', 'short_text', undefined, 'Australia/Brisbane');
    expect(out).not.toContain('2026-07-09T'); // never the raw ISO string
    // Exact wording is locale-dependent ("10 Jul"/"10 July", "GMT+10"/"AEST") —
    // assert the day rolled to the 10th at +10 and the local time is right.
    expect(out).toMatch(/10 Jul/);
    expect(out).toMatch(/0?9:59:32/);
    expect(out).toMatch(/GMT\+10|AEST/);
  });

  it('renders datetime-field ISO instants in the given timezone (unchanged behaviour)', () => {
    const out = formatValue('2026-07-09T23:59:32Z', 'datetime', undefined, 'Australia/Brisbane');
    expect(out).toMatch(/10 Jul/);
  });

  it('never shifts a zone-less wall-clock string', () => {
    // A datetime-local answer is the respondent's wall clock — no zone, no shifting.
    expect(formatValue('2026-07-09T23:59', 'short_text', undefined, 'Australia/Brisbane'))
      .toBe('2026-07-09T23:59');
  });

  it('leaves ordinary text alone', () => {
    expect(formatValue('caller said 2026 things', 'short_text', undefined, 'Australia/Brisbane'))
      .toBe('caller said 2026 things');
  });
});
