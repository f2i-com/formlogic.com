import type { CSSProperties } from 'react';
import type {
  FormBackgroundPattern,
  FormDensity,
  FormHeaderStyle,
  FormInputStyle,
  FormSurfaceStyle,
  FormTheme,
} from '../types/form';
import { luminance, parseHex, readableForegroundColor } from './color';

export interface FormStylePreset {
  id: string;
  name: string;
  tagline: string;
  theme: FormTheme;
  preview: {
    canvas: string;
    surface: string;
    primary: string;
    accent: string;
    text: string;
    isDark: boolean;
  };
}

/**
 * Curated, visually distinct form styles offered both when creating a form
 * (TemplateSelector) and when styling an existing form (ThemeEditor).
 */
export const FORM_STYLE_PRESETS: FormStylePreset[] = [
  {
    id: 'modern',
    name: 'Modern Clean',
    tagline: 'Open canvas, crisp outlined fields',
    theme: {
      primaryColor: '#4f46e5',
      backgroundColor: '#ffffff',
      textColor: '#111827',
      cardColor: '#ffffff',
      fontFamily: 'DM Sans',
      borderRadius: 'medium',
      surfaceStyle: 'clean',
      inputStyle: 'outlined',
      headerStyle: 'minimal',
      density: 'comfortable',
      backgroundPattern: 'none',
    },
    preview: {
      canvas: '#ffffff',
      surface: '#ffffff',
      primary: '#4f46e5',
      accent: '#e0e7ff',
      text: '#111827',
      isDark: false,
    },
  },
  {
    id: 'clinical',
    name: 'Clinical Paper',
    tagline: 'Structured sheet for intake & large forms',
    theme: {
      primaryColor: '#0284c7',
      backgroundColor: '#f1f5f9',
      textColor: '#0f172a',
      cardColor: '#ffffff',
      fontFamily: 'Plus Jakarta Sans',
      borderRadius: 'small',
      surfaceStyle: 'paper',
      inputStyle: 'outlined',
      headerStyle: 'accent_bar',
      density: 'compact',
      backgroundPattern: 'none',
    },
    preview: {
      canvas: '#f1f5f9',
      surface: '#ffffff',
      primary: '#0284c7',
      accent: '#e0f2fe',
      text: '#0f172a',
      isDark: false,
    },
  },
  {
    id: 'elevated',
    name: 'Elevated Card',
    tagline: 'Hero header & filled inputs on soft wash',
    theme: {
      primaryColor: '#4f46e5',
      backgroundColor: '#f5f7ff',
      textColor: '#1e1b4b',
      cardColor: '#ffffff',
      fontFamily: 'Plus Jakarta Sans',
      borderRadius: 'large',
      surfaceStyle: 'card',
      inputStyle: 'filled',
      headerStyle: 'hero',
      density: 'comfortable',
      backgroundPattern: 'gradient',
    },
    preview: {
      canvas: '#eef2ff',
      surface: '#ffffff',
      primary: '#4f46e5',
      accent: '#c7d2fe',
      text: '#1e1b4b',
      isDark: false,
    },
  },
  {
    id: 'editorial',
    name: 'Editorial Serif',
    tagline: 'Warm paper, underline fields & serif type',
    theme: {
      primaryColor: '#9f1239',
      backgroundColor: '#f8f4ee',
      textColor: '#1c1917',
      cardColor: '#fffdf9',
      fontFamily: 'Georgia',
      borderRadius: 'small',
      surfaceStyle: 'paper',
      inputStyle: 'underline',
      headerStyle: 'minimal',
      density: 'spacious',
      backgroundPattern: 'none',
    },
    preview: {
      canvas: '#f8f4ee',
      surface: '#fffdf9',
      primary: '#9f1239',
      accent: '#ffe4e6',
      text: '#1c1917',
      isDark: false,
    },
  },
  {
    id: 'midnight',
    name: 'Midnight Studio',
    tagline: 'Dark slate card with dot grid & violet accent',
    theme: {
      primaryColor: '#8b5cf6',
      backgroundColor: '#0f172a',
      textColor: '#f8fafc',
      cardColor: '#1e293b',
      fontFamily: 'DM Sans',
      borderRadius: 'medium',
      surfaceStyle: 'card',
      inputStyle: 'outlined',
      headerStyle: 'accent_bar',
      density: 'comfortable',
      backgroundPattern: 'dots',
    },
    preview: {
      canvas: '#0f172a',
      surface: '#1e293b',
      primary: '#8b5cf6',
      accent: '#312e81',
      text: '#f8fafc',
      isDark: true,
    },
  },
  {
    id: 'ocean_glass',
    name: 'Ocean Glass',
    tagline: 'Frosted translucent sheet over sky gradient',
    theme: {
      primaryColor: '#0369a1',
      backgroundColor: '#e0f2fe',
      textColor: '#0c4a6e',
      cardColor: '#ffffff',
      fontFamily: 'DM Sans',
      borderRadius: 'large',
      surfaceStyle: 'glass',
      inputStyle: 'filled',
      headerStyle: 'hero',
      density: 'comfortable',
      backgroundPattern: 'gradient',
    },
    preview: {
      canvas: '#bae6fd',
      surface: '#f0f9ff',
      primary: '#0369a1',
      accent: '#7dd3fc',
      text: '#0c4a6e',
      isDark: false,
    },
  },
  {
    id: 'forest',
    name: 'Botanical',
    tagline: 'Calm sage card with emerald hero banner',
    theme: {
      primaryColor: '#15803d',
      backgroundColor: '#ecfdf5',
      textColor: '#14532d',
      cardColor: '#ffffff',
      fontFamily: 'DM Sans',
      borderRadius: 'medium',
      surfaceStyle: 'card',
      inputStyle: 'outlined',
      headerStyle: 'hero',
      density: 'comfortable',
      backgroundPattern: 'none',
    },
    preview: {
      canvas: '#ecfdf5',
      surface: '#ffffff',
      primary: '#15803d',
      accent: '#bbf7d0',
      text: '#14532d',
      isDark: false,
    },
  },
  {
    id: 'high_contrast',
    name: 'High Contrast',
    tagline: 'WCAG AAA crisp paper for maximum legibility',
    theme: {
      primaryColor: '#1d4ed8',
      backgroundColor: '#f3f4f6',
      textColor: '#09090b',
      cardColor: '#ffffff',
      fontFamily: 'system-ui',
      borderRadius: 'small',
      surfaceStyle: 'paper',
      inputStyle: 'outlined',
      headerStyle: 'accent_bar',
      density: 'comfortable',
      backgroundPattern: 'none',
    },
    preview: {
      canvas: '#e5e7eb',
      surface: '#ffffff',
      primary: '#1d4ed8',
      accent: '#dbeafe',
      text: '#09090b',
      isDark: false,
    },
  },
];

export const FORM_FONT_OPTIONS = [
  { value: 'DM Sans', label: 'DM Sans (Clean geometric)' },
  { value: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans (Modern display)' },
  { value: 'system-ui', label: 'System Sans (Native OS)' },
  { value: 'Georgia', label: 'Georgia (Editorial serif)' },
  { value: 'monospace', label: 'Monospace (Technical)' },
] as const;

export const FORM_SURFACE_OPTIONS: Array<{ value: FormSurfaceStyle; label: string; hint: string }> = [
  { value: 'clean', label: 'Clean', hint: 'Seamless open page' },
  { value: 'card', label: 'Card', hint: 'Elevated floating card' },
  { value: 'paper', label: 'Paper', hint: 'Structured clinical / doc sheet' },
  { value: 'glass', label: 'Glass', hint: 'Frosted translucent card' },
];

export const FORM_INPUT_OPTIONS: Array<{ value: FormInputStyle; label: string; hint: string }> = [
  { value: 'outlined', label: 'Outlined', hint: 'Full border box' },
  { value: 'filled', label: 'Filled', hint: 'Soft tinted field' },
  { value: 'underline', label: 'Underline', hint: 'Minimal bottom line' },
];

export const FORM_HEADER_OPTIONS: Array<{ value: FormHeaderStyle; label: string; hint: string }> = [
  { value: 'minimal', label: 'Minimal', hint: 'Clean text title' },
  { value: 'accent_bar', label: 'Accent bar', hint: 'Top color strip' },
  { value: 'hero', label: 'Hero banner', hint: 'Full-width colored header' },
];

export const FORM_DENSITY_OPTIONS: Array<{ value: FormDensity; label: string; hint: string }> = [
  { value: 'compact', label: 'Compact', hint: 'Best for long forms' },
  { value: 'comfortable', label: 'Comfortable', hint: 'Balanced spacing' },
  { value: 'spacious', label: 'Spacious', hint: 'Airy presentation' },
];

export const FORM_PATTERN_OPTIONS: Array<{ value: FormBackgroundPattern; label: string }> = [
  { value: 'none', label: 'Solid' },
  { value: 'gradient', label: 'Soft glow' },
  { value: 'dots', label: 'Dot grid' },
  { value: 'grid', label: 'Fine grid' },
];

/**
 * Resolve a stored fontFamily value into a safe web-font stack that NEVER drops back
 * to unstyled browser serif (Times New Roman) when 'Inter' (unloaded legacy default)
 * or an empty string is encountered.
 */
export function resolveFormFontStack(fontFamily?: string | null): string {
  const raw = (fontFamily ?? '').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'inter' || lower === 'dm sans') {
    return "'DM Sans', 'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
  if (lower === 'plus jakarta sans') {
    return "'Plus Jakarta Sans', 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  }
  if (lower === 'system-ui') {
    return "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  }
  if (lower === 'georgia') {
    return "Georgia, Cambria, 'Times New Roman', Times, serif";
  }
  if (lower === 'monospace') {
    return "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  }
  // Custom font name saved by older form or API — quote safely and always include sans fallback.
  return `'${raw.replace(/['"\\;{}]/g, '')}', 'DM Sans', system-ui, sans-serif`;
}

/** Suggest a sensible preset when picking a template in Create New Form. */
export function suggestedPresetIdForTemplate(category?: string | null): string {
  if (!category) return 'modern';
  if (category === 'healthcare') return 'clinical';
  if (category === 'events') return 'elevated';
  if (category === 'education') return 'forest';
  return 'modern';
}

export function isHexDark(color?: string | null): boolean {
  if (!color) return false;
  const rgb = parseHex(color);
  return rgb ? luminance(rgb) < 0.5 : false;
}

export interface ResolvedFormThemeTokens {
  surfaceStyle: FormSurfaceStyle;
  inputStyle: FormInputStyle;
  headerStyle: FormHeaderStyle;
  density: FormDensity;
  backgroundPattern: FormBackgroundPattern;
  borderRadius: NonNullable<FormTheme['borderRadius']>;
  fontStack: string;
  isPageDark: boolean;
  isSurfaceDark: boolean;
  /** Resolved text color guaranteed readable on the form surface/sheet. */
  surfaceTextColor: string;
  /** Resolved background color of the inner card/paper sheet (or page bg when 'clean'). */
  surfaceBgColor: string;
  /** Border radius class for inputs, buttons, and choice tiles. */
  controlRadiusClass: string;
  /** Border radius class for outer cards, banners, and section headers. */
  cardRadiusClass: string;
  /** CSS style object for the outer full-page background (color, pattern, image). */
  pageStyle: CSSProperties;
  /** Whether a subtle scrim should sit over a custom background image for text legibility. */
  hasBackgroundImage: boolean;
  /** Class + style for the inner form container (clean = flat, card/paper/glass = framed sheet). */
  sheetClass: string;
  sheetStyle: CSSProperties;
  /** Class + style for text/number/date/textarea/select controls. */
  inputClass: string;
  inputStyleObj: CSSProperties;
  /** Native <option> colors so dropdown menus stay legible on dark themes. */
  selectOptionStyle: CSSProperties;
  /** Density-adjusted typography & spacing classes. */
  questionHeadingClass: string;
  questionHeadingCompactClass: string;
  questionGapClass: string;
  fieldSpacingClass: string;
  optionPaddingClass: string;
  optionTextClass: string;
  headerPaddingClass: string;
  /** Accent foreground color computed for hero banner & primary buttons. */
  onPrimaryColor: string;
}

/**
 * Compute all visual classes & styles for rendering a form from its `FormTheme`.
 * Shared across FormResponse (public), FormPreview (builder), ThemeEditor (live preview),
 * and AppFormView (hosted app runtime) so every surface renders identically.
 */
export function getFormThemeTokens(
  theme: Partial<FormTheme> | undefined | null,
  fallbackDark = false,
): ResolvedFormThemeTokens {
  const primaryColor = theme?.primaryColor || '#4f46e5';
  const backgroundColor = theme?.backgroundColor || (fallbackDark ? '#0b1220' : '#ffffff');
  const rawTextColor = theme?.textColor || (fallbackDark ? '#e8edf5' : '#1f2937');
  const borderRadius = theme?.borderRadius || 'medium';
  const surfaceStyle: FormSurfaceStyle = theme?.surfaceStyle || 'clean';
  const inputStyle: FormInputStyle = theme?.inputStyle || 'outlined';
  const headerStyle: FormHeaderStyle = theme?.headerStyle || 'minimal';
  const density: FormDensity = theme?.density || 'comfortable';
  const backgroundPattern: FormBackgroundPattern = theme?.backgroundPattern || 'none';
  const fontStack = resolveFormFontStack(theme?.fontFamily);
  const onPrimaryColor = readableForegroundColor(primaryColor);

  const isPageDark = parseHex(backgroundColor) ? isHexDark(backgroundColor) : fallbackDark;

  // Derive the card/paper surface background cleanly when not explicitly specified.
  const surfaceBgColor =
    surfaceStyle === 'clean'
      ? backgroundColor
      : theme?.cardColor || (isPageDark ? '#1e293b' : '#ffffff');

  const isSurfaceDark =
    surfaceStyle === 'clean'
      ? isPageDark
      : parseHex(surfaceBgColor)
        ? isHexDark(surfaceBgColor)
        : isPageDark;

  // Ensure text on a card/paper sheet always has strong contrast (e.g. if user has a dark page
  // background with a white paper sheet, or vice-versa).
  const textIsDark = parseHex(rawTextColor) ? isHexDark(rawTextColor) : !isPageDark;
  const surfaceTextColor =
    surfaceStyle !== 'clean' && textIsDark === isSurfaceDark
      ? isSurfaceDark
        ? '#f8fafc'
        : '#111827'
      : rawTextColor;

  const controlRadiusClass =
    borderRadius === 'none'
      ? 'rounded-none'
      : borderRadius === 'small'
        ? 'rounded-md'
        : borderRadius === 'large'
          ? 'rounded-2xl'
          : 'rounded-xl';

  const cardRadiusClass =
    borderRadius === 'none'
      ? 'rounded-none'
      : borderRadius === 'small'
        ? 'rounded-lg'
        : borderRadius === 'large'
          ? 'rounded-3xl'
          : 'rounded-2xl';

  // Background image OR subtle CSS pattern
  const hasBackgroundImage = Boolean(theme?.backgroundImage);
  const pageStyle: CSSProperties = {
    backgroundColor,
    color: rawTextColor,
    fontFamily: fontStack,
    colorScheme: isPageDark ? 'dark' : 'light',
  };

  if (hasBackgroundImage && theme?.backgroundImage) {
    pageStyle.backgroundImage = `url(${theme.backgroundImage})`;
    pageStyle.backgroundSize = 'cover';
    pageStyle.backgroundPosition = 'center';
  } else if (backgroundPattern === 'gradient') {
    pageStyle.backgroundImage = isPageDark
      ? `radial-gradient(ellipse 80% 55% at 50% -10%, ${primaryColor}38, transparent 70%), radial-gradient(ellipse 60% 45% at 100% 100%, ${primaryColor}22, transparent 70%)`
      : `radial-gradient(ellipse 85% 55% at 50% -10%, ${primaryColor}22, transparent 70%), radial-gradient(ellipse 60% 45% at 95% 100%, ${primaryColor}16, transparent 70%)`;
  } else if (backgroundPattern === 'dots') {
    const dot = isPageDark ? 'rgba(255,255,255,0.09)' : 'rgba(15,23,42,0.08)';
    pageStyle.backgroundImage = `radial-gradient(${dot} 1px, transparent 1px)`;
    pageStyle.backgroundSize = '20px 20px';
  } else if (backgroundPattern === 'grid') {
    const line = isPageDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';
    pageStyle.backgroundImage = `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`;
    pageStyle.backgroundSize = '28px 28px';
  }

  // Outer form sheet styling
  let sheetClass = '';
  const sheetStyle: CSSProperties = {
    color: surfaceTextColor,
    colorScheme: isSurfaceDark ? 'dark' : 'light',
  };

  const padClass =
    density === 'compact'
      ? 'p-5 sm:p-6'
      : density === 'spacious'
        ? 'p-6 sm:p-10'
        : 'p-5 sm:p-8';

  if (surfaceStyle === 'card') {
    sheetClass = `${cardRadiusClass} border shadow-lg shadow-slate-950/[0.06] ${padClass}`;
    sheetStyle.backgroundColor = surfaceBgColor;
    sheetStyle.borderColor = isSurfaceDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.09)';
  } else if (surfaceStyle === 'paper') {
    sheetClass = `${cardRadiusClass} border shadow-sm ${padClass}`;
    sheetStyle.backgroundColor = surfaceBgColor;
    sheetStyle.borderColor = isSurfaceDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.14)';
  } else if (surfaceStyle === 'glass') {
    sheetClass = `${cardRadiusClass} border shadow-xl shadow-slate-950/[0.08] backdrop-blur-md ${padClass}`;
    sheetStyle.backgroundColor = isSurfaceDark
      ? 'rgba(15, 23, 42, 0.72)'
      : 'rgba(255, 255, 255, 0.78)';
    sheetStyle.borderColor = isSurfaceDark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.75)';
  } else if (hasBackgroundImage) {
    // Even on 'clean', keep text readable over a custom background photo with a gentle frosted card.
    sheetClass = `${cardRadiusClass} border shadow-lg backdrop-blur-md ${padClass}`;
    sheetStyle.backgroundColor = isPageDark
      ? 'rgba(15, 23, 42, 0.80)'
      : 'rgba(255, 255, 255, 0.86)';
    sheetStyle.borderColor = isPageDark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.08)';
  }

  // Input control styling
  const inputTextSize =
    density === 'compact'
      ? 'text-base'
      : density === 'spacious'
        ? 'text-xl'
        : 'text-base sm:text-lg';

  const inputPad =
    density === 'compact'
      ? 'py-2 px-3'
      : density === 'spacious'
        ? 'py-3.5 px-4'
        : 'py-2.5 px-3.5';

  let inputClass: string;
  const inputStyleObj: CSSProperties = {
    color: surfaceTextColor,
    colorScheme: isSurfaceDark ? 'dark' : 'light',
    ['--tw-ring-color' as string]: primaryColor,
  };

  if (inputStyle === 'underline') {
    inputClass = `w-full bg-transparent border-b-2 border-current/25 focus:border-current/70 outline-hidden focus-visible:ring-2 py-2 px-1 ${inputTextSize} transition-colors`;
  } else if (inputStyle === 'filled') {
    inputClass = `w-full border-2 border-transparent focus:border-current/45 outline-hidden focus-visible:ring-2 ${controlRadiusClass} ${inputPad} ${inputTextSize} transition-colors`;
    inputStyleObj.backgroundColor = isSurfaceDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.05)';
  } else {
    // outlined (default)
    inputClass = `w-full border border-current/25 focus:border-current/70 outline-hidden focus-visible:ring-2 ${controlRadiusClass} ${inputPad} ${inputTextSize} transition-colors shadow-2xs`;
    inputStyleObj.backgroundColor = isSurfaceDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.92)';
  }

  const selectOptionStyle: CSSProperties = {
    backgroundColor: isSurfaceDark ? '#1e293b' : '#ffffff',
    color: isSurfaceDark ? '#f8fafc' : '#111827',
  };

  const questionHeadingClass =
    density === 'compact'
      ? 'text-lg sm:text-xl font-semibold mb-1.5 tracking-tight break-words'
      : density === 'spacious'
        ? 'text-2xl sm:text-3xl font-bold mb-3 tracking-tight break-words'
        : 'text-xl sm:text-2xl font-bold mb-2 tracking-tight break-words';

  const questionHeadingCompactClass =
    density === 'compact'
      ? 'text-base sm:text-lg font-semibold mb-1 tracking-tight break-words'
      : density === 'spacious'
        ? 'text-xl sm:text-2xl font-bold mb-2.5 tracking-tight break-words'
        : 'text-lg sm:text-xl font-semibold mb-1.5 tracking-tight break-words';

  const questionGapClass =
    density === 'compact' ? 'mb-3' : density === 'spacious' ? 'mb-7' : 'mb-4';

  const fieldSpacingClass =
    density === 'compact' ? 'space-y-5' : density === 'spacious' ? 'space-y-10' : 'space-y-7';

  const optionPaddingClass =
    density === 'compact' ? 'px-3.5 py-2.5 gap-3' : density === 'spacious' ? 'p-4 gap-4' : 'px-4 py-3 gap-3.5';

  const optionTextClass =
    density === 'compact' ? 'text-sm sm:text-base' : density === 'spacious' ? 'text-lg' : 'text-base';

  const headerPaddingClass =
    density === 'compact' ? 'px-5 py-4' : density === 'spacious' ? 'px-8 py-8' : 'px-6 py-6';

  return {
    surfaceStyle,
    inputStyle,
    headerStyle,
    density,
    backgroundPattern,
    borderRadius,
    fontStack,
    isPageDark,
    isSurfaceDark,
    surfaceTextColor,
    surfaceBgColor,
    controlRadiusClass,
    cardRadiusClass,
    pageStyle,
    hasBackgroundImage,
    sheetClass,
    sheetStyle,
    inputClass,
    inputStyleObj,
    selectOptionStyle,
    questionHeadingClass,
    questionHeadingCompactClass,
    questionGapClass,
    fieldSpacingClass,
    optionPaddingClass,
    optionTextClass,
    headerPaddingClass,
    onPrimaryColor,
  };
}
