// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAppLocalAccessForTests,
  appMayUseThisComputer,
  assertAppMayUseThisComputer,
  forgetAllowedApp,
  forgetAppLocalAccessOf,
  listAllowedApps,
  NOT_ALLOWED_MESSAGE,
  setAppLocalAccessAccount,
  setOnScreenApp,
  subscribeAppAccessRequests,
  type AppAccessRequest,
} from './appLocalAccess';

// An app's flows and screens are its author's code running in the viewer's browser,
// so what that browser can reach (OAIY, the phone behind it, the viewer's AI keys) is
// the viewer's to give, app by app, and never the app's to declare for itself.

const theirs = { id: 'app-theirs', slug: 'theirs', name: 'Their shop', manages: false };
const mine = { id: 'app-mine', slug: 'mine', name: 'My shop', manages: true };

function answering(allowed: boolean) {
  const seen: AppAccessRequest[] = [];
  const stop = subscribeAppAccessRequests((request) => {
    if (!request) return;
    seen.push(request);
    queueMicrotask(() => request.decide(allowed));
  });
  return { seen, stop };
}

beforeEach(() => {
  __resetAppLocalAccessForTests();
  localStorage.clear();
  setAppLocalAccessAccount('alice');
});
afterEach(() => {
  __resetAppLocalAccessForTests();
  vi.restoreAllMocks();
});

describe('appMayUseThisComputer', () => {
  it('asks nothing on the person\'s own pages or in an app they own', async () => {
    const { seen } = answering(false);
    expect(await appMayUseThisComputer()).toBe(true);
    setOnScreenApp(mine);
    expect(await appMayUseThisComputer()).toBe(true);
    expect(await appMayUseThisComputer('mine')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('asks about someone else\'s app, once, and keeps the yes for the account', async () => {
    setOnScreenApp(theirs);
    const { seen } = answering(true);
    expect(await appMayUseThisComputer()).toBe(true);
    expect(await appMayUseThisComputer()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].app.name).toBe('Their shop');
    expect(listAllowedApps()).toEqual([{ id: 'app-theirs', name: 'Their shop' }]);
  });

  it('asks once however many calls arrive together', async () => {
    setOnScreenApp(theirs);
    const { seen } = answering(true);
    expect(await Promise.all([appMayUseThisComputer(), appMayUseThisComputer(), appMayUseThisComputer()])).toEqual([true, true, true]);
    expect(seen).toHaveLength(1);
  });

  it('takes a no for the rest of the page, and does not nag', async () => {
    setOnScreenApp(theirs);
    const { seen } = answering(false);
    expect(await appMayUseThisComputer()).toBe(false);
    expect(await appMayUseThisComputer()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(listAllowedApps()).toEqual([]);
    await expect(assertAppMayUseThisComputer()).rejects.toThrow(NOT_ALLOWED_MESSAGE);
  });

  it('refuses when there is nobody to ask', async () => {
    setOnScreenApp(theirs);
    expect(await appMayUseThisComputer()).toBe(false);
  });

  it('refuses a run of any app but the one on screen', async () => {
    const { seen } = answering(true);
    setOnScreenApp(mine);
    expect(await appMayUseThisComputer('theirs')).toBe(false);
    setOnScreenApp(null);
    expect(await appMayUseThisComputer('mine')).toBe(false);
    expect(seen).toEqual([]);
  });

  it('does not carry one account\'s yes to another', async () => {
    setOnScreenApp(theirs);
    answering(true);
    expect(await appMayUseThisComputer()).toBe(true);

    __resetListenersOnly();
    setAppLocalAccessAccount('bob');
    expect(listAllowedApps()).toEqual([]);
    expect(await appMayUseThisComputer()).toBe(false);

    setAppLocalAccessAccount('alice');
    expect(await appMayUseThisComputer()).toBe(true);
  });

  it('asks again once the yes is taken back in Settings', async () => {
    setOnScreenApp(theirs);
    const { seen } = answering(true);
    await appMayUseThisComputer();
    forgetAllowedApp('app-theirs');
    await appMayUseThisComputer();
    expect(seen).toHaveLength(2);
  });

  it('forgets an account\'s answers when the account is deleted', async () => {
    setOnScreenApp(theirs);
    answering(true);
    await appMayUseThisComputer();
    forgetAppLocalAccessOf('alice');
    expect(listAllowedApps()).toEqual([]);
  });

  it('with no account keeps a yes only for the page', async () => {
    setAppLocalAccessAccount(null);
    setOnScreenApp(theirs);
    const { seen } = answering(true);
    expect(await appMayUseThisComputer()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(Object.keys(localStorage)).toEqual([]);
  });
});

/** Drop the answering listener the way a closed page would, keeping the account's stored answers. */
function __resetListenersOnly(): void {
  const stored = localStorage.getItem('formlogic:app-local-access:v1:alice');
  __resetAppLocalAccessForTests();
  if (stored) localStorage.setItem('formlogic:app-local-access:v1:alice', stored);
  setOnScreenApp(theirs);
}
