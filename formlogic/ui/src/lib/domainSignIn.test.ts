// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exchange = vi.fn();
vi.mock('./api', () => ({ api: { exchangeAppDomainCode: (code: string) => exchange(code) } }));

import { finishDomainSignIn, startDomainSignIn } from './domainSignIn';

const KEY = 'formlogic:domain-sign-in';
const assign = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  exchange.mockReset().mockResolvedValue({ data: { user: { id: 'member-1' } } });
  assign.mockReset();
  vi.stubGlobal('location', { origin: 'https://shop.acme.com', assign });
});

afterEach(() => vi.unstubAllGlobals());

/** The address startDomainSignIn left for, and the state it holds for the way back. */
function setOut(page: 'login' | 'signup', returnTo: string) {
  startDomainSignIn('https://forms.example', page, returnTo);
  return new URL(assign.mock.calls[0][0] as string);
}

describe('leaving for FormLogic', () => {
  it('names this site and the page, and carries no secret of its own', () => {
    const url = setOut('signup', '/orders?open=1');
    expect(`${url.origin}${url.pathname}`).toBe('https://forms.example/sign-in/domain');
    expect(url.searchParams.get('origin')).toBe('https://shop.acme.com');
    expect(url.searchParams.get('page')).toBe('signup');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(url.search).not.toContain('orders');
  });

  it('never reuses a state', () => {
    const first = setOut('login', '/').searchParams.get('state');
    assign.mockClear();
    expect(setOut('login', '/').searchParams.get('state')).not.toBe(first);
  });
});

describe('coming back', () => {
  it('spends the code, and goes where the visitor was', async () => {
    const state = setOut('login', '/orders?open=1').searchParams.get('state');
    await expect(finishDomainSignIn('the-code', state)).resolves.toBe('/orders?open=1');
    expect(exchange).toHaveBeenCalledWith('the-code');
  });

  it('refuses a code this tab did not set out for', async () => {
    // A link with someone else's code would sign whoever opened it in as that someone.
    await expect(finishDomainSignIn('their-code', 'their-state')).resolves.toBeNull();
    setOut('login', '/');
    await expect(finishDomainSignIn('their-code', 'their-state')).resolves.toBeNull();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('uses a state once', async () => {
    const state = setOut('login', '/').searchParams.get('state');
    await finishDomainSignIn('the-code', state);
    await expect(finishDomainSignIn('the-code', state)).resolves.toBeNull();
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('needs a code and a state', async () => {
    const state = setOut('login', '/').searchParams.get('state');
    await expect(finishDomainSignIn(null, state)).resolves.toBeNull();
    await expect(finishDomainSignIn('the-code', null)).resolves.toBeNull();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('says so when the server refuses the code', async () => {
    const state = setOut('login', '/').searchParams.get('state');
    exchange.mockResolvedValue({ error: 'This sign-in has expired. Please try again.' });
    await expect(finishDomainSignIn('the-code', state)).resolves.toBeNull();
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'orders'])('stays on this site with %s stored', async returnTo => {
    sessionStorage.setItem(KEY, JSON.stringify({ state: 'abc', returnTo }));
    await expect(finishDomainSignIn('the-code', 'abc')).resolves.toBe('/');
  });
});
