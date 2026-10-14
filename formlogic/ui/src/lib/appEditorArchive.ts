import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/** Older hosted manifests omit the file inventory required by the visual editor. */
export function editorBundle(bundle: Uint8Array): Uint8Array {
  const files = unzipSync(bundle);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const client = Object.keys(files).filter(path => !/^(server|backend|private)\//i.test(path));
  const inventory = {
    ui: client.filter(path => path.endsWith('.ui')),
    logic: client.filter(path => /\.(logic|py)$/.test(path)),
    assets: client.filter(path => path.startsWith('assets/')),
    xdb: client.filter(path => path.endsWith('.xdb')),
  };
  manifest.files = { ...manifest.files };
  for (const [group, paths] of Object.entries(inventory)) {
    // An explicit logic list chooses what runs. Adding an unreferenced example
    // can switch languages or compose JavaScript and Python into one entry.
    if (group === 'logic' && Array.isArray(manifest.files.logic)) continue;
    manifest.files[group] = [...new Set([...(Array.isArray(manifest.files[group]) ? manifest.files[group] : []), ...paths])];
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files);
}
