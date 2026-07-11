import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Database, ShieldCheck } from 'lucide-react';
import { StatCard } from '../ui/StatCard';
import { api } from '../../lib/api';
import { useResourcePaths } from './AdminActingContext';

/**
 * The acting-mode replacement for the app Records view: per-form record COUNTS
 * (statistics), never the records themselves. Data comes from the admin app
 * structure endpoint, which carries responseCount per attached form.
 */
export function AdminRecordCounts() {
  const { appId = '' } = useParams();
  const paths = useResourcePaths();
  const [forms, setForms] = useState<Array<{ formId: string; displayName?: string; responseCount?: number | null }> | null>(null);
  const [appName, setAppName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.adminGetApp(appId).then((r) => {
      if (cancelled) return;
      if (r.data) {
        setForms(r.data.forms);
        setAppName(typeof r.data.app.name === 'string' ? r.data.app.name : '');
      } else {
        setError(r.error || 'Could not load record counts');
      }
    });
    return () => { cancelled = true; };
  }, [appId]);

  const total = (forms ?? []).reduce((sum, f) => sum + (f.responseCount ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto w-full space-y-5">
        <Link
          to={paths.appSub(appId, 'settings?tab=manage')}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" /> {appName || 'App'} settings
        </Link>

        <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50/60 dark:bg-amber-500/10 p-4 flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-gray-900 dark:text-white">Record counts only</p>
            <p className="text-sm text-gray-600 dark:text-slate-300">
              Record data is not visible to platform admins — the data this app&apos;s forms collect belongs
              to the owner. You can manage its structure, members, roles, relations, flows and deployment.
            </p>
          </div>
        </div>

        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : forms === null ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <StatCard
              icon={Database}
              iconBg="bg-primary-100 dark:bg-primary-500/15"
              iconColor="text-primary-700 dark:text-primary-300"
              value={total.toLocaleString()}
              label="Records across all forms"
            />
            {forms.map((f) => (
              <StatCard
                key={f.formId}
                icon={Database}
                iconBg="bg-gray-100 dark:bg-slate-800"
                iconColor="text-gray-500 dark:text-slate-400"
                value={f.responseCount == null ? '?' : f.responseCount.toLocaleString()}
                label={f.displayName || f.formId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
