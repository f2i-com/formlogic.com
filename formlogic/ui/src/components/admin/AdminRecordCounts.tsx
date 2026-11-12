import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Database, ShieldCheck, Sigma } from 'lucide-react';
import { Header } from '../layout/Header';
import { PageBody } from '../layout/PageBody';
import { api } from '../../lib/api';
import { useResourcePaths } from './AdminActingContext';
import { AdminCount, AdminSpinner } from '../../pages/admin/adminUi';

/**
 * The acting-mode replacement for the app Records view: per-form record COUNTS
 * (statistics), never the records themselves. Data comes from the admin app
 * structure endpoint, which carries responseCount per attached form.
 */
export function AdminRecordCounts() {
  const { appId = '' } = useParams();
  const paths = useResourcePaths();
  const navigate = useNavigate();
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
    <div className="min-h-screen">
      {/* Back goes where the line "← {app} settings" went: the app's Manage settings. */}
      <Header
        title={appName ? `${appName} records` : 'Records'}
        back={{ onClick: () => navigate(paths.appSub(appId, 'settings?tab=manage')), label: `${appName || 'App'} settings` }}
      />
      <PageBody>
        <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-slate-300">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-gray-900 dark:text-white">Record counts only.</strong>{' '}
            Record data is not visible to platform admins — the data this app&apos;s forms collect belongs
            to the owner. You can manage its structure, members, roles, relations, flows and deployment.
          </span>
        </p>

        <div className="mt-4">
          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : forms === null ? (
            <AdminSpinner label="Loading record counts" />
          ) : (
            // The total first, then a count per form: as many across as the page has room for.
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
              <AdminCount icon={Sigma} label="Records across all forms" value={total.toLocaleString()} />
              {forms.map((f) => (
                <AdminCount
                  key={f.formId}
                  icon={Database}
                  label={f.displayName || f.formId}
                  value={f.responseCount == null ? '?' : f.responseCount.toLocaleString()}
                />
              ))}
            </dl>
          )}
        </div>
      </PageBody>
    </div>
  );
}
