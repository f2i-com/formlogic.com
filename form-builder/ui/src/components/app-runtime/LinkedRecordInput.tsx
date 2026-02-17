import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Loader2, ChevronDown } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { LinkedRecord } from '../../lib/api';
import { cn } from '../../lib/utils';

interface LinkedRecordInputProps {
  formId: string;
  targetFormId: string;
  displayFieldIds?: string[];
  searchFieldIds?: string[];
  allowMultiple?: boolean;
  value: unknown;
  onChange: (val: unknown) => void;
  primaryColor: string;
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
}: LinkedRecordInputProps) {
  const { lookupRecords } = useAppRuntimeStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LinkedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [resolvedLabels, setResolvedLabels] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Current selection(s)
  const selectedIds: string[] = allowMultiple
    ? (Array.isArray(value) ? value as string[] : [])
    : (value ? [value as string] : []);

  // Resolve display labels for selected IDs
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const unresolvedIds = selectedIds.filter((id) => !resolvedLabels[id]);
    if (unresolvedIds.length === 0) return;

    // Do a lookup without search query to get the selected records
    lookupRecords(formId, {
      targetFormId,
      displayFieldIds,
      searchFieldIds,
      limit: 50,
    }).then((records) => {
      const labels: Record<string, string> = {};
      for (const rec of records) {
        if (unresolvedIds.includes(rec.id)) {
          labels[rec.id] = rec.display;
        }
      }
      setResolvedLabels((prev) => ({ ...prev, ...labels }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.join(',')]);

  // Debounced search
  const doSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const records = await lookupRecords(formId, {
        targetFormId,
        displayFieldIds,
        searchFieldIds,
        q: q || undefined,
        limit: 20,
      });
      setResults(records);
      setHighlightIndex(0);
      setLoading(false);
    }, 300);
  }, [lookupRecords, formId, targetFormId, displayFieldIds, searchFieldIds]);

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
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

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
      onChange('');
    }
  };

  const filteredResults = results.filter((r) => !selectedIds.includes(r.id));

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30"
            >
              {resolvedLabels[id] || id.substring(0, 8) + '...'}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleRemove(id); }}
                aria-label="Remove selection"
                className="text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-200"
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
          className="flex items-center justify-between p-3 rounded-lg border-2 cursor-pointer transition-colors"
          style={{ borderColor: primaryColor, backgroundColor: `${primaryColor}08` }}
          onClick={() => { setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        >
          <span className="text-lg text-gray-900 dark:text-white">
            {resolvedLabels[selectedIds[0]] || selectedIds[0].substring(0, 8) + '...'}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleRemove(selectedIds[0]); }}
            aria-label="Clear selection"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"
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
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              doSearch(e.target.value);
              if (!isOpen) setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder="Search records..."
            className="w-full pl-10 pr-10 py-3 bg-white dark:bg-slate-800 border-2 border-gray-300 dark:border-slate-600 rounded-lg text-lg text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 outline-none transition-colors focus:border-indigo-500 dark:focus:border-indigo-400"
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
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg max-h-64 overflow-y-auto">
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
                onClick={() => handleSelect(record)}
                onMouseEnter={() => setHighlightIndex(index)}
                className={cn(
                  'w-full text-left px-4 py-3 text-sm transition-colors',
                  index === highlightIndex
                    ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-900 dark:text-indigo-100'
                    : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/50'
                )}
              >
                <span className="font-medium">{record.display}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
