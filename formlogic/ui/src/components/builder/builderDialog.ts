// The frame of the builder's own dialogs: form settings, theme, script, share, keyboard
// shortcuts and the template chooser.
//
// They are not the shared Modal (ui/Modal): each holds unsaved work, so it guards Escape itself
// and does not close on a click outside it. These are that Modal's classes, so the six look like
// every other dialog of the product: the same plain head (a name and one line under it, no
// picture), the same corners, and on a phone the same sheet at the bottom of the screen that
// clears the home indicator.
import { cn } from '../../lib/utils';

export const DIALOG_OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm max-sm:items-end max-sm:p-0';

/** The box itself. Give it a width (`max-w-…`) beside this. */
export const DIALOG_PANEL = cn(
  'relative flex w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl shadow-black/20 focus:outline-none dark:bg-slate-900',
  'border border-gray-200/50 ring-1 ring-black/5 dark:border-slate-800 dark:ring-white/[0.06]',
  // dvh, not vh: the height a phone really shows with its toolbars out.
  'max-h-[90dvh] max-sm:max-h-[85dvh] max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]',
);

export const DIALOG_HEADER = 'flex shrink-0 items-start justify-between gap-2 border-b border-gray-200/80 bg-gray-50/80 px-4 py-3 dark:border-slate-800 dark:bg-white/[0.02] sm:px-6 sm:py-4';
export const DIALOG_TITLE = 'break-words text-base font-semibold tracking-tight text-gray-900 dark:text-white sm:text-lg';
export const DIALOG_DESCRIPTION = 'mt-1 text-sm text-gray-500 dark:text-slate-400';
export const DIALOG_CLOSE = '-m-1 inline-flex min-h-11 min-w-11 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white';
export const DIALOG_FOOTER = 'shrink-0 border-t border-gray-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900 sm:px-6';

/** A dialog's sections, as a page's are (ui/SectionNav): one underlined row, which scrolls sideways
 *  where it is longer than the dialog; on a phone every one in view, wrapped onto as many lines as
 *  they need, each a button of its own at a finger's height without its icon. */
export const DIALOG_TABS = 'flex shrink-0 overflow-x-auto border-b border-gray-200 px-2 scrollbar-hide dark:border-slate-800 sm:px-4 max-sm:flex-wrap max-sm:gap-1.5 max-sm:overflow-visible max-sm:px-4 max-sm:py-2';

export function dialogTab(active: boolean): string {
  return cn(
    '-mb-px flex min-h-11 flex-none cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium motion-safe:transition-colors',
    'rounded-t-md focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 max-sm:[&>svg]:hidden',
    // On a phone, a button of its own on a line that wraps: no underline, a fill (as SectionNav's).
    'max-sm:mb-0 max-sm:rounded-lg max-sm:border-b-0',
    active
      ? 'border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 max-sm:bg-primary-100 max-sm:text-primary-800 dark:max-sm:bg-primary-500/20 dark:max-sm:text-primary-200'
      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200 max-sm:bg-gray-100 max-sm:text-gray-700 dark:max-sm:bg-white/5 dark:max-sm:text-slate-200',
  );
}

/** A small heading over a group of settings inside a dialog or a side panel. */
export const GROUP_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400';
