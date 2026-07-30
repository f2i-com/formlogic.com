import React from 'react';
import { cn } from '../../lib/utils';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'iconOnly';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const variants = {
      primary:
        'bg-primary-600 text-primary-foreground hover:bg-primary-700 dark:hover:bg-primary-500 focus:ring-primary-500 active:bg-primary-800 dark:active:bg-primary-700 shadow-md shadow-primary-600/15 dark:shadow-lg dark:shadow-primary-500/20 dark:hover:shadow-primary-500/30 border border-transparent',
      secondary:
        'bg-white dark:bg-slate-800/80 text-gray-700 dark:text-slate-100 hover:bg-gray-50 dark:hover:bg-slate-700 focus:ring-gray-500 dark:focus:ring-slate-500 active:bg-gray-100 dark:active:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-sm',
      outline:
        'border border-gray-300 dark:border-slate-700 bg-transparent text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-white dark:hover:border-slate-600 focus:ring-primary-500 active:bg-gray-100 dark:active:bg-slate-900',
      ghost:
        'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-white focus:ring-gray-500 dark:focus:ring-slate-500 active:bg-gray-200 dark:active:bg-slate-900/80',
      danger:
        'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-500 border border-red-200 dark:border-red-500/50 hover:bg-red-100 dark:hover:bg-red-500/20 focus:ring-red-500 active:bg-red-200 dark:active:bg-red-500/30 dark:hover:border-red-500',
    };

    const sizes = {
      // max-sm:min-h-11 — `sm` renders ~30px tall, under the ~44px a finger reliably
      // hits, and it is the size used for most row and header actions. Phones get the
      // full target; desktop keeps the compact height dense toolbars are built around.
      sm: 'px-3 py-1.5 text-xs font-medium gap-1.5 max-sm:min-h-11',
      md: 'px-4 py-2 text-sm font-medium gap-2',
      lg: 'px-6 py-2.5 text-[15px] font-semibold gap-2.5',
      // Square icon-only button with a guaranteed >=40px touch target
      iconOnly: 'h-10 w-10 p-0 gap-0',
    };

    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-lg',
          'transition-all duration-200 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
          'cursor-pointer',
          'active:scale-[0.97]',
          variants[variant],
          sizes[size],
          className
        )}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          leftIcon
        )}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  }
);

Button.displayName = 'Button';

export { Button };
