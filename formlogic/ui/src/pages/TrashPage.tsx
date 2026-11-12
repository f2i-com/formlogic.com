import { useCallback, useEffect, useState } from 'react';
import { Header } from '../components/layout/Header';
import { PageBody } from '../components/layout/PageBody';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { api } from '../lib/api';
import { deferEffect } from '../lib/deferredEffect';
import type { TrashItem } from '../lib/api';
import { useAccountTimezone, formatDateTimeInZone } from '../lib/timezone';
import { cn, parseServerDate } from '../lib/utils';
import { LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH } from '../components/ui/listLook';
import { ChevronRight, FileText, LayoutGrid, Workflow, RotateCcw, Trash2, Recycle } from 'lucide-react';

const KIND_META: Record<TrashItem['kind'], { label: string; icon: typeof FileText; iconColor: string }> = {
  form: { label: 'Form', icon: FileText, iconColor: 'text-primary-600 dark:text-primary-400' },
  app: { label: 'App', icon: LayoutGrid, iconColor: 'text-emerald-600 dark:text-emerald-400' },
  flow: { label: 'Flow', icon: Workflow, iconColor: 'text-amber-600 dark:text-amber-400' },
};
// When it was deleted joins the table once the name's column has room beside it; a card shows it.
const WHEN_WIDER = '@xl/list:hidden @2xl/list:table-cell';

/** What the item is: a form, an app or a flow, as its icon and the word. */
function Kind({ kind, className }: { kind: TrashItem['kind']; className?: string }) {
  const meta = KIND_META[kind] ?? KIND_META.form;
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-gray-700 dark:text-slate-300', className)}>
      <Icon className={cn('h-3.5 w-3.5 flex-none', meta.iconColor)} aria-hidden="true" />{meta.label}
    </span>
  );
}

/** "Nov 12, 8:51 AM": the day and the minute, for a column. Nothing here is older than 30 days,
    so the year is left to the full time, which the cell gives on hover. */
function shortWhen(value: string, tz: string): string {
  const date = parseServerDate(value);
  if (isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(date);
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** What the snapshot holds, from the zip manifest counts captured at delete time. */
function contentsLine(item: TrashItem): string {
  const c = item.meta?.counts;
  const parts: string[] = [];
  if (item.kind === 'form') {
    parts.push(`${(c?.responses ?? 0).toLocaleString()} record${c?.responses === 1 ? '' : 's'}`);
    if (c?.files) parts.push(`${c.files} file${c.files === 1 ? '' : 's'}`);
  } else if (item.kind === 'app') {
    if (item.meta?.slug) parts.push(`/${item.meta.slug}`);
    if (c?.flows) parts.push(`${c.flows} flow${c.flows === 1 ? '' : 's'}`);
    if (c?.bindings) parts.push(`${c.bindings} binding${c.bindings === 1 ? '' : 's'}`);
  } else {
    parts.push(item.meta?.appId ? 'app flow' : 'workspace flow');
    if (c?.bindings) parts.push(`${c.bindings} binding${c.bindings === 1 ? '' : 's'}`);
  }
  parts.push(formatSize(item.sizeBytes));
  return parts.join(' · ');
}

/**
 * The recycle bin (routed page): deleted forms/apps/flows stay restorable for
 * 30 days. Restore keeps the ORIGINAL ids when still free (a true undelete —
 * links from surviving forms reconnect) and consumes the item. Also reachable
 * for platform admins under /admin/users/:userId/trash via the acting-as
 * mirror — the api layer rewrites the calls automatically.
 */
export function TrashPage() {
  useDocumentTitle('Recycle bin');
  const tz = useAccountTimezone();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);
  const [isPurging, setIsPurging] = useState(false);

  const load = useCallback(async () => {
    const res = await api.listTrash();
    if (res.error || !res.data) {
      setError(res.error || 'Could not load the recycle bin');
      return;
    }
    setError(null);
    setItems(res.data.items);
  }, []);

  useEffect(() => deferEffect(() => { void load(); }), [load]);

  const handleRestore = async (item: TrashItem) => {
    setBusyId(item.id);
    try {
      const res = await api.restoreTrashItem(item.id);
      if (res.error || !res.data) {
        toast.error('Restore failed', res.error || 'Please try again');
        return;
      }
      const r = res.data.restored;
      const bits: string[] = [];
      if (r.apps.length) bits.push(`${r.apps.length} app${r.apps.length === 1 ? '' : 's'}`);
      if (r.forms.length) bits.push(`${r.forms.length} form${r.forms.length === 1 ? '' : 's'}`);
      if (r.flows) bits.push(`${r.flows} flow${r.flows === 1 ? '' : 's'}`);
      if (r.responses) bits.push(`${r.responses.toLocaleString()} record${r.responses === 1 ? '' : 's'}`);
      toast.success(`Restored “${item.name}”`, bits.length ? `Back in place: ${bits.join(', ')}.` : undefined);
      for (const w of r.warnings ?? []) toast.warning('Restore note', w);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setIsPurging(true);
    try {
      const res = await api.purgeTrashItem(purgeTarget.id);
      if (res.error) {
        toast.error('Could not delete', res.error);
        return;
      }
      toast.success(`“${purgeTarget.name}” deleted forever`);
      setPurgeTarget(null);
      await load();
    } finally {
      setIsPurging(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header title="Recycle bin" />

      <PageBody>
        <div className="@container/list space-y-3">
          {/* "exactly where they were … whenever possible" promised more than the snapshot
              captures, and buried the exception in a hedge. The zip manifest's own
              `excluded` list (AccountBackupService::exportScoped) is the authority; name the
              entries an owner would otherwise have to rediscover by hand. They are a press
              away, so the list itself starts under one line. */}
          <div className="text-sm text-gray-500 dark:text-slate-400">
            <p>
              Deleted forms, apps and flows stay here for 30 days. Restoring brings back their records, files,
              screens and automations.
            </p>
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-300 max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />What is not kept
              </summary>
              <p className="max-w-3xl pb-1 text-xs leading-5">
                Some things are deliberately left out of the snapshot and will need setting up again: the people
                you had invited, custom domains, API keys and webhook secrets.
              </p>
            </details>
          </div>

          {items === null && !error && (
            <div className="flex items-center gap-2.5 py-2 text-sm text-gray-500 dark:text-slate-400">
              <Spinner size="sm" /><span aria-hidden="true">Loading the recycle bin…</span>
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50/60 px-3 py-2.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</p>
          )}

          {/* Nothing deleted: one line where the list would be. */}
          {items !== null && items.length === 0 && !error && (
            <p className={cn(LIST_BOX, 'flex items-center gap-2 px-3 py-2.5 text-sm text-gray-500 dark:text-slate-400')}>
              <Recycle className="h-4 w-4 flex-none" aria-hidden="true" />The recycle bin is empty.
            </p>
          )}

          {/* Wide: a row per item, with what to do about it at the right. Narrow: the same rows
              as cards, the name on top and the buttons a finger tall underneath. */}
          {items !== null && items.length > 0 && (
            <div className={LIST_BOX}>
              <table className={LIST_TABLE}>
                <caption className="sr-only">Deleted items</caption>
                <thead className={LIST_HEAD}>
                  <tr>
                    <th scope="col" className={cn(LIST_TH, 'w-20 pl-3')}>What</th>
                    <th scope="col" className={LIST_TH}>Name</th>
                    <th scope="col" className={cn(LIST_TH, 'w-36', WHEN_WIDER)}>Deleted</th>
                    <th scope="col" className={cn(LIST_TH, 'w-28')}>Time left</th>
                    <th scope="col" className={cn(LIST_TH, 'w-[140px] pr-3 @3xl/list:w-[244px]')}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className={LIST_BODY}>
                  {items.map((item) => {
                    const expiresSoon = item.daysRemaining <= 5;
                    return (
                      <tr key={item.id} className={cn(LIST_ROW, 'grid grid-cols-2 gap-x-3 gap-y-1.5')}>
                        <td className={cn(LIST_CELL, 'hidden @xl/list:pl-3')}><Kind kind={item.kind} /></td>
                        <th scope="row" className={cn(LIST_CELL, 'col-span-2 font-normal @xl/list:py-0.5')}>
                          <span className="flex flex-wrap items-center gap-x-2">
                            <span className="font-semibold text-gray-900 [overflow-wrap:anywhere] dark:text-white max-sm:text-[15px]">{item.name}</span>
                            {/* A card has no "What" column: the kind stands beside the name. */}
                            <Kind kind={item.kind} className="@xl/list:hidden" />
                          </span>
                          <span className="block text-xs leading-4 text-gray-500 [overflow-wrap:anywhere] dark:text-slate-400">{contentsLine(item)}</span>
                        </th>
                        <td className={cn(LIST_CELL, 'whitespace-nowrap tabular-nums text-gray-600 dark:text-slate-300', WHEN_WIDER)} title={formatDateTimeInZone(item.deletedAt, tz)}>
                          <span className={LIST_LABEL}>Deleted</span>{shortWhen(item.deletedAt, tz)}
                        </td>
                        <td className={cn(LIST_CELL, 'whitespace-nowrap tabular-nums', expiresSoon ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-slate-300')}>
                          <span className={LIST_LABEL}>Time left</span>
                          {item.daysRemaining === 0 ? 'Expires today' : `${item.daysRemaining} day${item.daysRemaining === 1 ? '' : 's'}`}
                        </td>
                        <td className={cn(LIST_CELL, 'col-span-2 @xl/list:py-0.5 @xl/list:pr-2 @xl/list:text-right')}>
                          <span className="flex items-center gap-2 @xl/list:inline-flex">
                            {/* Quiet buttons: a row of solid ones down a long list shouts. */}
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void handleRestore(item)}
                              isLoading={busyId === item.id}
                              disabled={busyId !== null || item.status === 'restoring'}
                              leftIcon={<RotateCcw className="h-4 w-4 text-primary-600 dark:text-primary-400" />}
                            >
                              Restore
                            </Button>
                            {/* Its words give way to the name's column in a narrow table; the bin says what it does. */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                              title="Delete forever"
                              onClick={() => setPurgeTarget(item)}
                              disabled={busyId !== null || item.status === 'restoring'}
                              leftIcon={<Trash2 className="h-4 w-4" />}
                            >
                              <span className="@xl/list:sr-only @3xl/list:not-sr-only">Delete forever</span>
                            </Button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="border-t border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">
                {items.length.toLocaleString()} item{items.length === 1 ? '' : 's'}
              </p>
            </div>
          )}
        </div>
      </PageBody>

      <ConfirmDialog
        isOpen={purgeTarget !== null}
        onClose={() => { if (!isPurging) setPurgeTarget(null); }}
        onConfirm={() => void handlePurge()}
        title="Delete forever?"
        message={purgeTarget ? `“${purgeTarget.name}” and its snapshot will be permanently deleted. This can't be undone.` : ''}
        confirmLabel="Delete forever"
        variant="danger"
        isLoading={isPurging}
      />
    </div>
  );
}
