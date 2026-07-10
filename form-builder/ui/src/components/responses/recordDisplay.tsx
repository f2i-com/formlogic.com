// Owner-scoped linked-record display COMPONENTS. Pure formatting helpers live in
// recordFormat.ts — this file exports only components so react fast-refresh keeps working.
import { Link2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ResolvedLink } from './recordFormat';

// Renders resolved linked records as chips. A chip is clickable when the caller wires
// `onOpen` (every current call site navigates to the record's own page — records are
// full pages now, never pop-ups).
export function LinkedRecordChips({ items, onOpen }: { items: ResolvedLink[]; onOpen?: (item: ResolvedLink) => void }) {
  if (!items.length) return <span className="text-gray-300 dark:text-slate-600">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1 max-w-full min-w-0">
      {items.map((it, i) => {
        const clickable = !!onOpen && !!it.targetFormId && it.display !== 'Record not found';
        return (
          <button
            key={it.id + i}
            type="button"
            disabled={!clickable}
            onClick={(e) => { e.stopPropagation(); if (clickable) onOpen(it); }}
            title={clickable ? `${it.display} — click to open` : it.display}
            className={cn(
              'inline-flex items-center gap-1 max-w-full min-w-0 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 transition-colors',
              clickable
                ? 'border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 cursor-pointer'
                : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 cursor-default'
            )}
          >
            <Link2 className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{it.display}</span>
          </button>
        );
      })}
    </span>
  );
}
