import { describe, expect, it } from 'vitest';
import { coerceHeroContent, DEFAULT_HERO } from './heroSlides';

describe('hero slides', () => {
  it('ships non-empty defaults with a highlighted phrase on every slide', () => {
    expect(DEFAULT_HERO.slides.length).toBeGreaterThanOrEqual(3);
    for (const s of DEFAULT_HERO.slides) {
      expect(s.em.trim().length).toBeGreaterThan(0);
      expect((s.pre + s.em + (s.post ?? '')).length).toBeLessThanOrEqual(140 * 3);
    }
    expect(DEFAULT_HERO.intervalMs).toBeGreaterThanOrEqual(2500);
  });

  it('coerces a valid API payload', () => {
    const out = coerceHeroContent({ intervalMs: 4000, slides: [{ pre: 'A ', em: 'b.', post: '' }] });
    expect(out.slides).toEqual([{ pre: 'A ', em: 'b.', post: '' }]);
    expect(out.intervalMs).toBe(4000);
  });

  it('falls back to the defaults on malformed payloads', () => {
    expect(coerceHeroContent(null)).toBe(DEFAULT_HERO);
    expect(coerceHeroContent({ slides: [] })).toBe(DEFAULT_HERO);
    expect(coerceHeroContent({ slides: [{ pre: '   ', em: '', post: '' }] })).toBe(DEFAULT_HERO);
    expect(coerceHeroContent({ slides: 'nope' })).toBe(DEFAULT_HERO);
  });

  it('clamps interval and drops junk slides while keeping good ones', () => {
    const out = coerceHeroContent({
      intervalMs: 100,
      slides: [{ pre: 'ok ', em: 'fine.' }, 42, { pre: '', em: '' }, { pre: 'x'.repeat(500), em: 'y' }],
    });
    expect(out.intervalMs).toBe(2500);
    expect(out.slides).toHaveLength(2);
    expect(out.slides[1].pre).toHaveLength(140);
  });
});
