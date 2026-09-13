// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { nativeAppStorage } from './nativeAppStorage';

beforeEach(() => localStorage.clear());
it('restores only the selected app session and keeps it when another app clears storage', () => {
  const notes = nativeAppStorage('notes');
  notes.mutate({ operation: 'set', key: 'session', value: 'example-session' });
  nativeAppStorage('calendar').mutate({ operation: 'clear' });
  expect(nativeAppStorage('notes').read()).toEqual({ session: 'example-session' });
  notes.mutate({ operation: 'remove', key: 'session' });
  expect(notes.read()).toEqual({});
});
it('reports a full browser store without replacing the last saved value', () => {
  const notes = nativeAppStorage('notes');
  notes.mutate({ operation: 'set', key: 'draft', value: 'Saved note' });
  expect(() => notes.mutate({ operation: 'set', key: 'draft', value: 'x'.repeat(30001) })).toThrow();
  expect(notes.read().draft).toBe('Saved note');
});
