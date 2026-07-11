import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Menu, X } from 'lucide-react';
import { FormLogicMark } from './shared';

/**
 * Sticky dark marketing nav. In-page anchors for the sections, router links
 * for the product routes, and a proper aria-expanded hamburger under 900px.
 */
export function LandingNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <nav className="lv2-nav" aria-label="FormLogic primary navigation">
      <div className="lv2-container lv2-nav__inner">
        <a href="#top" className="lv2-nav__brand" aria-label="FormLogic home" onClick={close}>
          <FormLogicMark />
        </a>

        <div id="lv2-nav-links" className={`lv2-nav__links${open ? ' lv2-open' : ''}`}>
          <a href="#platform" onClick={close}>Product</a>
          <a href="#aokie" onClick={close}>Aokie</a>
          <a href="#desktop" onClick={close}>Desktop</a>
          <a href="#marketplace" onClick={close}>Marketplace</a>
          <a href="#pricing" onClick={close}>Pricing</a>
          <Link to="/docs" onClick={close}>Docs</Link>
          <Link to="/login" onClick={close} className="lv2-nav__mobile-signin">
            Sign in
          </Link>
        </div>

        <div className="lv2-nav__actions">
          <Link to="/login" className="lv2-nav__signin">
            Sign in
          </Link>
          <Link to="/signup" className="lv2-nav__cta">
            Start free <ArrowRight size={15} />
          </Link>
          <button
            type="button"
            className="lv2-nav__menu"
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
            aria-controls="lv2-nav-links"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
    </nav>
  );
}
