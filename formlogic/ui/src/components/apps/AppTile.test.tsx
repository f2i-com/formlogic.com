// @vitest-environment jsdom
// An app's tile wherever the workspace lists apps: the owner's logo, else a SoftN app's own icon
// (the one its tab and home screen show), else its curated icon, else its initial.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppTile } from './AppTile';
import type { App } from '../../types/app';

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

const app = (more: Partial<App> = {}): App => ({
  id: 'a1', name: 'tattled', slug: 'tattled-a55142', ownerId: 'u1', status: 'published',
  settings: {} as App['settings'], theme: {} as App['theme'], navConfig: [], createdAt: '', updatedAt: '', ...more,
});
const show = async (shown: App) => { await act(async () => root!.render(<AppTile app={shown} />)); };
const tile = () => container.firstElementChild as HTMLElement;
const img = () => container.querySelector('img');

describe('AppTile', () => {
  it("draws a SoftN app's own icon, whole, on no plate", async () => {
    await show(app({ lookIcon: { kind: 'raster', version: 'abc123' } }));
    expect(img()?.getAttribute('src')).toBe('/api/app/tattled-a55142/look/icon-192.png?v=abc123');
    expect(img()?.getAttribute('alt')).toBe('');
    expect(img()?.className).toContain('object-contain');
    expect(tile().dataset.appIcon).toBe('own');
    expect(tile().className).not.toContain('bg-');
    expect(container.textContent).toBe('');
  });

  it('asks for an SVG icon as it is', async () => {
    await show(app({ lookIcon: { kind: 'svg', version: '0f' } }));
    expect(img()?.getAttribute('src')).toBe('/api/app/tattled-a55142/look/icon.svg?v=0f');
  });

  it("puts the owner's logo first, filling the tile", async () => {
    await show(app({ logoUrl: 'https://cdn.example/logo.png', lookIcon: { kind: 'raster', version: 'abc123' } }));
    expect(img()?.getAttribute('src')).toBe('https://cdn.example/logo.png');
    expect(img()?.className).toContain('object-cover');
    expect(tile().dataset.appIcon).toBe('logo');
  });

  it('shows the initial for an app with neither', async () => {
    await show(app());
    expect(img()).toBeNull();
    expect(container.textContent).toBe('T');
    expect(tile().dataset.appIcon).toBe('initial');
  });

  it('falls back to the initial when the picture does not come, and tries a new icon afresh', async () => {
    await show(app({ lookIcon: { kind: 'raster', version: 'abc123' } }));
    await act(async () => { img()!.dispatchEvent(new Event('error')); });
    expect(img()).toBeNull();
    expect(container.textContent).toBe('T');
    // A new icon is another address, and gets its own try.
    await show(app({ lookIcon: { kind: 'raster', version: 'def456' } }));
    expect(img()?.getAttribute('src')).toBe('/api/app/tattled-a55142/look/icon-192.png?v=def456');
  });
});
