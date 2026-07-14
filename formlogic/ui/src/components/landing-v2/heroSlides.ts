// Rotating hero headlines. The server copy lives in backend/resources/landing-hero.json
// (served by GET /api/landing/hero) so headline edits never need a frontend build; these
// defaults are the same set, baked in so the hero renders instantly and never depends on
// the fetch. Slides are PLAIN STRINGS rendered as text nodes — never HTML.

export interface HeroSlide {
  pre: string;
  em: string;
  post?: string;
}

export interface HeroContent {
  intervalMs: number;
  slides: HeroSlide[];
}

export const DEFAULT_HERO: HeroContent = {
  intervalMs: 6000,
  slides: [
    { pre: 'Build the system that ', em: 'runs your business.' },
    { pre: 'From form, to app, to ', em: 'flow — with logic.' },
    { pre: 'Every call answered. ', em: 'Every booking captured.' },
    { pre: 'Forms in. Apps out. ', em: 'Logic all the way down.' },
    { pre: 'Stop renting software. ', em: 'Run your own.' },
    { pre: 'Less duct tape. ', em: 'More system.' },
  ],
};

/** Coerce an API payload into safe hero content; anything malformed falls back to the defaults. */
export function coerceHeroContent(raw: unknown): HeroContent {
  if (!raw || typeof raw !== 'object') return DEFAULT_HERO;
  const data = raw as { intervalMs?: unknown; slides?: unknown };
  const slides: HeroSlide[] = [];
  if (Array.isArray(data.slides)) {
    for (const s of data.slides.slice(0, 12)) {
      if (!s || typeof s !== 'object') continue;
      const { pre, em, post } = s as Record<string, unknown>;
      const slide: HeroSlide = {
        pre: typeof pre === 'string' ? pre.slice(0, 140) : '',
        em: typeof em === 'string' ? em.slice(0, 140) : '',
        post: typeof post === 'string' ? post.slice(0, 140) : '',
      };
      if ((slide.pre + slide.em + (slide.post ?? '')).trim() === '') continue;
      slides.push(slide);
    }
  }
  if (!slides.length) return DEFAULT_HERO;
  const interval = typeof data.intervalMs === 'number' && Number.isFinite(data.intervalMs) ? data.intervalMs : 6000;
  return { intervalMs: Math.max(2500, Math.min(interval, 20000)), slides };
}
