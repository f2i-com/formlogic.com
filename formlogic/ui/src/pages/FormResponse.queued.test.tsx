// @vitest-environment jsdom
// A public form submitted offline is held by the service worker's queue (Workbox, see swQueue.ts)
// and the page says "saved on this device". That queue keeps nothing as failed: a submission is
// sent when the connection is back, or dropped after 24 hours. What the person can do there is
// take their answers off the device (a borrowed or shared device, say), after being told they
// will not be sent; and the note says how long the device keeps them.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ discard: vi.fn(async (queue: string, key: string) => { void queue; void key; return 1; }) }));
vi.mock('../lib/swQueue', async (original) => ({
  ...(await original<typeof import('../lib/swQueue')>()),
  discardBackgroundSyncCopies: sw.discard,
}));

import { QueuedOnDeviceNote } from './FormResponse';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  sw.discard.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
async function click(label: string) {
  const b = button(label);
  if (!b) throw new Error(`no "${label}" button in: ${host.textContent}`);
  await act(async () => { b.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('the "saved on this device" note of a public form', () => {
  it('says how long the device keeps the answers', async () => {
    await act(async () => { root.render(<QueuedOnDeviceNote idempotencyKey="k1" sealed={false} textColor="#111111" />); });
    expect(host.textContent).toContain('saved on this device');
    expect(host.textContent).toContain('24 hours');
    expect(host.textContent).not.toContain('sealed');
  });

  it('says a private form’s answers are sealed', async () => {
    await act(async () => { root.render(<QueuedOnDeviceNote idempotencyKey="k1" sealed textColor="#111111" />); });
    expect(host.textContent).toContain('sealed so only the owner can read them');
  });

  it('removes the answers from the device only after saying they will not be sent', async () => {
    await act(async () => { root.render(<QueuedOnDeviceNote idempotencyKey="k1" sealed={false} textColor="#111111" />); });
    await click('Remove from this device');
    expect(sw.discard).not.toHaveBeenCalled();
    expect(host.textContent).toContain('will not be sent');
    await click('Keep them');
    expect(sw.discard).not.toHaveBeenCalled();
    await click('Remove from this device');
    await click('Remove');
    expect(sw.discard).toHaveBeenCalledWith('publicFormSubmissionQueue', 'k1');
    expect(host.textContent).toContain('Removed from this device');
    expect(button('Remove from this device')).toBeUndefined();
  });

  it('says so when the answers have already left the device', async () => {
    sw.discard.mockResolvedValueOnce(0);
    await act(async () => { root.render(<QueuedOnDeviceNote idempotencyKey="k1" sealed={false} textColor="#111111" />); });
    await click('Remove from this device');
    await click('Remove');
    expect(host.textContent).toContain('already left this device');
  });
});
