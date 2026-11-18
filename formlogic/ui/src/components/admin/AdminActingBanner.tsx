import { useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import type { AdminActing } from './AdminActingContext';

/**
 * The always-visible "you are acting as a platform admin" bar above a reused
 * owner UI. Sets the same --fl-demo-banner-h CSS variable the demo banner uses
 * so full-height pages (FlowsWorkspace's 100dvh calc) fit without layout edits
 * — the two can never collide because the demo account is never an admin.
 */
export function AdminActingBanner({ acting }: { acting: AdminActing }) {
  const navigate = useNavigate();
  const banner = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = banner.current;
    if (!element) return;
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--fl-demo-banner-h');
    const measure = () => root.style.setProperty('--fl-demo-banner-h', `${Math.ceil(element.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(element);
    else window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      if (prev) root.style.setProperty('--fl-demo-banner-h', prev);
      else root.style.removeProperty('--fl-demo-banner-h');
    };
  }, []);

  return (
    // z-40 matches DemoBanner: above the page headers (z-30), BELOW modals/
    // ConfirmDialogs (z-50) so overlays are never painted over by the bar.
    <aside ref={banner} aria-label="Administrator access" className="sticky top-0 z-40 flex items-center justify-between gap-x-3 bg-amber-100 px-3 py-1.5 text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-100">
      <div className="flex min-w-0 items-start gap-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0 text-xs leading-5 sm:text-sm">
          <span className="font-medium">Admin access to <strong className="[overflow-wrap:anywhere]">{acting.ownerEmail}</strong>.</span>{' '}
          <span className="block sm:inline">Record data is hidden. Changes are live for the owner.</span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => navigate(`/admin/users/${acting.ownerId}`)}
        className="min-h-11 shrink-0 rounded-md border border-amber-700/40 px-3 text-xs font-semibold hover:bg-amber-950/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:border-amber-300/50 dark:hover:bg-amber-100/10 sm:min-h-8"
      >
        Exit admin view
      </button>
    </aside>
  );
}
