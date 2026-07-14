// Reads user-selected files (a single file, a multi-select, or a whole folder picked via a
// webkitdirectory input) into ScreenFile objects for the custom-screen Studios. Text files only,
// per-file + batch size caps, and normalized safe paths (forward slashes, no '..', no leading '/').
// Anything that can't be imported is returned in `skipped` with a human-readable reason.

import type { ScreenFile } from '../../lib/screenCompile';

/** Extensions the multi-file screen editor treats as editable text. */
export const TEXT_FILE_EXTENSIONS = [
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'json', 'svg', 'md', 'txt',
] as const;

/** Max size for a single uploaded file (256KB). */
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * Max combined size for one upload batch. The backend caps the whole saved screen JSON (files +
 * compiled js/html/css) at 512KB (FormController/AppController: 524288), so the batch cap matches
 * that server limit rather than a looser client-side default.
 */
export const MAX_BATCH_BYTES = 512 * 1024;

/** Folders that are never worth importing (dependency/VCS/OS junk). */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '__MACOSX']);

/** True when the path ends in one of the editable text extensions. */
export function hasAllowedExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dotfile like ".gitignore"
  const ext = base.slice(dot + 1).toLowerCase();
  return (TEXT_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Normalize one uploaded file's path to a safe relative path:
 * - folder uploads keep their structure minus the top-level (picked) folder segment
 * - backslashes -> '/', empty and '.' segments dropped, no leading '/'
 * - whitespace collapsed to '-', characters outside [A-Za-z0-9._-] removed per segment
 * Returns null when the path is unsafe (contains '..') or empty after normalization.
 */
function normalizeUploadPath(file: File): string | null {
  const rel = file.webkitRelativePath || '';
  // A folder upload's webkitRelativePath always starts with the picked folder's own name — drop it.
  const raw = rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : file.name;
  const out: string[] = [];
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    const trimmed = seg.trim();
    if (trimmed === '' || trimmed === '.') continue;
    if (trimmed === '..') return null;
    const safe = trimmed.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
    if (safe === '' || /^\.+$/.test(safe)) return null;
    out.push(safe);
  }
  return out.length > 0 ? out.join('/') : null;
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)}KB`;

/**
 * Read an upload selection (FileList from an <input type="file"> — plain, multiple, or
 * webkitdirectory — or a File[] from drag-and-drop) into screen files.
 *
 * Returns the readable text files with normalized paths (sorted by path, deduplicated) plus a list
 * of "path — reason" strings for everything that was skipped (binary/unknown extension, too big,
 * unsafe path, over the batch cap, junk folders).
 */
export async function readUploadedScreenFiles(
  list: FileList | File[]
): Promise<{ files: ScreenFile[]; skipped: string[] }> {
  const input = Array.from(list);
  const files: ScreenFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const file of input) {
    const display = file.webkitRelativePath || file.name;

    const junkDir = display.split(/[\\/]/).find((seg) => SKIPPED_DIRS.has(seg));
    if (junkDir) {
      skipped.push(`${display} — inside ${junkDir}`);
      continue;
    }
    const path = normalizeUploadPath(file);
    if (!path) {
      skipped.push(`${display} — unsafe or empty path`);
      continue;
    }
    if (!hasAllowedExtension(path)) {
      skipped.push(`${display} — not an editable text file`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push(`${display} — larger than ${kb(MAX_FILE_BYTES)}`);
      continue;
    }
    if (total + file.size > MAX_BATCH_BYTES) {
      skipped.push(`${display} — upload limit reached (${kb(MAX_BATCH_BYTES)} total)`);
      continue;
    }
    if (seen.has(path)) {
      skipped.push(`${display} — duplicate of another selected file`);
      continue;
    }

    let content: string;
    try {
      content = await file.text();
    } catch {
      skipped.push(`${display} — could not be read`);
      continue;
    }
    if (content.includes(String.fromCharCode(0))) {
      skipped.push(`${display} — binary content`);
      continue;
    }

    seen.add(path);
    total += file.size;
    files.push({ path, content });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}
