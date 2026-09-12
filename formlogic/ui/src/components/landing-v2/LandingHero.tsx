import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { WorkspacePreview } from './WorkspacePreview';
import { FIELD_TYPE_COUNT, PACK_COUNT } from './stats';
import { api } from '../../lib/api';
import { coerceHeroContent, DEFAULT_HERO } from './heroSlides';

/**
 * Outcome-led hero: stable headline, CTAs, beta-aware proof line, the
 * dashboard demo preview, and the capability proof strip. The strip's
 * numbers come from stats.ts and are pinned to their sources of truth by
 * stats.test.ts. Headlines are editable server-side without a build
 * (backend/resources/landing-hero.json → GET /api/landing/hero); the baked
 * defaults render instantly and remain if the fetch fails.
 */
export function LandingHero({ beta }: { beta: boolean }) {
  const [hero, setHero] = useState(DEFAULT_HERO);
  const headline = hero.slides[0];

  useEffect(() => {
    let cancelled = false;
    api.getLandingHero().then((res) => {
      if (!cancelled && res.data) setHero(coerceHeroContent(res.data));
    }).catch(() => { /* keep the baked defaults */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="lv2-hero" id="top">
      <div className="lv2-hero__grid" aria-hidden="true" />
      <div className="lv2-container lv2-hero__inner">
        <div className="lv2-hero__copy">
          <span className="lv2-eyebrow">
            <Sparkles size={14} /> Your business, connected
          </span>
          {/* Keep the first configured headline readable without automatic rotation. */}
          <h1 className="lv2-hero__slides">
            <span className="lv2-hero__slide is-active">
              {headline.pre}<em>{headline.em}</em>{headline.post}
            </span>
          </h1>
          <p>
            Start with a form. Turn it into a workspace your team can run on.
            Connect records, dashboards and automations — then bring local AI into the work with OAIY.
          </p>
          <div className="lv2-hero__actions">
            <Link to="/signup" className="lv2-btn lv2-btn--primary">
              Build your first app <ArrowRight size={18} />
            </Link>
            <a href="#live-demo" className="lv2-btn lv2-btn--ghost">
              Explore a live demo <ArrowRight size={17} />
            </a>
          </div>
          <div className="lv2-hero__proof">
            <span>
              <Check size={14} /> {beta ? 'Free during public beta' : 'Free. Bring your own AI.'}
            </span>
            <span>
              <Check size={14} /> No credit card
            </span>
            <span>
              <Check size={14} /> Cloud or self-hosted
            </span>
          </div>
        </div>

        <Link to="/ai-setup" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-indigo-600 dark:text-indigo-300">Building with an AI assistant? Start here <ArrowRight size={16} /></Link>
        <WorkspacePreview />
      </div>

      <div className="lv2-container lv2-proof-strip" aria-label="Product capability summary">
        <span>
          <strong>{PACK_COUNT}</strong>
          <small>starter packs</small>
        </span>
        <span>
          <strong>{FIELD_TYPE_COUNT}</strong>
          <small>form field types</small>
        </span>
        <span>
          <strong>1</strong>
          <small>connected workspace</small>
        </span>
        <span>
          <strong>&#8734;</strong>
          <small>ways to make it yours</small>
        </span>
      </div>
    </section>
  );
}
