// Tests for the OAIY-first routing added to createDesktopBackedConnector.
//
// The connector composes two local runtimes: OAIY Desktop (preferred, the
// successor) and FormLogic Desktop (fallback). These lock in the branch logic:
// prefer OAIY, fall back to FormLogic Desktop ONLY on an OAIY transport failure,
// and NEVER fall back once a real per-command refusal came back — a command that
// reached a runtime and was refused must not be silently retried elsewhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oaiy/oaiyRuntime', () => ({
  oaiyRouteAvailable: vi.fn(() => false),
  oaiyConnectorRequest: vi.fn(),
}));
vi.mock('../desktop/desktopClient', () => ({
  desktopClient: { connectors: { request: vi.fn(), status: vi.fn() } },
}));
vi.mock('../desktop/desktopDetection', () => ({ getDesktopInfo: vi.fn(() => ({ available: false })) }));
vi.mock('../desktop/desktopPairing', () => ({ isDesktopPaired: vi.fn(() => false) }));
vi.mock('./connectorSimulator', () => ({ isSimulatorActive: vi.fn(() => false) }));
vi.mock('../../lib/api', () => ({ api: { isDemoMode: vi.fn(() => false) } }));

import { createDesktopBackedConnector } from './desktopConnector';
import { ConnectorError } from './connectorTypes';
import { oaiyRouteAvailable, oaiyConnectorRequest } from '../oaiy/oaiyRuntime';
import { desktopClient } from '../desktop/desktopClient';
import { getDesktopInfo } from '../desktop/desktopDetection';
import { isDesktopPaired } from '../desktop/desktopPairing';

const manifest = {
  connectorId: 'aokie',
  kind: 'aokie_phone',
  label: 'Aokie',
  commands: ['phone.status', 'sms.send'],
  journalledCommands: ['sms.send'],
};

const oaiyAvailable = vi.mocked(oaiyRouteAvailable);
const oaiyRequest = vi.mocked(oaiyConnectorRequest);
const desktopRequest = vi.mocked(desktopClient.connectors.request);
const desktopInfo = vi.mocked(getDesktopInfo);
const paired = vi.mocked(isDesktopPaired);

beforeEach(() => {
  oaiyAvailable.mockReturnValue(false);
  desktopInfo.mockReturnValue({ available: false } as never);
  paired.mockReturnValue(false);
});
afterEach(() => vi.clearAllMocks());

describe('createDesktopBackedConnector — OAIY-first routing', () => {
  it('routes through OAIY when the OAIY route is available', async () => {
    oaiyAvailable.mockReturnValue(true);
    oaiyRequest.mockResolvedValue({ ok: true, data: { paired: false } });
    const c = createDesktopBackedConnector(manifest as never, null);

    const out = await c.request('phone.status', { x: 1 });

    expect(out).toEqual({ paired: false });
    expect(oaiyRequest).toHaveBeenCalledWith('aokie', 'phone.status', { x: 1 }, undefined);
    // FormLogic Desktop was NOT consulted.
    expect(desktopRequest).not.toHaveBeenCalled();
  });

  it('falls back to FormLogic Desktop when OAIY transport-fails', async () => {
    oaiyAvailable.mockReturnValue(true);
    oaiyRequest.mockResolvedValue({
      ok: false,
      transportFailure: true,
      error: { code: 'connector_unavailable', message: 'OAIY gone' },
    });
    // FormLogic Desktop is up + paired and answers.
    desktopInfo.mockReturnValue({ available: true } as never);
    paired.mockReturnValue(true);
    desktopRequest.mockResolvedValue({ ok: true, data: { via: 'formlogic-desktop' } });
    const c = createDesktopBackedConnector(manifest as never, null);

    const out = await c.request('phone.status');

    expect(out).toEqual({ via: 'formlogic-desktop' });
    expect(oaiyRequest).toHaveBeenCalled();
    expect(desktopRequest).toHaveBeenCalled();
  });

  it('does NOT fall back on a real per-command refusal from OAIY', async () => {
    // A command that reached OAIY and was refused must not be retried on
    // FormLogic Desktop — that could double a side effect.
    oaiyAvailable.mockReturnValue(true);
    oaiyRequest.mockResolvedValue({
      ok: false,
      error: { code: 'capability_denied', message: 'not declared' },
    });
    desktopInfo.mockReturnValue({ available: true } as never);
    paired.mockReturnValue(true);
    const c = createDesktopBackedConnector(manifest as never, null);

    await expect(c.request('phone.status')).rejects.toBeInstanceOf(ConnectorError);
    expect(desktopRequest).not.toHaveBeenCalled();
  });

  it('passes a journalled command idempotencyKey to OAIY', async () => {
    oaiyAvailable.mockReturnValue(true);
    oaiyRequest.mockResolvedValue({ ok: true, data: null });
    const c = createDesktopBackedConnector(manifest as never, null);

    await c.request('sms.send', { to: 'x' });

    // sms.send is journalled → a requestId is minted and passed as idempotencyKey.
    const call = oaiyRequest.mock.calls[0]!;
    expect(call[0]).toBe('aokie');
    expect(call[1]).toBe('sms.send');
    expect(call[3]).toMatchObject({ idempotencyKey: expect.any(String) });
  });

  it('uses FormLogic Desktop when OAIY is not available (unchanged behavior)', async () => {
    oaiyAvailable.mockReturnValue(false);
    desktopInfo.mockReturnValue({ available: true } as never);
    paired.mockReturnValue(true);
    desktopRequest.mockResolvedValue({ ok: true, data: { via: 'formlogic-desktop' } });
    const c = createDesktopBackedConnector(manifest as never, null);

    const out = await c.request('phone.status');

    expect(out).toEqual({ via: 'formlogic-desktop' });
    expect(oaiyRequest).not.toHaveBeenCalled();
  });

  it('fails typed when NEITHER runtime is available', async () => {
    oaiyAvailable.mockReturnValue(false);
    desktopInfo.mockReturnValue({ available: false } as never);
    paired.mockReturnValue(false);
    const c = createDesktopBackedConnector(manifest as never, null);

    await expect(c.request('phone.status')).rejects.toBeInstanceOf(ConnectorError);
    expect(oaiyRequest).not.toHaveBeenCalled();
    expect(desktopRequest).not.toHaveBeenCalled();
  });

  it('status reports available via OAIY when the OAIY route is up', async () => {
    oaiyAvailable.mockReturnValue(true);
    const c = createDesktopBackedConnector(manifest as never, null);
    const s = await c.status();
    expect(s.available).toBe(true);
    expect(s.label).toContain('OAIY Desktop');
  });
});
