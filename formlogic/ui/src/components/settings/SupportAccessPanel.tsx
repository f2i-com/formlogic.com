import { useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Settings, Security: whether site administrators may edit this account's automations, logic and
 * screens, a day at a time, and what they have done here. Hidden for the shared demo.
 */
export function SupportAccessPanel() {
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const [state, setState] = useState<{ until: string | null; activity: { at: string; what: string }[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    void api.getSupportAccess().then((result) => {
      if (cancelled) return;
      if (result.data) setState(result.data);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, [isDemo]);

  if (isDemo) return null;

  const change = async (allow: boolean) => {
    setBusy(true);
    const result = await api.setSupportAccess(allow);
    setBusy(false);
    if (result.error || !result.data) {
      toast.error('Could not change support access', result.error);
      return;
    }
    const until = result.data.until;
    setState((current) => ({ until, activity: current?.activity ?? [] }));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-4 w-4 text-gray-500 dark:text-slate-400" />
        <h3 className="font-medium text-gray-900 dark:text-white">Support access</h3>
      </div>
      <p className="text-sm text-gray-500 dark:text-slate-400">
        Site administrators can look at how your apps and forms are built when they help you. Editing your automations, logic or screens needs your permission, because that code runs on your records.
      </p>
      {failed ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Support access could not be loaded. Reload this page to try again.</p>
      ) : !state ? (
        <p role="status" className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {state.until ? (
              <>
                <p className="text-sm text-gray-900 dark:text-white">Allowed until {when(state.until)}</p>
                <Button size="sm" variant="outline" onClick={() => void change(false)} isLoading={busy}>End now</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void change(true)} isLoading={busy}>Allow for 24 hours</Button>
            )}
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-900 dark:text-white">Administrator activity</h4>
            {state.activity.length === 0 ? (
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">No administrator has been in your account.</p>
            ) : (
              <ul className="mt-1 divide-y divide-gray-100 dark:divide-slate-800">
                {state.activity.map((row, index) => (
                  <li key={`${row.at}-${index}`} className="py-1.5 text-sm">
                    <span className="text-gray-900 dark:text-white">{row.what}</span>
                    <span className="block text-xs text-gray-500 dark:text-slate-400">{when(row.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
