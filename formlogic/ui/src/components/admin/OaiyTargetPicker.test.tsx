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
});
