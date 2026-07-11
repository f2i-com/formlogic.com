import { Link } from 'react-router-dom';
import { ArrowRight, Check, PhoneCall, Sparkles } from 'lucide-react';
import { HeroProductScene } from './HeroProductScene';

/**
 * Outcome-led hero: headline, CTAs, beta-aware proof line, the interactive
 * product scene, and the capability proof strip.
 */
export function LandingHero({ beta, packCount }: { beta: boolean; packCount: number }) {
  return (
    <section className="lv2-hero" id="top">
      <div className="lv2-hero__grid" aria-hidden="true" />
      <div className="lv2-container lv2-hero__inner">
        <div className="lv2-hero__copy">
          <span className="lv2-eyebrow">
            <Sparkles size={14} /> Forms · Apps · Flows · AI receptionist
          </span>
          <h1>
            Build the system that <em>runs your business.</em>
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
          <strong>{packCount}</strong>
          <small>starter packs</small>
        </span>
        <span>
          <strong>23</strong>
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
