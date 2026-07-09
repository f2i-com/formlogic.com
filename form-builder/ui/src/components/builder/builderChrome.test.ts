import { describe, expect, it } from 'vitest';
import { BUILDER_CHROME, resolveBuilderChrome } from './builderChrome';

describe('resolveBuilderChrome', () => {
  it('shows full labels at and above the full-width threshold', () => {
    expect(resolveBuilderChrome(BUILDER_CHROME.FULL_MIN_W)).toBe('full');
    expect(resolveBuilderChrome(BUILDER_CHROME.FULL_MIN_W + 1)).toBe('full');
  });

  it('uses compact icon-only chrome between the full and tiny thresholds', () => {
    expect(resolveBuilderChrome(BUILDER_CHROME.FULL_MIN_W - 1)).toBe('compact');
    expect(resolveBuilderChrome(BUILDER_CHROME.COMPACT_MIN_W)).toBe('compact');
  });

  it('folds middle clusters into overflow below the compact threshold', () => {
    expect(resolveBuilderChrome(BUILDER_CHROME.COMPACT_MIN_W - 1)).toBe('tiny');
    expect(resolveBuilderChrome(390)).toBe('tiny');
  });

  it('falls back to full before ResizeObserver reports a measured width', () => {
    expect(resolveBuilderChrome(null)).toBe('full');
    expect(resolveBuilderChrome(0)).toBe('full');
    expect(resolveBuilderChrome(Number.NaN)).toBe('full');
  });
});
