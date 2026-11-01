// @vitest-environment jsdom
// A theme goes out in the same save as the title, status, settings and script, so an oversized
// image used to hold all of those back while the dialog said "Theme saved".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormTheme } from '../../types/form';

const h = vi.hoisted(() => ({ shrink: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../lib/shrinkImage', () => ({ shrinkImageToDataUrl: h.shrink }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: h.success, error: h.error, info: vi.fn(), warning: vi.fn() } }));

import { ThemeEditor } from './ThemeEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const theme: FormTheme = { primaryColor: '#4f46e5', backgroundColor: '#ffffff', textColor: '#1f2937', fontFamily: 'DM Sans', borderRadius: 'medium' };

let root: Root | null = null;
let host: HTMLElement | null = null;
let onSave: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.shrink.mockReset().mockResolvedValue({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' });
  h.success.mockReset();
  h.error.mockReset();
  onSave = vi.fn().mockResolvedValue(true);
  onClose = vi.fn();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(start: FormTheme = theme) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ThemeEditor isOpen onClose={onClose as never} theme={start} onSave={onSave as never} />);
  });
}

const input = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const apply = () => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('Apply Theme')) as HTMLButtonElement;
const alertText = () => document.body.querySelector('[role="alert"]')?.textContent;

async function pick(label: string, picked: File) {
  const box = input(label);
  // What the browser does on a pick: the input holds the file until it is cleared.
  Object.defineProperty(box, 'files', { value: [picked], configurable: true });
  let value = 'C:\\fakepath\\logo.png';
  Object.defineProperty(box, 'value', { get: () => value, set: (next: string) => { value = next; }, configurable: true });
  await act(async () => { box.dispatchEvent(new Event('change', { bubbles: true })); });
  return () => value;
}

const png = (size = 1000) => new File([new Uint8Array(size)], 'logo.png', { type: 'image/png' });

describe('uploading a logo or background', () => {
  it('stores what the image was shrunk to, held to a size two can share', async () => {
    render();
    await pick('Logo file', png());

    expect(h.shrink).toHaveBeenCalledWith(expect.any(File), { maxPx: 1024, maxChars: 200 * 1024 });
    await act(async () => apply().click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ logo: 'data:image/jpeg;base64,AAAA' }));
  });

  it('clears the file input, so the same file can be picked again', async () => {
    render();
    const value = await pick('Background image file', png());
    expect(value()).toBe('');
  });

  it('shows why an image did not fit, and leaves it out of the theme', async () => {
    h.shrink.mockResolvedValue({ ok: false, reason: 'too-large' });
    render();
    await pick('Logo file', png());

    expect(alertText()).toContain('too detailed to fit');
    await act(async () => apply().click());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('logo');
  });

  it('shows why an image could not be read', async () => {
    h.shrink.mockResolvedValue({ ok: false, reason: 'unreadable' });
    render();
    await pick('Background image file', png());
    expect(alertText()).toContain('could not be read');
  });

  it('refuses a file that is no image, and one over the limit, in the dialog', async () => {
    render();
    await pick('Logo file', new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(alertText()).toContain('not an image');
    await pick('Logo file', png(20 * 1024 * 1024 + 1));
    expect(alertText()).toContain('over 20MB');
    expect(h.shrink).not.toHaveBeenCalled();
  });

  // What is stored is the shrunk copy, so a phone photo is a fine background.
  it('takes a photo of several MB', async () => {
    render();
    await pick('Background image file', png(6 * 1024 * 1024));
    expect(h.shrink).toHaveBeenCalled();
    expect(alertText()).toBeUndefined();
  });

  it('holds Apply until the image is in the theme', async () => {
    let finish!: (value: unknown) => void;
    h.shrink.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render();
    await pick('Logo file', png());
    expect(apply().disabled).toBe(true);
    await act(async () => finish({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' }));
    expect(apply().disabled).toBe(false);
  });
});

describe('Apply Theme', () => {
  it('says the theme is saved only when it was', async () => {
    render();
    await act(async () => apply().click());
    expect(h.success).toHaveBeenCalledWith('Theme saved', expect.anything());
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open and says so when the save did not arrive', async () => {
    onSave.mockResolvedValue(false);
    render();
    await act(async () => apply().click());

    expect(h.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(alertText()).toContain('not saved');
  });

  // Local-mode themes were never held to a size, and would stop every save once synced.
  it('does not send a theme the server would refuse, whatever it took to get here', async () => {
    render({ ...theme, logo: `data:image/png;base64,${'A'.repeat(600 * 1024)}` });
    await act(async () => apply().click());

    expect(onSave).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
    expect(alertText()).toContain('too large to save');
  });
});
