// Behavioral tests for the pack-owned Device Setup section screen (TSX edition): the screen's
// `files` are bundled with the REAL sandbox pipeline (screenCompile vfs + embedded preact +
// automatic JSX via the native-esbuild test seam) and EXECUTED in a JSDOM document against a
// mocked window.FormLogic - the compiled artifact is exactly what the iframe runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AOKIE_DEVICE_SETUP_SCREEN } from './aokieDeviceSetupScreen';
import { flushScreen as flush, runScreen, setupScreenTestEsbuild, teardownScreenTestEsbuild } from './aokieScreenTestHarness';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

interface ServiceCall { op: string; input: Record<string, unknown> }
interface ConnectorCall { connectorId: string; command: string; payload: Record<string, unknown> }
interface Calls { service: ServiceCall[]; connector: ConnectorCall[]; ceremonies: string[] }

const newCalls = (): Calls => ({ service: [], connector: [], ceremonies: [] });

/** A never-settling read - the screen must hold its Loading state against it. */
const never = () => new Promise<never>(() => { /* pending forever */ });

/** A fully-resolved happy-path FormLogic mock; override per test. */
function mockFormLogic(calls: Calls, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currentUser: () => Promise.resolve({ id: 'u1', name: 'Owner', email: 'owner@example.com' }),
    can: () => Promise.resolve(true),
    presence: () => Promise.resolve({ kind: 'remote', deviceName: 'DESKTOP-HQ', lastSeenAt: '2026-07-18T00:00:00Z' }),
    connector: (connectorId: string, command: string, payload: Record<string, unknown>) => {
      calls.connector.push({ connectorId, command, payload });
      if (command === 'dongle.list') {
        return Promise.resolve({
          status: 'done',
          result: {
            connected: [
              { vid: 2578, pid: 33, vidHex: '0a12', pidHex: '0021', description: 'CSR dongle', driverBound: true, matchesCatalog: true, hardwareId: 'usb-1' },
            ],
          },
        });
      }
      if (command === 'dongle.getPreferred') return Promise.resolve({ status: 'done', result: { preferred: { vid: 2578, pid: 33 } } });
      if (command === 'phone.listPaired') {
        return Promise.resolve({ status: 'done', result: { devices: [{ address: '04:C8:B0:00:00:01', name: 'Pixel 9', connected: true }] } });
      }
      return Promise.resolve({ status: 'done', result: {} });
    },
    service: (op: string, input: Record<string, unknown>) => {
      calls.service.push({ op, input });
      if (op === 'desktop.connections.list') {
        return Promise.resolve({ status: 'done', result: { connections: [{ deviceName: 'DESKTOP-HQ', lastSeenAt: '2026-07-18T00:00:00Z' }] } });
      }
      if (op === 'aokie.companion.policy.get') {
        return Promise.resolve({
          status: 'done',
          result: { configured: true, remoteMonitoring: true, remoteConsult: false, remoteTakeover: false, remoteCaptions: true, remoteAssistance: false },
        });
      }
      if (op === 'aokie.companion.devices.list') {
        return Promise.resolve({
          status: 'done',
          result: {
            devices: [
              { id: 'dev-live', displayName: 'Front desk tablet', role: 'monitor', lastSeenAt: '2026-07-18T00:00:00Z' },
              { id: 'dev-old', displayName: 'Old phone', role: 'monitor', revokedAt: '2026-07-01T00:00:00Z' },
            ],
          },
        });
      }
      if (op === 'aokie.companion.devices.revoke' || op === 'aokie.companion.devices.approve' || op === 'aokie.companion.policy.update') {
        return Promise.resolve({ status: 'done', result: {} });
      }
      return Promise.resolve({ status: 'failed', error: { message: 'unknown op ' + op } });
    },
    records: () => Promise.resolve([
      {
        id: 'ev1',
        answers: { event_name: 'dongle.error', message: 'USB wedge detected', severity: 'error', occurred_at: '2026-07-17 23:00:00' },
        submittedAt: '2026-07-17T23:00:05Z',
      },
    ]),
    deleteRecords: (ids: string[]) => Promise.resolve({ deleted: ids, failed: [] }),
    host: {
      ceremony: (name: string) => {
        calls.ceremonies.push(name);
        return Promise.resolve({ status: 'done', deleted: 0 });
      },
    },
    ...overrides,
  };
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('button')];
const buttonByText = (root: HTMLElement, text: string) => buttons(root).find((b) => b.textContent === text);

describe('device setup section screen (TSX)', () => {
  it('paints every card in a Loading state before any read resolves - nothing sits blank', async () => {
    const calls = newCalls();
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls, {
      presence: never,
      connector: never,
      service: never,
      records: never,
    }));
    await flush();
    for (const id of ['#dongles', '#phones', '#companion', '#events']) {
      expect(root.querySelector(id)?.textContent, id).toContain('Loading...');
    }
    // The desktop card holds its skeleton probe instead of an empty box.
    expect(root.querySelector('#runtime .skeleton')).not.toBeNull();
    // Headings are already up, so the operator sees the card structure.
    expect(root.querySelector('#dongles h2')?.textContent).toBe('Bluetooth dongles');
    expect(root.querySelector('#fresh h2')?.textContent).toBe('Start fresh');
  });

  it('renders desktop connections, dongles, phones, policy and endpoints from the mocked reads', async () => {
    const calls = newCalls();
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls));
    await flush();

    // Remote presence pill + the owner's linked-desktop registry.
    expect(root.querySelector('#runtime .pill.accent')?.textContent).toBe('Running on DESKTOP-HQ');
    expect(root.querySelector('#runtime')?.textContent).toContain('Linked desktops');
    expect(root.querySelector('#runtime')?.textContent).toContain('relayed to that machine');

    // Dongle table row: hex usb id, driver + preferred + supported pills, no action buttons.
    const dongles = root.querySelector('#dongles');
    expect(dongles?.textContent).toContain('CSR dongle');
    expect(dongles?.textContent).toContain('0a12:0021');
    expect(dongles?.querySelector('.pill.ok')?.textContent).toBe('supported');
    expect(dongles?.textContent).toContain('preferred');
    expect(dongles?.textContent).toContain('Installed');
    expect(buttonByText(dongles as HTMLElement, 'Install driver')).toBeUndefined();
    expect(buttonByText(dongles as HTMLElement, 'Set preferred')).toBeUndefined();

    // Paired phone row with the Disconnect affordance.
    const phones = root.querySelector('#phones');
    expect(phones?.textContent).toContain('Pixel 9');
    expect(phones?.textContent).toContain('04:C8:B0:00:00:01');
    expect(phones?.querySelector('.pill.ok')?.textContent).toBe('Connected');
    expect(buttonByText(phones as HTMLElement, 'Disconnect')).toBeDefined();

    // Companion policy checkboxes mirror the served policy.
    const monitoring = root.querySelector<HTMLInputElement>('input[data-policy="remoteMonitoring"]');
    const consult = root.querySelector<HTMLInputElement>('input[data-policy="remoteConsult"]');
    expect(monitoring?.checked).toBe(true);
    expect(consult?.checked).toBe(false);
    expect(buttonByText(root, 'Save policy')).toBeDefined();

    // Endpoint rows: active device offers Revoke, revoked device offers Approve again.
    const companion = root.querySelector('#companion');
    expect(companion?.textContent).toContain('Front desk tablet');
    expect(companion?.textContent).toContain('Old phone');
    expect(companion?.textContent).toContain('Active');
    expect(companion?.textContent).toContain('Revoked');
    expect(buttonByText(companion as HTMLElement, 'Revoke')).toBeDefined();
    expect(buttonByText(companion as HTMLElement, 'Approve again')).toBeDefined();

    // Hardware event row: name + message + severity pill + per-row timestamp tooltip.
    const events = root.querySelector('#events');
    expect(events?.textContent).toContain('dongle.error');
    expect(events?.textContent).toContain('USB wedge detected');
    expect(events?.querySelector('.pill.bad')?.textContent).toBe('error');
    expect(events?.querySelector('.faint[title]')).not.toBeNull();
  });

  it('revoke is double-gated and approve/save-policy call the exact service ops', async () => {
    const calls = newCalls();
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls));
    await flush();

    // Revoke: ask first, the op fires only on Confirm revoke.
    buttonByText(root, 'Revoke')!.click();
    await flush();
    expect(calls.service.some((c) => c.op === 'aokie.companion.devices.revoke')).toBe(false);
    buttonByText(root, 'Confirm revoke')!.click();
    await flush();
    expect(calls.service.filter((c) => c.op === 'aokie.companion.devices.revoke')).toEqual([
      { op: 'aokie.companion.devices.revoke', input: { deviceId: 'dev-live' } },
    ]);

    // Approve-again targets the revoked endpoint.
    buttonByText(root, 'Approve again')!.click();
    await flush();
    expect(calls.service.filter((c) => c.op === 'aokie.companion.devices.approve')).toEqual([
      { op: 'aokie.companion.devices.approve', input: { deviceId: 'dev-old' } },
    ]);

    // Toggling a checkbox + Save policy sends the full remoteConsent draft.
    root.querySelector<HTMLInputElement>('input[data-policy="remoteConsult"]')!.click();
    await flush();
    buttonByText(root, 'Save policy')!.click();
    await flush();
    const update = calls.service.find((c) => c.op === 'aokie.companion.policy.update');
    expect(update?.input).toEqual({
      remoteConsent: {
        remoteMonitoring: true,
        remoteConsult: true,
        remoteTakeover: false,
        remoteCaptions: true,
        remoteAssistance: false,
      },
    });
  });

  it('phone controls drive the connector with the bonded address (accepted-only + busy label)', async () => {
    const calls = newCalls();
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls));
    await flush();
    buttonByText(root.querySelector('#phones') as HTMLElement, 'Disconnect')!.click();
    await flush();
    expect(calls.connector.some(
      (c) => c.connectorId === 'aokie' && c.command === 'phone.disconnect'
        && c.payload.address === '04:C8:B0:00:00:01'
    )).toBe(true);
    // The command is accepted-only - the row holds its busy label while the
    // bonded list is polled for the real outcome.
    expect(root.querySelector('#phones')?.textContent).toContain('Disconnecting...');
  });

  it("start-fresh fires the host ceremony ONLY after typing the exact 'delete all' phrase", async () => {
    const calls = newCalls();
    const { root, dom } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls, {
      host: {
        ceremony: (name: string) => {
          calls.ceremonies.push(name);
          return Promise.resolve({ status: 'done', deleted: 7 });
        },
      },
    }));
    await flush();
    const input = root.querySelector<HTMLInputElement>('#fresh-confirm')!;
    const typeConfirm = (value: string) => {
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };

    expect(root.querySelector<HTMLButtonElement>('#fresh-go')!.disabled).toBe(true);

    typeConfirm('delete');
    await flush();
    const goWrong = root.querySelector<HTMLButtonElement>('#fresh-go')!;
    expect(goWrong.disabled).toBe(true);
    goWrong.click();
    await flush();
    expect(calls.ceremonies).toEqual([]);

    // Case/whitespace tolerant, exact phrase required.
    typeConfirm('  Delete ALL ');
    await flush();
    const go = root.querySelector<HTMLButtonElement>('#fresh-go')!;
    expect(go.disabled).toBe(false);
    go.click();
    await flush();
    expect(calls.ceremonies).toEqual(['start-fresh']);
    expect(root.querySelector('#fresh-note')?.textContent).toBe('7 records removed.');
  });

  it('advisory can()=false hides the gated dongle/phone surfaces without touching the connector', async () => {
    const calls = newCalls();
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls, {
      can: () => Promise.resolve(false),
    }));
    await flush();
    expect(root.querySelector('#dongles')?.textContent).toContain('This app has not been granted dongle access.');
    expect(root.querySelector('#phones')?.textContent).toContain('This app has not been granted phone status access.');
    expect(calls.connector.length).toBe(0);
  });

  it('a failed read paints the honest error, never a blank card', async () => {
    // connector_unavailable maps to the friendly reconnect copy in the banner,
    // and the dongles card falls to its explanatory empty state.
    const calls = newCalls();
    const unavailable = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls, {
      presence: () => Promise.resolve({ kind: 'none' }),
      connector: (connectorId: string, command: string, payload: Record<string, unknown>) => {
        calls.connector.push({ connectorId, command, payload });
        if (command === 'phone.listPaired') return Promise.resolve({ status: 'done', result: { devices: [] } });
        return Promise.resolve({ status: 'failed', error: { code: 'connector_unavailable', message: 'no desktop' } });
      },
      service: (op: string, input: Record<string, unknown>) => {
        calls.service.push({ op, input });
        return Promise.resolve({ status: 'failed', error: { message: 'not allowed' } });
      },
    }));
    await flush();
    expect(unavailable.root.querySelector('#banner')?.textContent)
      .toContain('FormLogic Desktop is not reachable right now - connect it above, then press Refresh.');
    expect(unavailable.root.querySelector('#dongles')?.textContent).toContain('No supported dongles detected');
    // The companion admission refusal hides the section honestly.
    expect(unavailable.root.querySelector('#companion')?.textContent)
      .toContain('Your role does not include Companion administration.');

    // A rejected records() read banners its message and leaves the honest empty state.
    const calls2 = newCalls();
    const broken = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mockFormLogic(calls2, {
      records: () => Promise.reject(new Error('events backend down')),
    }));
    await flush();
    expect(broken.root.querySelector('#banner')?.textContent).toBe('events backend down');
    expect(broken.root.querySelector('#events')?.textContent).toContain('No hardware events recorded.');
  });
});
