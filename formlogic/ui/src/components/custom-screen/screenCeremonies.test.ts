// @vitest-environment jsdom
// Device Setup's "Connect OAIY" runs the host's connect-desktop ceremony. With OAIY on
// this computer that must be OAIY's own pairing (a code the user approves in OAIY) -
// OAIY does not serve FormLogic Desktop's pairing-requests route, so the old legacy
// request failed with "Could not reach FormLogic Desktop".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  demo: false,
  oaiyAvailable: true,
  oaiyPaired: false,
  pair: vi.fn(),
  requestPairing: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../lib/api', () => ({ api: { isDemoMode: () => h.demo, registerDesktopConnection: vi.fn() } }));
vi.mock('../../stores/toastStore', () => ({ toast: { info: h.toastInfo, success: h.toastSuccess, warning: vi.fn(), error: vi.fn() } }));
vi.mock('../../client-runtime/oaiy/oaiyRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../client-runtime/oaiy/oaiyRuntime')>()),
  probeOaiy: vi.fn(async () => ({ available: h.oaiyAvailable, baseUrl: 'http://127.0.0.1:17972' })),
  isOaiyPaired: () => h.oaiyPaired,
}));
vi.mock('../../client-runtime/oaiy/oaiyPairing', () => ({ pairWithOaiy: h.pair }));
vi.mock('../../client-runtime/desktop/desktopDetection', () => ({ getDesktopInfo: () => ({ available: false, baseUrl: 'http://127.0.0.1:17872' }) }));
vi.mock('../../client-runtime/desktop/desktopPairing', () => ({
  allowAutoReconnect: vi.fn(),
  isDesktopPaired: () => false,
  pollPairing: vi.fn(),
  requestPairing: h.requestPairing,
}));

import { runConnectDesktop } from './screenCeremonies';

beforeEach(() => {
  h.demo = false;
  h.oaiyAvailable = true;
  h.oaiyPaired = false;
  h.pair.mockReset();
  h.requestPairing.mockReset();
  h.toastInfo.mockReset();
  h.toastSuccess.mockReset();
});

describe('connect-desktop ceremony', () => {
  it('pairs with OAIY on this computer, showing the code to approve there', async () => {
    h.pair.mockImplementation(async (_product: string, _label: string, opts: { onPending?: (h: { pairingId: string; code: string }) => void }) => {
      opts.onPending?.({ pairingId: 'p1', code: 'K7Q2' });
      return { state: 'approved', token: 'tok' };
    });
    const out = await runConnectDesktop();
    expect(out).toEqual({ status: 'done' });
    expect(h.pair).toHaveBeenCalledWith('formlogic', window.location.origin, expect.any(Object));
    expect(h.toastInfo.mock.calls[0][1]).toContain('K7Q2');
    expect(h.requestPairing).not.toHaveBeenCalled();
  });

  it('reports a declined or unfinished pairing honestly', async () => {
    h.pair.mockResolvedValueOnce({ state: 'denied' });
    expect(await runConnectDesktop()).toMatchObject({ status: 'denied' });
    h.pair.mockResolvedValueOnce({ state: 'expired' });
    expect(await runConnectDesktop()).toMatchObject({ status: 'failed' });
    h.pair.mockRejectedValueOnce(new Error('connection refused'));
    expect((await runConnectDesktop()).message).toContain('Could not reach OAIY');
  });

  it('an already-paired browser is simply done', async () => {
    h.oaiyPaired = true;
    expect(await runConnectDesktop()).toMatchObject({ status: 'done' });
    expect(h.pair).not.toHaveBeenCalled();
  });

  it('with nothing running here it says to start OAIY; the demo never pairs', async () => {
    h.oaiyAvailable = false;
    expect(await runConnectDesktop()).toEqual({ status: 'unavailable', message: 'OAIY is not running on this computer. Start it, then try again.' });
    h.demo = true;
    expect((await runConnectDesktop()).status).toBe('unavailable');
    expect(h.pair).not.toHaveBeenCalled();
  });
});
