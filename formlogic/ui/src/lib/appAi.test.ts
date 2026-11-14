// App AI's small words and choices: the picture model to suggest, and a server's time said to a person.
import { describe, expect, it } from 'vitest';
import { sinceWords, suggestedPictureModel, utcStamp, whenWords } from './appAi';

describe('suggestedPictureModel', () => {
  it('suggests the first picture model the computer lists, never a language or a video model', () => {
    expect(suggestedPictureModel([{ id: 'language-a', name: 'Language A' }, { id: 'video-a', name: 'Video A', type: 'video' }, { id: 'picture-a', name: 'Picture A', type: 'image' }, { id: 'picture-b', name: 'Picture B', type: 'image' }])).toBe('picture-a');
  });

  it('names no model of its own: the computer\'s list, in its own order, decides', () => {
    const listed = [{ id: 'picture-a', name: 'Picture A', type: 'image' }, { id: 'picture-b', name: 'Picture B', type: 'image' }];
    expect(suggestedPictureModel(listed)).toBe('picture-a');
    expect(suggestedPictureModel([...listed].reverse())).toBe('picture-b');
  });

  it('suggests nothing when the computer lists no picture model', () => {
    expect(suggestedPictureModel([{ id: 'language-a', name: 'Language A' }])).toBeNull();
    expect(suggestedPictureModel([])).toBeNull();
  });
});

describe('a server\'s time, said to a person', () => {
  const stamp = '2026-11-09 07:05:00';
  const then = utcStamp(stamp);
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = then.toLocaleDateString([], { day: 'numeric', month: 'short' });

  it('reads the server\'s stamps as UTC, with or without their fraction', () => {
    expect(then.toISOString()).toBe('2026-11-09T07:05:00.000Z');
    expect(utcStamp('2026-11-09 07:05:00.250').toISOString()).toBe('2026-11-09T07:05:00.000Z');
    expect(utcStamp('2026-11-09T07:05:00Z').toISOString()).toBe('2026-11-09T07:05:00.000Z');
  });

  it('gives the time alone on the same day, and the day too on another', () => {
    const sameDay = new Date(then.getTime() + 60_000);
    const nextWeek = new Date(then.getTime() + 7 * 86_400_000);
    expect(sinceWords(stamp, sameDay)).toBe(`since ${time}`);
    expect(whenWords(stamp, sameDay)).toBe(`at ${time}`);
    expect(sinceWords(stamp, nextWeek)).toBe(`since ${day}, ${time}`);
    expect(whenWords(stamp, nextWeek)).toBe(`on ${day}, ${time}`);
  });

  it('says nothing for a time it was not given or cannot read', () => {
    expect([sinceWords(null), sinceWords(undefined), sinceWords(''), sinceWords('not a time')]).toEqual(['', '', '', '']);
    expect([whenWords(null), whenWords('not a time')]).toEqual(['', '']);
  });
});
