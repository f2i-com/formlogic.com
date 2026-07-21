import { describe, expect, it } from 'vitest';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { runDesktopOp, type DesktopOpRequest } from './desktopOps';

const OPS_URL = resolveBackendApiUrl('/desktop/ops');

// Remote desktop lifecycle ops over the backend relay: POST /api/desktop/ops then
// poll GET /api/desktop/ops/{id} to a terminal outcome. The module never throws;
// a claimed-but-unreported op at give-up is 'uncertain', never a fake failure.

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(responses: Array<{ status?: number; body?: unknown } | 'throw'>) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === 'throw') throw new Error('network down');
    const status = next.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => next.body,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const immediateSleep = () => Promise.resolve();

function makeClock(stepMs = 2000) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(ms, stepMs);
    },
  };
}

const restartService: DesktopOpRequest = { op: 'desktop.services.restart', serviceId: 'llama-cpp' };

describe('runDesktopOp enqueue', () => {
  it('POSTs the op with credentials and polls the command id to done', async () => {
    const { fetchFn, calls } = stubFetch([
      { body: { data: { commandId: 'cmd-1' } } },
      { body: { data: { status: 'pending' } } },
      { body: { data: { status: 'done', result: { restarted: true } } } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res).toEqual({ ok: true, outcome: { status: 'done', result: { restarted: true }, commandId: 'cmd-1' } });
    expect(calls[0].url).toBe(OPS_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('include');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.op).toBe('desktop.services.restart');
    expect(body.serviceId).toBe('llama-cpp');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(calls[1].url).toBe(`${OPS_URL}/cmd-1`);
    expect(calls[1].init.credentials).toBe('include');
  });

  it('sends the CSRF header on the POST when the cookie is present', async () => {
    (globalThis as { document?: unknown }).document = { cookie: 'formlogic_csrf=csrf%40123' };
    try {
      const { fetchFn, calls } = stubFetch([{ body: { data: { commandId: 'c', status: 'done' } } }]);
      await runDesktopOp({ op: 'desktop.plugins.restart', pluginId: 'aokie' }, { fetchFn, sleep: immediateSleep });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('csrf@123');
      expect(JSON.parse(String(calls[0].init.body)).pluginId).toBe('aokie');
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('surfaces a typed enqueue refusal with its code and status', async () => {
    const { fetchFn } = stubFetch([
      { status: 503, body: { error: true, code: 'desktop_offline', message: 'No desktop is online' } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res).toEqual({
      ok: false,
      error: { code: 'desktop_offline', message: 'No desktop is online', status: 503 },
    });
  });

  it('maps a 401 enqueue to auth_required', async () => {
    const { fetchFn } = stubFetch([{ status: 401, body: { error: true, message: 'Authentication required' } }]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth_required');
  });

  it('retries the enqueue ONCE with the same idempotency key on transport failure', async () => {
    const { fetchFn, calls } = stubFetch(['throw', { body: { data: { commandId: 'cmd-9', status: 'done' } } }]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res.ok).toBe(true);
    const posts = calls.filter((c) => c.url === OPS_URL);
    expect(posts.length).toBe(2);
    expect(JSON.parse(String(posts[0].init.body)).idempotencyKey).toBe(
      JSON.parse(String(posts[1].init.body)).idempotencyKey
    );
  });

  it('fails honestly (never throws) when both enqueue attempts hit transport failure', async () => {
    const { fetchFn } = stubFetch(['throw', 'throw']);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('transport');
      expect(res.error.message).toContain('may or may not have been queued');
    }
  });
});

describe('runDesktopOp poll outcomes', () => {
  it('maps a failed poll to a failed outcome with the server message', async () => {
    const { fetchFn } = stubFetch([
      { body: { data: { commandId: 'cmd-2' } } },
      { body: { data: { status: 'failed', error: 'service failed to start' } } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res).toEqual({
      ok: true,
      outcome: { status: 'failed', result: undefined, error: 'service failed to start', commandId: 'cmd-2' },
    });
  });

  it('maps an expired poll to an expired outcome', async () => {
    const { fetchFn } = stubFetch([
      { body: { data: { commandId: 'cmd-3' } } },
      { body: { data: { status: 'expired' } } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res.ok && res.outcome.status).toBe('expired');
  });

  it('a server-marked uncertain verdict wins over the status word', async () => {
    const { fetchFn } = stubFetch([
      { body: { data: { commandId: 'cmd-4' } } },
      { body: { data: { status: 'expired', uncertain: true, result: { claimedBy: 'DESKTOP-1' } } } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: immediateSleep });

    expect(res).toEqual({
      ok: true,
      outcome: { status: 'uncertain', result: { claimedBy: 'DESKTOP-1' }, commandId: 'cmd-4' },
    });
  });

  it('a CLAIMED op at the give-up is uncertain (the desktop may have acted)', async () => {
    const clock = makeClock();
    const { fetchFn } = stubFetch([
      { body: { data: { commandId: 'cmd-5' } } },
      { body: { data: { status: 'claimed' } } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: clock.sleep, now: clock.now, timeoutMs: 3000 });

    expect(res.ok && res.outcome.status).toBe('uncertain');
  });

  it('a PENDING op at the give-up is expired (no desktop online)', async () => {
    const clock = makeClock();
    const { fetchFn } = stubFetch([
      { body: { data: { commandId: 'cmd-6' } } },
      { body: { data: { status: 'pending' } } },
    ]);

    const res = await runDesktopOp(restartService, { fetchFn, sleep: clock.sleep, now: clock.now, timeoutMs: 3000 });

    expect(res.ok && res.outcome.status).toBe('expired');
  });

  it('keeps polling through transport blips until a terminal status arrives', async () => {
    const { fetchFn } = stubFetch([
      { body: { data: { commandId: 'cmd-7' } } },
      'throw',
      { body: { data: { status: 'done', result: { services: [] } } } },
    ]);

    const res = await runDesktopOp({ op: 'desktop.services.list' }, { fetchFn, sleep: immediateSleep });

    expect(res.ok && res.outcome.status).toBe('done');
    if (res.ok) expect(res.outcome.result).toEqual({ services: [] });
  });
});
