// The relay-target picker's prediction of the server's refusal (DesktopFlowRelayController::enqueue),
// per docs/FORMLOGIC_DESKTOP.md §8 "Desktop capability vocabulary": a legacy computer (no tokens)
// takes JavaScript as always; a ZIPP-era computer (any logic-language:* token) takes nothing
// without logic-engine:zipp, and with it the languages its tokens name.
import { describe, expect, it } from 'vitest';
import { capabilitiesEngineDown, capabilitiesRunLanguages } from '../../client-runtime/flows/nodes';
import { relayLanguageBlock, type RemoteComputer } from './remoteComputers';

const JS_ONLY: string[] = [];
const PY = ['python'];
const ENGINE = 'logic-engine:zipp';

describe('capabilitiesRunLanguages — what the server would queue for a computer', () => {
  it('a legacy computer (no tokens) takes JavaScript, never Python', () => {
    expect(capabilitiesRunLanguages([], JS_ONLY)).toBe(true);
    expect(capabilitiesRunLanguages(['relay.flows'], JS_ONLY)).toBe(true);
    expect(capabilitiesRunLanguages([], PY)).toBe(false);
    expect(capabilitiesEngineDown([])).toBe(false);
    // The engine token alone is not a ZIPP-era marker: still legacy.
    expect(capabilitiesRunLanguages([ENGINE], JS_ONLY)).toBe(true);
    expect(capabilitiesRunLanguages([ENGINE], PY)).toBe(false);
  });

  it('a ZIPP-era computer without logic-engine:zipp takes NOTHING, JavaScript included', () => {
    expect(capabilitiesEngineDown(['logic-language:javascript'])).toBe(true);
    expect(capabilitiesRunLanguages(['logic-language:javascript'], JS_ONLY)).toBe(false);
    expect(capabilitiesRunLanguages(['relay.flows', 'logic-language:python'], PY)).toBe(false);
    expect(capabilitiesRunLanguages(['logic-language:javascript', 'logic-language:python'], JS_ONLY)).toBe(false);
  });

  it('a ZIPP-era computer with its engine up takes the languages its tokens name', () => {
    expect(capabilitiesEngineDown(['logic-language:javascript', ENGINE])).toBe(false);
    expect(capabilitiesRunLanguages(['logic-language:javascript', ENGINE], JS_ONLY)).toBe(true);
    expect(capabilitiesRunLanguages(['logic-language:javascript', ENGINE], PY)).toBe(false);
    expect(capabilitiesRunLanguages(['logic-language:python', ENGINE], PY)).toBe(true);
    expect(capabilitiesRunLanguages(['relay.flows', ENGINE, 'logic-language:python'], PY)).toBe(true);
  });
});

describe('relayLanguageBlock — the drawer note before the click', () => {
  const NOW = 1_000_000_000_000;
  const online = new Date(NOW - 5_000).toISOString().replace('T', ' ').slice(0, 19);
  const stale = new Date(NOW - 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const computer = (id: string, name: string, capabilities: string[], lastSeenAt: string = online): RemoteComputer =>
    ({ desktopInstanceId: id, deviceName: name, lastSeenAt, capabilities });

  it('a JavaScript flow is not held while the computers load; a Python one says it is checking', () => {
    expect(relayLanguageBlock(JS_ONLY, null, '', NOW)).toBeNull();
    expect(relayLanguageBlock(PY, null, '', NOW)).toContain('Checking');
  });

  it('the selected computer with its engine down is refused truthfully — not "does not run Python"', () => {
    const list = [computer('home', 'Home PC', ['logic-language:javascript', 'logic-language:python'])];
    const note = relayLanguageBlock(JS_ONLY, list, 'home', NOW);
    expect(note).toContain('Home PC');
    expect(note).toContain('engine is not reporting healthy');
    expect(note).toContain('run the flow in the browser');
    // With Python code too, the engine is still the reason: it runs nothing.
    const py = relayLanguageBlock(PY, list, 'home', NOW);
    expect(py).toContain('engine is not reporting healthy');
    expect(py).not.toContain('does not run');
  });

  it('the selected computer with its engine up takes JavaScript, and Python only when named', () => {
    const list = [computer('home', 'Home PC', ['logic-language:javascript', ENGINE])];
    expect(relayLanguageBlock(JS_ONLY, list, 'home', NOW)).toBeNull();
    expect(relayLanguageBlock(PY, list, 'home', NOW)).toContain('does not run Python');
    expect(relayLanguageBlock(PY, [computer('home', 'Home PC', ['logic-language:python', ENGINE])], 'home', NOW)).toBeNull();
  });

  it('a legacy selected computer takes JavaScript exactly as before', () => {
    expect(relayLanguageBlock(JS_ONLY, [computer('old', 'Old PC', [])], 'old', NOW)).toBeNull();
    expect(relayLanguageBlock(PY, [computer('old', 'Old PC', [])], 'old', NOW)).toContain('does not run Python');
  });

  it('with the server picking the target, the refusal is certain only when every online computer is down', () => {
    const down = computer('a', 'Desk A', ['logic-language:javascript']);
    const healthy = computer('b', 'Desk B', ['logic-language:javascript', ENGINE]);
    const legacy = computer('c', 'Desk C', []);
    expect(relayLanguageBlock(JS_ONLY, [down], '', NOW)).toContain("Desk A's engine is not reporting healthy");
    expect(relayLanguageBlock(JS_ONLY, [down, computer('d', 'Desk D', ['logic-language:python'])], '', NOW)).toContain('None of your online computers');
    expect(relayLanguageBlock(JS_ONLY, [down, healthy], '', NOW)).toBeNull();
    expect(relayLanguageBlock(JS_ONLY, [down, legacy], '', NOW)).toBeNull();
    // A stale computer contributes nothing, whatever its heartbeat said.
    expect(relayLanguageBlock(JS_ONLY, [computer('s', 'Stale', ['logic-language:javascript'], stale)], '', NOW)).toBeNull();
    // Python still needs a healthy computer that names it.
    expect(relayLanguageBlock(PY, [down, healthy], '', NOW)).toContain('none of your online computers runs Python');
    expect(relayLanguageBlock(PY, [down, computer('e', 'Desk E', ['logic-language:python', ENGINE])], '', NOW)).toBeNull();
  });
});
