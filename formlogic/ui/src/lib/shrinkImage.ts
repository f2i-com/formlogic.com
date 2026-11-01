// Fit an uploaded image into a small data URL, in the browser, before it is stored in a document.
// Everything is re-encoded, even an image that already fits: that drops what a photo carries
// besides its pixels (its location, for one), and the markup an SVG can hold.

export type ShrunkImage =
  /** `firstFrameOnly`: the file was animated, and a canvas draws only its first frame. */
  | { ok: true; dataUrl: string; firstFrameOnly?: true }
  /** `unreadable`: not an image the browser can draw. `too-large`: no size or quality tried fits. */
  | { ok: false; reason: 'unreadable' | 'too-large' };

const QUALITIES = [0.85, 0.7, 0.55, 0.4];
// Lowering the quality is tried first at each size; a detailed photo needs fewer pixels as well.
const SIZES = [1, 0.75, 0.5, 0.35];

function loadImage(file: File): Promise<{ image: HTMLImageElement; release: () => void }> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, release: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable image'));
    };
    image.src = url;
  });
}

function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/** Whether a GIF's blocks hold a second image. Anything it can't follow counts as a still. */
function isAnimatedGif(bytes: Uint8Array): boolean {
  const skipColourTable = (at: number, packed: number) => (packed & 0x80 ? at + 3 * 2 ** ((packed & 7) + 1) : at);
  const skipSubBlocks = (from: number) => {
    let at = from;
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at] + 1;
    return at + 1;
  };
  // Past the 6-byte signature and the 7-byte screen descriptor, which has its flags at byte 10.
  let at = skipColourTable(13, bytes[10]);
  let images = 0;
  while (at < bytes.length) {
    if (bytes[at] === 0x21) {
      at = skipSubBlocks(at + 2);
    } else if (bytes[at] === 0x2c) {
      images += 1;
      if (images > 1) return true;
      // 10 bytes of image descriptor, its colour table, then one byte of LZW code size.
      at = skipSubBlocks(skipColourTable(at + 10, bytes[at + 9]) + 1);
    } else {
      return false;
    }
  }
  return false;
}

async function keepsOnlyItsFirstFrame(file: File): Promise<boolean> {
  if (file.type !== 'image/gif') return false;
  try {
    return isAnimatedGif(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return false;
  }
}

export async function shrinkImageToDataUrl(
  file: File,
  { maxPx, maxChars }: { maxPx: number; maxChars: number }
): Promise<ShrunkImage> {
  let loaded: Awaited<ReturnType<typeof loadImage>>;
  try {
    loaded = await loadImage(file);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const { image, release } = loaded;
  try {
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    // An SVG with no size of its own reads as 0 wide in some browsers, and draws as nothing.
    if (longest === 0) return { ok: false, reason: 'unreadable' };
    // An SVG has no pixels of its own to lose, so it is drawn as large as it may be stored: frozen
    // at its nominal size, a 48px logo goes soft on any sharp screen.
    const fit = file.type === 'image/svg+xml' ? maxPx / longest : Math.min(1, maxPx / longest);
    const firstFrameOnly = await keepsOnlyItsFirstFrame(file);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { ok: false, reason: 'unreadable' };

    let formats: string[] | null = null;
    for (const size of SIZES) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * fit * size));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * fit * size));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // JPEG has no transparency: a logo's clear background would come out black. Where the
      // browser cannot write WebP, toDataURL gives a PNG, which keeps it too.
      formats ??= hasTransparency(context, canvas.width, canvas.height) ? ['image/webp', 'image/png'] : ['image/jpeg'];
      for (const format of formats) {
        for (const quality of format === 'image/png' ? [1] : QUALITIES) {
          const dataUrl = canvas.toDataURL(format, quality);
          if (dataUrl.startsWith('data:image/') && dataUrl.length <= maxChars) return { ok: true, dataUrl, ...(firstFrameOnly ? { firstFrameOnly } : {}) };
        }
      }
    }
    return { ok: false, reason: 'too-large' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    release();
  }
}
