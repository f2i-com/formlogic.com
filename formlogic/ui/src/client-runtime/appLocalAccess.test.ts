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

describe('someone not signed in', () => {
  it('is asked once for each page, as there is no account to keep the answer under', async () => {
    const theirs = { id: 'app-theirs', slug: 'theirs', name: 'Their shop', manages: false };
    __resetAppLocalAccessForTests();
    setOnScreenApp(theirs);
    const asked: string[] = [];
    subscribeAppAccessRequests((request) => {
      if (request) {
        asked.push(request.app.name);
        request.decide(true);
      }
    });
    expect(await appMayUseThisComputer('theirs')).toBe(true);
    expect(await appMayUseThisComputer('theirs')).toBe(true);
    expect(asked).toEqual(['Their shop']);
  });
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

  // A tab outlives a sign-in. One account's yes must not release a command another account's
  // session was waiting on, nor be kept as that second account's answer about an app.
  describe('a prompt open when the account changes', () => {
    function promptOpen() {
      const shown: Array<AppAccessRequest | null> = [];
      subscribeAppAccessRequests((request) => shown.push(request));
      return shown;
    }

    it('is withdrawn: the prompt closes and the waiting command is refused', async () => {
      setOnScreenApp(theirs);
      const shown = promptOpen();
      const waiting = appMayUseThisComputer();
      expect(shown.at(-1)?.app.name).toBe('Their shop');

      setAppLocalAccessAccount('bob');

      expect(await waiting).toBe(false);
      expect(shown.at(-1)).toBeNull();
    });

    it('takes no late answer, and stores none for the next account', async () => {
      setOnScreenApp(theirs);
      const shown = promptOpen();
      const waiting = appMayUseThisComputer();
      const prompt = shown.at(-1)!;

      setAppLocalAccessAccount('bob');
      prompt.decide(true);

      expect(await waiting).toBe(false);
      expect(listAllowedApps()).toEqual([]);
      setAppLocalAccessAccount('alice');
      expect(listAllowedApps()).toEqual([]);
    });

    it('leaves no answer behind: the next account is asked for itself', async () => {
      setOnScreenApp(theirs);
      const shown = promptOpen();
      const first = appMayUseThisComputer();

      setAppLocalAccessAccount('bob');
      await first;
      const second = appMayUseThisComputer();
      const prompt = shown.at(-1)!;
      expect(prompt.app.name).toBe('Their shop');

      prompt.decide(true);

      expect(await second).toBe(true);
      expect(listAllowedApps()).toEqual([{ id: 'app-theirs', name: 'Their shop' }]);
    });

    it('withdraws every prompt in the line', async () => {
      setOnScreenApp(theirs);
      const shown = promptOpen();
      const one = appMayUseThisComputer();
      setOnScreenApp(mine);
      setOnScreenApp({ ...theirs, id: 'app-other', slug: 'other' });
      const two = appMayUseThisComputer();

      setAppLocalAccessAccount(null);

      expect(await Promise.all([one, two])).toEqual([false, false]);
      expect(shown.at(-1)).toBeNull();
    });
  });

  it('counts one answer once, whatever the prompt does', async () => {
    setOnScreenApp(theirs);
    const first: AppAccessRequest[] = [];
    subscribeAppAccessRequests((request) => { if (request) first.push(request); });
    const one = appMayUseThisComputer();
    setOnScreenApp({ ...theirs, id: 'app-other', slug: 'other', name: 'Other shop' });
    const two = appMayUseThisComputer();

    first[0].decide(true);
    first[0].decide(true); // a double click

    expect(await one).toBe(true);
    expect(first.at(-1)?.app.name).toBe('Other shop');
    first.at(-1)!.decide(false);
    expect(await two).toBe(false);
  });
});

/** Drop the answering listener the way a closed page would, keeping the account's stored answers. */
function __resetListenersOnly(): void {
  const stored = localStorage.getItem('formlogic:app-local-access:v1:alice');
  __resetAppLocalAccessForTests();
  if (stored) localStorage.setItem('formlogic:app-local-access:v1:alice', stored);
  setOnScreenApp(theirs);
}
