/**
 * The client engines an embedded Softn app can run on, and how they read to a person.
 *
 * The SERVER decides which one an app actually runs on (backend RuntimeEngineService): the site
 * policy, the owner's code-trust verification and what the installed hosted runtime advertises.
 * Everything here is labelling for the admin and owner settings screens — never authority.
 */

export type ClientEngineId = 'zipp-web-python' | 'zipp-web' | 'host-js';

/** Every id this UI knows, in the order the settings screens list them. */
export const CLIENT_ENGINES: readonly ClientEngineId[] = ['zipp-web-python', 'zipp-web', 'host-js'];

/** The engines that run app code inside the ZIPP VM; only these may be the site default. */
export const ZIPP_ENGINES: readonly ClientEngineId[] = ['zipp-web-python', 'zipp-web'];

/** The universal fallback: it can never be removed from a site's allowed engines. */
export const REQUIRED_ENGINE: ClientEngineId = 'zipp-web-python';

export const ENGINE_LABELS: Record<ClientEngineId, string> = {
  'zipp-web-python': 'ZIPP (JavaScript and Python)',
  'zipp-web': 'ZIPP (JavaScript only)',
  'host-js': 'None (host JavaScript, verified accounts)',
};

export const ENGINE_DESCRIPTIONS: Record<ClientEngineId, string> = {
  'zipp-web-python': 'App code runs inside the ZIPP virtual machine, which can also run Python. This is the safe default.',
  'zipp-web': 'A smaller ZIPP build that runs JavaScript only. Apps with Python logic keep using the full engine.',
  'host-js': 'App code runs as ordinary JavaScript in the sandboxed frame, with no virtual machine around it. Only accounts an administrator has verified for code trust can use this.',
};

export function engineLabel(id: string): string {
  return ENGINE_LABELS[id as ClientEngineId] ?? id;
}

export function isClientEngine(id: string): id is ClientEngineId {
  return (CLIENT_ENGINES as readonly string[]).includes(id);
}

/** Why the engine an app runs on is not the one its owner asked for. */
export function engineReason(reason: string | undefined, effective: string): string | null {
  switch (reason) {
    case 'policy':
      return `This site does not allow that engine, so the app runs on ${engineLabel(effective)}.`;
    case 'unverified':
      return `Host JavaScript needs an administrator to verify this account for code trust, so the app runs on ${engineLabel(effective)}.`;
    case 'not-installed':
      return `That engine is not in the installed runtime yet, so the app runs on ${engineLabel(effective)}.`;
    case 'python-required':
      return 'This app needs Python, which only the full ZIPP engine runs.';
    default:
      return null;
  }
}
