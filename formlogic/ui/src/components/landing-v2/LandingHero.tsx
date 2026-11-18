import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { WorkspacePreview } from './WorkspacePreview';
import { api } from '../../lib/api';
import { coerceHeroContent, DEFAULT_HERO } from './heroSlides';
import '../../styles/landing-hero.css';

/**
 * The headline, signup and demo links sit alongside a working sample notebook.
 * Headlines are editable server-side without a build
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
    <section className="fl-intro" id="top" aria-labelledby="fl-intro-title">
      <div className="lv2-container fl-intro__layout">
        <div className="fl-intro__copy">
          {/* Keep the first configured headline readable without automatic rotation. */}
          <h1 id="fl-intro-title">
            {headline.pre}<em>{headline.em}</em>{headline.post}
          </h1>
          <p>
            Build forms and apps that share your team’s records. Bring your own
            JavaScript app, connect a backend, and host it all in one workspace.
          </p>
          <div className="fl-intro__actions">
            <Link to="/signup" className="fl-intro__start">
              Build your first app <ArrowRight size={17} aria-hidden="true" />
            </Link>
            <a href="#live-demo" className="fl-intro__demo">
              Explore examples
            </a>
          </div>
          <p className="fl-intro__terms">{beta ? 'Free during public beta.' : 'Free to start.'} No credit card required.</p>
        </div>

        <WorkspacePreview />
      </div>
    </section>
  );
}
