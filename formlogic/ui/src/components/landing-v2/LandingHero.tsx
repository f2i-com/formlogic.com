import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Sparkles } from 'lucide-react';
import { WorkspacePreview } from './WorkspacePreview';
import { api } from '../../lib/api';
import { coerceHeroContent, DEFAULT_HERO } from './heroSlides';
import { useAuthStore } from '../../stores/authStore';
import '../../styles/landing-hero.css';

/**
 * The headline, signup and demo links sit alongside a working interactive sample.
 * Headlines are editable server-side without a build
 * (backend/resources/landing-hero.json → GET /api/landing/hero); the baked
 * defaults render instantly and remain if the fetch fails.
 */
export function LandingHero({ beta }: { beta: boolean }) {
  const [hero, setHero] = useState(DEFAULT_HERO);
  const signedIn = useAuthStore((s) => !!s.user && !s.user.isDemo);
  const headline = hero.slides[0];

  useEffect(() => {
    let cancelled = false;
    api.getLandingHero().then((res) => {
      if (!cancelled && res.data) setHero(coerceHeroContent(res.data));
    }).catch(() => { /* keep the baked defaults */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="fl-intro" id="top" data-bot-showcase="hero" aria-labelledby="fl-intro-title">
      <div className="lv2-container fl-intro__layout">
        <div className="fl-intro__copy">
          <div className="fl-intro__eyebrow">
            <Sparkles size={14} aria-hidden="true" />
            <span>Forms · SoftN Apps · Shared SQLite · Visual Flows</span>
          </div>
          {/* Keep the first configured headline readable without automatic rotation. */}
          <h1 id="fl-intro-title">
            {headline.pre}<em>{headline.em}</em>{headline.post}
          </h1>
          <p>
            Build forms, live charts, and hosted SoftN apps (PHP, Rust, JS, Python)
            that share one SQLite database — linked together with external API keys
            and visual flows.
          </p>
          <div className="fl-intro__actions">
            <Link to={signedIn ? '/' : '/signup'} className="fl-intro__start">
              {signedIn ? 'Open your workspace' : 'Start building free'} <ArrowRight size={17} aria-hidden="true" />
            </Link>
            {signedIn ? (
              <a href="#live-demo" className="fl-intro__demo">
                Explore examples
              </a>
            ) : (
              <Link to="/demo" className="fl-intro__demo">
                Try live demo
              </Link>
            )}
          </div>
          <ul className="fl-intro__highlights" aria-label="Key capabilities">
            <li><CheckCircle2 size={14} aria-hidden="true" />Shared SQLite databases</li>
            <li><CheckCircle2 size={14} aria-hidden="true" />1-click CRUD forms &amp; charts</li>
            <li><CheckCircle2 size={14} aria-hidden="true" />API keys &amp; cross-app flows</li>
          </ul>
          <p className="fl-intro__terms">{beta ? 'Free during public beta.' : 'Free to start.'} No credit card required.</p>
        </div>

        <div data-bot-showcase="preview" className="min-w-0">
          <WorkspacePreview />
        </div>
      </div>
    </section>
  );
}
