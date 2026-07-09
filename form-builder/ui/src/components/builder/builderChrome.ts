// Pure Form Builder chrome density resolver.
//
// The header can be squeezed by docked builder panels or a snapped desktop window, so labels and
// overflow are driven by the measured header width rather than viewport breakpoints.
export type BuilderChromeTier = 'full' | 'compact' | 'tiny';

export const BUILDER_CHROME = {
  FULL_MIN_W: 1080,
  COMPACT_MIN_W: 760,
} as const;

function measured(width: number | null | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

export function resolveBuilderChrome(headerWidth: number | null | undefined): BuilderChromeTier {
  if (!measured(headerWidth)) return 'full';
  if (headerWidth >= BUILDER_CHROME.FULL_MIN_W) return 'full';
  if (headerWidth >= BUILDER_CHROME.COMPACT_MIN_W) return 'compact';
  return 'tiny';
}
