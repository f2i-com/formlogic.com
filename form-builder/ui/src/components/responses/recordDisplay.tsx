// Owner-scoped linked-record display COMPONENTS (chips + read-only peek). Pure formatting
// helpers live in recordFormat.tsx — this file exports only components so react
// fast-refresh keeps working.
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { api, resolveFileUrl } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { Form } from '../../types/form';
import { asResolvedList, formatValue, linkedText, type ResolvedLink } from './recordFormat';

// Target-form definitions are cached so the peek doesn't refetch field labels for every chip.
const linkedFormCache = new Map<string, Form>();

// Renders resolved linked records as chips. Each real record is clickable; by default it
// opens a read-only peek modal — pass `onOpen` to navigate somewhere instead (e.g. the
// full-page record view).
export function LinkedRecordChips({ items, onOpen }: { items: ResolvedLink[]; onOpen?: (item: ResolvedLink) => void }) {
  const [peek, setPeek] = useState<ResolvedLink | null>(null);
  if (!items.length) return <span className="text-gray-300 dark:text-slate-600">—</span>;
  return (
    <>
      <span className="flex flex-wrap items-center gap-1 max-w-full min-w-0">
        {items.map((it, i) => {
          const clickable = !!it.targetFormId && it.display !== 'Record not found';
          return (
            <button
              key={it.id + i}
              type="button"
              disabled={!clickable}
              onClick={(e) => { e.stopPropagation(); if (clickable) { if (onOpen) onOpen(it); else setPeek(it); } }}
              title={clickable ? `${it.display} — click to view` : it.display}
              className={cn(
                'inline-flex items-center gap-1 max-w-full min-w-0 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 transition-colors',
                clickable
                  ? 'border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 cursor-pointer'
                  : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 cursor-default'
              )}
            >
              <Link2 className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{it.display}</span>
            </button>
          );
        })}
      </span>
      {peek && <LinkedRecordPeek item={peek} onClose={() => setPeek(null)} />}
    </>
  );
}

// A modal that lazily loads and displays a single linked record (the owner owns the target
// form, so it's fetched directly). Kept lightweight — a read-only peek, not the full editor.
export function LinkedRecordPeek({ item, onClose }: { item: ResolvedLink; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [resolved, setResolved] = useState<Record<string, ResolvedLink | ResolvedLink[]>>({});

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const tfid = item.targetFormId ?? '';
        let f = linkedFormCache.get(tfid) ?? null;
        if (!f) {
          const fr = await api.getForm(tfid);
          f = fr.data?.form ?? null;
          if (f) linkedFormCache.set(tfid, f);
        }
        const rr = await api.getResponse(tfid, item.id);
        if (cancelled) return;
        setForm(f);
        setAnswers((rr.data?.response?.answers as Record<string, unknown>) ?? {});
        setResolved((rr.data?.response as { _resolved?: Record<string, ResolvedLink | ResolvedLink[]> })?._resolved ?? {});
      } catch {
        if (!cancelled) setError('Could not load this record.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [item]);

  const fields = (form?.fields ?? []).filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type));

  return (
    <Modal isOpen onClose={onClose} title={form?.title || 'Linked record'} description={item.display} size="md">
      <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : fields.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">This record has no displayable fields.</p>
        ) : (
          fields.map((field) => {
            let content: ReactNode;
            if (field.type === 'linked_record') {
              content = linkedText(asResolvedList(resolved[field.id]));
            } else if (field.type === 'file_upload' && Array.isArray(answers[field.id]) && (answers[field.id] as unknown[]).length > 0) {
              content = (
                <span className="inline-flex flex-wrap gap-2">
                  {(answers[field.id] as Array<{ originalFilename?: string; url?: string }>).map((f, i) => (
                    f && f.url
                      ? <a key={i} href={resolveFileUrl(f.url)} target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline">{f.originalFilename || 'File'}</a>
                      : <span key={i}>{(f && f.originalFilename) || 'File'}</span>
                  ))}
                </span>
              );
            } else {
              content = formatValue(answers[field.id], field.type, field.properties?.options);
            }
            const empty = content === '' || content === '-' || content == null;
            return (
              <div key={field.id} className="border-b border-gray-100 dark:border-slate-800 pb-3 last:border-0 last:pb-0">
                <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">{field.label}</p>
                <div className="text-sm text-gray-900 dark:text-white break-words">
                  {empty ? <span className="text-gray-400 dark:text-slate-500 italic">No answer</span> : content}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
