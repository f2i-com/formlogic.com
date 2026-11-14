// The key file an app brings with its data: the private configuration of the SoftN host it ran on
// (private/config.json). Read in the browser only to say whether it is one, and to offer what it
// holds for the plugin that sends the app's sign-in codes (lib/signInCodes); the server reads it
// again, takes the key (NativeAppService::importedKey), and holds anything else to that plugin's checks.

/** What a chosen key file holds, or why it is not one. */
export async function readKeyFile(file: File): Promise<{ appId: string | null; config: Record<string, unknown> } | { error: string }> {
  try {
    const config = JSON.parse(await file.text()) as Record<string, unknown>;
    if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.keyHex !== 'string') return { error: 'That file holds no key. Choose the old site\'s private/config.json.' };
    return { appId: typeof config.appId === 'string' ? config.appId : null, config };
  } catch {
    return { error: 'That file is not the JSON configuration a SoftN host keeps (private/config.json).' };
  }
}
