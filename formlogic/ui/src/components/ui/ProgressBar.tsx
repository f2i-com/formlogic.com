import { cn } from '../../lib/utils';

interface ProgressBarProps {
  value: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  color?: 'primary' | 'success' | 'warning' | 'error';
  /** Explicit bar color (e.g. a form's theme primaryColor). Overrides the `color` preset. */
  barColor?: string;
  showLabel?: boolean;
  animated?: boolean;
  className?: string;
}

export function ProgressBar({
  value,
  max = 100,
  size = 'md',
  color = 'primary',
  barColor,
  showLabel = false,
  animated = true,
  className,
}: ProgressBarProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  const sizes = {
    sm: 'h-1',
    md: 'h-2',
    lg: 'h-3',
  };

  const colors = {
    primary: {
      bar: 'bg-gradient-to-r from-primary-500 to-primary-600',
      glow: 'shadow-[0_0_8px_rgb(var(--primary-500)/0.4)]',
    },
    success: {
      bar: 'bg-gradient-to-r from-green-400 to-green-500',
      glow: 'shadow-[0_0_8px_rgba(34,197,94,0.4)]',
    },
    warning: {
      bar: 'bg-gradient-to-r from-amber-400 to-amber-500',
      glow: 'shadow-[0_0_8px_rgba(245,158,11,0.4)]',
    },
    error: {
      bar: 'bg-gradient-to-r from-red-400 to-red-500',
      glow: 'shadow-[0_0_8px_rgba(239,68,68,0.4)]',
    },
  };

  return (
    <div className={cn('w-full', className)}>
      {showLabel && (
        <div className="flex justify-between text-sm mb-1.5">
          <span className="font-medium text-gray-700 dark:text-slate-300">Progress</span>
          <span className="text-gray-500 dark:text-slate-400">{Math.round(percentage)}%</span>
        </div>
      )}
      <div
        className={cn(
          'w-full bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden',
          sizes[size]
        )}
      >
        <div
          className={cn(
            'h-full rounded-full',
            animated && 'transition-all duration-500 ease-out',
            !barColor && colors[color].bar,
            !barColor && percentage > 0 && colors[color].glow
          )}
          style={barColor ? { width: `${percentage}%`, backgroundColor: barColor } : { width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-label="Progress"
        />
      </div>
    </div>
  );
}
