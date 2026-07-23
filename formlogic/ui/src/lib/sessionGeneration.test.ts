// Audit FL-11/FL-28 — the monotonic auth-session generation: stores capture it
// before an authenticated request and discard results that resolve after ANY
// session boundary; the owner mirror scopes the offline queue without an
// authStore import cycle.
import { describe, expect, it } from 'vitest';
import {
  bumpSessionGeneration,
  currentSessionGeneration,
  currentSessionOwner,
  isSessionGenerationCurrent,
  setSessionOwner,
} from './sessionGeneration';

describe('sessionGeneration', () => {
  it('a captured generation stays valid only until the next boundary', () => {
    const captured = currentSessionGeneration();
    expect(isSessionGenerationCurrent(captured)).toBe(true);

    bumpSessionGeneration();
    expect(isSessionGenerationCurrent(captured)).toBe(false);
    expect(isSessionGenerationCurrent(currentSessionGeneration())).toBe(true);
  });

  it('bumps are strictly monotonic — two boundaries never collide', () => {
    const first = bumpSessionGeneration();
    const second = bumpSessionGeneration();
    expect(second).toBeGreaterThan(first);
  });

  it('the owner mirror tracks sign-in and teardown', () => {
    setSessionOwner('user-a');
    expect(currentSessionOwner()).toBe('user-a');
    setSessionOwner(null);
    expect(currentSessionOwner()).toBeNull();
  });
});
