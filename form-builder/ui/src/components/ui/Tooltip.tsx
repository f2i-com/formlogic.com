import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { cn } from '../../lib/utils';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 200,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const tooltipId = useId();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const showTooltip = useCallback(() => {
    // Clear any pending timer so there is at most one in-flight; otherwise a
    // rapid leave/enter leaks timers and can flash a tooltip after the pointer left.
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(true), delay);
  }, [delay]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const arrows = {
    top: 'top-full left-1/2 -translate-x-1/2 border-t-gray-800 dark:border-t-slate-700',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-gray-800 dark:border-b-slate-700',
    left: 'left-full top-1/2 -translate-y-1/2 border-l-gray-800 dark:border-l-slate-700',
    right: 'right-full top-1/2 -translate-y-1/2 border-r-gray-800 dark:border-r-slate-700',
  };

  // Associate the tooltip with the trigger so screen readers announce it.
  const trigger = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-describedby': isVisible ? tooltipId : undefined,
      })
    : children;

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
      onTouchStart={showTooltip}
      onKeyDown={(e) => { if (e.key === 'Escape') hideTooltip(); }}
    >
      {trigger}
      {isVisible && (
        <div
          id={tooltipId}
          role="tooltip"
          className={cn(
            'absolute z-50 px-2.5 py-1.5 text-xs font-medium text-white',
            'bg-gray-800 dark:bg-slate-700 rounded-lg shadow-lg',
            'whitespace-nowrap animate-scale-in',
            positions[position]
          )}
        >
          {content}
          <div
            className={cn(
              'absolute w-0 h-0 border-4 border-transparent',
              arrows[position]
            )}
          />
        </div>
      )}
    </div>
  );
}
