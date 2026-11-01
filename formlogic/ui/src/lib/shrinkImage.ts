// Fit an uploaded image into a small data URL, in the browser, before it is stored in a document.
// Everything is re-encoded, even an image that already fits: that drops what a photo carries
// besides its pixels (its location, for one), and the markup an SVG can hold.

export type ShrunkImage =
  | { ok: true; dataUrl: string }
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
    const fit = Math.min(1, maxPx / longest);
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
          if (dataUrl.startsWith('data:image/') && dataUrl.length <= maxChars) return { ok: true, dataUrl };
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
