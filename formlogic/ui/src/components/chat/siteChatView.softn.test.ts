import { beforeEach, describe, expect, it } from 'vitest';
import { chatToolLinkPath, prepareSoftnHandOff } from './siteChatView';
import { useUIStore } from '../../stores/uiStore';

/** The chat takes the person to a new SoftN app, where AI Studio builds it from their request — once. */
describe('the SoftN app hand-off', () => {
  beforeEach(() => useUIStore.getState().setSoftnOpen(null));

  it('links a SoftN app to its workspace', () => {
    expect(chatToolLinkPath({ kind: 'softnApp', id: 'a 1' })).toBe('/apps/a%201/softn');
  });

  it('hands the request to AI Studio the first time, and opens the app plainly after that', () => {
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-hand-off', brief: 'A recipe box.' });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-hand-off', editor: 'studio', brief: { prompt: 'A recipe box.', kind: 'build' } });
    useUIStore.getState().setSoftnOpen(null);
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-hand-off', brief: 'A recipe box.' });
    expect(useUIStore.getState().softnOpen).toBeNull();
  });

  it('opens plainly when there is no request, and ignores other links', () => {
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-no-request' });
    expect(useUIStore.getState().softnOpen).toBeNull();
    useUIStore.getState().setSoftnOpen({ appId: 'x', editor: 'builder' });
    prepareSoftnHandOff({ kind: 'app', id: 'x' });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'x', editor: 'builder' });
  });
});
