import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { Search, X, Loader2, ChevronDown } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { LinkedRecord } from '../../lib/api';
import { cn, parseServerDate } from '../../lib/utils';

interface LinkedRecordInputProps {
  formId: string;
  targetFormId: string;
  displayFieldIds?: string[];
  searchFieldIds?: string[];
  allowMultiple?: boolean;
  value: unknown;
  onChange: (val: unknown) => void;
  primaryColor: string;
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
  lookup: lookupProp,
}: LinkedRecordInputProps) {
  const storeLookup = useAppRuntimeStore((s) => s.lookupRecords);
  const lookup = lookupProp ?? storeLookup;
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinkedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [resolvedLabels, setResolvedLabels] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchIdRef = useRef(0);

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

  // Debounced search with stale-result protection
  const doSearch = useCallback((q: string) => {
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
          limit: 20,
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
    }, 300);
  }, [lookup, formId, targetFormId, displayFieldIds, searchFieldIds]);

  // Load initial results when opening
  useEffect(() => {
    if (isOpen) {
      doSearch(query);
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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = (record: LinkedRecord) => {
    setResolvedLabels((prev) => ({ ...prev, [record.id]: record.display }));
    if (allowMultiple) {
      const current = Array.isArray(value) ? (value as string[]) : [];
      if (current.includes(record.id)) return;
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

  const filteredResults = results.filter((r) => !selectedIds.includes(r.id));

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
          className="w-full flex items-center justify-between p-3 rounded-lg border-2 cursor-pointer transition-colors text-left focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
          style={{ borderColor: primaryColor, backgroundColor: `${primaryColor}08` }}
          onClick={() => { setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); } }}
        >
          <span className="text-base sm:text-lg text-gray-900 dark:text-white">
            {resolvedLabels[selectedIds[0]] || selectedIds[0].substring(0, 8) + '...'}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleRemove(selectedIds[0]); }}
            aria-label="Clear selection"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Search input */}
      {(allowMultiple || selectedIds.length === 0 || isOpen) && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 dark:text-slate-500" />
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
            placeholder="Search records..."
            className="w-full pl-10 pr-10 py-3 bg-white dark:bg-slate-800 border-2 border-gray-300 dark:border-slate-600 rounded-lg text-base sm:text-lg text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 outline-none transition-colors"
            style={{ borderColor: query ? primaryColor : undefined }}
          />
          {loading ? (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 animate-spin" />
          ) : (
            <ChevronDown
              className={cn(
                'absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 transition-transform',
                isOpen && 'rotate-180'
              )}
            />
          )}
        </div>
      )}

      {/* Dropdown results */}
      {isOpen && (
        <div id={listId} role="listbox" className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-gray-200/80 dark:border-slate-700 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 max-h-64 overflow-y-auto">
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
            </div>
          ) : filteredResults.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500 dark:text-slate-400">
              No records found
            </div>
          ) : (
            filteredResults.map((record, index) => (
              <button
                key={record.id}
                type="button"
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={index === highlightIndex}
                onClick={() => handleSelect(record)}
                onMouseEnter={() => setHighlightIndex(index)}
                className={cn(
                  'w-full text-left px-4 py-3 text-sm transition-colors cursor-pointer',
                  index === highlightIndex
                    ? 'app-bg-primary-light app-text-primary'
                    : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/50'
                )}
              >
                <span className="font-medium">{record.display}</span>
                {record.submittedAt && (
                  <span className="block text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                    {parseServerDate(record.submittedAt).toLocaleDateString()}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
