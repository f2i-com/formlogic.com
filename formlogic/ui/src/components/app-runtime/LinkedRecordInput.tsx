import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Loader2, ChevronDown, Check } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useFloatingPopover } from '../../hooks/useFloatingPopover';
import type { LinkedRecord } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useDisplayTimezone, formatDateInZone } from '../../lib/timezone';

interface LinkedRecordInputProps {
  formId: string;
  targetFormId: string;
  displayFieldIds?: string[];
  searchFieldIds?: string[];
  allowMultiple?: boolean;
  value: unknown;
  onChange: (val: unknown) => void;
  primaryColor: string;
  /** Optional custom placeholder text (defaults to "Select or search records..."). */
  placeholder?: string;
  /** Compact sizing for modals and inline edit tables. */
  compact?: boolean;
  /**
   * Optional lookup override. In the app runtime this defaults to the app-scoped store lookup;
   * standalone/pack forms pass an owner-scoped lookup so linked records work without an app.
   */
  lookup?: (formId: string, options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; offset?: number; ids?: string[] }) => Promise<LinkedRecord[]>;
}

export function LinkedRecordInput({
  formId,
  targetFormId,
  displayFieldIds,
  searchFieldIds,
  allowMultiple,
  value,
  onChange,
  primaryColor,
  placeholder,
  compact = false,
  lookup: lookupProp,
}: LinkedRecordInputProps) {
  const storeLookup = useAppRuntimeStore((s) => s.lookupRecords);
  const lookup = lookupProp ?? storeLookup;
  const tz = useDisplayTimezone();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinkedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [resolvedLabels, setResolvedLabels] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchIdRef = useRef(0);

  const floating = useFloatingPopover(isOpen, inputRef, {
    align: 'match-width',
    minWidth: 220,
    estimatedHeight: 240,
    maxHeight: 260,
  });

  // Current selection(s)
  const selectedIds: string[] = allowMultiple
    ? (Array.isArray(value) ? value as string[] : [])
    : (value ? [value as string] : []);

  // Resolve display labels for selected IDs
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const unresolvedIds = selectedIds.filter((id) => !resolvedLabels[id]);
    if (unresolvedIds.length === 0) return;

    // Resolve specific IDs via the ids parameter
    lookup(formId, {
      targetFormId,
      displayFieldIds,
      searchFieldIds,
      ids: unresolvedIds,
    }).then((records) => {
      const labels: Record<string, string> = {};
      for (const rec of records) {
        labels[rec.id] = rec.display;
      }
      setResolvedLabels((prev) => ({ ...prev, ...labels }));
    }).catch(() => {
      // On error, set fallback labels so we don't show "Loading..." forever
      const fallbacks: Record<string, string> = {};
      for (const id of unresolvedIds) {
        fallbacks[id] = id.slice(0, 8) + '...';
      }
      setResolvedLabels((prev) => ({ ...prev, ...fallbacks }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.join(',')]);

  // Debounced search (0ms when opening the dropdown, 200ms while typing)
  const doSearch = useCallback((q: string, delayMs = 200) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const thisSearchId = ++searchIdRef.current;
      setLoading(true);
      try {
        const records = await lookup(formId, {
          targetFormId,
          displayFieldIds,
          searchFieldIds,
          q: q || undefined,
          limit: 50,
        });
        // Only apply results if this is still the latest search
        if (thisSearchId === searchIdRef.current) {
          setResults(records);
          setHighlightIndex(0);
        }
      } catch {
        if (thisSearchId === searchIdRef.current) {
          setResults([]);
        }
      }
      if (thisSearchId === searchIdRef.current) {
        setLoading(false);
      }
    }, delayMs);
  }, [lookup, formId, targetFormId, displayFieldIds, searchFieldIds]);

  // Load initial options immediately when the select box opens (0ms macrotask)
  useEffect(() => {
    if (isOpen) {
      doSearch(query, 0);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (listRef.current && listRef.current.contains(target))
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = (record: LinkedRecord) => {
    setResolvedLabels((prev) => ({ ...prev, [record.id]: record.display }));
    if (allowMultiple) {
      const current = Array.isArray(value) ? (value as string[]) : [];
      // Selected options stay visible in the list — clicking one again toggles it off.
      if (current.includes(record.id)) {
        onChange(current.filter((id) => id !== record.id));
        return;
      }
      onChange([...current, record.id]);
    } else {
      onChange(record.id);
      setIsOpen(false);
      setQuery('');
    }
  };

  const handleRemove = (id: string) => {
    if (allowMultiple) {
      const current = Array.isArray(value) ? (value as string[]) : [];
      onChange(current.filter((v) => v !== id));
    } else {
      onChange(null);
    }
  };

  // Keep selected records IN the list (marked with a check) so reopening the dropdown shows the
  // current selection in place; sort them first so it's visible without scrolling.
  const filteredResults = [...results].sort(
    (a, b) => Number(selectedIds.includes(b.id)) - Number(selectedIds.includes(a.id))
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filteredResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (filteredResults[highlightIndex]) {
        handleSelect(filteredResults[highlightIndex]);
        if (allowMultiple) setQuery('');
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Selected chips (multi-select) */}
      {allowMultiple && selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {selectedIds.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium app-bg-primary-light app-text-primary border app-border-primary"
            >
              {resolvedLabels[id] || 'Loading...'}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleRemove(id); }}
                aria-label="Remove selection"
                className="app-text-primary hover:opacity-70 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Single-select display */}
      {!allowMultiple && selectedIds.length > 0 && !isOpen && (
        <div
          role="button"
          tabIndex={0}
          className={cn(
            'w-full flex items-center justify-between gap-2 rounded-lg border-2 cursor-pointer transition-colors text-left focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
            compact ? 'px-3 py-2 text-sm' : 'p-3',
          )}
          style={{
            borderColor: primaryColor,
            backgroundColor: primaryColor.startsWith('#') ? `${primaryColor}08` : undefined,
          }}
          onClick={() => { setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); } }}
        >
          <span className={cn('min-w-0 flex-1 truncate text-gray-900 dark:text-white', compact ? 'text-sm font-medium' : 'text-base sm:text-lg')}>
            {resolvedLabels[selectedIds[0]] || selectedIds[0].substring(0, 8) + '...'}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleRemove(selectedIds[0]); }}
              aria-label="Clear selection"
              className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-700 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
            </button>
            <ChevronDown className={cn('text-gray-400 dark:text-slate-500', compact ? 'h-4 w-4' : 'h-5 w-5')} aria-hidden="true" />
          </span>
        </div>
      )}

      {/* Search / select input */}
      {(allowMultiple || selectedIds.length === 0 || isOpen) && (
        <div className="relative">
          <Search
            className={cn(
              'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500',
              compact ? 'h-4 w-4' : 'h-5 w-5',
            )}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={isOpen && highlightIndex >= 0 ? `${listId}-opt-${highlightIndex}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              doSearch(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || 'Select or search records...'}
            className={cn(
              'w-full bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 outline-none transition-colors focus:ring-2 focus:ring-primary-500/20',
              compact ? 'border pl-9 pr-9 py-2 text-sm' : 'border-2 pl-10 pr-10 py-3 text-base sm:text-lg',
            )}
            style={{ borderColor: query || isOpen ? primaryColor : undefined }}
          />
          {loading ? (
            <Loader2 className={cn('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin', compact ? 'h-4 w-4' : 'h-5 w-5')} aria-hidden="true" />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isOpen ? 'Close options' : 'Open options'}
              onMouseDown={(e) => {
                e.preventDefault();
                if (isOpen) {
                  setIsOpen(false);
                } else {
                  setIsOpen(true);
                  inputRef.current?.focus();
                }
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"
            >
              <ChevronDown
                className={cn(
                  'transition-transform',
                  compact ? 'h-4 w-4' : 'h-5 w-5',
                  isOpen && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      )}

      {/* Portaled dropdown results so listbox never clips inside cards or modals */}
      {isOpen && floating && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          style={floating.style}
          className="z-[200] bg-white dark:bg-slate-800 border border-gray-200/80 dark:border-slate-700 rounded-xl shadow-2xl shadow-gray-900/15 dark:shadow-black/50 overflow-y-auto scrollbar-thin"
        >
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-gray-500 dark:text-slate-400">
              <Loader2 className="h-4 w-4 text-gray-400 animate-spin" aria-hidden="true" />
              <span>Loading related records…</span>
            </div>
          ) : filteredResults.length === 0 ? (
            <div className="py-6 px-4 text-center text-sm text-gray-500 dark:text-slate-400">
              {query.trim() ? `No records matching "${query.trim()}"` : 'No related records found yet'}
            </div>
          ) : (
            filteredResults.map((record, index) => {
              const isSelected = selectedIds.includes(record.id);
              return (
                <button
                  key={record.id}
                  type="button"
                  id={`${listId}-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(record)}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-2 text-left px-3.5 py-2.5 text-sm transition-colors cursor-pointer',
                    index === highlightIndex
                      ? 'app-bg-primary-light app-text-primary'
                      : isSelected
                        ? 'app-text-primary'
                        : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/50'
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate font-medium', isSelected && 'font-semibold')}>{record.display}</span>
                    {record.submittedAt && (
                      <span className="block text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                        {formatDateInZone(record.submittedAt, tz)}
                      </span>
                    )}
                  </span>
                  {isSelected && <Check className="h-4 w-4 flex-none app-text-primary" aria-hidden="true" />}
                </button>
              );
            })
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
