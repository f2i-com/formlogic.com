// Hosted SoftN apps: an app whose interface, private backend and database are its SoftN
// project rather than forms. Created here with a first version — the server's working
// starter, or a .softn file — and managed in the SoftN app workspace (/apps/:id/softn).
import { api } from './api';
import { importNativeProject, type NativeProject } from './nativeHosting';
import { useAppStore } from '../stores/appStore';
import type { App } from '../types/app';

/** Whether the app is a hosted SoftN app (created as one, or marked so later). */
export function isSoftnApp(app: Pick<App, 'settings'> | null | undefined): boolean {
  return app?.settings?.softnApp === true;
}

/** Where the owner manages a SoftN app. */
export const softnWorkspacePath = (appId: string) => `/apps/${appId}/softn`;

/** How a new SoftN app's first version is made. */
export type SoftnStart = { kind: 'starter' } | { kind: 'upload'; file: File };

export interface CreatedSoftnApp {
  app: App;
  /** The installed first version; null when it could not be installed (see `error`). */
  project: NativeProject | null;
  /** Why the first version was not installed. The app exists either way. */
  error?: string;
}

/**
 * The project a .softn file becomes as a new app's first version: open at the app's address,
 * and for members only until its owner opens it to everyone.
 */
export async function projectFromUpload(file: File): Promise<NativeProject> {
  const imported = await importNativeProject(file);
  return { ...imported, home: true, access: 'members' };
}

/** The name a .softn file's app goes by: its manifest's name, else the file's. */
export function uploadName(project: NativeProject, file: File): string {
  try {
    const manifest = JSON.parse(project.files['manifest.json'] ?? '{}') as { name?: unknown };
    if (typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim().slice(0, 120);
  } catch { /* the file's name below */ }
  return file.name.replace(/\.(softn|zip)$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 120) || 'SoftN app';
}

/**
 * Create a SoftN app and install its first version. A .softn file is read before the app is
 * created, so a file that is not a SoftN project with a backend creates nothing.
 */
export async function createSoftnApp(input: { name: string; description?: string; start: SoftnStart }): Promise<CreatedSoftnApp> {
  const uploaded = input.start.kind === 'upload' ? await projectFromUpload(input.start.file) : null;
  // An upload with no name given is named after the app it carries.
  const name = input.name.trim() || (uploaded && input.start.kind === 'upload' ? uploadName(uploaded, input.start.file) : '');
  if (!name) throw new Error('Give the app a name.');
  const app = await useAppStore.getState().createApp({
    name,
    description: input.description?.trim() || undefined,
    settings: { softnApp: true },
  });
  if (!app) throw new Error(useAppStore.getState().error || 'Could not create the app. Please try again.');
  const result = uploaded ? await api.saveNativeProject(app.id, uploaded, 0) : await api.installNativeStarter(app.id);
  if (result.error || !result.data) return { app, project: null, error: result.error || 'The app was created, but its first version could not be installed.' };
  return { app, project: result.data.project };
}
