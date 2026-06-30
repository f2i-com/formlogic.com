import { cn } from '../../lib/utils';
import { Button } from './Button';

interface ShowMoreProps {
  /** How many items are currently shown. */
  shown: number;
  /** Total available. */
  total: number;
  onShowMore: () => void;
  /** Plural noun for the label, e.g. "forms" / "apps". */
  noun?: string;
  className?: string;
}

/**
 * Incremental "Show more" pagination footer for card grids — renders a centered button + a
 * "Showing X of Y" hint, and nothing once everything is shown.
 */
export function ShowMore({ shown, total, onShowMore, noun = 'items', className }: ShowMoreProps) {
  if (total <= shown) return null;
  return (
    <div className={cn('mt-5 flex flex-col items-center gap-1.5', className)}>
      <Button variant="outline" size="sm" onClick={onShowMore}>
        Show more {noun}
      </Button>
      <span className="text-xs text-gray-400 dark:text-slate-500">Showing {shown} of {total}</span>
    </div>
  );
}
