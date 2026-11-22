import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Image, X, Search } from 'lucide-react';
import { getLucideIcon, ICON_CATEGORIES } from '../../lib/iconUtils';
import { useFloatingPopover } from '../../hooks/useFloatingPopover';
import { DynamicIcon } from './DynamicIcon';

interface IconPickerProps {
  value: string | undefined;
  onChange: (iconName: string | null) => void;
  className?: string;
  ariaLabel?: string;
}

export function IconPicker({
  value,
  onChange,
  className,
  ariaLabel = 'Choose form icon',
}: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const floating = useFloatingPopover(open, triggerRef, {
    width: 320,
    estimatedHeight: 280,
    maxHeight: 380,
    align: 'left',
  });

  // Close on click outside or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (triggerRef.current && triggerRef.current.contains(target)) ||
        (popoverRef.current && popoverRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Focus search when opened
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => searchRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset search draft synchronously when the picker closes (open state change)
    setSearch('');
  }, [open]);

  // Filter icons by search
  const filteredCategories = useMemo(() => {
    if (!search.trim()) return ICON_CATEGORIES;
    const q = search.toLowerCase();
    const result: Record<string, string[]> = {};
    for (const [cat, names] of Object.entries(ICON_CATEGORIES)) {
      const matched = names.filter((n) => n.toLowerCase().includes(q));
      if (matched.length > 0) result[cat] = matched;
    }
    return result;
  }, [search]);

  const hasResults = Object.keys(filteredCategories).length > 0;

  return (
    <div className={`relative inline-flex ${className || ''}`}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center justify-center min-h-[40px] min-w-[40px] rounded-lg transition-colors cursor-pointer border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
          open
            ? 'bg-gray-100 dark:bg-slate-800 border-primary-400/70 dark:border-primary-500/60'
            : 'hover:bg-gray-100 dark:hover:bg-slate-800 border-transparent hover:border-gray-200 dark:hover:border-slate-700'
        }`}
        title={value ? `Icon: ${value}` : 'Choose icon'}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {value ? (
          <DynamicIcon name={value} className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        ) : (
          <Image className="h-5 w-5 text-gray-400 dark:text-slate-500" />
        )}
      </button>

      {/* Portaled popover so it always renders above cards, CSS columns, sticky bars & modals */}
      {open && floating && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Icon picker"
          style={floating.style}
          className={`flex flex-col bg-white dark:bg-slate-900 rounded-xl shadow-2xl shadow-gray-900/15 dark:shadow-black/50 border border-gray-200/90 dark:border-slate-700/80 z-[200] overflow-hidden animate-scale-in ${
            floating.placement === 'top' ? 'origin-bottom-left' : 'origin-top-left'
          }`}
        >
          {/* Search */}
          <div className="shrink-0 p-2 border-b border-gray-100 dark:border-slate-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search icons..."
                aria-label="Search icons"
                className="w-full pl-8 pr-3 py-2 text-sm bg-gray-50 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>
          </div>

          {/* Clear button */}
          {value && (
            <div className="shrink-0 px-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
                Remove icon
              </button>
            </div>
          )}

          {/* Icons grid */}
          <div className="flex-1 min-h-0 overflow-y-auto p-2 scrollbar-thin">
            {!hasResults && (
              <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-6">No icons found</p>
            )}
            {Object.entries(filteredCategories).map(([category, names]) => (
              <div key={category} className="mb-3 last:mb-0">
                <p className="text-[11px] font-medium text-gray-400 dark:text-slate-500 uppercase tracking-wider px-1 mb-1.5">
                  {category}
                </p>
                <div className="grid grid-cols-8 gap-0.5">
                  {names.map((name) => {
                    const Icon = getLucideIcon(name);
                    if (!Icon) return null;
                    const isSelected = value === name;
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => {
                          onChange(name);
                          setOpen(false);
                          triggerRef.current?.focus();
                        }}
                        title={name}
                        aria-label={name}
                        aria-pressed={isSelected}
                        className={`p-2 rounded-lg transition-colors cursor-pointer flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                          isSelected
                            ? 'bg-primary-50 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 ring-1 ring-inset ring-primary-500/30'
                            : 'hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-200'
                        }`}
                      >
                        <Icon className="h-4.5 w-4.5" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
