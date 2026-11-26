import { beforeEach, describe, expect, it } from 'vitest';
import { bumpSessionGeneration, setSessionOwner } from '../../lib/sessionGeneration';
import { useUIStore } from '../../stores/uiStore';
import { prepareSoftnHandOff } from './siteChatView';

describe('Site chat session isolation (Pass 7)', () => {
  beforeEach(() => {
    setSessionOwner(null);
    bumpSessionGeneration();
    useUIStore.setState({ chatSeed: null, chatLaunch: null, softnOpen: null });
  });

  it('preserves a Dashboard launch queued before initial auth hydration resolves', () => {
    useUIStore.setState({
      chatLaunch: { text: 'Build after sign-in' },
    });

    setSessionOwner('user-a');

    expect(useUIStore.getState().chatLaunch).toEqual({ text: 'Build after sign-in' });
  });

  it('clears chatSeed, chatLaunch, and softnOpen on logout and account switch', () => {
    setSessionOwner('user-a');
    useUIStore.setState({
      chatSeed: 'Private prompt from user A',
      chatLaunch: {
        text: 'Create confidential HR app',
        images: ['data:image/png;base64,AAAA'],
        newThread: true,
      },
      softnOpen: {
        appId: 'app-a',
        editor: 'studio',
        brief: { prompt: 'Edit user A app', kind: 'edit' },
      },
    });

    // Switching directly to another user clears all queued handoffs.
    setSessionOwner('user-b');
    expect(useUIStore.getState().chatSeed).toBeNull();
    expect(useUIStore.getState().chatLaunch).toBeNull();
    expect(useUIStore.getState().softnOpen).toBeNull();

    // Signing out clears all queued handoffs.
    useUIStore.setState({
      chatSeed: 'Prompt from user B',
      chatLaunch: { text: 'Launch from user B' },
      softnOpen: { appId: 'app-b', editor: 'studio', brief: { prompt: 'Edit B', kind: 'edit' } },
    });
    setSessionOwner(null);
    expect(useUIStore.getState().chatSeed).toBeNull();
    expect(useUIStore.getState().chatLaunch).toBeNull();
    expect(useUIStore.getState().softnOpen).toBeNull();
  });

  it('resets softnHandedOff deduplication cache across session boundaries', () => {
    const link = { kind: 'softnApp' as const, id: 'app-1', brief: 'Build tracker' };

    prepareSoftnHandOff(link, 'act-1');
    expect(useUIStore.getState().softnOpen?.appId).toBe('app-1');

    // Re-triggering the same activity in the same session clears instead of re-handing off.
    useUIStore.setState({ softnOpen: null });
    prepareSoftnHandOff(link, 'act-1');
    expect(useUIStore.getState().softnOpen).toBeNull();

    // After a session boundary, the cache is cleared so a new session can hand off cleanly.
    bumpSessionGeneration();
    prepareSoftnHandOff(link, 'act-1');
    expect(useUIStore.getState().softnOpen?.appId).toBe('app-1');
  });
});
