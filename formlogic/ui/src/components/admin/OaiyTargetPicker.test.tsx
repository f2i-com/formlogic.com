// @vitest-environment jsdom
/**
 * The administrator's picker of a linked computer, its provider and its model (OaiyTargetPicker): each listing it asks
 * a computer for is let go when another is asked, the picker goes, or the page closes, so a computer is not kept
 * listing for nobody (followListing sends its letGo with keepalive once its signal is aborted).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ adminOaiyProviders: vi.fn(), adminOaiyModels: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: mocks }));
const { OaiyTargetPicker } = await import('./OaiyTargetPicker');

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const CANDIDATES = [{ connectionId: 'c1', instanceId: 'i1', deviceName: 'Studio PC', fingerprint: 'AB12', online: true }];

beforeEach(() => {
  mocks.adminOaiyProviders.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.adminOaiyModels.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function pickTheComputer() {
  await act(async () => root.render(<OaiyTargetPicker name="t" candidates={CANDIDATES as never} onChange={() => {}} />));
  const radio = container.querySelector('input[type="radio"]') as HTMLInputElement;
  await act(async () => radio.click());
  const signal = mocks.adminOaiyProviders.mock.calls[0]?.[1] as AbortSignal | undefined;
  expect(signal).toBeInstanceOf(AbortSignal);
  return signal!;
}

describe('the picker\'s listing of a computer', () => {
  it('is let go when the picker goes', async () => {
    const signal = await pickTheComputer();
    expect(signal.aborted).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(signal.aborted).toBe(true);
  });

  it('is let go when the page closes', async () => {
    const signal = await pickTheComputer();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(signal.aborted).toBe(true);
  });

  it('is asked again when the page comes back from the back-forward cache, so the choices are not left waiting', async () => {
    const first = await pickTheComputer();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(first.aborted).toBe(true);
    mocks.adminOaiyProviders.mockImplementation(async () => ({ data: { engineProvider: 'oaiy-engine', providers: [{ id: 'oaiy-engine', label: 'OAIY engine', model: null }] } }));
    // (a page shown anew asks nothing again; one brought back from the cache does)
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    expect(mocks.adminOaiyProviders).toHaveBeenCalledTimes(1);
    const back = new Event('pageshow');
    Object.defineProperty(back, 'persisted', { value: true });
    await act(async () => { window.dispatchEvent(back); });
    expect(mocks.adminOaiyProviders).toHaveBeenCalledTimes(2);
    expect(mocks.adminOaiyProviders.mock.calls[1][0]).toBe('c1');
    expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect(container.textContent).not.toContain('Asking the computer what it offers');
  });
});
