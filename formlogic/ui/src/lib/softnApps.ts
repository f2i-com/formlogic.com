// Hosted SoftN apps: an app whose interface, private backend and database are its SoftN
// project rather than forms. Created here with a first version — the server's working
// starter, or a .softn file — and managed in the SoftN app workspace (/apps/:id/softn).
import { api } from './api';
import { importNativeProject, type NativeProject } from './nativeHosting';
import { backendOf, withBackend } from './softnBackend';
import { useAppStore } from '../stores/appStore';
import type { App } from '../types/app';

/** Whether the app is a hosted SoftN app (created as one, or marked so later). */
export function isSoftnApp(app: Pick<App, 'settings'> | null | undefined): boolean {
  return app?.settings?.softnApp === true;
}

/** The sections of a SoftN app's page, each at its own address under /apps/<id>/softn/. */
export const SOFTN_SECTIONS = ['overview', 'data', 'api', 'members', 'edit', 'automations', 'history', 'domains', 'settings'] as const;
export type SoftnSection = (typeof SOFTN_SECTIONS)[number];

/**
 * Where the owner manages a SoftN app: its page, or one section of it. The overview is the page's
 * own address, and `rest` names what is open inside a section (a table and its view, under data).
 */
export const softnWorkspacePath = (appId: string, section: SoftnSection = 'overview', ...rest: string[]) =>
  section === 'overview' ? `/apps/${appId}/softn` : `/apps/${appId}/softn/${[section, ...rest.filter(Boolean).map(encodeURIComponent)].join('/')}`;

/**
 * The App Studio is for forms apps. An address of it that names a SoftN app (an old link, a
 * bookmark, a button that knows only the app's id) lands on the section of the app's own page that
 * does what that part of the studio did. The studio's own address, with no part named, is the app's
 * settings.
 */
const STUDIO_STEP_SECTIONS: Readonly<Record<string, SoftnSection>> = {
  plan: 'overview', data: 'data', screens: 'edit', automations: 'automations', access: 'members', publish: 'overview',
};
export const softnPathForStudio = (appId: string, step?: string) =>
  softnWorkspacePath(appId, (step !== undefined && Object.hasOwn(STUDIO_STEP_SECTIONS, step) ? STUDIO_STEP_SECTIONS[step] : undefined) ?? 'settings');

/** How a new SoftN app's first version is made. */
/** `backendFile`: for a file with no backend of its own, the app's full file, whose backend is added to it (lib/softnBackend). */
export type SoftnStart = { kind: 'starter' } | { kind: 'upload'; file: File; backendFile?: File };

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

/** Whether a project brings a backend of its own (a `server` block); an app without one runs in the browser alone. */
export function projectHasBackend(project: NativeProject): boolean {
  try {
    const manifest = JSON.parse(project.files['manifest.json'] ?? '{}') as Record<string, unknown>;
    return manifest !== null && typeof manifest === 'object' && 'server' in manifest;
  } catch { return false; }
}

/** Why the shared demo cannot add a SoftN app. */
export const SOFTN_NEEDS_ACCOUNT = 'SoftN apps are hosted on the server, so they are available after sign-up.';

/**
 * Create a SoftN app and install its first version. A .softn file (with a backend of its own or
 * none) is read before the app is created, so a file this host cannot take creates nothing.
 */
export async function createSoftnApp(input: { name: string; description?: string; start: SoftnStart }): Promise<CreatedSoftnApp> {
  // The demo keeps its apps in this browser; a SoftN app runs on the server, so nothing is created.
  if (api.isDemoMode()) throw new Error(SOFTN_NEEDS_ACCOUNT);
  let uploaded = input.start.kind === 'upload' ? await projectFromUpload(input.start.file) : null;
  if (uploaded && input.start.kind === 'upload' && input.start.backendFile) {
    const backend = backendOf(await importNativeProject(input.start.backendFile));
    if (!backend) throw new Error(`${input.start.backendFile.name} has no backend: its manifest.json has no server block.`);
    uploaded = withBackend(uploaded, backend);
  }
  // An upload with no name given is named after the app it carries.
  const name = input.name.trim() || (uploaded && input.start.kind === 'upload' ? uploadName(uploaded, input.start.file) : '');
  if (!name) throw new Error('Give the app a name.');
  const app = await useAppStore.getState().createApp({
    name,
    description: input.description?.trim() || undefined,
    settings: { softnApp: true },
  });
  if (!app) throw new Error(useAppStore.getState().error || 'Could not create the app. Please try again.');
  const result = uploaded ? await api.saveNativeProject(app.id, uploaded, 0, { how: 'upload' }) : await api.installNativeStarter(app.id);
  if (result.error || !result.data) return { app, project: null, error: result.error || 'The app was created, but its first version could not be installed.' };
  return { app, project: result.data.project };
}
