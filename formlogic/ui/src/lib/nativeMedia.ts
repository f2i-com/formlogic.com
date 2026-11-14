import { api } from './api';
import { bytesToBase64, isKeptMedia, mediaSize, readOwnerMediaPack, type NativeKeptMedia, type NativeMedia, type NativeProject, type NativeProjectBytes } from './nativeHosting';

/**
 * An app's media on its owner's page. The page is given each media file's name, size and SHA-256
 * (NativeKeptMedia), not its bytes: a game's ran to tens of megabytes on every visit, for a list of
 * names. The bytes are read for what needs them, a download of the app or an editor (withMediaBytes),
 * and a save names each file the server already has rather than sending it again (keepUnchanged).
 */

/** base64 of bytes (nativeHosting's bytesToBase64). */
export const toBase64 = bytesToBase64;

/** The bytes base64 text holds (line breaks in it allowed); throws where it is not base64. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * SHA-256 of bytes, as hex: the browser's own where the page has it (HTTPS, or this computer), and
 * libsodium's where it has not (a site on a local network over plain HTTP, where browsers give a
 * page no crypto.subtle).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  let digest: Uint8Array;
  if (subtle) digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  else {
    const { getSodium } = await import('./crypto/sodium');
    digest = (await getSodium()).crypto_hash_sha256(bytes);
  }
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The project with every media file's bytes, for a download or an editor. The files it names are
 * read from the server in one pack of the installed app's media (api.getNativeMediaPack) and found
 * there by the SHA-256 that names them, a file renamed in a draft included. One the installed
 * version no longer has (a draft made before the app was changed elsewhere) is read on its own,
 * from wherever the server still has it (an earlier version's, in the app's history), and checked
 * against its name. A project that names none is returned as it is. Throws, in the owner's words,
 * where a file is not on the server at all.
 */
export async function withMediaBytes(appId: string, project: NativeProject): Promise<NativeProjectBytes> {
  if (Object.values(project.assets).every(value => typeof value === 'string')) return project as NativeProjectBytes;
  const pack = readOwnerMediaPack(await api.getNativeMediaPack(appId));
  const assets: Record<string, string> = {};
  for (const [path, value] of Object.entries(project.assets)) {
    if (typeof value === 'string') { assets[path] = value; continue; }
    const gone = new Error(`${path} is not on the server any more: the app was changed since this draft was made. Add the file again, or discard the draft.`);
    if (!isKeptMedia(value)) throw gone;
    let bytes = pack.get(value.kept);
    if (!bytes) {
      const fetched = await api.getNativeMediaFile(appId, path, value.kept);
      if (!fetched) throw gone;
      bytes = new Uint8Array(fetched);
      if (await sha256Hex(bytes) !== value.kept) throw gone;
    }
    assets[path] = toBase64(bytes);
  }
  return { ...project, assets };
}

/**
 * What a save sends: each media file that is, byte for byte, one the installed version has, named as
 * the server named it (NativeKeptMedia) rather than sent again in base64. A page changed, or a new
 * build or .softn file brought in with most of its media as they were, then uploads only what is
 * new. Only a file the size of an installed one is hashed; with no installed names (nothing installed,
 * or a server from before them) the project is sent as it is.
 */
export async function keepUnchanged(project: NativeProject, installed: NativeProject | null): Promise<NativeProject> {
  const named = new Map<string, NativeKeptMedia>();
  for (const value of Object.values(installed?.assets ?? {})) if (isKeptMedia(value)) named.set(value.kept, value);
  if (named.size === 0) return project;
  const sizes = new Set([...named.values()].map(value => value.size));
  let assets: Record<string, NativeMedia> | null = null;
  for (const [path, value] of Object.entries(project.assets)) {
    if (typeof value !== 'string' || !sizes.has(mediaSize(value))) continue;
    let bytes: Uint8Array;
    try { bytes = fromBase64(value); } catch { continue; }
    const same = named.get(await sha256Hex(bytes));
    if (same) (assets ??= { ...project.assets })[path] = { kept: same.kept, size: same.size };
  }
  return assets ? { ...project, assets } : project;
}

/** The type a picture is shown as, by its name's ending. */
const PICTURE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp' };

/**
 * Where the page shows one of a project's pictures: a file in the draft as a data: address; one the
 * server named, at the address that reads that copy of it (api.nativeMediaFileUrl). Empty where there
 * is no such picture.
 */
export function pictureUrl(appId: string, path: string | undefined, value: NativeMedia | undefined): string {
  if (!path || value === undefined) return '';
  if (typeof value === 'string') return `data:${PICTURE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png'};base64,${value}`;
  return isKeptMedia(value) ? api.nativeMediaFileUrl(appId, path, value.kept) ?? '' : '';
}
