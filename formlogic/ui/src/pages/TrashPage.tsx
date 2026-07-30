import { useCallback, useEffect, useState } from 'react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { api } from '../lib/api';
import type { TrashItem } from '../lib/api';
import { useAccountTimezone, formatDateTimeInZone } from '../lib/timezone';
import { FileText, LayoutGrid, Workflow, RotateCcw, Trash2, Recycle } from 'lucide-react';

const KIND_META: Record<TrashItem['kind'], { label: string; icon: typeof FileText; iconBg: string; iconColor: string }> = {
  form: { label: 'Form', icon: FileText, iconBg: 'bg-indigo-50 dark:bg-indigo-500/10', iconColor: 'text-indigo-600 dark:text-indigo-400' },
  app: { label: 'App', icon: LayoutGrid, iconBg: 'bg-emerald-50 dark:bg-emerald-500/10', iconColor: 'text-emerald-600 dark:text-emerald-400' },
  flow: { label: 'Flow', icon: Workflow, iconBg: 'bg-amber-50 dark:bg-amber-500/10', iconColor: 'text-amber-600 dark:text-amber-400' },
};

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

  useEffect(() => { void load(); }, [load]);

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
    <div className="min-h-full flex flex-col">
      <Header title="Recycle bin" />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4">
        {/* "exactly where they were … whenever possible" promised more than the snapshot
            captures, and buried the exception in a hedge. The zip manifest's own
            `excluded` list (AccountBackupService::exportScoped) is the authority; name the
            entries an owner would otherwise have to rediscover by hand. */}
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Deleted forms, apps and flows stay here for 30 days. Restoring brings back their records, files,
          screens and automations.
        </p>
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Some things are deliberately left out of the snapshot and will need setting up again: the people
          you had invited, custom domains, API keys and webhook secrets.
        </p>

        {items === null && !error && (
          <div className="flex justify-center py-16"><Spinner /></div>
        )}

        {error && (
          <Card><CardContent className="p-6 text-sm text-red-600 dark:text-red-400">{error}</CardContent></Card>
        )}

        {items !== null && items.length === 0 && !error && (
          <Card>
            <CardContent className="p-10">
              <EmptyState
                icon={Recycle}
                title="The recycle bin is empty"
                description="When you delete a form, app or flow it lands here, restorable for 30 days."
              />
            </CardContent>
          </Card>
        )}

        {items !== null && items.length > 0 && (
          <div className="space-y-3">
            {items.map((item) => {
              const kind = KIND_META[item.kind] ?? KIND_META.form;
              const KindIcon = kind.icon;
              const expiresSoon = item.daysRemaining <= 5;
              return (
                <Card key={item.id} className="overflow-hidden">
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${kind.iconBg}`}>
                        <KindIcon className={`h-5 w-5 ${kind.iconColor}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-gray-900 dark:text-white truncate">{item.name}</p>
                          <span className="text-[11px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400">
                            {kind.label}
                          </span>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-slate-400 truncate">{contentsLine(item)}</p>
                        <p className="text-xs text-gray-400 dark:text-slate-500">
                          Deleted {formatDateTimeInZone(item.deletedAt, tz)} ·{' '}
                          <span className={expiresSoon ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>
                            {item.daysRemaining === 0 ? 'expires today' : `${item.daysRemaining} day${item.daysRemaining === 1 ? '' : 's'} left`}
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          size="sm"
                          onClick={() => void handleRestore(item)}
                          isLoading={busyId === item.id}
                          disabled={busyId !== null || item.status === 'restoring'}
                          leftIcon={<RotateCcw className="h-4 w-4" />}
                        >
                          Restore
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPurgeTarget(item)}
                          disabled={busyId !== null || item.status === 'restoring'}
                          leftIcon={<Trash2 className="h-4 w-4" />}
                        >
                          Delete forever
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

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
