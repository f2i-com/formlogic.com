import '../styles/landing-v2.css';
import '../styles/landing-refresh.css';
import '../styles/landing-guides.css';
import { LiveDemoSection } from '../components/landing/LiveDemoSection';
import { FormExamplesSection } from '../components/landing/FormExamplesSection';
import { AokieSpotlight } from '../components/landing-v2/AokieSpotlight';
import { CapabilityBento } from '../components/landing-v2/CapabilityBento';
import { DesktopSpotlight } from '../components/landing-v2/DesktopSpotlight';
import { LandingFooter } from '../components/landing-v2/LandingFooter';
import { LandingHero } from '../components/landing-v2/LandingHero';
import { LandingNav } from '../components/landing-v2/LandingNav';
import { PortableAppsSpotlight } from '../components/landing-v2/PortableAppsSpotlight';
import { PricingSection } from '../components/landing-v2/PricingSection';
import { useLandingFonts, useLandingFragment, useReveal } from '../components/landing-v2/hooks';
import { useBetaMode } from '../hooks/useBetaMode';

export function Landing() {
  useLandingFonts();
  useLandingFragment();
  useReveal();
  const beta = useBetaMode();

  return (
    <div className="lv2">
      <a href="#main-content" className="fl-skip">Skip to content</a>
      <LandingNav />
      <main id="main-content">
        <LandingHero beta={beta} />
        <div id="live-demo" data-bot-showcase="live-demo" className="lv2-band--alt lv2-demo-band">
          <LiveDemoSection />
        </div>
        <div data-bot-showcase="form-examples" className="lv2-band lv2-demo-band">
          <FormExamplesSection />
        </div>
        <div data-bot-showcase="portable-apps"><PortableAppsSpotlight /></div>
        <div id="platform" data-bot-showcase="platform"><CapabilityBento /></div>
        <div data-bot-showcase="aokie"><AokieSpotlight /></div>
        <div data-bot-showcase="desktop"><DesktopSpotlight /></div>
        <div data-bot-showcase="pricing"><PricingSection beta={beta} /></div>
      </main>
      <LandingFooter />
    </div>
  );
}
