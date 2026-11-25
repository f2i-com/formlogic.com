import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, Terminal, Trash2 } from 'lucide-react';
import type { SiteProblem, SoftnConsoleEntry } from '../studio/SiteAppFrame';
import { cn, copyToClipboard } from '../../lib/utils';

function formatLocation(problem: SiteProblem): string | null {
  if (!problem.file) return null;
  if (problem.line) {
    return `${problem.file}:${problem.line}${problem.column ? `:${problem.column}` : ''}`;
  }
  return problem.file;
}

export function SoftnDebugConsole({
  problems,
  logs,
  onClear,
}: {
  problems: SiteProblem[];
  logs: SoftnConsoleEntry[];
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'errors' | 'console'>('errors');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoFirstCollapsed, setAutoFirstCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const prevErrorCountRef = useRef(0);

  const errorCount = problems.length;

  useEffect(() => {
    if (errorCount > prevErrorCountRef.current) {
      setOpen(true);
    }
    if (errorCount === 0 && prevErrorCountRef.current > 0) {
      setExpanded(new Set());
      setAutoFirstCollapsed(false);
    }
    prevErrorCountRef.current = errorCount;
  }, [errorCount]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const isExpanded = open;

  const copyAll = async () => {
    const lines: string[] = [];
    if (problems.length > 0) {
      lines.push('=== SoftN Errors ===');
      for (const p of problems) {
        const loc = formatLocation(p);
        lines.push(`[${p.kind.toUpperCase()}${p.phase ? `/${p.phase}` : ''}]${loc ? ` ${loc} —` : ''} ${p.text}`);
        if (p.snippet) lines.push(p.snippet);
        if (p.stack) lines.push(p.stack);
        lines.push('');
      }
    }
    if (logs.length > 0) {
      lines.push('=== Console Output ===');
      for (const entry of logs) {
        lines.push(`[${entry.level.toUpperCase()}] ${entry.text}`);
      }
    }
    await copyToClipboard(lines.join('\n').trim() || 'No errors or console output recorded.');
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="border-t border-slate-200 bg-slate-950 text-slate-100 dark:border-slate-700" data-testid="softn-debug-console">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setOpen(v => !v)}
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-200 hover:text-white"
        >
          {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
          <Terminal className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
          <span>Debug Console</span>
          {errorCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          ) : (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              0 errors
            </span>
          )}
          {logs.length > 0 && (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
              {logs.length} log{logs.length === 1 ? '' : 's'}
            </span>
          )}
        </button>

        <div className="flex items-center gap-1.5">
          {isExpanded && (
            <>
              <div role="tablist" aria-label="Debug console views" className="inline-flex rounded-lg bg-slate-900 p-0.5 text-[11px]">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'errors'}
                  onClick={() => setTab('errors')}
                  className={cn('rounded-md px-2 py-0.5 font-medium', tab === 'errors' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200')}
                >
                  Errors ({errorCount})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'console'}
                  onClick={() => setTab('console')}
                  className={cn('rounded-md px-2 py-0.5 font-medium', tab === 'console' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200')}
                >
                  Console ({logs.length})
                </button>
              </div>
              <button
                type="button"
                onClick={() => void copyAll()}
                title="Copy diagnostics"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-700 px-2 text-[11px] text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                Copy
              </button>
              {(errorCount > 0 || logs.length > 0) && (
                <button
                  type="button"
                  onClick={onClear}
                  title="Clear console"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-700 px-2 text-[11px] text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="max-h-72 overflow-y-auto border-t border-slate-800 px-3 py-2 font-mono text-xs">
          {tab === 'errors' ? (
            problems.length === 0 ? (
              <p className="py-2 text-slate-400">
                No runtime or script errors detected. Errors also log with exact file &amp; line numbers in your browser&rsquo;s DevTools Console.
              </p>
            ) : (
              <div className="space-y-2">
                {problems.map((problem, idx) => {
                  const loc = formatLocation(problem);
                  const entryKey = `${problem.kind}:${loc ?? ''}:${problem.text}:${idx}`;
                  const hasDetails = Boolean(problem.snippet || problem.stack);
                  const isOpen = expanded.has(entryKey) || (idx === 0 && !autoFirstCollapsed);
                  return (
                    <div
                      key={entryKey}
                      className={cn(
                        'rounded-lg border p-2.5',
                        problem.kind === 'error'
                          ? 'border-rose-500/30 bg-rose-950/35'
                          : problem.kind === 'blocked'
                            ? 'border-amber-500/30 bg-amber-950/30'
                            : 'border-slate-700 bg-slate-900',
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                              problem.kind === 'error' ? 'bg-rose-500/25 text-rose-200' : problem.kind === 'blocked' ? 'bg-amber-500/25 text-amber-200' : 'bg-sky-500/25 text-sky-200',
                            )}>
                              {problem.kind}
                            </span>
                            {loc && (
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300">
                                {loc}
                              </span>
                            )}
                            {problem.phase && (
                              <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-400">
                                {problem.phase}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 break-words text-slate-100">{problem.text}</p>
                        </div>
                        {hasDetails && (
                          <button
                            type="button"
                            onClick={() => {
                              if (isOpen) {
                                if (idx === 0) setAutoFirstCollapsed(true);
                                setExpanded(prev => {
                                  if (!prev.has(entryKey)) return prev;
                                  const next = new Set(prev);
                                  next.delete(entryKey);
                                  return next;
                                });
                              } else {
                                if (idx === 0) setAutoFirstCollapsed(false);
                                setExpanded(prev => {
                                  const next = new Set(prev);
                                  next.add(entryKey);
                                  return next;
                                });
                              }
                            }}
                            className="shrink-0 text-[11px] text-sky-300 hover:underline"
                          >
                            {isOpen ? 'Hide frame' : 'Show frame'}
                          </button>
                        )}
                      </div>
                      {hasDetails && isOpen && (
                        <div className="mt-2 space-y-2 border-t border-slate-800 pt-2">
                          {problem.snippet && (
                            <pre className="overflow-x-auto rounded bg-slate-950/90 p-2 text-[11px] leading-5 text-emerald-200">{problem.snippet}</pre>
                          )}
                          {problem.stack && (
                            <pre className="overflow-x-auto rounded bg-slate-950/70 p-2 text-[11px] leading-4 text-slate-400">{problem.stack}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            logs.length === 0 ? (
              <p className="py-2 text-slate-400">No console messages captured yet.</p>
            ) : (
              <div className="space-y-1">
                {logs.map((entry, idx) => (
                  <div key={`${entry.at}-${idx}`} className="flex items-start gap-2 border-b border-slate-900 py-1 last:border-0">
                    <span className={cn(
                      'shrink-0 rounded px-1 py-0.5 text-[10px] uppercase',
                      entry.level === 'error' ? 'bg-rose-500/20 text-rose-300'
                        : entry.level === 'warn' ? 'bg-amber-500/20 text-amber-300'
                          : entry.level === 'debug' ? 'bg-purple-500/20 text-purple-300'
                            : 'bg-slate-800 text-slate-300',
                    )}>
                      {entry.level}
                    </span>
                    <span className="break-words text-slate-200">{entry.text}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
