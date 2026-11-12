import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { api, type DeepHealth, type DeepHealthCheck } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';
import { cn } from '../../lib/utils';
import { LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_ROW, LIST_TABLE, LIST_TH } from '../../components/ui/listLook';

/**
 * /admin/doctor — system diagnostics (GET /api/health/deep, platform admins
 * only server-side too). Formerly the standalone /doctor page.
 */

type Severity = 'ok' | 'warn' | 'fail';

function severityOf(c: DeepHealthCheck): Severity {
  if (c.critical && !c.ok) return 'fail';
  if (!c.ok || c.warning) return 'warn';
  return 'ok';
}

const LABELS: Record<string, string> = {
  database: 'Database',
  // 'quickjs' is the historical /api/health/deep check id, kept for monitors; it checks the ZIPP runtime.
  quickjs: 'ZIPP runtime',
  paypal: 'Billing (PayPal)',
  webhook_worker: 'Webhook retry worker',
  scheduled_backup: 'Nightly backups',
  data_encryption: 'Encryption of stored data',
  backup_sealing: 'Sealed nightly backups',
  dual_store: 'Dual-store consistency',
  document_converter: 'Document converters',
  ai: 'AI service',
};

function humanize(key: string): string {
  if (LABELS[key]) return LABELS[key];
  if (key.startsWith('writable:')) return 'Writable: ' + key.slice('writable:'.length);
  if (key.startsWith('tool:')) return 'Tool: ' + key.slice('tool:'.length);
  return key.replace(/[_:]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

// Hints for checks whose own warning/detail doesn't already state the fix (webhook_worker +
// dual_store carry their remedy in the warning, so they're intentionally omitted here).
const REMEDIATION: Record<string, string> = {
  database: 'Check DB credentials/connectivity in the backend .env.',
  quickjs: 'Check the ZIPP launcher in backend/bin/runtime (it ships in the release zip; a source checkout builds it with scripts/build-runtime.sh) and resources/formlogic-prelude.js. If using a custom installation, check FORMLOGIC_RUNTIME_BIN. The launcher must be executable on Linux.',
};

const ORDER: Record<Severity, number> = { fail: 0, warn: 1, ok: 2 };

export function AdminDoctor() {
  const tz = useAdminTimezone();
  const [data, setData] = useState<DeepHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // setState only in the async callback so the initial-load effect never calls it synchronously.
  const load = useCallback(() => {
    api.getDeepHealth().then((res) => {
      if (res) { setData(res); setError(false); } else { setError(true); }
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh from a user click — synchronous spinner state here is fine (not an effect).
  const refresh = () => { setLoading(true); setError(false); load(); };

  const checks = data ? Object.entries(data.checks) : [];
  checks.sort((a, b) => ORDER[severityOf(a[1])] - ORDER[severityOf(b[1])]);
  const counts = checks.reduce(
    (m, [, c]) => { m[severityOf(c)]++; return m; },
    { ok: 0, warn: 0, fail: 0 } as Record<Severity, number>
  );

  const styles: Record<Severity, { chip: string; Icon: typeof CheckCircle2 }> = {
    fail: { chip: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300', Icon: XCircle },
    warn: { chip: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300', Icon: AlertTriangle },
    ok: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', Icon: CheckCircle2 },
  };

  return (
    <div className="@container/list space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 text-sm text-gray-500 dark:text-slate-400">
          Checks for database access, storage, and connected services.
          {data?.timestamp && <> Checked {formatDateTimeInZone(data.timestamp, tz)}.</>}
        </p>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2.5 py-2 text-sm text-gray-500 dark:text-slate-400">
          <div className="h-5 w-5 flex-none animate-spin rounded-full border-b-2 border-primary-500" role="status" aria-label="Running diagnostics" />
          <span aria-hidden="true">Running diagnostics…</span>
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2.5 dark:border-red-500/30 dark:bg-red-500/10">
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">Couldn't load diagnostics.</p>
          <Button variant="secondary" size="sm" onClick={refresh}>Try again</Button>
        </div>
      ) : data ? (
        <>
          {/* The verdict in one line: what state the installation is in, and how many checks say what. */}
          <div
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 ${data.status === 'ok' ? 'border-emerald-300 dark:border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-red-300 dark:border-red-500/40 bg-red-50/60 dark:bg-red-500/10'}`}
            role="status"
          >
            <span className="flex min-w-0 items-center gap-2">
              {data.status === 'ok'
                ? <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                : <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" aria-hidden="true" />}
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                {data.status === 'ok' ? 'All critical checks passing' : 'Degraded — a critical check is failing'}
              </span>
            </span>
            <span className="text-xs text-gray-600 dark:text-slate-300 tabular-nums">
              {counts.fail} failing · {counts.warn} warnings · {counts.ok} ok
            </span>
          </div>

          {/* Every check as a row, the ones that need attention first. Wide: a table whose last
              column takes the room for what was found. Narrow: the name and its state on one line,
              what was found under them. */}
          <div className={LIST_BOX}>
            <table className={LIST_TABLE}>
              <caption className="sr-only">System checks</caption>
              <thead className={LIST_HEAD}>
                <tr>
                  <th scope="col" className={cn(LIST_TH, 'w-56 pl-3 @4xl/list:w-72')}>Check</th>
                  <th scope="col" className={cn(LIST_TH, 'w-20')}>State</th>
                  <th scope="col" className={cn(LIST_TH, 'pr-3')}>What it found</th>
                </tr>
              </thead>
              <tbody className={LIST_BODY}>
                {checks.map(([key, c]) => {
                  const sev = severityOf(c);
                  const s = styles[sev];
                  return (
                    <tr key={key} className={cn(LIST_ROW, 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1')}>
                      <th scope="row" className={cn(LIST_CELL, 'font-medium text-gray-900 [overflow-wrap:anywhere] dark:text-white @xl/list:py-2 @xl/list:pl-3 @xl/list:align-top')}>{humanize(key)}</th>
                      <td className={cn(LIST_CELL, '@xl/list:py-[7px] @xl/list:align-top')}>
                        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${s.chip}`}>
                          <s.Icon className="h-3 w-3" aria-hidden="true" /> {sev === 'ok' ? 'OK' : sev === 'warn' ? 'Warn' : 'Fail'}
                        </span>
                      </td>
                      <td className={cn(LIST_CELL, 'col-span-2 @xl/list:py-2 @xl/list:pr-3 @xl/list:align-top')}>
                        <p className="break-words text-gray-600 dark:text-slate-300">{c.detail}</p>
                        {c.warning && <p className="break-words text-xs leading-5 text-amber-700 dark:text-amber-400">{c.warning}</p>}
                        {sev !== 'ok' && REMEDIATION[key] && (
                          <p className="break-words text-xs leading-5 text-gray-500 dark:text-slate-400">{REMEDIATION[key]}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
