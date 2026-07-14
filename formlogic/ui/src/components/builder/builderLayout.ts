// Form builder measured-width layout resolver.
//
// This keeps the canvas readable by layering user collapse preferences under forced
// width tiers: settings/right-dock wins, palette is hidden under pressure, and settings
// becomes a sheet when the measured builder body cannot preserve the canvas floor.
export const BUILDER_CANVAS_FLOOR = 420;
export const BUILDER_PALETTE_W = 288;
export const BUILDER_SETTINGS_W = 320;
/** The Flows dock is wider than field settings (its binding editor needs the room). */
export const BUILDER_FLOWS_W = 384;

export type BuilderPalettePlacement = 'inline' | 'hidden';
export type BuilderSettingsPlacement = 'inline' | 'sheet' | 'hidden';

export interface BuilderLayoutInput {
  builderWidth: number | null;
  belowMd: boolean;
  paletteOpenPref: boolean;
  settingsWanted: boolean;
  /** Width of whichever right dock is open (field settings 320 / flows 384). */
  rightDockWidth?: number;
}

export interface ResolvedBuilderLayout {
  palette: BuilderPalettePlacement;
  settings: BuilderSettingsPlacement;
}

function fits(width: number | null, sideWidth: number): boolean {
  return width === null || width >= BUILDER_CANVAS_FLOOR + sideWidth;
}

export function resolveBuilderLayout({
  builderWidth,
  belowMd,
  paletteOpenPref,
  settingsWanted,
  rightDockWidth = BUILDER_SETTINGS_W,
}: BuilderLayoutInput): ResolvedBuilderLayout {
  if (belowMd) {
    return {
      palette: 'hidden',
      settings: settingsWanted ? 'sheet' : 'hidden',
    };
  }

  if (settingsWanted) {
    if (!fits(builderWidth, rightDockWidth)) {
      return { palette: 'hidden', settings: 'sheet' };
    }
    return {
      palette: paletteOpenPref && fits(builderWidth, rightDockWidth + BUILDER_PALETTE_W) ? 'inline' : 'hidden',
      settings: 'inline',
    };
  }

  return {
    palette: paletteOpenPref && fits(builderWidth, BUILDER_PALETTE_W) ? 'inline' : 'hidden',
    settings: 'hidden',
  };
}

export function sameResolvedBuilderLayout(a: ResolvedBuilderLayout, b: ResolvedBuilderLayout): boolean {
  return a.palette === b.palette && a.settings === b.settings;
}
