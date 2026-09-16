// Linked computers as the Desktop relay controls see them (RemoteComputerSelect, TestRunDrawer),
// and whether one can take a flow: its engine must be reporting healthy, and it must run every
// language the flow's code is in (formlogic-python/1).
import { capabilitiesEngineDown, capabilitiesRunLanguages } from '../../client-runtime/flows/nodes';
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
 * Why the Desktop relay cannot take this flow, or null when it can — what the server would answer
 * (DesktopFlowRelayController::enqueue, judging each computer's last heartbeat by
 * capabilitiesRunLanguages), said before the click. Two refusals, the engine first because it is
 * the whole truth: a ZIPP-era computer whose engine is not reporting healthy runs nothing,
 * JavaScript included (409 engine_unavailable); and the Desktop that claims a relay run fetches
 * the flow and runs it, and one built before Python runs Python as JavaScript, so a flow with
 * code in another language goes only to a computer advertising 'logic-language:<id>' for it
 * (409 language_unsupported).
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
  const names = languages.map((language) => LANGUAGE_NAMES[language] ?? language).join(' and ');
  // A flow with only JavaScript is not held while the computers load: the server answers for it.
  if (computers === null) return languages.length === 0 ? null : `Checking which of your computers can run this flow's ${names} code…`;
  const runs = (computer: RemoteComputer) => capabilitiesRunLanguages(computer.capabilities ?? [], languages);
  const down = (computer: RemoteComputer) => capabilitiesEngineDown(computer.capabilities ?? []);
  if (selected !== '') {
    const target = computers.find((computer) => computer.desktopInstanceId === selected);
    if (target && down(target)) return engineDownMessage(target.deviceName || 'The selected computer', 'pick another computer, or run the flow in the browser');
    if (languages.length === 0 || (target && runs(target))) return null;
    return `This flow has ${names} code, and ${target?.deviceName || 'the selected computer'} does not run ${names} yet. Update OAIY on it, pick another computer, or run it in the browser.`;
  }
  // The server picks the target (the flow lane's assignment, or the single online computer):
  // only when no online computer could take the flow is the refusal certain.
  const online = computers.filter((computer) => isComputerOnline(computer, now));
  if (online.length > 0 && online.every(down)) {
    return online.length === 1
      ? engineDownMessage(online[0].deviceName || 'Your computer', 'or run the flow in the browser')
      : 'None of your online computers has an engine that is reporting healthy, so none can run flows right now. Check OAIY on them, or run the flow in the browser.';
  }
  if (languages.length === 0 || online.some(runs)) return null;
  return `This flow has ${names} code, and none of your online computers runs ${names} yet. Update OAIY, or run it in the browser.`;
}

/** The truthful reason for an engine-down computer: not "does not run Python" — it runs nothing right now. */
function engineDownMessage(deviceName: string, alternatives: string): string {
  return `${deviceName}'s engine is not reporting healthy, so it cannot run flows right now. Check OAIY on it, ${alternatives}.`;
}
