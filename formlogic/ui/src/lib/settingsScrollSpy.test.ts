import { describe, expect, it } from 'vitest';
import { resolveActiveScrollSection } from './settingsScrollSpy';

const sections = [
  { id: 'profile', top: -640 },
  { id: 'appearance', top: -80 },
  { id: 'security', top: 460 },
];

describe('resolveActiveScrollSection', () => {
  it('uses the last section that has crossed the reading line', () => {
    expect(resolveActiveScrollSection(sections, {
      scrollY: 800,
      viewportHeight: 700,
      documentHeight: 5000,
      markerY: 112,
    })).toBe('appearance');
  });

  it('keeps the first section active above the first card', () => {
    expect(resolveActiveScrollSection([
      { id: 'profile', top: 180 },
      { id: 'appearance', top: 720 },
    ], {
      scrollY: 0,
      viewportHeight: 700,
      documentHeight: 5000,
    })).toBe('profile');
  });

  it('selects the final section at the bottom of the document', () => {
    expect(resolveActiveScrollSection(sections, {
      scrollY: 4300,
      viewportHeight: 700,
      documentHeight: 5000,
    })).toBe('security');
  });

  it('handles an empty section list', () => {
    expect(resolveActiveScrollSection([], {
      scrollY: 0,
      viewportHeight: 700,
      documentHeight: 700,
    })).toBeNull();
  });
});
