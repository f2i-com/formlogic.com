import { useState } from 'react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { LogoMark } from '../ui/Logo';
import { cn } from '../../lib/utils';
import { panelColors, type AppWelcome } from '../../lib/appWelcome';

/**
 * How the site's sign-in and sign-up pages show the app a visitor is signing in to use, in its colours and words. The
 * headings stay the site's ("Sign in to {app}"), as does its mark and the line that it is this site's account; the
 * owner's words come under the app's name, as plain text.
 */

type Mode = 'login' | 'signup';

function defaultTitle(welcome: AppWelcome, mode: Mode): string {
  return mode === 'signup' ? `Join ${welcome.app.name}` : `Welcome to ${welcome.app.name}`;
}

/** The app's logo, icon or first letter, on a tile that reads on its panel. */
export function AppWelcomeMark({ welcome, ink, size = 'md' }: { welcome: AppWelcome; ink: 'light' | 'dark'; size?: 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const box = size === 'lg' ? 'h-14 w-14 rounded-2xl' : 'h-11 w-11 rounded-xl';
  const monogram = (welcome.app.name.trim().charAt(0) || '?').toUpperCase();
  if (welcome.app.logo && !failed) {
    return (
      <span className={cn('flex flex-none items-center justify-center overflow-hidden bg-white ring-1 ring-black/5', box)}>
        <img src={welcome.app.logo} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className={cn('flex flex-none items-center justify-center', box, ink === 'light' ? 'bg-white/15 text-white ring-1 ring-inset ring-white/25' : 'bg-black/[0.07] text-slate-900 ring-1 ring-inset ring-black/10')} aria-hidden="true">
      {welcome.app.icon
        ? <DynamicIcon name={welcome.app.icon} className={size === 'lg' ? 'h-7 w-7' : 'h-5 w-5'} fallback={<span className="text-lg font-semibold">{monogram}</span>} />
        : <span className="text-lg font-semibold">{monogram}</span>}
    </span>
  );
}

/** The site's own line: whose account this is. */
function SiteAccount({ ink }: { ink: 'light' | 'dark' }) {
  return (
    <p className={cn('flex items-center gap-2 text-sm', ink === 'light' ? 'text-white/75' : 'text-slate-700')}>
      <LogoMark size={18} />
      <span>You sign in with your FormLogic account.</span>
    </p>
  );
}

/** The large panel beside the form (the split layout, on wide screens). */
export function AppWelcomePanel({ welcome, mode, className, compact = false }: { welcome: AppWelcome; mode: Mode; className?: string; compact?: boolean }) {
  const colors = panelColors(welcome.look);
  const ink = colors?.ink ?? 'light';
  return (
    <div
      data-testid="app-welcome-panel"
      className={cn('relative flex-col justify-between gap-6 overflow-hidden', compact ? 'p-5' : 'p-12', !colors && 'bg-gradient-to-br from-primary-700 via-primary-800 to-slate-900', ink === 'light' ? 'text-white' : 'text-slate-900', className)}
      style={colors ? { backgroundColor: colors.background } : undefined}
    >
      <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-[110px]" aria-hidden="true" />
      <div className="relative z-10 flex items-center gap-3">
        <AppWelcomeMark welcome={welcome} ink={ink} size={compact ? 'md' : 'lg'} />
        <span className={cn('font-semibold tracking-tight', compact ? 'text-base' : 'text-xl')}>{welcome.app.name}</span>
      </div>
      <div className="relative z-10">
        <p className={cn('font-bold tracking-tight', compact ? 'mb-2 text-xl' : 'mb-4 text-4xl')}>{welcome.text.title ?? defaultTitle(welcome, mode)}</p>
        {welcome.text.message && <p className={cn('whitespace-pre-line leading-relaxed', compact ? 'text-sm' : 'text-lg', ink === 'light' ? 'text-white/85' : 'text-slate-800')}>{welcome.text.message}</p>}
      </div>
      <div className="relative z-10"><SiteAccount ink={ink} /></div>
    </div>
  );
}

/** The app's banner over the form: for the centered layout, and in place of the panel on narrow screens. */
export function AppWelcomeBanner({ welcome, mode, className }: { welcome: AppWelcome; mode: Mode; className?: string }) {
  const colors = panelColors(welcome.look);
  const ink = colors?.ink ?? 'light';
  return (
    <div
      data-testid="app-welcome-banner"
      className={cn('mb-8 overflow-hidden rounded-2xl p-5', !colors && 'bg-gradient-to-br from-primary-700 to-primary-900', ink === 'light' ? 'text-white' : 'text-slate-900', className)}
      style={colors ? { backgroundColor: colors.background } : undefined}
    >
      <div className="flex items-center gap-3">
        <AppWelcomeMark welcome={welcome} ink={ink} />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight">{welcome.app.name}</p>
          <p className={cn('text-sm', ink === 'light' ? 'text-white/80' : 'text-slate-700')}>{welcome.text.title ?? defaultTitle(welcome, mode)}</p>
        </div>
      </div>
      {welcome.text.message && <p className={cn('mt-3 whitespace-pre-line text-sm leading-relaxed', ink === 'light' ? 'text-white/85' : 'text-slate-800')}>{welcome.text.message}</p>}
    </div>
  );
}
