// The data manager's shared looks: every colour has a light value and a dark one. The sizes are
// the compact ones of the approved drawing (28px controls, 26px rows, 12px text). Below the `sm`
// breakpoint every control grows to a finger's reach (40px, 44px for the ones pressed most).
export const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';
export const muted = 'text-slate-500 dark:text-slate-400';
export const strong = 'text-slate-900 dark:text-white';
export const body = 'text-slate-700 dark:text-slate-300';
export const line = 'border-slate-200 dark:border-slate-800';
/** The quieter surface of the table list, the toolbar and the pager. */
export const quietSurface = 'bg-slate-50 dark:bg-slate-900/40';
export const link = 'text-primary-700 underline-offset-2 hover:underline dark:text-primary-300';
/** A text box or a select. */
export const field = `h-7 rounded-md border border-slate-300 bg-white text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100 max-sm:h-10 ${focusRing}`;
/** A small outlined button in a toolbar. */
export const smallButton = `inline-flex h-6 flex-none items-center justify-center gap-1 rounded-md border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 max-sm:h-10 max-sm:px-3 ${focusRing}`;
/** Over `smallButton` (through `cn`), for what cannot be undone. */
export const danger = 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-500/10';
/** The one filled button of a form. */
export const primaryButton = `inline-flex h-7 flex-none items-center justify-center gap-1.5 rounded-md bg-primary-600 px-3 text-xs font-semibold text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-primary-500 max-sm:h-10 ${focusRing}`;
/** A square button that holds one icon. */
export const iconButton = `inline-flex h-6 w-6 flex-none items-center justify-center rounded-md text-slate-600 hover:bg-slate-200/70 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-800 dark:disabled:text-slate-600 max-sm:h-11 max-sm:w-11 ${focusRing}`;
/** The small capital heading of a panel. */
export const panelHeading = 'text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400';
export const panel = 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70';
/** A row that is ticked, in the grid and as a card. */
export const tickedRow = 'bg-primary-50 dark:bg-primary-500/[0.08]';
/** The row whose details are open. */
export const openRow = 'bg-primary-50 dark:bg-primary-500/10';
