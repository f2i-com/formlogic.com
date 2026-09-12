import { describe, expect, it, vi } from 'vitest';
import { deferEffect } from './deferredEffect';

describe('deferred external work', () => {
  it('does not start a request whose effect was already discarded', async () => {
    const start = vi.fn();
    const cancel = deferEffect(start);
    cancel();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  });

  it('releases a started subscription once when the effect is cleaned up', async () => {
    const cleanup = vi.fn();
    const cancel = deferEffect(() => cleanup);
    await Promise.resolve();
    cancel();
    cancel();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('starts only the latest setup when dependencies change before work begins', async () => {
    const load = vi.fn();
    const old = deferEffect(() => { load('old app'); });
    old();
    const current = deferEffect(() => { load('current app'); });
    await Promise.resolve();
    expect(load).toHaveBeenCalledExactlyOnceWith('current app');
    current();
  });
});
