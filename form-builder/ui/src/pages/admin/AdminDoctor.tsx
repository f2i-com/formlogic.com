import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw, Stethoscope } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { api, type DeepHealth, type DeepHealthCheck } from '../../lib/api';
import { formatDateTimeInZone, useAdminTimezone } from '../../lib/timezone';

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
  quickjs: 'QuickJS runtime',
  paypal: 'Billing (PayPal)',
  webhook_worker: 'Webhook retry worker',
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
  quickjs: 'Ensure the vendored qjs binary, harness, and prelude are present in backend/bin + resources.',
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

  const styles: Record<Severity, { ring: string; chip: string; Icon: typeof CheckCircle2 }> = {
    fail: { ring: 'border-red-300 dark:border-red-500/40', chip: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300', Icon: XCircle },
    warn: { ring: 'border-amber-300 dark:border-amber-500/40', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300', Icon: AlertTriangle },
    ok: { ring: 'border-gray-200/80 dark:border-slate-700/60', chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', Icon: CheckCircle2 },
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2.5 min-w-0">
          <Stethoscope className="h-5 w-5 text-primary-600 dark:text-primary-400 shrink-0" />
          <p className="text-sm text-gray-500 dark:text-slate-400">
            System diagnostics from <code className="fl-mono text-xs">/api/health/deep</code>.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" role="status" aria-label="Running diagnostics" />
        </div>
      ) : error ? (
        <Card className="p-6 text-center">
          <p className="text-red-600 dark:text-red-400 mb-3">Couldn't load diagnostics.</p>
          <Button variant="secondary" size="sm" onClick={refresh}>Try again</Button>
        </Card>
      ) : data ? (
        <>
          <div
            className={`mb-6 rounded-xl border p-4 flex items-center gap-3 ${data.status === 'ok' ? 'border-emerald-300 dark:border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-red-300 dark:border-red-500/40 bg-red-50/60 dark:bg-red-500/10'}`}
            role="status"
          >
            {data.status === 'ok'
              ? <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
              : <XCircle className="h-6 w-6 text-red-600 dark:text-red-400 shrink-0" />}
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 dark:text-white">
                {data.status === 'ok' ? 'All critical checks passing' : 'Degraded — a critical check is failing'}
              </p>
              <p className="text-xs text-gray-500 dark:text-slate-400 tabular-nums">
                {counts.fail} failing · {counts.warn} warnings · {counts.ok} ok
              </p>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            {checks.map(([key, c]) => {
              const sev = severityOf(c);
              const s = styles[sev];
              return (
                <Card key={key} className={`p-4 border ${s.ring}`}>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium text-gray-900 dark:text-white text-sm min-w-0 truncate">{humanize(key)}</h3>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 ${s.chip}`}>
                      <s.Icon className="h-3 w-3" /> {sev === 'ok' ? 'OK' : sev === 'warn' ? 'Warn' : 'Fail'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-gray-600 dark:text-slate-300 break-words">{c.detail}</p>
                  {c.warning && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400 break-words">{c.warning}</p>}
                  {sev !== 'ok' && REMEDIATION[key] && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-slate-500 break-words">{REMEDIATION[key]}</p>
                  )}
                </Card>
              );
            })}
          </div>

          {data.timestamp && (
            <p className="mt-6 text-xs text-gray-400 dark:text-slate-500">Checked {formatDateTimeInZone(data.timestamp, tz)}</p>
          )}
        </>
      ) : null}
    </div>
  );
}
