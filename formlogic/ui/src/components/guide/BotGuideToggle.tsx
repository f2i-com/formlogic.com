import { useEffect } from 'react';
import { Bot, Loader2, Sparkles, X } from 'lucide-react';
import { useBotGuideStore } from '../../stores/botGuideStore';
import { cn } from '../../lib/utils';
import { isGuideHiddenPath } from './formlogicAiml';

interface BotGuideToggleProps {
  /** 'landing' matches LandingNav's compact icon button style; 'header' matches workspace ThemeToggle. */
  variant?: 'landing' | 'header';
  className?: string;
}

/**
 * Compact, unobtrusive toggle for FormLogic's optional bot.computer interactive guide,
 * paired with a friendly first-visit speech bubble up top ("Press here for a guided tour").
 */
export function BotGuideToggle({ variant = 'header', className }: BotGuideToggleProps) {
  const enabled = useBotGuideStore((s) => s.enabled);
  const status = useBotGuideStore((s) => s.status);
  const tourCalloutDismissed = useBotGuideStore((s) => s.tourCalloutDismissed);
  const toggleEnabled = useBotGuideStore((s) => s.toggleEnabled);
  const requestAsk = useBotGuideStore((s) => s.requestAsk);
  const dismissTourCallout = useBotGuideStore((s) => s.dismissTourCallout);

  const inIframe = typeof window !== 'undefined' && window.self !== window.top;
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
  const hiddenByRoute = isGuideHiddenPath(pathname) || pathname.startsWith('/login') || pathname.startsWith('/signup');
  const showTourCallout = !enabled && !tourCalloutDismissed && !inIframe && !hiddenByRoute;

  useEffect(() => {
    if (!showTourCallout) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissTourCallout();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showTourCallout, dismissTourCallout]);

  const label = enabled
    ? 'Hide interactive guide (bot.computer)'
    : 'Show interactive guide (bot.computer)';

  const handleStartGuidedTour = () => {
    dismissTourCallout();
    requestAsk('Take me on a tour');
  };

  const calloutBubble = showTourCallout ? (
    <div
      data-fl-tour-callout="1"
      className={cn(
        'absolute right-0 top-full z-50 mt-2.5 max-sm:mt-1 flex items-center gap-1.5 rounded-2xl border px-3 py-2 max-sm:px-2.5 max-sm:py-1 text-xs max-sm:text-[11px] font-semibold shadow-xl whitespace-nowrap',
        'animate-fade-in',
        variant === 'landing'
          ? 'border-indigo-400/70 bg-indigo-600 text-white shadow-indigo-950/40 max-sm:-right-12'
          : 'border-indigo-500/80 bg-indigo-600 text-white shadow-indigo-900/25 dark:border-lime-400/60 dark:bg-slate-900 dark:text-white dark:shadow-black/50',
      )}
    >
      {/* Upward-pointing speech bubble tail aimed at the Guided Tour button */}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute -top-1.5 right-3.5 h-3 w-3 rotate-45 border-l border-t',
          variant === 'landing'
            ? 'border-indigo-400/70 bg-indigo-600 max-sm:right-[3.85rem]'
            : 'border-indigo-500/80 bg-indigo-600 dark:border-lime-400/60 dark:bg-slate-900',
        )}
      />
      <button
        type="button"
        onClick={handleStartGuidedTour}
        className="relative z-10 inline-flex cursor-pointer items-center gap-1.5 text-left text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-200 dark:text-lime-300" aria-hidden="true" />
        <span>Press here for a guided tour</span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          dismissTourCallout();
        }}
        aria-label="Dismiss guided tour hint"
        title="Dismiss"
        className="relative z-10 -mr-1 inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  ) : null;

  if (variant === 'landing') {
    return (
      <div className="relative inline-flex items-center">
        <button
          type="button"
          onClick={toggleEnabled}
          aria-label={label}
          aria-pressed={enabled}
          title={label}
          className={cn(
            'lv2-nav__theme relative',
            enabled && '!border-[var(--fl-intro-accent)] !bg-[var(--fl-intro-accent-soft)] !text-[var(--fl-intro-accent)]',
            className,
          )}
        >
          {status === 'loading' ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <Bot size={16} aria-hidden="true" />
          )}
          {enabled && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400"
            />
          )}
        </button>
        {calloutBubble}
      </div>
    );
  }

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={toggleEnabled}
        aria-label={label}
        aria-pressed={enabled}
        title={label}
        className={cn(
          'relative inline-flex h-10 w-10 items-center justify-center rounded-xl border transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          enabled
            ? 'border-primary-300 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/40 dark:bg-primary-500/15 dark:text-primary-300 dark:hover:bg-primary-500/25'
            : 'border-transparent text-gray-500 hover:border-gray-200 hover:bg-gray-100 hover:text-gray-700 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200',
          className,
        )}
      >
        {status === 'loading' ? (
          <Loader2 className="h-4.5 w-4.5 animate-spin" aria-hidden="true" />
        ) : (
          <Bot className="h-4.5 w-4.5" aria-hidden="true" />
        )}
        {enabled && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900"
          />
        )}
      </button>
      {calloutBubble}
    </div>
  );
}
