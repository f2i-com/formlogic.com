import React, { useState, useId, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface DropdownProps {
  options: DropdownOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  disabled?: boolean;
  className?: string;
}

export function Dropdown({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  label,
  error,
  disabled,
  className,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      // The menu is portaled to <body>, so it's outside dropdownRef — exclude it
      // explicitly or clicking an option would close before selecting.
      if (
        (dropdownRef.current && dropdownRef.current.contains(target)) ||
        (listRef.current && listRef.current.contains(target))
      ) {
        return;
      }
      setIsOpen(false);
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Track the trigger's viewport position so the portaled menu (fixed) can be
  // placed beneath it; recompute on scroll/resize while open.
  useEffect(() => {
    if (!isOpen) {
      setMenuRect(null);
      return;
    }
    const update = () => {
      if (triggerRef.current) setMenuRect(triggerRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const selectedIdx = options.findIndex((opt) => opt.value === value);
      setFocusedIndex(selectedIdx >= 0 ? selectedIdx : 0);
    } else {
      setFocusedIndex(-1);
    }
  }, [isOpen, options, value]);

  useEffect(() => {
    if (isOpen && focusedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll<HTMLElement>('[role="option"]');
      items[focusedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex, isOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setFocusedIndex((prev) => Math.min(prev + 1, options.length - 1));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (isOpen && focusedIndex >= 0) {
          onChange(options[focusedIndex].value);
          setIsOpen(false);
        } else {
          setIsOpen(true);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
      case 'Home':
        if (isOpen) {
          e.preventDefault();
          setFocusedIndex(0);
        }
        break;
      case 'End':
        if (isOpen) {
          e.preventDefault();
          setFocusedIndex(options.length - 1);
        }
        break;
    }
  }, [disabled, isOpen, focusedIndex, options, onChange]);

  const listboxId = `dropdown${useId()}`;

  return (
    <div className={cn('w-full', className)} ref={dropdownRef}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={isOpen ? listboxId : undefined}
          aria-activedescendant={isOpen && focusedIndex >= 0 ? `${listboxId}-option-${focusedIndex}` : undefined}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          className={cn(
            'w-full flex items-center justify-between gap-2 px-3 py-2',
            'bg-white dark:bg-slate-900/50 border border-gray-300 dark:border-slate-700 rounded-lg text-left',
            'text-gray-900 dark:text-white',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:border-transparent',
            disabled && 'bg-gray-50 dark:bg-slate-800/50 cursor-not-allowed opacity-50',
            error && 'border-red-500'
          )}
        >
          <span className={cn(!selectedOption && 'text-gray-400 dark:text-slate-500')}>
            {selectedOption ? (
              <span className="flex items-center gap-2">
                {selectedOption.icon}
                {selectedOption.label}
              </span>
            ) : (
              placeholder
            )}
          </span>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-gray-400 dark:text-slate-500 transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </button>

        {isOpen && menuRect && createPortal(
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={label || placeholder}
            style={(() => {
              // Flip up when there isn't room below, and cap the height to the
              // available space so the menu never renders off-screen at the bottom.
              const spaceBelow = window.innerHeight - menuRect.bottom;
              const spaceAbove = menuRect.top;
              const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
              return {
                position: 'fixed' as const,
                left: menuRect.left,
                width: menuRect.width,
                maxHeight: Math.max(120, Math.min(240, (openUp ? spaceAbove : spaceBelow) - 8)),
                ...(openUp
                  ? { bottom: window.innerHeight - menuRect.top + 4 }
                  : { top: menuRect.bottom + 4 }),
              };
            })()}
            className="z-[70] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg overflow-auto animate-scale-in"
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                onMouseEnter={() => setFocusedIndex(index)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer',
                  'transition-colors',
                  'text-gray-900 dark:text-slate-200',
                  option.value === value && 'bg-primary-50 dark:bg-primary-900/10 text-primary-700 dark:text-primary-400',
                  focusedIndex === index && option.value !== value && 'bg-gray-50 dark:bg-slate-800',
                )}
              >
                {option.icon}
                {option.label}
              </div>
            ))}
          </div>,
          document.body
        )}
      </div>
      {error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
