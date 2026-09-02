import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Menu, Moon, Star, Sun, X } from 'lucide-react';
import { FormLogicMark } from './shared';
import { GITHUB_URL } from './stats';
import { useUIStore } from '../../stores/uiStore';

/**
 * Sticky dark marketing nav. In-page anchors for the sections, router links
 * for the product routes, and a proper aria-expanded hamburger under 900px.
 */
/**
 * GitHub's mark (Primer Octicons `mark-github`, MIT). lucide 1.x dropped every
 * brand icon, so the nav carries the one it needs.
 */
function GithubMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  // The same persisted theme the whole product uses (App syncs it onto <html>): the landing's
  // light bands, the docs page, and the app runtime all follow this toggle.
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);

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
          <Link to="/packs" onClick={close}>Marketplace</Link>
          <a href="#pricing" onClick={close}>Pricing</a>
          <Link to="/docs" onClick={close}>Docs</Link>
          <Link to="/login" onClick={close} className="lv2-nav__mobile-signin">
            Sign in
          </Link>
        </div>

        <div className="lv2-nav__actions">
          <button
            type="button"
            className="lv2-nav__theme"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Star FormLogic on GitHub"
            title="Star us on GitHub"
            className="lv2-nav__star"
          >
            <GithubMark size={15} />
            <span>Star</span>
            <Star size={13} className="lv2-nav__star-glyph" />
          </a>
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
