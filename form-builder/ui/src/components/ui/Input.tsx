import React from 'react';
import { cn } from '../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  /** Decorative (non-interactive) icon on the right. */
  rightIcon?: React.ReactNode;
  /** Interactive control on the right (e.g. a show/hide-password button). */
  rightElement?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, leftIcon, rightIcon, rightElement, id, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id || generatedId;
    const errorId = error ? `${inputId}-error` : undefined;
    const hintId = hint && !error ? `${inputId}-hint` : undefined;
    const describedBy = errorId || hintId || undefined;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 dark:text-slate-500">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(
              'block w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 px-3.5 py-2.5',
              'text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500',
              'transition-all duration-200 ease-out',
              'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
              'hover:border-gray-400 dark:hover:border-slate-600',
              'disabled:bg-gray-100 dark:disabled:bg-slate-800/50 disabled:text-gray-500 dark:disabled:text-slate-600 disabled:cursor-not-allowed disabled:hover:border-gray-300 dark:disabled:hover:border-slate-800',
              error && 'border-red-400 focus:ring-red-500/20 focus:border-red-500 hover:border-red-400',
              leftIcon && 'pl-10',
              (rightIcon || rightElement) && 'pr-10',
              className
            )}
            {...props}
          />
          {rightIcon && !rightElement && (
            <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-gray-400 dark:text-slate-500">
              {rightIcon}
            </div>
          )}
          {rightElement && (
            <div className="absolute inset-y-0 right-0 pr-2 flex items-center">
              {rightElement}
            </div>
          )}
        </div>
        {error && (
          <p id={errorId} className="mt-1.5 text-sm text-red-600 dark:text-red-400 flex items-center gap-1" role="alert">
            <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={hintId} className="mt-1.5 text-sm text-gray-500 dark:text-slate-400">{hint}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input };
