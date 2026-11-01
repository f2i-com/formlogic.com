// @vitest-environment jsdom
// jsdom draws nothing, so the canvas here is a stand-in that answers with a data URL of a size
// that falls with the pixels and the quality, as a real encoder's does. What is under test is the
// walk: which format, in what order, and when to give up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shrinkImageToDataUrl } from './shrinkImage';

interface Picture { width: number; height: number; transparent?: boolean; fails?: boolean }
let picture: Picture;
let encoded: Array<{ type: string; quality?: number; width: number; height: number }>;
/** Characters of data URL per pixel at quality 1, as the stand-in encoder writes them. */
let density: number;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  get naturalWidth() { return picture.width; }
  get naturalHeight() { return picture.height; }
  set src(_url: string) {
    queueMicrotask(() => (picture.fails ? this.onerror?.() : this.onload?.()));
  }
}

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(4 * canvas.width * canvas.height).fill(picture.transparent ? 0 : 255) }),
    }),
    toDataURL: (type: string, quality?: number) => {
      encoded.push({ type, quality, width: canvas.width, height: canvas.height });
      const chars = Math.round(canvas.width * canvas.height * density * (type === 'image/png' ? 1 : (quality ?? 1)));
      return `data:${type};base64,${'x'.repeat(chars)}`;
    },
  };
  return canvas;
}

const file = () => new File(['x'], 'logo.png', { type: 'image/png' });
const limits = { maxPx: 1024, maxChars: 200 * 1024 };

/** A real GIF's block structure, with `frames` images in it. */
function gif(frames: number, { colourTable = false, localTable = false, comment = false } = {}): File {
  const table = (size: number) => new Array(3 * 2 ** (size + 1)).fill(0);
  const bytes = [
    ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
    1, 0, 1, 0, colourTable ? 0x81 : 0, 0, 0, // screen: 1 by 1, packed, background, aspect
    ...(colourTable ? table(1) : []),
    ...(comment ? [0x21, 0xfe, 3, 0x2c, 0x2c, 0x2c, 0] : []), // a comment that spells 0x2c
  ];
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.push(0x21, 0xf9, 4, 4, 10, 0, 0, 0); // graphic control: the delay between frames
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, localTable ? 0x80 : 0); // image descriptor
    if (localTable) bytes.push(...table(0));
    bytes.push(2, 2, 0x44, 0x01, 0); // code size, one sub-block of pixels, end
  }
  bytes.push(0x3b);
  return new File([new Uint8Array(bytes)], 'logo.gif', { type: 'image/gif' });
}

beforeEach(() => {
  encoded = [];
  density = 0.1;
  picture = { width: 400, height: 200 };
  vi.stubGlobal('Image', FakeImage);
  URL.createObjectURL = vi.fn(() => 'blob:picture');
  URL.revokeObjectURL = vi.fn();
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'canvas' ? fakeCanvas() : real(tag))) as typeof document.createElement);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shrinkImageToDataUrl', () => {
  it('fits the longest side within the limit, keeping the shape', async () => {
    picture = { width: 4000, height: 2000 };
    density = 0.01;
    expect((await shrinkImageToDataUrl(file(), limits)).ok).toBe(true);
    expect(encoded[0]).toMatchObject({ width: 1024, height: 512 });
  });

  it('does not make a small image larger', async () => {
    await shrinkImageToDataUrl(file(), limits);
    expect(encoded[0]).toMatchObject({ width: 400, height: 200 });
  });

  it('re-encodes an image that already fits, so nothing but its pixels is stored', async () => {
    const shrunk = await shrinkImageToDataUrl(file(), limits);
    expect(shrunk).toMatchObject({ ok: true });
    expect(encoded).toHaveLength(1);
  });

  it('lowers the quality until it fits', async () => {
    picture = { width: 1000, height: 500 };
    density = 0.65;
    const shrunk = await shrinkImageToDataUrl(file(), limits);
    expect(shrunk.ok).toBe(true);
    expect(encoded.map((e) => e.quality)).toEqual([0.85, 0.7, 0.55]);
    expect(encoded.every((e) => e.type === 'image/jpeg')).toBe(true);
    if (shrunk.ok) expect(shrunk.dataUrl.length).toBeLessThanOrEqual(limits.maxChars);
  });

  it('takes fewer pixels when the lowest quality is not enough', async () => {
    picture = { width: 1024, height: 1024 };
    density = 1;
    const shrunk = await shrinkImageToDataUrl(file(), limits);
    expect(shrunk.ok).toBe(true);
    expect(encoded.at(-1)?.width).toBeLessThan(1024);
  });

  // JPEG has no transparency: a logo's clear background would come out black.
  it('keeps a transparent image out of JPEG', async () => {
    picture = { width: 1000, height: 1000, transparent: true };
    density = 1;
    await shrinkImageToDataUrl(file(), limits);
    expect(encoded.some((e) => e.type === 'image/jpeg')).toBe(false);
    expect(encoded[0].type).toBe('image/webp');
    expect(encoded.some((e) => e.type === 'image/png')).toBe(true);
  });

  it('says so when nothing tried fits', async () => {
    picture = { width: 1024, height: 1024 };
    density = 100;
    expect(await shrinkImageToDataUrl(file(), limits)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('says so when the file does not draw, and lets the object URL go', async () => {
    picture = { width: 10, height: 10, fails: true };
    expect(await shrinkImageToDataUrl(file(), limits)).toEqual({ ok: false, reason: 'unreadable' });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:picture');
  });

  // Some browsers give an SVG with no size of its own no size at all, and it draws as nothing.
  it('does not store an empty image for a picture with no size', async () => {
    picture = { width: 0, height: 0 };
    expect(await shrinkImageToDataUrl(file(), limits)).toEqual({ ok: false, reason: 'unreadable' });
    expect(encoded).toHaveLength(0);
  });

  // Frozen at its nominal 48 pixels, a logo goes soft on any sharp screen.
  describe('an SVG', () => {
    const svg = () => new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });

    it('is drawn as large as it may be stored, however small it says it is', async () => {
      picture = { width: 48, height: 48 };
      await shrinkImageToDataUrl(svg(), { maxPx: 512, maxChars: 64 * 1024 });
      expect(encoded[0]).toMatchObject({ width: 512, height: 512 });
    });

    it('keeps its shape, and gets the room a background has', async () => {
      picture = { width: 48, height: 24 };
      density = 0.01;
      await shrinkImageToDataUrl(svg(), { maxPx: 1280, maxChars: 150 * 1024 });
      expect(encoded[0]).toMatchObject({ width: 1280, height: 640 });
    });

    it('comes down to fit, as anything else does', async () => {
      picture = { width: 4000, height: 2000 };
      density = 0.01;
      await shrinkImageToDataUrl(svg(), { maxPx: 512, maxChars: 64 * 1024 });
      expect(encoded[0]).toMatchObject({ width: 512, height: 256 });
    });

    it('takes fewer pixels when it won\'t fit at that size', async () => {
      picture = { width: 48, height: 48 };
      density = 1;
      const shrunk = await shrinkImageToDataUrl(svg(), { maxPx: 512, maxChars: 64 * 1024 });
      expect(shrunk.ok).toBe(true);
      expect(encoded.at(-1)?.width).toBeLessThan(512);
    });
  });

  describe('a GIF', () => {
    const shrink = (picked: File) => shrinkImageToDataUrl(picked, limits);

    it('is marked when it has more than one frame', async () => {
      expect(await shrink(gif(3))).toMatchObject({ ok: true, firstFrameOnly: true });
    });

    it('is not marked when it has one', async () => {
      expect(await shrink(gif(1))).not.toHaveProperty('firstFrameOnly');
    });

    it.each([
      ['a global colour table', { colourTable: true }],
      ['local colour tables', { localTable: true }],
      ['a comment holding the byte of an image', { comment: true }],
    ])('reads its way past %s', async (_label, shape) => {
      expect(await shrink(gif(2, shape))).toMatchObject({ firstFrameOnly: true });
      expect(await shrink(gif(1, shape))).not.toHaveProperty('firstFrameOnly');
    });

    it('takes a file it can\'t follow for a still', async () => {
      const broken = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff])], 'logo.gif', { type: 'image/gif' });
      expect(await shrink(broken)).toMatchObject({ ok: true });
      expect(await shrink(broken)).not.toHaveProperty('firstFrameOnly');
    });
  });
});
