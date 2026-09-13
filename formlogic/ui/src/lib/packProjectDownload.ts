import { zipSync, strToU8 } from 'fflate';
import { api } from './api';
import type { NativeProject } from './nativeHosting';
import type { HostedPackage } from './hosting';

/** Complete installable pack, plus a separate editable .softn project for every app. No account data. */
export async function downloadPackProjects(slug: string) {
  const [result, detail] = await Promise.all([api.downloadPack(slug), api.getPackDetail(slug)]);
  if (!result.data?.pack) throw new Error(result.error || 'Could not load pack sources.');
  const pack = result.data.pack;
  const entries: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(pack)) };
  const install = structuredClone(pack);
  const projects: Record<string, string> = {};
  const addProject = (id: string, files: Record<string, Uint8Array>) => {
    const name = id.replace(/[^a-zA-Z0-9_-]/g, '-');
    projects[id] = `projects/${name}`;
    for (const [path, bytes] of Object.entries(files)) entries[`projects/${name}/${path}`] = bytes;
    entries[`projects/${name}.softn`] = zipSync(files);
  };
  for (const app of pack.apps ?? []) {
    const native = (app as typeof app & { nativeProject?: NativeProject }).nativeProject;
    if (native) {
      const files = Object.fromEntries(Object.entries(native.files).map(([path, source]) => [path, strToU8(source)]));
      for (const [path, encoded] of Object.entries(native.assets ?? {})) files[path] = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      files['formlogic.json'] = strToU8(JSON.stringify({ formatVersion: 1, hosting: 'native', access: native.access, files: Object.keys(native.files), assets: Object.keys(native.assets ?? {}) }, null, 2));
      addProject(String(app.packAppId), files);
      continue;
    }
    const project = (app as typeof app & { hostedProject?: HostedPackage }).hostedProject;
    if (!project) continue;
    const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(project.client).map(([path, source]) => [path, strToU8(source)]));
    const actions = Object.fromEntries(Object.entries(project.actions).map(([name, action]) => {
      const file = `server/${name}.logic`;
      files[file] = strToU8(action.source);
      return [name, { file, access: action.access, mode: action.mode }];
    }));
    files['formlogic.json'] = strToU8(JSON.stringify({ formatVersion: 1, storage: 'formlogic-forms-sqlite', actions }, null, 2));
    files['README.md'] = strToU8('This app uses its installed FormLogic forms, roles and flows. Install the outer pack ZIP first. Open this .softn in Builder or Studio to edit the interface, or import into FormLogic app hosting to preserve its named backend actions. It does not include records, credentials or an offline backend.');
    addProject(String(app.packAppId), files);
  }
  for (const app of install.apps ?? []) { delete app.hostedProject; delete app.nativeProject; }
  for (const form of install.forms) if (typeof form.logicScript === 'string' && form.logicScript) {
    const file = `server/forms/${String(form.packFormId).replace(/[^a-zA-Z0-9_-]/g, '-')}.logic`;
    entries[file] = strToU8(form.logicScript); form.logicScriptFile = file; delete form.logicScript;
  }
  const info = detail.data?.pack;
  entries['pack.json'] = strToU8(JSON.stringify({ formatVersion: 1, id: pack.packMeta.id || slug, name: info?.name || pack.packMeta.name, version: pack.packMeta.version, description: info?.description || pack.packMeta.description || '', tags: info?.tags || pack.packMeta.tags || [], icon: info?.icon || 'Package', category: info?.category || 'Apps', projects }, null, 2));
  entries['install.json'] = strToU8(JSON.stringify(install, null, 2));
  entries['README.md'] = strToU8('Import this ZIP in FormLogic > Templates > Import to install the complete pack, including forms, SQLite record stores, links, roles, reports, automations and editable app projects. Installing creates a draft; publish and configure member access in App Studio. Aokie hardware and messaging require OAIY setup. Existing installations are not overwritten. Operators can extract this ZIP into backend/storage/pack-projects/<the pack ID>/ and edit pack.json, install.json and the project folders to maintain a live catalogue entry. After editing those folders, use Download app sources again to rebuild the installable ZIP; manifest.json in an old ZIP is a snapshot.');
  const url = URL.createObjectURL(new Blob([Uint8Array.from(zipSync(entries)).buffer], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${slug}-projects.zip`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
