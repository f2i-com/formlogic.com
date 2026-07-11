import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, PhoneCall, Sparkles } from 'lucide-react';
import { HeroProductScene } from './HeroProductScene';
import { FIELD_TYPE_COUNT, PACK_COUNT } from './stats';
import { api } from '../../lib/api';
import { coerceHeroContent, DEFAULT_HERO } from './heroSlides';

/**
 * Outcome-led hero: rotating headline, CTAs, beta-aware proof line, the
 * interactive product scene, and the capability proof strip. The strip's
 * numbers come from stats.ts and are pinned to their sources of truth by
 * stats.test.ts. Headlines are editable server-side without a build
 * (backend/resources/landing-hero.json → GET /api/landing/hero); the baked
 * defaults render instantly and remain if the fetch fails.
 */
export function LandingHero({ beta }: { beta: boolean }) {
  const [hero, setHero] = useState(DEFAULT_HERO);
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getLandingHero().then((res) => {
      if (!cancelled && res.data) setHero(coerceHeroContent(res.data));
    }).catch(() => { /* keep the baked defaults */ });
    return () => { cancelled = true; };
  }, []);

  // Auto-rotate: paused while the tab is hidden, and not started at all for
  // Auto-rotate, paused while the tab is hidden. Reduced-motion users (incl. Windows with
  // "Animation effects" off) still get the rotating copy — the CSS media query swaps the
  // fade/slide for an instant change, so the text updates without any motion.
  useEffect(() => {
    if (hero.slides.length < 2) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setSlide((i) => (i + 1) % hero.slides.length);
    }, hero.intervalMs);
    return () => window.clearInterval(timer);
  }, [hero]);

  return (
    <section className="lv2-hero" id="top">
      <div className="lv2-hero__grid" aria-hidden="true" />
      <div className="lv2-container lv2-hero__inner">
        <div className="lv2-hero__copy">
          <span className="lv2-eyebrow">
            <Sparkles size={14} /> Forms · Apps · Flows · AI receptionist
          </span>
          {/* Every slide stays mounted in one grid cell, so the h1 is sized by the
              tallest headline and rotation never shifts the layout below it. */}
          <h1 className="lv2-hero__slides">
            {hero.slides.map((s, i) => (
              <span
                key={i}
                className={`lv2-hero__slide${i === slide % hero.slides.length ? ' is-active' : ''}`}
                aria-hidden={i !== slide % hero.slides.length}
              >
                {s.pre}
                <em>{s.em}</em>
                {s.post}
              </span>
            ))}
          </h1>
          <p>
            Turn forms into connected apps, dashboards and automations. Add FormLogic Desktop for
            local AI, devices and headless flows — including Aokie, your AI phone receptionist.
          </p>
          <div className="lv2-hero__actions">
            <Link to="/signup" className="lv2-btn lv2-btn--primary">
              Build your first app <ArrowRight size={18} />
            </Link>
            <a href="#aokie" className="lv2-btn lv2-btn--ghost">
              See Aokie in action <PhoneCall size={17} />
            </a>
          </div>
          <div className="lv2-hero__proof">
            <span>
              <Check size={14} /> {beta ? 'Free during public beta' : 'First 30 days free'}
            </span>
            <span>
              <Check size={14} /> No credit card
            </span>
            <span>
              <Check size={14} /> Cloud or self-hosted
            </span>
          </div>
        </div>

        <HeroProductScene />
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
