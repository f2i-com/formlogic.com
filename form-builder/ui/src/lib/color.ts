// WCAG color-contrast utilities — used by the app-runtime theme provider to
// pick a readable foreground for owner-chosen accent colors, and by AppSettings
// to warn when a chosen palette fails accessibility contrast thresholds.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb` (with or without leading #). Returns null on failure. */
export function parseHex(hex: string): RGB | null {
  if (!hex || typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0..1). */
export function luminance({ r, g, b }: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1..21) between two colors. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const NEAR_BLACK: RGB = { r: 17, g: 24, b: 39 }; // slate-900

/**
 * Pick white or near-black ink for text sitting ON `bg` (e.g. a solid accent button).
 *
 * NOT a pure max-WCAG-contrast pick: that crossover sits around luminance 0.18, so medium *brand*
 * colors — orange/teal/cyan/emerald/sky/green-600 — flip to dark navy ink, where white is the
 * expected, better-looking button convention. Instead we bias to white and only switch to dark once
 * the background is genuinely LIGHT. This matches the intuitive rule "dark background → white text,
 * bright background → dark text". Genuinely light/pastel accents (yellow, lime, pale cyan) still get
 * dark ink, where white would be unreadable.
 */
export function readableForeground(bg: RGB): RGB {
  return luminance(bg) > 0.4 ? NEAR_BLACK : WHITE;
}

export function toRgbString({ r, g, b }: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** Readable foreground (CSS color string) for a hex background; '#ffffff' fallback. */
export function readableForegroundColor(bgHex: string): string {
  const bg = parseHex(bgHex);
  return bg ? toRgbString(readableForeground(bg)) : '#ffffff';
}

/** Contrast ratio between two hex strings; null if either won't parse. */
export function hexContrast(a: string, b: string): number | null {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  return contrastRatio(ca, cb);
}

export type ContrastLevel = 'fail' | 'aa-large' | 'aa' | 'aaa';

/** Classify a contrast ratio against WCAG thresholds (for normal-size text). */
export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio >= 7) return 'aaa';
  if (ratio >= 4.5) return 'aa';
  if (ratio >= 3) return 'aa-large';
  return 'fail';
}
