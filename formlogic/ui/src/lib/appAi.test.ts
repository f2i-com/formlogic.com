// App AI's small words and choices: the picture model to suggest, and a server's time said to a person.
import { describe, expect, it } from 'vitest';
import { sinceWords, suggestedPictureModel, utcStamp, whenWords } from './appAi';

describe('suggestedPictureModel', () => {
  it('suggests FLUX 3 Image Klein where the computer has it, wherever it is listed', () => {
    expect(suggestedPictureModel([{ id: 'nanbeige', name: 'nanbeige' }, { id: 'sdxl', name: 'SD XL', type: 'image' }, { id: 'flux-3-image-klein', name: 'FLUX 3 Klein', type: 'image' }])).toBe('flux-3-image-klein');
  });

  it('suggests the first picture model otherwise, never a language or a video model', () => {
    expect(suggestedPictureModel([{ id: 'nanbeige', name: 'nanbeige' }, { id: 'ltx-2.5', name: 'ltx-2.5', type: 'video' }, { id: 'sdxl', name: 'SD XL', type: 'image' }, { id: 'pony', name: 'pony', type: 'image' }])).toBe('sdxl');
    // A language model that happens to carry the name is not a picture model.
    expect(suggestedPictureModel([{ id: 'flux-3-image-klein', name: 'flux-3-image-klein' }, { id: 'pony', name: 'pony', type: 'image' }])).toBe('pony');
  });

  it('suggests nothing when the computer lists no picture model', () => {
    expect(suggestedPictureModel([{ id: 'nanbeige', name: 'nanbeige' }])).toBeNull();
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
