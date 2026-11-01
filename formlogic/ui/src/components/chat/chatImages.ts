// Chat image attachments: client-side downscale before anything leaves the
// browser (mirrors the diagram canvas paste pipeline). The server admits only
// base64 raster data URIs ≤ CHAT_MAX_IMAGE_DATA_CHARS, so re-encode with
// headroom rather than trusting the original file.
import { getAiPreferences } from '../../client-runtime/flows/aiDefault';
import { toast } from '../../stores/toastStore';

/** Max data-URI length we send (server cap is 700k chars — keep headroom). */
export const CHAT_IMAGE_MAX_CHARS = 480_000;
/** Max images the composer accepts per message (server pins 4). */
export const CHAT_IMAGES_PER_MESSAGE = 4;
/**
 * Most image data one message can carry to Desktop AI. Its sealed request has room for about
 * 258,000 bytes (DESKTOP_CHAT_LIMITS in chatEngine), and the words of the turn go in there too.
 */
export const CHAT_DESKTOP_IMAGE_CHARS = 240_000;

/**
 * Whether an image can join the ones already on this message. An image that can't ever reach
 * Desktop AI is refused now, in plain words: it would go on being saved and failing afterwards.
 */
export async function acceptChatImage(url: string, attached: string[]): Promise<boolean> {
  const prefs = await getAiPreferences();
  if (!prefs.ok || prefs.data.aiSource !== 'desktop') return true;
  const chars = [...attached, url].reduce((total, image) => total + image.length, 0);
  if (chars <= CHAT_DESKTOP_IMAGE_CHARS) return true;
  toast.error(
    'That image is too large for FormLogic Desktop',
    'One message can carry about 180 KB of images there. Use a smaller image, or send it in another message.'
  );
  return false;
}

/** Downscale an image file to ≤1024px JPEG and return its data URI, or null when
 * the file is unreadable or still too large after re-encoding. */
export async function downscaleChatImage(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('unreadable image'));
      image.src = url;
    });
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height, 1));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
    let src = canvas.toDataURL('image/jpeg', 0.85);
    if (src.length > CHAT_IMAGE_MAX_CHARS) src = canvas.toDataURL('image/jpeg', 0.6);
    return src.length > CHAT_IMAGE_MAX_CHARS ? null : src;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
