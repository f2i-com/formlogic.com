// Tests for the OAIY-first routing added to createDesktopBackedConnector.
//
// The connector composes two local runtimes: OAIY Desktop (preferred, the
// successor) and FormLogic Desktop (fallback). These lock in the branch logic:
// prefer OAIY and pin the operation there once dispatch is attempted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oaiy/oaiyRuntime', () => ({
  oaiyRouteAvailable: vi.fn(() => false),
  oaiyConnectorAvailable: vi.fn(async () => false),
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
import { __resetAppLocalAccessForTests, setOnScreenApp } from '../appLocalAccess';
import { oaiyRouteAvailable, oaiyConnectorAvailable, oaiyConnectorRequest } from '../oaiy/oaiyRuntime';
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
  vi.mocked(oaiyConnectorAvailable).mockResolvedValue(false);
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

  it('sends nothing to the viewer\'s runtime for an app they have not allowed', async () => {
    oaiyAvailable.mockReturnValue(true);
    setOnScreenApp({ id: 'app-theirs', slug: 'theirs', name: 'Their shop', manages: false });
    const c = createDesktopBackedConnector(manifest as never, null);

    await expect(c.request('sms.send', { to: 'x' })).rejects.toMatchObject({ code: 'capability_denied' });

    expect(oaiyRequest).not.toHaveBeenCalled();
    expect(desktopRequest).not.toHaveBeenCalled();
    __resetAppLocalAccessForTests();
  });

  it('asks nothing in an app the viewer owns', async () => {
    oaiyAvailable.mockReturnValue(true);
    oaiyRequest.mockResolvedValue({ ok: true, data: { sent: true } });
    setOnScreenApp({ id: 'app-mine', slug: 'mine', name: 'My shop', manages: true });
    const c = createDesktopBackedConnector(manifest as never, null);

    expect(await c.request('phone.status')).toEqual({ sent: true });
    __resetAppLocalAccessForTests();
  });

  it('does not replay an uncertain SMS through FormLogic Desktop', async () => {
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

    await expect(c.request('sms.send', { to: 'x' })).rejects.toMatchObject({ code: 'connector_uncertain' });
    expect(oaiyRequest).toHaveBeenCalled();
    expect(desktopRequest).not.toHaveBeenCalled();
  });

  it('passes on FormLogic Desktop\'s uncertain outcome as it stands, typed and worded', async () => {
    desktopInfo.mockReturnValue({ available: true } as never);
    paired.mockReturnValue(true);
    desktopRequest.mockResolvedValue({
      ok: false,
      transportFailure: true,
      error: { code: 'connector_uncertain', message: 'FormLogic Desktop did not respond — the command may have run.' },
    });
    const c = createDesktopBackedConnector(manifest as never, null);

    await expect(c.request('sms.send', { to: 'x' })).rejects.toMatchObject({
      code: 'connector_uncertain',
      message: expect.stringContaining('may have run'),
    });
  });

  // A refresh changes nothing, so a lost answer is just a desktop that can't be reached, and that
  // is what the screen's banner tells people how to fix. "May have run" tells them nothing.
  describe('a read that gets no answer', () => {
    const lost = { ok: false as const, error: { code: 'connector_uncertain' as const, message: 'the command may have run' } };
    const reads = ['dongle.list', 'dongle.getPreferred', 'phone.listPaired', 'phone.status', 'call.current', 'sms.threads', 'sms.thread', 'settings.get'];

    it.each(reads)('says %s could not reach OAIY Desktop', async (command) => {
      oaiyAvailable.mockReturnValue(true);
      oaiyRequest.mockResolvedValue(lost);
      const c = createDesktopBackedConnector(manifest as never, null);

      await expect(c.request(command)).rejects.toMatchObject({ code: 'connector_unavailable', message: expect.not.stringContaining('may have run') });
    });

    it.each(reads)('says %s could not reach FormLogic Desktop', async (command) => {
      desktopInfo.mockReturnValue({ available: true } as never);
      paired.mockReturnValue(true);
      desktopRequest.mockResolvedValue({ ...lost, transportFailure: true });
      const c = createDesktopBackedConnector(manifest as never, null);

      await expect(c.request(command)).rejects.toMatchObject({ code: 'connector_unavailable', message: expect.not.stringContaining('may have run') });
    });

    it('keeps OAIY\'s own refusal of a read as it came', async () => {
      oaiyAvailable.mockReturnValue(true);
      oaiyRequest.mockResolvedValue({ ok: false, error: { code: 'capability_denied', message: 'not declared' } });
      const c = createDesktopBackedConnector(manifest as never, null);

      await expect(c.request('phone.status')).rejects.toMatchObject({ code: 'capability_denied' });
    });

    // A wrong "couldn't reach it" is what invites the second call or SMS.
    it.each(['sms.send', 'call.dial', 'dongle.reset', 'dongle.installDriver', 'dongle.setPreferred', 'settings.set', 'dongle.diagnostics'])('still says %s may have run', async (command) => {
      oaiyAvailable.mockReturnValue(true);
      oaiyRequest.mockResolvedValue(lost);
      const c = createDesktopBackedConnector(manifest as never, null);

      await expect(c.request(command)).rejects.toMatchObject({ code: 'connector_uncertain' });
    });

    it('does not take a journalled command for a read, whatever its name', async () => {
      oaiyAvailable.mockReturnValue(true);
      oaiyRequest.mockResolvedValue(lost);
      const c = createDesktopBackedConnector({ ...manifest, journalledCommands: ['ticket.getNext'] } as never, null);

      await expect(c.request('ticket.getNext')).rejects.toMatchObject({ code: 'connector_uncertain' });
    });
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

  it('pairing alone does not make a missing connector available', async () => {
    oaiyAvailable.mockReturnValue(true);
    const c = createDesktopBackedConnector(manifest as never, null);
    expect((await c.status()).available).toBe(false);
    expect(oaiyConnectorAvailable).toHaveBeenCalledWith('aokie');
  });

  it('status reports available when the connector capability is available', async () => {
    oaiyAvailable.mockReturnValue(true);
    vi.mocked(oaiyConnectorAvailable).mockResolvedValue(true);
    const c = createDesktopBackedConnector(manifest as never, null);
    const s = await c.status();
    expect(s.available).toBe(true);
    expect(s.label).toContain('OAIY Desktop');
  });
});
