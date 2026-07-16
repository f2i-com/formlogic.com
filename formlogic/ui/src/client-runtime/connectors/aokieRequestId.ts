import { generateId } from '../../lib/utils';

/** Keep aligned with aokie-plugin's durable `is_journalled_command` list. */
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

/** One plugin-safe request id for one browser-side operator action. */
export function createAokieRequestId(command: string): string | undefined {
  if (!AOKIE_DURABLE_COMMANDS.has(command)) return undefined;
  return `ui-${command}-${generateId()}`;
}
