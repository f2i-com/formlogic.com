// A hosted SoftN app's look (AppLookService on the server): its loading colours, its icon in the
// tab and on a home screen, its description, and the manifest that installs it. The runtime GET
// carries it; a return visit opens on the colours remembered from the last one.
import { API_BASE_URL } from './apiBase';

export interface NativeLook {
  background: string | null;
  spinner: string | null;
  themeColor: string | null;
  description: string;
  /** Which icon the app has: drawn at each size ('raster'), an SVG, or none. */
  icon: 'raster' | 'svg' | null;
  /** Changes whenever the app or its look does: its images are addressed with it. */
  version: string;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const color = (value: unknown): string | null => typeof value === 'string' && HEX.test(value) ? value : null;

/** The look as the server sent it, held to its shape; null for anything else. */
export function readLook(value: unknown): NativeLook | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const look = value as Record<string, unknown>;
  if (typeof look.version !== 'string' || !/^[0-9a-f]{1,64}$/.test(look.version)) return null;
  return {
    background: color(look.background),
    spinner: color(look.spinner),
    themeColor: color(look.themeColor),
    description: typeof look.description === 'string' ? look.description.slice(0, 300) : '',
    icon: look.icon === 'raster' || look.icon === 'svg' ? look.icon : null,
    version: look.version,
  };
}

/** Where one image of the look is served (AppLookController::image), under the API's own base. */
export function lookImageUrl(slug: string, name: string, version: string): string {
  return `${API_BASE_URL.replace(/\/$/, '')}/app/${encodeURIComponent(slug)}/look/${name}?v=${encodeURIComponent(version)}`;
}

const lookKey = (slug: string) => `formlogic:app-look:v1:${slug}`;
/** The look this browser last saw for the app, so a return visit opens on its colours at once. */
export function rememberedLook(slug: string): NativeLook | null {
  try { return readLook(JSON.parse(localStorage.getItem(lookKey(slug)) ?? 'null')); } catch { return null; }
}
export function rememberLook(slug: string, look: NativeLook | null): void {
  try { if (look) localStorage.setItem(lookKey(slug), JSON.stringify(look)); else localStorage.removeItem(lookKey(slug)); } catch { /* This visit only. */ }
}

/**
 * The page's head while the app is on screen: its icon in the tab and on an Apple home screen, its
 * theme colour and description, and, at /app/<slug>, its manifest, so installing the page installs
 * the app. (On its own domain the domain's manifest is already there.) What was there before comes
 * back when the app leaves.
 */
export function applyAppHead(slug: string, look: NativeLook, { manifest }: { manifest: boolean }): () => void {
  const head = document.head;
  const undo: Array<() => void> = [];
  const add = (element: HTMLElement) => { head.appendChild(element); undo.push(() => element.remove()); };
  const link = (rel: string, href: string, extra: Record<string, string> = {}) => {
    const element = document.createElement('link');
    element.rel = rel;
    element.href = href;
    for (const [name, value] of Object.entries(extra)) element.setAttribute(name, value);
    element.dataset.appLook = '';
    add(element);
  };
  // The site's own icons step aside (a browser picks among all it finds), and come back after.
  const replaced = (selector: string) => {
    for (const element of [...head.querySelectorAll<HTMLElement>(selector)]) {
      if ('appLook' in element.dataset) continue;
      const parent = element.parentNode;
      const next = element.nextSibling;
      element.remove();
      undo.push(() => { if (parent) parent.insertBefore(element, next && next.parentNode === parent ? next : null); });
    }
  };
  if (look.icon === 'raster') {
    replaced('link[rel="icon"], link[rel="shortcut icon"]');
    link('icon', lookImageUrl(slug, 'icon-32.png', look.version), { type: 'image/png', sizes: '32x32' });
    link('icon', lookImageUrl(slug, 'icon-192.png', look.version), { type: 'image/png', sizes: '192x192' });
    replaced('link[rel="apple-touch-icon"]');
    link('apple-touch-icon', lookImageUrl(slug, 'icon-180.png', look.version));
  } else if (look.icon === 'svg') {
    replaced('link[rel="icon"], link[rel="shortcut icon"]');
    link('icon', lookImageUrl(slug, 'icon.svg', look.version), { type: 'image/svg+xml' });
  }
  const meta = (name: string, content: string) => {
    const existing = head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    if (existing) {
      const before = existing.content;
      existing.content = content;
      undo.push(() => { existing.content = before; });
    } else {
      const element = document.createElement('meta');
      element.name = name;
      element.content = content;
      add(element);
    }
  };
  if (look.themeColor) meta('theme-color', look.themeColor);
  if (look.description) meta('description', look.description);
  if (manifest) {
    const existing = head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const href = `${API_BASE_URL.replace(/\/$/, '')}/app/${encodeURIComponent(slug)}/manifest.json`;
    if (existing) {
      const before = existing.getAttribute('href');
      existing.setAttribute('href', href);
      undo.push(() => { if (before === null) existing.removeAttribute('href'); else existing.setAttribute('href', before); });
    } else {
      link('manifest', href);
    }
  }
  return () => { for (const step of undo.reverse()) step(); };
}
