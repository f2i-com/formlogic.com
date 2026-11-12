import { describe, expect, it } from 'vitest';
import { BUILDER_CHROME, resolveBuilderChrome } from './builderChrome';

describe('resolveBuilderChrome', () => {
  it('keeps every control in the bar at and above the width that holds them as icons', () => {
    expect(resolveBuilderChrome(BUILDER_CHROME.BAR_MIN_W)).toBe('bar');
    expect(resolveBuilderChrome(BUILDER_CHROME.BAR_MIN_W + 1)).toBe('bar');
    expect(resolveBuilderChrome(1920)).toBe('bar');
  });

  it('keeps them in the bar on a tablet held upright, whose bar is 744 px inside its padding', () => {
    expect(resolveBuilderChrome(768 - 24)).toBe('bar');
  });

  it('lists the first two groups in the menu below that width', () => {
    expect(resolveBuilderChrome(BUILDER_CHROME.BAR_MIN_W - 1)).toBe('menu');
    expect(resolveBuilderChrome(390)).toBe('menu');
  });

  it('keeps them in the bar before ResizeObserver reports a measured width', () => {
    expect(resolveBuilderChrome(null)).toBe('bar');
    expect(resolveBuilderChrome(0)).toBe('bar');
    expect(resolveBuilderChrome(Number.NaN)).toBe('bar');
  });
});
