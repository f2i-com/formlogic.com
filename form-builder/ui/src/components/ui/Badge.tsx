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
    default: 'bg-gray-100 text-gray-700 ring-gray-200/50',
    success: 'bg-green-50 text-green-700 ring-green-200/50',
    warning: 'bg-amber-50 text-amber-700 ring-amber-200/50',
    error: 'bg-red-50 text-red-700 ring-red-200/50',
    info: 'bg-blue-50 text-blue-700 ring-blue-200/50',
    primary: 'bg-primary-50 text-primary-700 ring-primary-200/50',
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
