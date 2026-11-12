import type { NativeLook } from '../../lib/appLook';

/**
 * What a hosted SoftN app shows while it opens: its loading background and a wheel in its colour,
 * no words (a screen reader hears the label). The same in the page while the app downloads and
 * over the frame until the app's first page is drawn, so one wheel turns from start to finish.
 * Someone who asked for less motion sees it pulse slowly.
 */
export function AppSplash({ look, label = 'Opening the app', className = '' }: { look?: NativeLook | null; label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="app-splash"
      className={`flex h-full w-full items-center justify-center ${look?.background ? '' : 'bg-white dark:bg-slate-950'} ${className}`}
      style={look?.background ? { background: look.background } : undefined}
    >
      <span
        aria-hidden="true"
        className={`h-10 w-10 rounded-full border-[3.5px] border-r-transparent motion-safe:animate-spin motion-reduce:animate-pulse ${look?.spinner ? '' : 'border-primary-500 border-r-transparent dark:border-primary-400 dark:border-r-transparent'}`}
        style={look?.spinner ? { borderColor: look.spinner, borderRightColor: 'transparent' } : undefined}
      />
    </div>
  );
}
