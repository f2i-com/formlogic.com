import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2, XCircle, Ban } from 'lucide-react';
import { Button } from '../ui/Button';
import { api, type PackageInstallJob } from '../../lib/api';
import { toast } from '../../stores/toastStore';

/**
 * MKT-604: progress for installs that run on a DEVICE.
 *
 * A device install is not a request you wait on — it is fetch, verify, stage, install,
 * activate, on a machine that may be slow or may drop. Two consequences shape this component:
 *
 *   - **State lives on the server, not in this component.** Progress is polled from the job
 *     row, so closing this panel and reopening it (or reloading the page entirely) shows the
 *     same job at the same point. Progress kept in component state would reset to nothing and
 *     imply the work had restarted.
 *   - **A finished job stays on screen.** Success does not auto-dismiss, because the result —
 *     what installed, or why it failed — is the part worth reading, and a panel that vanishes
 *     on completion takes the answer with it.
 *
 * Polling stops once every job is terminal, so an idle page is not making requests forever.
 */

const POLL_MS = 2000;

function isTerminal(job: PackageInstallJob): boolean {
  return job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled';
}

function StateIcon({ state }: { state: PackageInstallJob['state'] }) {
  if (state === 'succeeded') return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />;
  if (state === 'failed') return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden="true" />;
  if (state === 'cancelled') return <Ban className="h-4 w-4 text-gray-400 dark:text-slate-500" aria-hidden="true" />;
  return <Loader2 className="h-4 w-4 animate-spin text-primary-600 dark:text-primary-400" aria-hidden="true" />;
}

/** Plain-language state, in the interface's voice. */
function stateLabel(job: PackageInstallJob): string {
  switch (job.state) {
    case 'queued': return 'Waiting for a device';
    case 'running': return job.step ? job.step : 'Installing';
    case 'succeeded': return 'Installed';
    case 'failed': return job.error || 'Install failed';
    case 'cancelled': return 'Cancelled';
  }
}

export function InstallJobProgress() {
  const [jobs, setJobs] = useState<PackageInstallJob[] | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.listPackageJobs().then((response) => {
      if (!cancelled) setJobs(response.data?.jobs ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Poll only while something is still moving — an idle page should go quiet.
  useEffect(() => {
    if (jobs === null || jobs.every(isTerminal)) return;
    const timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
    return () => clearTimeout(timer);
  }, [jobs]);

  const cancel = useCallback(async (jobId: string) => {
    setCancelling(jobId);
    const response = await api.cancelPackageJob(jobId);
    setCancelling(null);
    if (response.data) {
      setTick((t) => t + 1);
      toast.info('Install cancelled', 'The device will stop when it next checks in.');
    } else {
      toast.error('Could not cancel', response.error || 'The job may have already finished.');
    }
  }, []);

  // Nothing to report is not worth a section — an empty progress panel is noise.
  if (jobs === null || jobs.length === 0) return null;

  return (
    <section className="space-y-2" aria-label="Device installs">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500">
        Device installs
      </h3>
      <ul className="space-y-2">
        {jobs.map((job) => (
          <li
            key={job.id}
            className="rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5"><StateIcon state={job.state} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {job.distributionId || job.installationId || job.kind}
                </p>
                <p className={`mt-0.5 text-xs ${job.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-slate-400'}`}>
                  {stateLabel(job)}
                </p>
                {job.state === 'running' && (
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-slate-800"
                    role="progressbar"
                    aria-valuenow={job.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Install progress: ${job.progress}%`}
                  >
                    <div
                      className="h-full rounded-full bg-primary-500 transition-[width] duration-500 motion-reduce:transition-none"
                      style={{ width: `${Math.max(2, job.progress)}%` }}
                    />
                  </div>
                )}
                {job.state === 'failed' && job.errorCode && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-gray-400 dark:text-slate-500">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {job.errorCode}
                  </p>
                )}
              </div>
              {!isTerminal(job) && (
                <Button variant="outline" size="sm" onClick={() => void cancel(job.id)} isLoading={cancelling === job.id}>
                  Cancel
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
