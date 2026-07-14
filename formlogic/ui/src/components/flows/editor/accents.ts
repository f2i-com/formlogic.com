// FormLogic Flows editor — shared category-accent chip classes (Live Wire palette pass).
//
// The rainbow accent lives ONLY on a node's icon chip now (FlowNode + NodePalette both import
// this ONE definition instead of maintaining their own copies) — rings, borders and run-state
// color all speak in the primary token so brand color reads as "selected" / "executed", never
// as decoration. Kept as plain Tailwind class strings (not computed) so Tailwind's static
// analysis can see every class name used.
export const ACCENT_CHIP: Record<string, string> = {
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  teal: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  rose: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  slate: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};
