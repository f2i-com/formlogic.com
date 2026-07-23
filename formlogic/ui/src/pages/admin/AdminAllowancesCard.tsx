// Admin → Platform: "AI & credits allowances" card (Site AI plan Phase 2 step 9).
//
// Edits the plan_allowances table via GET/PUT /api/admin/allowances: monthly caps for
// the metered metrics (ai_messages, cloud_flow_runs) per plan, plus the on/off switch
// that decides whether the metric is enforced at all. Edits are staged per row and
// saved explicitly — a toggle flip is NOT live until its row's Save succeeds.
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api, type PlanAllowance } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';

interface AllowanceRow {
  plan: string;
  metric: string;
  /** Edited as text so an in-progress value can be any input; validated on save. */
  monthlyValue: string;
  enabled: boolean;
  dirty: boolean;
  saving: boolean;
}

function rowKey(row: Pick<AllowanceRow, 'plan' | 'metric'>): string {
  return `${row.plan}||${row.metric}`;
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'ai_messages':
      return 'AI messages / month';
    case 'cloud_flow_runs':
      return 'Cloud flow runs / month';
    default:
      return metric;
  }
}

function toRow(allowance: PlanAllowance): AllowanceRow {
  return {
    plan: allowance.plan,
    metric: allowance.metric,
    monthlyValue: String(allowance.monthlyValue),
    enabled: allowance.enabled,
    dirty: false,
    saving: false,
  };
}

export function AdminAllowancesCard() {
  const [rows, setRows] = useState<AllowanceRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.adminListAllowances().then((r) => {
      if (cancelled) return;
      if (r.data) {
        setRows(r.data.allowances.map(toRow));
        setLoadError(null);
      } else {
        setLoadError(r.error || 'Could not load the AI allowances');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const retry = () => {
    setRows(null);
    setLoadError(null);
    setReloadTick((t) => t + 1);
  };

  const patchRow = (key: string, patch: Partial<AllowanceRow>) => {
    setRows((current) => (current ?? []).map((r) => (rowKey(r) === key ? { ...r, ...patch } : r)));
  };

  const saveRow = async (row: AllowanceRow) => {
    // '' (e.g. a number input that rejected the keystrokes) must not silently become 0.
    const trimmed = row.monthlyValue.trim();
    const monthlyValue = trimmed === '' ? NaN : Number(trimmed);
    if (!Number.isInteger(monthlyValue) || monthlyValue < 0) {
      toast.error('Invalid monthly value', 'Enter a whole number of 0 or more.');
      return;
    }
    patchRow(rowKey(row), { saving: true });
    const r = await api.adminPutAllowance({ plan: row.plan, metric: row.metric, monthlyValue, enabled: row.enabled });
    if (r.error || !r.data) {
      // Keep the row dirty so the admin sees the edit was NOT persisted.
      patchRow(rowKey(row), { saving: false });
      toast.error('Could not save the allowance', r.error || undefined);
      return;
    }
    patchRow(rowKey(row), { ...toRow(r.data.allowance) });
    toast.success('Allowance saved', `${row.plan} · ${metricLabel(row.metric)}`);
  };

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> AI &amp; credits allowances
          </h3>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Monthly caps for metered AI and cloud-flow usage, per plan. A disabled metric is never blocked; changes apply on Save.
          </p>
        </div>

        {rows === null && !loadError && <AdminSpinner label="Loading AI allowances" />}
        {loadError && <AdminError message={loadError} onRetry={retry} />}

        {rows !== null && rows.length === 0 && !loadError && (
          <p className="text-sm text-gray-500 dark:text-slate-400">No allowances are configured yet.</p>
        )}

        {rows !== null && rows.length > 0 && (
          <div className="space-y-1.5">
            {rows.map((row) => {
              const key = rowKey(row);
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-white capitalize">{row.plan}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">{metricLabel(row.metric)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      aria-label={`Monthly value for ${row.plan} ${row.metric}`}
                      value={row.monthlyValue}
                      disabled={row.saving}
                      onChange={(e) => patchRow(key, { monthlyValue: e.target.value, dirty: true })}
                      className="w-28 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100"
                    />
                    <Switch
                      size="sm"
                      checked={row.enabled}
                      disabled={row.saving}
                      onChange={(enabled) => patchRow(key, { enabled, dirty: true })}
                      ariaLabel={`Enable the ${row.plan} ${metricLabel(row.metric)} allowance`}
                    />
                    {row.dirty ? <Badge variant="warning">unsaved</Badge> : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void saveRow(row)}
                      disabled={!row.dirty || row.saving}
                      isLoading={row.saving}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
