import { Bot, Loader2 } from 'lucide-react';
import { useBotGuideStore } from '../../stores/botGuideStore';
import { cn } from '../../lib/utils';

interface BotGuideToggleProps {
  /** 'landing' matches LandingNav's compact icon button style; 'header' matches workspace ThemeToggle. */
  variant?: 'landing' | 'header';
  className?: string;
}

/**
 * Compact, unobtrusive toggle for FormLogic's optional bot.computer interactive guide.
 */
export function BotGuideToggle({ variant = 'header', className }: BotGuideToggleProps) {
  const enabled = useBotGuideStore((s) => s.enabled);
  const status = useBotGuideStore((s) => s.status);
  const toggleEnabled = useBotGuideStore((s) => s.toggleEnabled);

  const label = enabled
    ? 'Hide interactive guide (bot.computer)'
    : 'Show interactive guide (bot.computer)';

  if (variant === 'landing') {
    return (
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
    );
  }

  return (
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
  );
}
