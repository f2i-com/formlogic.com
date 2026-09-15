import { reviewAppArchive } from './appImportReview';
import { strFromU8, strToU8, zipSync } from 'fflate';

export interface NativeProject { home?: boolean; version: number; updatedAt?: string; files: Record<string,string>; assets: Record<string,string>; access: 'application' | 'members' }
export interface NativeRuntimeProject { version: number; client: Record<string,string>; assets: Record<string,string>; access: 'application' | 'members'; origins?: string[] }
export interface NativeRecordField { name: string; type: string; primary: boolean; required: boolean; defaultValue: string | null; auto: boolean; readOnly: boolean }
export interface NativeRecordDetail { values: Record<string, string | null>; revision: string; fields: NativeRecordField[] }
/**
 * A page of records. `offset` is the offset the server actually used (it
 * clamps requests past its browsing window), `end` says why the page ends:
 * more pages follow, the table ended, or the window's limit was reached with
 * rows beyond it. Older servers send only `hasMore`.
 */
export interface NativeRecords { schema?: { fields: NativeRecordField[]; primaryKey: string[]; canCreate: boolean }; keys?: (Record<string, string> | null)[]; installed?: boolean; tables: string[]; columns?: string[]; rows?: Record<string, unknown>[]; hasMore?: boolean; offset?: number; end?: 'more' | 'end' | 'limit'; limit?: number }
export async function importNativeProject(file: File): Promise<NativeProject> {
  const { files, review } = reviewAppArchive(new Uint8Array(await file.arrayBuffer()));
  if (review.backend !== 'native') throw new Error('This app has no native server entry. Use App hosting for a client app and named backend actions.');
  const source: Record<string,string> = {};
  const assets: Record<string,string> = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (/\.(ui|logic|json|sql)$/.test(path)) source[path] = strFromU8(bytes);
    else if (path.startsWith('assets/')) {
      let binary = '';
      for (let offset=0;offset<bytes.length;offset+=8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
      assets[path] = btoa(binary);
    } else if (!/^(README|LICENSE|NOTICE)(\.|$)/.test(path)) throw new Error(`Unsupported project file: ${path}`);
  }
  return { version: 0, files: source, assets, access: 'application' };
}

/** Owner project export: source and media, without databases or host credentials. */
export function exportNativeProject(project: NativeProject): Uint8Array {
  const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(project.files).map(([path, source]) => [path, strToU8(source)]));
  for (const [path, encoded] of Object.entries(project.assets)) files[path] = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return zipSync(files);
}
