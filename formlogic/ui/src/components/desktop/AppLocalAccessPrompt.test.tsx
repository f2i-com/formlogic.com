// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAppLocalAccessForTests,
  appMayUseThisComputer,
  listAllowedApps,
  setAppLocalAccessAccount,
  setOnScreenApp,
} from '../../client-runtime/appLocalAccess';
import { AppLocalAccessPrompt } from './AppLocalAccessPrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const dialogButton = (label: string) =>
  [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === label) as HTMLButtonElement;

/** Boxed: an async function that returned the promise itself would wait for the answer. */
async function ask(): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>;
  await act(async () => {
    answer = appMayUseThisComputer();
  });
  return { answer };
}

beforeEach(async () => {
  __resetAppLocalAccessForTests();
  localStorage.clear();
  setAppLocalAccessAccount('alice');
  setOnScreenApp({ id: 'app-theirs', slug: 'theirs', name: 'Their shop', manages: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AppLocalAccessPrompt />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetAppLocalAccessForTests();
});

describe('AppLocalAccessPrompt', () => {
  it('shows nothing until an app asks', () => {
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('names the app and what it would reach, and a yes is kept', async () => {
    const { answer } = await ask();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Let Their shop use this computer?');
    expect(text).toContain('your plugins, such as your phone, see what they report');
    expect(text).toContain('see where you are');
    await act(async () => dialogButton('Allow').click());
    expect(await answer).toBe(true);
    expect(listAllowedApps()).toEqual([{ id: 'app-theirs', name: 'Their shop' }]);
    expect(document.body.textContent).not.toContain('Let Their shop use this computer?');
  });

  it('takes Not now as a no', async () => {
    const { answer } = await ask();
    await act(async () => dialogButton('Not now').click());
    expect(await answer).toBe(false);
    expect(listAllowedApps()).toEqual([]);
  });
});
