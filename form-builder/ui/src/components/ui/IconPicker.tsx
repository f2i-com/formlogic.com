import { useState, useRef, useEffect, useMemo } from 'react';
import { Image, X, Search } from 'lucide-react';
import { getLucideIcon, ICON_CATEGORIES } from '../../lib/iconUtils';
import { DynamicIcon } from './DynamicIcon';

interface IconPickerProps {
  value: string | undefined;
  onChange: (iconName: string | null) => void;
  className?: string;
}

export function IconPicker({ value, onChange, className }: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on click outside or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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
      setTimeout(() => searchRef.current?.focus(), 50);
    } else {
      setSearch('');
    }
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
    <div className={`relative ${className || ''}`} ref={containerRef}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer border border-transparent hover:border-gray-200 dark:hover:border-slate-700"
        title={value ? `Icon: ${value}` : 'Choose icon'}
        aria-label="Choose form icon"
      >
        {value ? (
          <DynamicIcon name={value} className="h-5 w-5 text-indigo-600 dark:text-primary-400" />
        ) : (
          <Image className="h-5 w-5 text-gray-400 dark:text-slate-500" />
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 w-80 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-700/60 z-50 overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-gray-100 dark:border-slate-800">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search icons..."
                className="w-full pl-8 pr-3 py-2 text-sm bg-gray-50 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>
          </div>

          {/* Clear button */}
          {value && (
            <div className="px-2 pt-2">
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
                Remove icon
              </button>
            </div>
          )}

          {/* Icons grid */}
          <div className="max-h-[320px] overflow-y-auto p-2">
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
                        onClick={() => { onChange(name); setOpen(false); }}
                        title={name}
                        className={`p-2 rounded-lg transition-colors cursor-pointer flex items-center justify-center ${
                          isSelected
                            ? 'bg-indigo-100 dark:bg-primary-500/20 text-indigo-600 dark:text-primary-400'
                            : 'hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400'
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
        </div>
      )}
    </div>
  );
}
