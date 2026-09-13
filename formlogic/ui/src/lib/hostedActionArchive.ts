import { strFromU8 } from 'fflate';
import type { HostedPackage } from './hosting';

export function hasHostedActions(files: Record<string, Uint8Array>): boolean {
  try {
    const config = JSON.parse(strFromU8(files['formlogic.json']));
    return config.formatVersion === 1 && config.storage === 'formlogic-forms-sqlite' && config.actions !== null && typeof config.actions === 'object' && !Array.isArray(config.actions);
  } catch { return false; }
}

/** Decode named FormLogic actions without putting private source in the client file map. */
export function hostedPackageFromArchive(files: Record<string, Uint8Array>): HostedPackage {
  if (!hasHostedActions(files)) throw new Error('Missing named backend action configuration.');
  const config = JSON.parse(strFromU8(files['formlogic.json']));
  const actions: HostedPackage['actions'] = {};
  const sources = new Set<string>();
  if (Object.keys(config.actions).length > 30) throw new Error('A project can contain up to 30 backend actions.');
  for (const [name, value] of Object.entries(config.actions)) {
    const action = value as { file?: string; access?: string; mode?: string } | null;
    if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) || !action || typeof action.file !== 'string'
      || !/^server\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.logic$/.test(action.file)
      || !files[action.file] || files[action.file].length > 50000
      || !['owner', 'member'].includes(action.access ?? '') || !['read', 'write'].includes(action.mode ?? '')) throw new Error(`Invalid backend action: ${name}`);
    sources.add(action.file);
    actions[name] = { source: strFromU8(files[action.file]), access: action.access as 'owner' | 'member', mode: action.mode as 'read' | 'write' };
  }
  const client: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (path === 'formlogic.json' || sources.has(path) || /^(README|LICENSE|NOTICE)(\.|$)/i.test(path)) continue;
    if (/^(server|backend|private)\//i.test(path)) throw new Error('Undeclared private files must be added to the action configuration.');
    if (!/\.(ui|logic|json)$/.test(path)) throw new Error('This project needs native asset hosting.');
    client[path] = strFromU8(bytes);
  }
  return { version: 1, client, actions };
}
