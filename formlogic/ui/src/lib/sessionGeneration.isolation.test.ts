import { afterEach, expect, it, vi } from 'vitest';
import * as session from './sessionGeneration';
afterEach(() => session.setSessionOwner(null));
it('owner changes synchronously fence pending work; same-owner refresh does not', () => {
  session.setSessionOwner('a');
  const generation = session.currentSessionGeneration();
  session.setSessionOwner('a'); expect(session.currentSessionGeneration()).toBe(generation);
  session.setSessionOwner('b'); expect(session.isSessionGenerationCurrent(generation)).toBe(false);
});
it('notifies frame subscribers synchronously for boundaries and supports unsubscribe', () => {
  const notify = vi.fn();
  const subscribe = (session as unknown as { subscribeSessionGeneration: (cb: () => void) => () => void }).subscribeSessionGeneration;
  const unsubscribe = subscribe(notify);
  session.bumpSessionGeneration(); expect(notify).toHaveBeenCalledTimes(1);
  session.setSessionOwner('subscriber-owner'); expect(notify).toHaveBeenCalledTimes(2);
  session.setSessionOwner('subscriber-owner'); expect(notify).toHaveBeenCalledTimes(2);
  unsubscribe(); session.bumpSessionGeneration(); expect(notify).toHaveBeenCalledTimes(2);
});
