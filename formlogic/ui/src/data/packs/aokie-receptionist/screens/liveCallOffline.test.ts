// Live Call console while a linked OAIY is away: it says plainly that OAIY
// can't be reached and when it was last seen, never offers the scripted demo
// call over a real line, reads the registry once (not every poll), and never
// raises an error for the absence itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AOKIE_LIVE_CALL_SCREEN } from './liveCallScreen';
import { flushScreen as flush, runScreen, setupScreenTestEsbuild, teardownScreenTestEsbuild } from '../../aokieScreenTestHarness';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

function fl(opts: { connections?: Array<Record<string, unknown>> | null; toasts?: string[]; serviceCalls?: string[] }): Record<string, unknown> {
  const toasts = opts.toasts ?? [];
  const serviceCalls = opts.serviceCalls ?? [];
  return {
    presence: () => Promise.resolve({ kind: 'none' }),
    currentUser: () => Promise.resolve(null),
    can: () => Promise.resolve(true),
    connector: () => Promise.resolve({ status: 'failed', error: { code: 'connector_unavailable', message: 'no desktop' } }),
    records: () => Promise.resolve([]),
    queryRecords: () => Promise.resolve([]),
    openRecords: () => Promise.resolve(undefined),
    service: (op: string) => {
      serviceCalls.push(op);
      if (opts.connections === null) return Promise.resolve({ status: 'failed', error: { message: 'forbidden' } });
      return Promise.resolve({ status: 'done', result: { connections: opts.connections ?? [] } });
    },
    toast: {
      success: () => Promise.resolve(undefined),
      error: (m: string) => { toasts.push(m); return Promise.resolve(undefined); },
    },
    host: {
      openScreen: () => Promise.resolve(undefined),
      openRecord: () => Promise.resolve(undefined),
      ceremony: () => Promise.resolve({ status: 'done' }),
    },
    events: { subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve(undefined) }) },
    captions: {
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve(undefined), tombstone: () => Promise.resolve(undefined) }),
    },
  };
}

describe('live call with OAIY offline', () => {
  it('names the linked OAIY and when it was last seen, without the demo call or error toasts', async () => {
    const toasts: string[] = [];
    const serviceCalls: string[] = [];
    const seen = new Date(Date.now() - 7 * 60000).toISOString();
    const { root } = await runScreen(
      AOKIE_LIVE_CALL_SCREEN,
      fl({ connections: [{ deviceName: 'FRONT-DESK', lastSeenAt: seen }], toasts, serviceCalls }),
      { windowGlobals: { __flPollMs: 20 } },
    );
    await flush(150);
    expect(root.querySelector('#presence')?.textContent).toContain('OAIY offline - last seen 7 min ago');
    const card = root.querySelector('[data-offline]')?.textContent ?? '';
    expect(card).toContain("OAIY can't be reached. FRONT-DESK was last seen 7 min ago.");
    expect(card).toContain('keeps answering calls, lookups and appointment requests');
    expect(root.querySelector('[data-act="simulate"]')).toBeNull();
    expect(toasts).toEqual([]);
    // Several polls ran; the registry was read once, at boot.
    expect(serviceCalls.filter((op) => op === 'desktop.connections.list').length).toBe(1);
  });

  it('a member (no registry) keeps the connect-or-demo card', async () => {
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, fl({ connections: null }));
    await flush(60);
    expect(root.querySelector('[data-offline]')).toBeNull();
    expect(root.querySelector('#presence')?.textContent).toContain('OAIY not connected');
    expect(root.querySelector('[data-act="simulate"]')).not.toBeNull();
  });
});
