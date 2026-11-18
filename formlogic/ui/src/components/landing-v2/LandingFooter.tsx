import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { FormLogicMark } from './shared';
import { GITHUB_URL } from './stats';

const SUPPORT_EMAIL = `mailto:support@${import.meta.env.VITE_PUBLIC_DOMAIN || 'formlogic.com'}`;

/** Final CTA band + the legal footer. */
export function LandingFooter() {
  return (
    <>
      <section className="lv2-cta">
        <div className="lv2-container lv2-cta__inner">
          <div className="lv2-cta__text">
            <h2>Create your FormLogic workspace</h2>
          </div>
          <Link to="/signup" className="lv2-btn lv2-btn--light">
            Start building free <ArrowRight size={17} />
          </Link>
        </div>
      </section>

      <footer className="lv2-footer">
        <div className="lv2-container lv2-footer__top">
          <div className="lv2-footer__brand">
            <FormLogicMark />
            <p>Build forms, host apps and automate the work around them.</p>
          </div>
          <div className="lv2-footer__col">
            <strong>Product</strong>
            <a href="/#platform">Platform</a>
            <a href="/#aokie">Aokie</a>
            <a href="/#desktop">Desktop</a>
            <Link to="/packs">Marketplace</Link>
          </div>
          <div className="lv2-footer__col">
            <strong>Resources</strong>
            <Link to="/docs">Documentation</Link>
            <Link to="/ai-setup">Set up your AI assistant</Link>
            <Link to="/aokie">Aokie setup guide</Link>
            <a href="/docs#self-hosting">Self-hosting</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={SUPPORT_EMAIL}>Support</a>
          </div>
          <div className="lv2-footer__col">
            <strong>Account</strong>
            <Link to="/signup">Create account</Link>
            <Link to="/login">Sign in</Link>
          </div>
        </div>
        <div className="lv2-container lv2-footer__bottom">
          <span>© {new Date().getFullYear()} FormLogic</span>
          <span className="lv2-footer__legal">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </span>
        </div>
      </footer>
    </>
  );
}
