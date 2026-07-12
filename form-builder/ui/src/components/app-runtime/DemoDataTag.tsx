import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { cn } from '../../lib/utils';

// One flag per browser: the disclaimer card auto-opens on the visitor's FIRST demo
// app and stays closed afterwards (the pill remains and can re-open it any time).
const NOTICE_KEY = 'fl-demo-data-notice-v1';

const readNoticeSeen = () => {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return true; // storage blocked → don't nag on every navigation
  }
};

const markNoticeSeen = () => {
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    /* storage blocked — the pill still re-opens the card on demand */
  }
};

/**
 * Corner "Demo" tag shown on every screen of an app runtime while the shared Demo
 * account is active, so gallery visitors never mistake the sample records for real
 * people or businesses. The attached disclaimer card auto-opens once per browser
 * and can be re-opened from the tag. Renders nothing for real accounts.
 */
export function DemoDataTag() {
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const config = useAppRuntimeStore((s) => s.config);
  const [open, setOpen] = useState(() => !readNoticeSeen());

  if (!isDemo) return null;

  const dismiss = () => {
    markNoticeSeen();
    setOpen(false);
  };

  // Chromeless apps park their Records/Reports quick-access cluster at the
  // bottom-right corner — lift the tag above it so the two never overlap.
  const hideNav = (config?.app?.settings as { hideNav?: boolean } | undefined)?.hideNav === true;

  return (
    // Mobile: bottom-left, above the in-flow bottom nav. Desktop: bottom-right —
    // the sidebar's Profile/theme footer owns the bottom-left corner there.
    // Below modals/drawers (z-50).
    <div
      className={cn(
        'fixed left-4 bottom-[4.5rem] md:left-auto md:right-4 z-40',
        hideNav ? 'md:bottom-16' : 'md:bottom-4'
      )}
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      {open && (
        <div
          role="region"
          aria-label="Demo data notice"
          className="absolute bottom-full left-0 md:left-auto md:right-0 mb-2 w-72 rounded-2xl border border-amber-300/60 dark:border-amber-400/30 bg-white dark:bg-slate-900 p-4 shadow-xl shadow-black/20"
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-400/15">
              <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">This is demo data</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-600 dark:text-slate-400">
                Everything in this app is fictional sample data — the names, people, contact
                details and records aren&apos;t real. It&apos;s here so you can explore how the app works.
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss demo data notice"
              className="-mr-1 -mt-1 flex-shrink-0 rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="mt-3 w-full rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-300 cursor-pointer"
          >
            Got it
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => (open ? dismiss() : setOpen(true))}
        aria-expanded={open}
        aria-label="Demo app — view the demo data notice"
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/70 dark:border-amber-400/40 bg-white/90 dark:bg-slate-900/90 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 shadow-lg shadow-black/10 backdrop-blur-md transition hover:bg-amber-50 dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Demo
      </button>
    </div>
  );
}
