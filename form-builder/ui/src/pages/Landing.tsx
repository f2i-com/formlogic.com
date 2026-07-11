import '../styles/landing-v2.css';
import { LiveDemoSection } from '../components/landing/LiveDemoSection';
import { AiMcpSpotlight } from '../components/landing-v2/AiMcpSpotlight';
import { AokieSpotlight } from '../components/landing-v2/AokieSpotlight';
import { CapabilityBento } from '../components/landing-v2/CapabilityBento';
import { DesktopSpotlight } from '../components/landing-v2/DesktopSpotlight';
import { LandingFooter } from '../components/landing-v2/LandingFooter';
import { LandingHero } from '../components/landing-v2/LandingHero';
import { LandingNav } from '../components/landing-v2/LandingNav';
import { PlatformStory } from '../components/landing-v2/PlatformStory';
import { PricingSection } from '../components/landing-v2/PricingSection';
import { useLandingFonts, useReveal } from '../components/landing-v2/hooks';
import { useBetaMode } from '../hooks/useBetaMode';

/**
 * Marketing landing page (landing-v2, 2026-07 redesign).
 *
 * Story: Capture → Operate → Automate, with Aokie as the flagship solution and
 * FormLogic Desktop as the local capability layer. The page is an orchestrator
 * over components/landing-v2/*; all visual rules live in styles/landing-v2.css
 * (scoped under .lv2 — the dark hero/desktop/footer are dark in both themes,
 * the light bands follow the app theme).
 *
 * Contracts preserved from the previous landing:
 *  - named export `Landing`, rendered eagerly at "/" for signed-out + demo;
 *  - `useBetaMode()` drives beta wording (never hardcoded);
 *  - the REAL `LiveDemoSection` (live demo apps, no signup) stays;
 *  - no heavy imports (pack catalogue, React Flow, Monaco, Recharts).
 */

export function Landing() {
  useLandingFonts();
  useReveal();
  const beta = useBetaMode();

  return (
    <div className="lv2">
      <LandingNav />
      <LandingHero beta={beta} />
      <PlatformStory />
      <div id="live-demo" className="lv2-band--alt lv2-demo-band">
        <LiveDemoSection />
      </div>
      <AokieSpotlight />
      <CapabilityBento />
      <DesktopSpotlight />
      <AiMcpSpotlight />
      <PricingSection beta={beta} />
      <LandingFooter />
    </div>
  );
}
