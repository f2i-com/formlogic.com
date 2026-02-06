import { cn } from '../../lib/utils';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary';
  size?: 'sm' | 'md';
}

export function Badge({
  className,
  variant = 'default',
  size = 'sm',
  children,
  ...props
}: BadgeProps) {
  const variants = {
    default: 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 ring-gray-200/50 dark:ring-slate-700/50',
    success: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 ring-green-200/50 dark:ring-green-500/20',
    warning: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-amber-200/50 dark:ring-amber-500/20',
    error: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 ring-red-200/50 dark:ring-red-500/20',
    info: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 ring-blue-200/50 dark:ring-blue-500/20',
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-400 ring-primary-200/50 dark:ring-primary-500/20',
  };

  const sizes = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded-md ring-1 ring-inset',
        'transition-colors duration-150',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
