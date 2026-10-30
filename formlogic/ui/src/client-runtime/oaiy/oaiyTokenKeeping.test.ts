// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOaiyBaseUrlForTests,
  __setOaiyBaseUrlForTests,
  forgetOaiyTokenOf,
  getOaiyToken,
  isOaiyPaired,
  listOaiyPlugins,
  oaiyConnectorRequest,
  restartOaiyPlugin,
  setOaiyToken,
  setOaiyTokenAccount,
  startOaiyPlugin,
  subscribeOaiyPaired,
} from './oaiyRuntime';
import { oaiyAiChat } from './oaiyAi';

// Pairing means a code and a click in OAIY's window, and OAIY keeps the grant, so
// FormLogic must keep its copy: a new tab or a restarted browser reconnects by
// itself. What that must not do is hand one person's desktop to another, so the
// token belongs to an account, and one OAIY has stopped honouring is let go.

const BASE = 'http://127.0.0.1:19995';

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** What a new tab, or a browser opened again, starts with. */
const openNewTab = () => sessionStorage.clear();

beforeEach(() => {
  __setOaiyBaseUrlForTests(BASE);
  localStorage.clear();
  sessionStorage.clear();
  setOaiyTokenAccount(null);
});
afterEach(() => {
  setOaiyTokenAccount(null);
  __resetOaiyBaseUrlForTests();
  vi.unstubAllGlobals();
});

describe('a token kept for an account', () => {
  it('survives a new tab, so nobody is asked for a code again', () => {
    setOaiyTokenAccount('alice');
    setOaiyToken('alice-token');
    openNewTab();
    expect(getOaiyToken()).toBe('alice-token');
    expect(isOaiyPaired()).toBe(true);
  });

  it('is out of reach of whoever signs in next, and back when its owner does', () => {
    setOaiyTokenAccount('alice');
    setOaiyToken('alice-token');

    setOaiyTokenAccount(null);
    expect(getOaiyToken()).toBeNull();

    setOaiyTokenAccount('bob');
    expect(getOaiyToken()).toBeNull();
    setOaiyToken('bob-token');

    setOaiyTokenAccount('alice');
    expect(getOaiyToken()).toBe('alice-token');
  });

  it('with no account lasts for the tab and is never written to localStorage', () => {
    setOaiyToken('nobody-token');
    expect(getOaiyToken()).toBe('nobody-token');
    expect(Object.keys(localStorage)).toEqual([]);
    openNewTab();
    expect(getOaiyToken()).toBeNull();
  });

  it('is what a disconnect forgets, leaving another account\'s alone', () => {
    setOaiyTokenAccount('bob');
    setOaiyToken('bob-token');
    setOaiyTokenAccount('alice');
    setOaiyToken('alice-token');

    setOaiyToken(null);
    expect(getOaiyToken()).toBeNull();
    setOaiyTokenAccount('bob');
    expect(getOaiyToken()).toBe('bob-token');
  });

  it('is erased with its account, whoever is signed in', () => {
    setOaiyTokenAccount('alice');
    setOaiyToken('alice-token');
    setOaiyTokenAccount(null);
    forgetOaiyTokenOf('alice');
    setOaiyTokenAccount('alice');
    expect(getOaiyToken()).toBeNull();
  });

  it('is told to the other tabs, which do not write it themselves', () => {
    setOaiyTokenAccount('alice');
    const seen: boolean[] = [];
    const stop = subscribeOaiyPaired((paired) => seen.push(paired));
    localStorage.setItem(`oaiy.token:${BASE}:alice`, 'from-another-tab');
    window.dispatchEvent(new StorageEvent('storage', { key: `oaiy.token:${BASE}:alice` }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    stop();
    expect(seen).toEqual([true]);
  });

  it('moves in from the old tab-only place, so a tab open across an update stays connected', () => {
    sessionStorage.setItem(`oaiy.token:${BASE}`, 'from-before');
    setOaiyTokenAccount('alice');
    expect(getOaiyToken()).toBe('from-before');
    setOaiyToken('from-before');
    expect(sessionStorage.getItem(`oaiy.token:${BASE}`)).toBeNull();
    openNewTab();
    expect(getOaiyToken()).toBe('from-before');
  });
});

describe('a token OAIY no longer honours', () => {
  beforeEach(() => {
    setOaiyTokenAccount('alice');
    setOaiyToken('revoked');
  });

  it('goes when the guard refuses a command, so the control stops saying connected', async () => {
    answer(403, { error: 'origin not allowed' });
    const res = await oaiyConnectorRequest('aokie', 'phone.status');
    expect(res.ok).toBe(false);
    expect(isOaiyPaired()).toBe(false);
  });

  it('goes when the guard refuses a listing, a lifecycle action or a chat', async () => {
    answer(403, { error: 'origin not allowed' });
    expect(await listOaiyPlugins()).toBeNull();
    expect(isOaiyPaired()).toBe(false);

    setOaiyToken('revoked');
    answer(401, { error: 'authentication required' });
    expect((await startOaiyPlugin('aokie')).ok).toBe(false);
    expect(isOaiyPaired()).toBe(false);

    setOaiyToken('revoked');
    answer(403, { error: 'origin not allowed' });
    expect((await oaiyAiChat('p', {})).ok).toBe(false);
    expect(isOaiyPaired()).toBe(false);
  });

  it('stays when a route refuses a command: that says nothing about the token', async () => {
    answer(403, { error: { code: 'capability_denied', message: 'not declared' } });
    await oaiyConnectorRequest('aokie', 'phone.undeclared');
    expect(getOaiyToken()).toBe('revoked');

    answer(400, { error: 'plugin is not running' });
    const res = await startOaiyPlugin('aokie');
    expect(res).toEqual({ ok: false, error: 'plugin is not running' });
    expect(getOaiyToken()).toBe('revoked');
  });

  it('stays through OAIY being closed: it reconnects when OAIY is back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await listOaiyPlugins()).toBeNull();
    expect((await startOaiyPlugin('aokie')).ok).toBe(false);
    expect(getOaiyToken()).toBe('revoked');
  });
});

describe('restarting a plugin', () => {
  it('is a stop and a start, as OAIY has no route for it', async () => {
    setOaiyToken('t');
    const fetchMock = answer(200, { ok: true });
    expect(await restartOaiyPlugin('a/b')).toEqual({ ok: true });
    expect((fetchMock.mock.calls as unknown as string[][]).map(([url]) => url)).toEqual([
      `${BASE}/api/plugins/a%2Fb/stop`,
      `${BASE}/api/plugins/a%2Fb/start`,
    ]);
  });
});
