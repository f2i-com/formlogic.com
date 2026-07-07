// FormLogic Flows — derive the connectors available to a flow's editor context (docs §4).
//
// The context-aware node palette (NodePalette) hides app-specific nodes (e.g. aokie_speak) unless
// an installed app actually provides that connector. An app declares its connector surface as
// `connector.<id>.<command>` grants in its customLogic bundle (app-wide + per-script permissions,
// e.g. the Aokie Receptionist app grants connector.aokie.*). This pure helper reads those grants
// and returns the distinct connectors (+ the commands seen) so the palette + connector_request
// pickers stay data-driven rather than hardcoding connector names.
import type { App } from '../../types/app';
import type { FlowConnectorInfo } from './editor/nodeCatalog';

const CONNECTOR_GRANT = /^connector\.([^.]+)\.(.+)$/;

/**
 * Distinct connectors an app makes available to its flows, derived from its declared
 * `connector.<id>.<command>` grants. `command === '*'` contributes the connector but no command.
 * Returns [] for an app with no customLogic / no connector grants (or a null app).
 */
export function deriveFlowConnectors(app: Pick<App, 'customLogic'> | null | undefined): FlowConnectorInfo[] {
  const bundle = app?.customLogic;
  if (!bundle) return [];

  const grants = new Set<string>();
  for (const p of bundle.permissions ?? []) grants.add(p);
  for (const script of bundle.scripts ?? []) {
    for (const p of script.permissions ?? []) grants.add(p);
  }

  const commandsById = new Map<string, Set<string>>();
  for (const grant of grants) {
    const m = CONNECTOR_GRANT.exec(grant);
    if (!m) continue;
    const [, id, command] = m;
    if (!commandsById.has(id)) commandsById.set(id, new Set());
    if (command !== '*') commandsById.get(id)!.add(command);
  }

  return [...commandsById.entries()]
    .map(([id, cmds]) => ({ id, commands: [...cmds].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
