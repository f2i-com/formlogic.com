// Linked computers as the Desktop relay controls see them (RemoteComputerSelect, TestRunDrawer),
// and whether one can take a flow whose code is in a language other than JavaScript
// (formlogic-python/1).
import { capabilitiesRunLanguages } from '../../client-runtime/flows/nodes';
import { CONNECTION_FRESH_MS, parseDbTimestamp } from '../custom-screen/connector/runtimePresence';

/** A linked computer; `capabilities` are those its last heartbeat sent. */
export type RemoteComputer = { desktopInstanceId: string; deviceName: string; lastSeenAt: string | null; capabilities?: string[] };

/** Whether a computer heartbeated within the freshness window at `now`. */
export function isComputerOnline(computer: RemoteComputer, now: number): boolean {
  const seen = parseDbTimestamp(computer.lastSeenAt);
  return seen !== null && now - seen < CONNECTION_FRESH_MS;
}

const LANGUAGE_NAMES: Record<string, string> = { javascript: 'JavaScript', python: 'Python' };

/**
 * Why the Desktop relay cannot take this flow, or null when it can. The Desktop that claims a
 * relay run fetches the flow and runs it, and one built before Python runs Python as JavaScript,
 * so the server queues such a flow only for a Desktop whose heartbeat advertises
 * 'logic-language:<id>' for each non-JavaScript language (409 language_unsupported otherwise;
 * DesktopFlowRelayController::enqueue). This says so before the click.
 *
 * @param languages the non-JavaScript languages the flow needs
 * @param computers null until the linked computers have loaded
 * @param selected the chosen computer, or '' for the account's assignment
 * @param now when `computers` was loaded (online is judged at that moment)
 */
export function relayLanguageBlock(
  languages: readonly string[],
  computers: readonly RemoteComputer[] | null,
  selected: string,
  now: number,
): string | null {
  if (languages.length === 0) return null;
  const names = languages.map((language) => LANGUAGE_NAMES[language] ?? language).join(' and ');
  if (computers === null) return `Checking which of your computers can run this flow's ${names} code…`;
  const runs = (computer: RemoteComputer) => capabilitiesRunLanguages(computer.capabilities ?? [], languages);
  if (selected !== '') {
    const target = computers.find((computer) => computer.desktopInstanceId === selected);
    if (target && runs(target)) return null;
    return `This flow has ${names} code, and ${target?.deviceName || 'the selected computer'} does not run ${names} yet. Update OAIY on it, pick another computer, or run it in the browser.`;
  }
  if (computers.some((computer) => isComputerOnline(computer, now) && runs(computer))) return null;
  return `This flow has ${names} code, and none of your online computers runs ${names} yet. Update OAIY, or run it in the browser.`;
}
