// The colours a form's page is drawn in (the public form page, and its preview): its theme's, with
// what the theme leaves out filled in so its text is always readable on its background, and whether
// that background is dark, which decides how the controls on it are drawn, not the viewer's own
// light or dark mode.
import { luminance, parseHex } from './color';

/** The pairs a form with no colours of its own is drawn in. */
export const FORM_PAGE_LIGHT = { backgroundColor: '#ffffff', textColor: '#1f2937' } as const;
export const FORM_PAGE_DARK = { backgroundColor: '#0b1220', textColor: '#e8edf5' } as const;

/** Whether a colour is dark (by luminance), or null for one that is not a hex colour. */
function isDark(color: string): boolean | null {
  const rgb = parseHex(color);
  return rgb ? luminance(rgb) < 0.5 : null;
}

const given = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * A form's background and text colours, and whether its page is dark. Both are the theme's where it
 * has both. One alone keeps the other readable against it: a background gets the text of the pair
 * whose page it is nearer (dark text on a light page), a text colour gets a background the same way.
 * Neither (a form never themed, stored as no theme at all): the viewer's own mode, as an untouched
 * form has always followed it. A background that is not a hex colour is taken as light.
 */
export function formPageColors(theme: unknown, viewerDark: boolean): { backgroundColor: string; textColor: string; dark: boolean } {
  const set = theme && typeof theme === 'object' && !Array.isArray(theme) ? (theme as Record<string, unknown>) : {};
  const background = given(set.backgroundColor);
  const text = given(set.textColor);
  let colors: { backgroundColor: string; textColor: string };
  if (background && text) colors = { backgroundColor: background, textColor: text };
  else if (background) colors = { backgroundColor: background, textColor: isDark(background) ? FORM_PAGE_DARK.textColor : FORM_PAGE_LIGHT.textColor };
  else if (text) colors = { backgroundColor: isDark(text) === false ? FORM_PAGE_DARK.backgroundColor : FORM_PAGE_LIGHT.backgroundColor, textColor: text };
  else colors = viewerDark ? { ...FORM_PAGE_DARK } : { ...FORM_PAGE_LIGHT };
  return { ...colors, dark: isDark(colors.backgroundColor) ?? false };
}
