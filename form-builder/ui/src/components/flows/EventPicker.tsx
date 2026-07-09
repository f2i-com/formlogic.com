// FormLogic Flows - grouped trigger-event picker.
//
// The binding editor still accepts arbitrary event names, but the common Aokie/FormLogic events
// are discoverable here with their payload chips. Teach entries can write a real event plus a
// preset condition without pretending to be an event themselves.
import { useMemo, useState } from 'react';
import { Check, Lightbulb, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  flowEventGroupsForConnectors,
  flowEventsForGroup,
  type FlowEventCatalogEntry,
} from './flowEventCatalog';

const EMPTY_CONNECTOR_IDS: readonly string[] = [];

export interface EventPickerChange {
  event: string;
  presetCondition?: string;
}

interface EventPickerProps {
  value: string;
  onChange: (next: EventPickerChange) => void;
  ariaLabel?: string;
  placeholder?: string;
  inputClassName?: string;
  connectorIds?: readonly string[];
}

function matches(entry: FlowEventCatalogEntry, query: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  return (
    entry.label.toLowerCase().includes(q) ||
    entry.event.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q) ||
    entry.payloadHints.some((hint) => hint.toLowerCase().includes(q))
  );
}

export function EventPicker({
  value,
  onChange,
  ariaLabel = 'Event name',
  placeholder,
  inputClassName,
  connectorIds = EMPTY_CONNECTOR_IDS,
}: EventPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const hasAokie = connectorIds.includes('aokie');
  const effectivePlaceholder = placeholder ?? (hasAokie ? 'aokie.call.incoming' : 'form.submitted');

  const grouped = useMemo(() => {
    const q = query.trim();
    return flowEventGroupsForConnectors(connectorIds).map((group) => ({
      group,
      entries: flowEventsForGroup(group.id).filter((entry) => matches(entry, q)),
    })).filter((group) => group.entries.length > 0);
  }, [connectorIds, query]);

  const choose = (entry: FlowEventCatalogEntry) => {
    onChange({
      event: entry.event,
      ...(entry.kind === 'teach' ? { presetCondition: entry.presetCondition } : {}),
    });
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={value}
          placeholder={effectivePlaceholder}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            onChange({ event: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={cn(
            'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white',
            inputClassName,
            'pl-8',
          )}
        />
      </div>
      {open && (
        <div
          role="listbox"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {grouped.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400 dark:text-slate-500">
              No catalog event matches "{query}". Keep typing to use a custom event.
            </div>
          ) : (
            grouped.map(({ group, entries }) => (
              <div key={group.id} className="py-1">
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
                  {group.label}
                </p>
                {entries.map((entry) => {
                  const active = value === entry.event && entry.kind === 'event';
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(entry);
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors focus:outline-none',
                        active
                          ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300'
                          : 'text-gray-700 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-slate-800',
                      )}
                    >
                      <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center text-gray-400 dark:text-slate-500">
                        {entry.kind === 'teach' ? <Lightbulb className="h-3.5 w-3.5" /> : active ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{entry.label}</span>
                          <span className="truncate font-mono text-[10px] text-gray-400 dark:text-slate-500">{entry.event}</span>
                        </span>
                        <span className="mt-0.5 block text-xs leading-snug text-gray-500 dark:text-slate-400">{entry.description}</span>
                        {entry.payloadHints.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {entry.payloadHints.slice(0, 5).map((hint) => (
                              <span key={hint} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-slate-800 dark:text-slate-400">
                                {hint}
                              </span>
                            ))}
                          </span>
                        )}
                        {entry.kind === 'teach' && (
                          <span className="mt-1 block font-mono text-[10px] text-amber-600 dark:text-amber-300">
                            condition: {entry.presetCondition}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
