// What an app's earlier SoftN host kept for its sign-in codes, in its private/config.json, where the
// plugin that sends this site's codes for the app says such a host keeps each setting (its app
// settings' `importFrom`, AppSignInCodes.imports). Read in the browser only to offer it: the server
// reads the file again (NativePhoneVerification::heldIn) and holds each value to the plugin's checks.

/** The text at a dotted path in a configuration, when there is some. */
function textAt(config: unknown, path: string): string | null {
  let value: unknown = config;
  for (const step of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[step];
  }
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Whether a host configuration holds every setting the plugin takes from one, each where it says. */
export function holdsSignInSettings(config: unknown, imports: Record<string, string>): boolean {
  const paths = Object.values(imports);
  return paths.length > 0 && paths.every((path) => textAt(config, path) !== null);
}
