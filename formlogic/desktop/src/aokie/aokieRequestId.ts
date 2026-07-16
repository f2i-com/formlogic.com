/**
 * Aokie commands that can perform an observable phone/radio action. The
 * plugin journals these commands durably and deliberately refuses one that
 * has no requestId. Keep this list aligned with aokie-plugin's
 * `is_journalled_command` contract.
 */
const AOKIE_DURABLE_COMMANDS: ReadonlySet<string> = new Set([
  'phone.startPairing',
  'phone.stopPairing',
  'phone.removePaired',
  'phone.disconnect',
  'phone.connect',
  'phone.confirmPairing',
  'call.activate',
  'call.answer',
  'call.reject',
  'call.hangup',
  'call.operatorSpeak',
  'call.configureAgent',
  'call.dial',
  'sms.send',
]);

type RequestIdGenerator = () => string;

const defaultGenerator: RequestIdGenerator = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Tauri's WebView supplies randomUUID. This fallback keeps local development
  // and older WebViews functional while retaining only plugin-safe characters.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Preserve an explicit id across a caller-managed retry. Otherwise mint one
 * id for this API invocation (one operator action); the HTTP request serializes
 * it once, so transport handling cannot accidentally change it mid-flight.
 */
export function aokieCommandRequestId(
  pluginId: string,
  command: string,
  supplied?: string,
  generate: RequestIdGenerator = defaultGenerator,
): string | undefined {
  if (supplied !== undefined) return supplied;
  if (pluginId !== 'aokie' || !AOKIE_DURABLE_COMMANDS.has(command)) return undefined;
  const commandTag = command.replaceAll('.', '-');
  return `desktop-${commandTag}-${generate()}`;
}
