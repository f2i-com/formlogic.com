// The app a visitor is signing in to use, as the site's sign-in and sign-up pages show it: its name, logo or icon,
// its look and its owner's words (GET /api/app/{slug}/welcome). The site writes the headings and keeps its own mark;
// the app's look comes as design tokens, never style sheets, as these are the pages where people type their password.
import type { CSSProperties } from 'react';
import type { SignInPageSettings } from '../types/app';
import { contrastRatio, parseHex, readableForeground, type RGB } from './color';

export interface AppWelcome {
  app: { name: string; slug: string; icon: string | null; logo: string | null };
  look: { accent: string | null; font: string | null; panel: string | null; layout: 'split' | 'centered' };
  text: { title: string | null; message: string | null };
  joining: 'open' | 'approval' | 'invite';
}

/** The fonts an app's theme offers (AppSettings → Appearance), the only ones a sign-in page takes. */
export const SIGN_IN_FONTS = ['DM Sans', 'Plus Jakarta Sans', 'system-ui', 'Georgia', 'monospace'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const BASE = 'https://formlogic.invalid';

/**
 * Which app a sign-in destination (what signInDestination left of ?redirect=) leads to: an app's own pages on this
 * site (/app/{slug}…), or the page that signs a member in for an app on its own domain (/sign-in/domain?origin=…).
 */
export function appFromDestination(dest: string): { slug: string } | { host: string } | null {
  let url: URL;
  try {
    url = new URL(dest, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const inApp = /^\/app\/([^/]+)(?:\/|$)/.exec(url.pathname);
  if (inApp) return SLUG.test(inApp[1]) ? { slug: inApp[1] } : null;
  if (url.pathname.replace(/\/+$/, '') === '/sign-in/domain') {
    try {
      const origin = new URL(url.searchParams.get('origin') ?? '');
      return origin.protocol === 'https:' || origin.protocol === 'http:' ? { host: origin.hostname } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** An answer from /welcome held to its shape, or null: the page draws nothing of an app from anything else. */
export function readWelcome(value: unknown): AppWelcome | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<AppWelcome>;
  const app = v.app;
  if (!app || typeof app.name !== 'string' || app.name.trim() === '' || typeof app.slug !== 'string') return null;
  const text = (s: unknown) => (typeof s === 'string' && s.trim() !== '' ? s : null);
  const color = (s: unknown) => (typeof s === 'string' && HEX.test(s) ? s : null);
  const logo = typeof app.logo === 'string' && (/^\/(?![/\\])/.test(app.logo) || /^data:image\/(png|jpeg|gif|webp);base64,/.test(app.logo)) ? app.logo : null;
  return {
    app: { name: app.name, slug: app.slug, icon: text(app.icon), logo },
    look: {
      accent: color(v.look?.accent),
      font: SIGN_IN_FONTS.includes(v.look?.font ?? '') ? (v.look?.font as string) : null,
      panel: color(v.look?.panel),
      layout: v.look?.layout === 'centered' ? 'centered' : 'split',
    },
    text: { title: text(v.text?.title), message: text(v.text?.message) },
    joining: v.joining === 'open' || v.joining === 'approval' ? v.joining : 'invite',
  };
}

/** What AppSettings is about to save, drawn as the server will serve it: for the owner's preview. */
export function previewWelcome(app: { name: string; slug: string; logoUrl?: string | null; settings?: { icon?: string; allowSelfRegistration?: boolean; requireApproval?: boolean; signInPage?: SignInPageSettings }; theme?: { primaryColor?: string; fontFamily?: string } }): AppWelcome | null {
  const page = app.settings?.signInPage ?? {};
  const full = (hex?: string) => (/^#[0-9a-fA-F]{3}$/.test(hex ?? '') ? `#${(hex ?? '').slice(1).split('').map((c) => c + c).join('')}` : hex)?.toLowerCase();
  const accent = full(app.theme?.primaryColor);
  return readWelcome({
    app: { name: app.name, slug: app.slug, icon: app.settings?.icon ?? null, logo: app.logoUrl ?? null },
    look: {
      accent,
      font: page.appFont === false ? null : app.theme?.fontFamily,
      panel: full(page.panelColor) || accent,
      layout: page.layout,
    },
    text: { title: page.title?.trim().slice(0, 80) || null, message: page.message?.trim().slice(0, 280) || null },
    joining: !app.settings?.allowSelfRegistration ? 'invite' : app.settings?.requireApproval ? 'approval' : 'open',
  });
}

const triplet = ({ r, g, b }: RGB) => `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
const mix = (a: RGB, b: RGB, t: number): RGB => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };
/** How far each shade is mixed toward white (negative: toward black); 600, the buttons' fill, is the colour itself. */
const SHADES: Record<number, number> = { 50: 0.93, 100: 0.85, 200: 0.72, 300: 0.55, 400: 0.35, 500: 0.15, 600: 0, 700: -0.15, 800: -0.3, 900: -0.45, 950: -0.65 };

/** The site's primary palette (50–950, as "r g b" triplets) built on one colour, at 600. */
export function paletteFromHex(hex: string): Record<number, string> | null {
  const base = parseHex(hex);
  if (!base || !HEX.test(hex)) return null;
  const out: Record<number, string> = {};
  for (const [shade, t] of Object.entries(SHADES)) {
    out[Number(shade)] = triplet(t >= 0 ? mix(base, WHITE, t) : mix(base, BLACK, -t));
  }
  return out;
}

/** The pages' backgrounds, light and dark: the site's links sit on these in shades 600 and 400. */
const LIGHT_PAGE: RGB = { r: 249, g: 250, b: 251 };
const DARK_PAGE: RGB = { r: 15, g: 23, b: 42 };
const FINDABLE = 3;

/** A colour moved toward another as little as it takes to be findable on a page. */
function findableOn(page: RGB, colour: RGB, toward: RGB): RGB {
  for (let t = 0; t < 1; t += 0.05) {
    const moved = mix(colour, toward, t);
    if (contrastRatio(moved, page) >= FINDABLE) return moved;
  }
  return toward;
}

/**
 * The app's look for the part of the page it styles: the site's primary palette set to its accent (on that element,
 * not the document, so nothing else changes) with a readable text colour on it, and its font. Only a #rrggbb colour
 * and a font from the list reach a style; anything else leaves the site's own. The buttons wear the accent as it is.
 * The links ("Forgot password?", "Create one") and the focus ring are the platform's, on a password page, and use
 * shades 700, 400 and 500: those are moved until they can be found, so an owner's near-white hides nothing. The ring
 * is the same shade on both pages, so it is moved for each.
 */
export function welcomeStyle(look: AppWelcome['look']): CSSProperties {
  const style: Record<string, string> = {};
  const palette = look.accent ? paletteFromHex(look.accent) : null;
  const accent = look.accent ? parseHex(look.accent) : null;
  if (palette && accent) {
    const shade = (n: number) => (SHADES[n] >= 0 ? mix(accent, WHITE, SHADES[n]) : mix(accent, BLACK, -SHADES[n]));
    palette[700] = triplet(findableOn(LIGHT_PAGE, shade(700), BLACK));
    palette[800] = triplet(findableOn(LIGHT_PAGE, shade(800), BLACK));
    palette[400] = triplet(findableOn(DARK_PAGE, shade(400), WHITE));
    palette[500] = triplet(findableOn(DARK_PAGE, findableOn(LIGHT_PAGE, shade(500), BLACK), WHITE));
    for (const [shade, rgb] of Object.entries(palette)) {
      style[`--primary-${shade}`] = rgb;
      style[`--color-primary-${shade}`] = `rgb(${rgb})`;
    }
    const ink = triplet(readableForeground(accent));
    style['--primary-foreground'] = ink;
    style['--color-primary-foreground'] = `rgb(${ink})`;
  }
  if (look.font && SIGN_IN_FONTS.includes(look.font)) {
    style.fontFamily = look.font === 'system-ui' || look.font === 'monospace' ? look.font : `"${look.font}", system-ui, sans-serif`;
  }
  return style as CSSProperties;
}

/** For the sign-up page: whether a new account gets into the app by itself. */
export function joiningNote(welcome: AppWelcome): string | null {
  if (welcome.joining === 'invite') return `${welcome.app.name} is by invitation. Once you have an account, its owner can invite you.`;
  if (welcome.joining === 'approval') return `${welcome.app.name}'s owner approves new members after you sign up.`;
  return null;
}

/** The panel beside the form: its colour (the accent unless the owner chose one) and the ink that reads on it. */
export function panelColors(look: AppWelcome['look']): { background: string; ink: 'light' | 'dark' } | null {
  const panel = look.panel ?? look.accent;
  const rgb = panel && HEX.test(panel) ? parseHex(panel) : null;
  if (!rgb || !panel) return null;
  return { background: panel, ink: readableForeground(rgb).r > 128 ? 'light' : 'dark' };
}
