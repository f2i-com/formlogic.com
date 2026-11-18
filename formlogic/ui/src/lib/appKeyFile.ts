// The key file an app brings with its data: the private configuration of the SoftN host it ran on
// (private/config.json). Read in the browser only to say whether it is one, and to offer what it
// holds for the plugin that sends the app's sign-in codes (lib/signInCodes); the server reads it
// again, takes the key (NativeAppService::importedKey), and holds anything else to that plugin's checks.

/** The identity a source bundle declares, when it can be checked before importing a key. */
export function declaredAppId(manifest: string | undefined): string | undefined {
  try {
    const id = manifest && JSON.parse(manifest)?.id;
    return typeof id === 'string' && id ? id : undefined;
  } catch { return undefined; }
}

/** What a chosen key file holds, or why it is not one. */
export async function readKeyFile(file: File, expectedAppId?: string): Promise<{ appId: string | null; config: Record<string, unknown> } | { error: string }> {
  if (file.size > 65536) return { error: 'That key file is too large. Choose the old site’s private/config.json (up to 64 KiB).' };
  try {
    const config = JSON.parse(await file.text()) as Record<string, unknown>;
    if (!config || typeof config.keyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(config.keyHex) || config.keyHex.length !== 64) {
      return { error: 'The key file needs a keyHex value of 64 hexadecimal characters. Choose the old site’s private/config.json.' };
    }
    const domains = config.cryptoDomains as Record<string, unknown> | null;
    const validDomain = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 120 && !/[^\x21-\x7e]/.test(value);
    if (!validDomain(domains?.hmac) || !validDomain(domains?.seal)) return { error: 'The key file must name both cryptoDomains.hmac and cryptoDomains.seal.' };
    const appId = typeof config.appId === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(config.appId) ? config.appId : null;
    if (appId && expectedAppId && appId !== expectedAppId) return { error: `That key belongs to ${appId}. Choose the key file for ${expectedAppId}.` };
    return { appId, config };
  } catch {
    return { error: 'Choose the previous host’s private/config.json configuration file.' };
  }
}
