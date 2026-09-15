import type { NativeProject } from './nativeHosting';

/**
 * Audit FL-S08: a recoverable checkpoint of the native editor's unpublished
 * draft, kept in this browser so a reload, a closed tab or a crash does not
 * cost an afternoon of edits. It is scoped to the signed-in account and the
 * app, records the installed version the draft was based on (so a publish
 * elsewhere in the meantime is shown as a conflict, not silently replaced),
 * and is never published by itself: the owner recovers or discards it.
 *
 * Three states stay distinct: this local recoverable draft, the draft held in
 * the open editor, and the installed (published) project on the server.
 */
export interface NativeDraftCheckpoint {
  baseVersion: number;
  savedAt: string;
  project: NativeProject;
}

/** Larger drafts are not checkpointed rather than risk a half-written record. */
const LIMIT = 4 * 1024 * 1024;

export function nativeDraftStore(userId: string | undefined, appId: string) {
  const key = userId ? `formlogic:native-draft:${encodeURIComponent(userId)}:${encodeURIComponent(appId)}` : null;
  function read(): NativeDraftCheckpoint | null {
    if (!key) return null;
    let raw: string | null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<NativeDraftCheckpoint>;
      const project = value?.project;
      if (!value || typeof value.baseVersion !== 'number' || typeof value.savedAt !== 'string' || !project || typeof project !== 'object') return null;
      if (!project.files || typeof project.files !== 'object' || !project.assets || typeof project.assets !== 'object') return null;
      return { baseVersion: value.baseVersion, savedAt: value.savedAt, project: project as NativeProject };
    } catch { return null; }
  }
  /** Returns false when nothing was kept (no account, too large, or storage refused). */
  function write(checkpoint: NativeDraftCheckpoint): boolean {
    if (!key) return false;
    const data = JSON.stringify(checkpoint);
    if (data.length > LIMIT) return false;
    try { localStorage.setItem(key, data); return true; } catch { return false; }
  }
  function clear(): void {
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* nothing to clear, or storage is unavailable */ }
  }
  return { read, write, clear, scoped: key !== null };
}
