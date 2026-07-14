import { describe, expect, it } from 'vitest';
import {
  BUILDER_CANVAS_FLOOR,
  BUILDER_PALETTE_W,
  BUILDER_SETTINGS_W,
  resolveBuilderLayout,
  sameResolvedBuilderLayout,
} from './builderLayout';

describe('resolveBuilderLayout', () => {
  it('uses sheets below md and never renders an inline palette there', () => {
    expect(resolveBuilderLayout({
      builderWidth: 1000,
      belowMd: true,
      paletteOpenPref: true,
      settingsWanted: true,
    })).toEqual({ palette: 'hidden', settings: 'sheet' });
    expect(resolveBuilderLayout({
      builderWidth: 1000,
      belowMd: true,
      paletteOpenPref: true,
      settingsWanted: false,
    })).toEqual({ palette: 'hidden', settings: 'hidden' });
  });

  it('keeps only the palette inline when it fits beside the canvas', () => {
    expect(resolveBuilderLayout({
      builderWidth: BUILDER_CANVAS_FLOOR + BUILDER_PALETTE_W,
      belowMd: false,
      paletteOpenPref: true,
      settingsWanted: false,
    })).toEqual({ palette: 'inline', settings: 'hidden' });
    expect(resolveBuilderLayout({
      builderWidth: BUILDER_CANVAS_FLOOR + BUILDER_PALETTE_W - 1,
      belowMd: false,
      paletteOpenPref: true,
      settingsWanted: false,
    })).toEqual({ palette: 'hidden', settings: 'hidden' });
  });

  it('lets settings win over the palette under pressure', () => {
    expect(resolveBuilderLayout({
      builderWidth: BUILDER_CANVAS_FLOOR + BUILDER_SETTINGS_W,
      belowMd: false,
      paletteOpenPref: true,
      settingsWanted: true,
    })).toEqual({ palette: 'hidden', settings: 'inline' });
    expect(resolveBuilderLayout({
      builderWidth: BUILDER_CANVAS_FLOOR + BUILDER_SETTINGS_W + BUILDER_PALETTE_W,
      belowMd: false,
      paletteOpenPref: true,
      settingsWanted: true,
    })).toEqual({ palette: 'inline', settings: 'inline' });
  });

  it('falls back to a settings sheet when the measured body cannot fit settings plus the canvas floor', () => {
    expect(resolveBuilderLayout({
      builderWidth: BUILDER_CANVAS_FLOOR + BUILDER_SETTINGS_W - 1,
      belowMd: false,
      paletteOpenPref: true,
      settingsWanted: true,
    })).toEqual({ palette: 'hidden', settings: 'sheet' });
  });

  it('layers user preferences underneath forced states', () => {
    expect(resolveBuilderLayout({
      builderWidth: 1400,
      belowMd: false,
      paletteOpenPref: false,
      settingsWanted: true,
    })).toEqual({ palette: 'hidden', settings: 'inline' });
    expect(resolveBuilderLayout({
      builderWidth: 1400,
      belowMd: false,
      paletteOpenPref: false,
      settingsWanted: false,
    })).toEqual({ palette: 'hidden', settings: 'hidden' });
  });
});

describe('sameResolvedBuilderLayout', () => {
  it('compares only the derived tiers', () => {
    expect(sameResolvedBuilderLayout(
      { palette: 'inline', settings: 'hidden' },
      { palette: 'inline', settings: 'hidden' },
    )).toBe(true);
    expect(sameResolvedBuilderLayout(
      { palette: 'inline', settings: 'hidden' },
      { palette: 'hidden', settings: 'hidden' },
    )).toBe(false);
  });
});
