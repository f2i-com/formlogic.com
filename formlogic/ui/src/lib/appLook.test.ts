// @vitest-environment jsdom
// A hosted SoftN app's look in the page: held to its shape, remembered for the next visit, and worn
// in the page's head while the app is on screen, the site's own put back after.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appIconUrl, applyAppHead, lookImageUrl, readLook, rememberLook, rememberedLook, type NativeLook } from './appLook';

const look = (overrides: Partial<NativeLook> = {}): NativeLook => ({ background: '#0b1020', spinner: '#e9c46a', themeColor: '#123456', description: 'A colony on Hollow-7.', icon: 'raster', version: 'abc123', installable: true, ...overrides });
const siteHead = '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#6366f1"><meta name="description" content="FormLogic">';

beforeEach(() => { document.head.innerHTML = siteHead; localStorage.clear(); });
afterEach(() => { document.head.innerHTML = ''; });

describe('readLook', () => {
  it('keeps the look the server sent and nothing else', () => {
    expect(readLook(look())).toEqual(look());
    expect(readLook({ ...look(), background: 'red; background-image: url(x)', spinner: 'url(x)', icon: 'gif', extra: 1 })).toEqual(look({ background: null, spinner: null, icon: null }));
    expect(readLook({ ...look(), version: '../x' })).toBeNull();
    // A draft's manifest is not served; a server from before the flag said nothing, which is installable.
    expect(readLook({ ...look(), installable: false })).toEqual(look({ installable: false }));
    const older: Record<string, unknown> = { ...look() };
    delete older.installable;
    expect(readLook(older)).toEqual(look({ installable: true }));
    expect(readLook({ ...look(), installable: 'no' })).toEqual(look({ installable: true }));
    expect(readLook(null)).toBeNull();
    expect(readLook('look')).toBeNull();
  });
  it('is remembered per app for the next visit', () => {
    rememberLook('outerstead', look());
    expect(rememberedLook('outerstead')).toEqual(look());
    expect(rememberedLook('other')).toBeNull();
    rememberLook('outerstead', null);
    expect(rememberedLook('outerstead')).toBeNull();
  });
  it('addresses each image with the look version', () => {
    expect(lookImageUrl('my app', 'icon-32.png', 'abc')).toBe('/api/app/my%20app/look/icon-32.png?v=abc');
  });
});

describe('appIconUrl', () => {
  it('is where a listed SoftN app serves its own icon', () => {
    expect(appIconUrl({ slug: 'my app', lookIcon: { kind: 'raster', version: 'abc123' } })).toBe('/api/app/my%20app/look/icon-192.png?v=abc123');
    expect(appIconUrl({ slug: 'outerstead', lookIcon: { kind: 'svg', version: '0f' } })).toBe('/api/app/outerstead/look/icon.svg?v=0f');
  });
  it('is nothing for an app with no icon of its own, and for anything that is not the shape the server sends', () => {
    expect(appIconUrl({ slug: 'forms-app' })).toBeNull();
    expect(appIconUrl({ slug: 'forms-app', lookIcon: null })).toBeNull();
    expect(appIconUrl({ slug: '', lookIcon: { kind: 'raster', version: 'abc' } })).toBeNull();
    expect(appIconUrl({ slug: 'x', lookIcon: { kind: 'gif', version: 'abc' } })).toBeNull();
    expect(appIconUrl({ slug: 'x', lookIcon: { kind: 'raster', version: '../y' } })).toBeNull();
    expect(appIconUrl({ slug: 'x', lookIcon: { kind: 'raster', version: 7 } })).toBeNull();
  });
});

describe('applyAppHead', () => {
  it('wears the app icon, colour, description and manifest, and gives the site its own back', () => {
    const undo = applyAppHead('outerstead', look(), { manifest: true });
    const icons = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map(link => link.getAttribute('href'));
    expect(icons).toEqual(['/api/app/outerstead/look/icon-32.png?v=abc123', '/api/app/outerstead/look/icon-192.png?v=abc123']);
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/api/app/outerstead/look/icon-180.png?v=abc123');
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe('/api/app/outerstead/manifest.json');
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#123456');
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content).toBe('A colony on Hollow-7.');
    undo();
    expect(document.head.innerHTML).toBe(siteHead);
  });
  it('an SVG icon in the tab; on its own domain the manifest is left as the domain set it', () => {
    const undo = applyAppHead('outerstead', look({ icon: 'svg' }), { manifest: false });
    expect([...document.head.querySelectorAll('link[rel="icon"]')].map(link => link.getAttribute('href'))).toEqual(['/api/app/outerstead/look/icon.svg?v=abc123']);
    // Apple's home screen takes a PNG only: the site's stays.
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/apple-touch-icon.png');
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe('/manifest.webmanifest');
    undo();
    expect(document.head.innerHTML).toBe(siteHead);
  });
  it('with no icon of its own the site icons stay', () => {
    const undo = applyAppHead('outerstead', look({ icon: null, themeColor: null, description: '' }), { manifest: false });
    expect(document.head.innerHTML).toBe(siteHead);
    undo();
    expect(document.head.innerHTML).toBe(siteHead);
  });
});
