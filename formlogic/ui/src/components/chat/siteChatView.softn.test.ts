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

  it('links a section of a SoftN app’s page: its data at a table, its members, its source', () => {
    expect(chatToolLinkPath({ kind: 'softnApp', id: 'a1', section: 'data', table: 'orders' })).toBe('/apps/a1/softn/data/orders');
    expect(chatToolLinkPath({ kind: 'softnApp', id: 'a1', section: 'data' })).toBe('/apps/a1/softn/data');
    expect(chatToolLinkPath({ kind: 'softnApp', id: 'a1', section: 'members' })).toBe('/apps/a1/softn/members');
    expect(chatToolLinkPath({ kind: 'softnApp', id: 'a1', section: 'edit' })).toBe('/apps/a1/softn/edit');
  });

  it('hands a change to an app that exists to AI Studio as an edit, each new request once', () => {
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-edit', brief: 'Add a dark theme.', edit: true });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-edit', editor: 'studio', brief: { prompt: 'Add a dark theme.', kind: 'edit' } });
    useUIStore.getState().setSoftnOpen(null);
    // The same request again (the card's Open, later) does not make the change a second time…
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-edit', brief: 'Add a dark theme.', edit: true });
    expect(useUIStore.getState().softnOpen).toBeNull();
    // …and another request for the same app is handed over.
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-edit', brief: 'Make the buttons larger.', edit: true });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-edit', editor: 'studio', brief: { prompt: 'Make the buttons larger.', kind: 'edit' } });
  });

  it('hands over once for each time the tool ran: the card opened again is not a second request, asking again in the same words is', () => {
    const link = { kind: 'softnApp' as const, id: 'app-runs', brief: 'Add a dark theme.', edit: true };
    prepareSoftnHandOff(link, 'tool-1');
    expect(useUIStore.getState().softnOpen?.brief?.prompt).toBe('Add a dark theme.');
    // The same run arriving again before the workspace has taken it leaves the hand-off standing.
    prepareSoftnHandOff(link, 'tool-1');
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-runs', editor: 'studio', brief: { prompt: 'Add a dark theme.', kind: 'edit' } });
    // Taken by the workspace; the card's Open, later, opens the app plainly.
    useUIStore.getState().setSoftnOpen(null);
    prepareSoftnHandOff(link, 'tool-1');
    expect(useUIStore.getState().softnOpen).toBeNull();
    // Asked again in the same words (Studio's first change was discarded, say): the tool ran again, so it is handed over again.
    prepareSoftnHandOff(link, 'tool-2');
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'app-runs', editor: 'studio', brief: { prompt: 'Add a dark theme.', kind: 'edit' } });
  });

  it('opens plainly when there is no request, and ignores other links', () => {
    prepareSoftnHandOff({ kind: 'softnApp', id: 'app-no-request' });
    expect(useUIStore.getState().softnOpen).toBeNull();
    useUIStore.getState().setSoftnOpen({ appId: 'x', editor: 'builder' });
    prepareSoftnHandOff({ kind: 'app', id: 'x' });
    expect(useUIStore.getState().softnOpen).toEqual({ appId: 'x', editor: 'builder' });
  });
});
