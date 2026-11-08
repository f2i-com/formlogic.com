// The key file an app brings with its data: the private configuration of the SoftN host it ran on
// (private/config.json). Read in the browser only to offer what it holds (its Twilio Verify
// details); the server reads it again and takes only the key (NativeAppService::importedKey).

/** What a chosen key file says about itself, or why it is not one. */
export async function readKeyFile(file: File): Promise<{ twilio: boolean; appId: string | null } | { error: string }> {
  try {
    const config = JSON.parse(await file.text()) as Record<string, unknown>;
    if (!config || typeof config !== 'object' || typeof config.keyHex !== 'string') return { error: 'That file holds no key. Choose the old site\'s private/config.json.' };
    const sms = (config.sms ?? {}) as Record<string, unknown>;
    const twilio = typeof sms.TWILIO_SID === 'string' && sms.TWILIO_SID !== '' && typeof sms.TWILIO_TOKEN === 'string' && sms.TWILIO_TOKEN !== '' && typeof sms.TWILIO_VERIFY_SERVICE_SID === 'string' && sms.TWILIO_VERIFY_SERVICE_SID !== '';
    return { twilio, appId: typeof config.appId === 'string' ? config.appId : null };
  } catch {
    return { error: 'That file is not the JSON configuration a SoftN host keeps (private/config.json).' };
  }
}
