// Device Setup: "Reset the dongle" (connector dongle.reset - a software reset,
// no unplugging) and the offline OAIY card. The reset must read every answer
// Aokie can give: done (phone back or not yet), refused during a call, and an
// older plugin's unknown-command error, which asks for an update instead of
// failing. Runs the COMPILED screen against a mocked window.FormLogic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AOKIE_DEVICE_SETUP_SCREEN } from './deviceSetupScreen';
import { resetOutcome } from './device-setup/format';
import { flushScreen as flush, runScreen, setupScreenTestEsbuild, teardownScreenTestEsbuild } from '../../aokieScreenTestHarness';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

type Outcome = { status: string; result?: unknown; error?: unknown };

function mock(opts: {
  reset?: Outcome;
  can?: (perm: string) => boolean;
  presence?: Record<string, unknown>;
  connections?: Array<Record<string, unknown>>;
  sent?: string[];
}): Record<string, unknown> {
  const sent = opts.sent ?? [];
  return {
    currentUser: () => Promise.resolve({ id: 'u1', name: 'Owner', email: 'owner@example.com' }),
    can: (perm: string) => Promise.resolve(opts.can ? opts.can(perm) : true),
    presence: () => Promise.resolve(opts.presence ?? { kind: 'local' }),
    connector: (_id: string, command: string) => {
      sent.push(command);
      if (opts.presence && opts.presence.kind === 'none') {
        return Promise.resolve({ status: 'failed', error: { code: 'connector_unavailable', message: 'no desktop' } });
      }
      if (command === 'dongle.reset') return Promise.resolve(opts.reset ?? { status: 'done', result: { accepted: true, via: 'software', phoneReconnected: true } });
      if (command === 'dongle.list') {
        return Promise.resolve({ status: 'done', result: { connected: [{ vid: 2578, pid: 33, vidHex: '0a12', pidHex: '0021', description: 'CSR dongle', driverBound: true, matchesCatalog: true }] } });
      }
      if (command === 'phone.listPaired') return Promise.resolve({ status: 'done', result: { devices: [] } });
      return Promise.resolve({ status: 'done', result: {} });
    },
    service: (op: string) => {
      if (op === 'desktop.connections.list') return Promise.resolve({ status: 'done', result: { connections: opts.connections ?? [] } });
      return Promise.resolve({ status: 'failed', error: { message: 'not allowed' } });
    },
    records: () => Promise.resolve([]),
    deleteRecords: () => Promise.resolve({ deleted: [], failed: [] }),
    host: { ceremony: () => Promise.resolve({ status: 'done' }) },
  };
}

async function pressReset(fl: Record<string, unknown>) {
  const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, fl);
  await flush();
  const btn = root.querySelector('[data-act="reset-dongle"]') as HTMLButtonElement;
  expect(btn?.textContent).toBe('Reset the dongle');
  btn.click();
  await flush(40);
  return root;
}

describe('Reset the dongle', () => {
  it('sends dongle.reset with an empty payload and reports the phone reconnecting', async () => {
    const sent: string[] = [];
    const root = await pressReset(mock({ sent }));
    expect(sent).toContain('dongle.reset');
    expect(root.querySelector('[data-reset-note="ok"]')?.textContent).toContain('reset in software and the phone reconnected');
    // The inventory is re-read after a reset.
    expect(sent.filter((c) => c === 'dongle.list').length).toBe(2);
  });

  it('says so when the phone has not reconnected yet', async () => {
    const root = await pressReset(mock({ reset: { status: 'done', result: { accepted: true, via: 'software', phoneReconnected: false } } }));
    expect(root.querySelector('[data-reset-note="warn"]')?.textContent).toContain('has not reconnected yet');
  });

  it('during a call: the plugin refusal becomes "after it ends"', async () => {
    const root = await pressReset(mock({
      reset: { status: 'failed', error: { code: 'command_failed', message: 'a call is in progress: reset the dongle after it ends' } },
    }));
    expect(root.querySelector('[data-reset-note="warn"]')?.textContent).toBe('A call is in progress: reset the dongle after it ends.');
  });

  it('an older plugin: unknown command asks for an Aokie update, never an error banner', async () => {
    const sent: string[] = [];
    const root = await pressReset(mock({ sent, reset: { status: 'failed', error: { code: 'command_failed', message: 'unknown command: dongle.reset' } } }));
    const note = root.querySelector('[data-reset-note="update"]')?.textContent ?? '';
    expect(note).toContain('Update Aokie in OAIY > Plugins');
    expect(note).toContain('unplug the dongle');
    expect(root.querySelector('#banner')).toBeNull();
    expect(sent.filter((c) => c === 'dongle.list').length).toBe(1);
  });

  it('without the dongle.reset grant there is no button, only the manual way', async () => {
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mock({ can: (perm) => perm !== 'connector.aokie.dongle.reset' }));
    await flush();
    expect(root.querySelector('[data-act="reset-dongle"]')).toBeNull();
    expect(root.querySelector('[data-reset-unavailable]')?.textContent).toContain('Unplug the dongle');
  });

  it('classifies every answer (unit)', () => {
    expect(resetOutcome({ status: 'failed', error: { code: 'unknown_command', message: '' } }).needsUpdate).toBe(true);
    expect(resetOutcome({ status: 'failed', error: { code: 'command_not_declared', message: 'x' } }).needsUpdate).toBe(true);
    expect(resetOutcome({ status: 'failed', error: { code: 'connector_unavailable', message: 'no desktop' } }).text).toContain("can't be reached");
    expect(resetOutcome({ status: 'expired' }).text).toContain('within a minute');
    expect(resetOutcome({ status: 'uncertain' }).tone).toBe('warn');
    expect(resetOutcome({ status: 'done', result: { accepted: false } }).tone).toBe('bad');
    expect(resetOutcome({ status: 'failed', error: { code: 'command_failed', message: 'USB busy' } }).text).toBe('The dongle was not reset: USB busy');
  });
});

describe('OAIY offline on Device Setup', () => {
  it('says when the linked OAIY was last seen and what it keeps doing', async () => {
    const lastSeen = new Date(Date.now() - 20 * 60000).toISOString();
    const { root } = await runScreen(AOKIE_DEVICE_SETUP_SCREEN, mock({
      presence: { kind: 'none' },
      connections: [{ deviceName: 'FRONT-DESK', lastSeenAt: lastSeen }],
    }));
    await flush();
    expect(root.querySelector('#runtime .pill.warn')?.textContent).toBe('Offline');
    const note = root.querySelector('#runtime [data-offline]')?.textContent ?? '';
    expect(note).toContain('FRONT-DESK was last seen 20 min ago');
    expect(note).toContain('keeps answering calls, lookups and appointment requests');
    // Said once: the hardware cards say they can't be read, the reset waits,
    // and the transport banner is not repeated over the OAIY card.
    expect(root.querySelector('[data-dongle-offline]')).not.toBeNull();
    expect(root.querySelector('[data-phone-offline]')).not.toBeNull();
    expect(root.querySelector('[data-act="reset-dongle"]')).toBeNull();
    expect(root.querySelector('#banner')).toBeNull();
  });
});
