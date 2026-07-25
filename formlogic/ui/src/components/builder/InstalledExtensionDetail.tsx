import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, PackageCheck, ArrowDownToLine, ArrowUpFromLine, ShieldCheck } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { api, type PackageInstallationDetail } from '../../lib/api';
import { ServiceSlotBindings } from './ServiceSlotBindings';

/**
 * ADR-010 §13.1 / MKT-605: the management detail of ONE installed Application Package v2.
 *
 * Reads the immutable install receipt endpoint and shows what the row cannot: the exact
 * contributed node types (with the digests the compiler locks against), BOTH dependency
 * directions, and the connector grants the install was reviewed under. Dependents are the
 * ones that matter operationally — required dependents block uninstall and constrain which
 * versions an update may move to — so they are surfaced up front rather than only appearing
 * as a 409 after the user commits.
 *
 * Fetch-on-expand: nothing is requested until the user opens the detail.
 */
export function InstalledExtensionDetail({ installationId }: { installationId: string }) {
  const [detail, setDetail] = useState<PackageInstallationDetail | null>(null);
  const [error, setError] = useState('');
  // Retry re-runs the effect; loading is DERIVED (never set inside the effect body).
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.getPackageInstallation(installationId).then((response) => {
      if (cancelled) return; // a re-expand/retry replaced this request
      if (response.data?.installation) {
        setDetail(response.data.installation);
      } else {
        setError(typeof response.error === 'string' && response.error !== '' ? response.error : 'Could not load the extension details.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [installationId, reloadToken]);

  const retry = useCallback(() => {
    setDetail(null);
    setError('');
    setReloadToken((token) => token + 1);
  }, []);

  const loading = detail === null && error === '';

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-gray-200 dark:border-slate-800 px-3 py-2 text-xs text-gray-500 dark:text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading extension details…
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <span className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="break-words">{error || 'Could not load the extension details.'}</span>
        </span>
        <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
      </div>
    );
  }

  const grants = Array.isArray(detail.receipt?.approvedConnectorGrants)
    ? (detail.receipt?.approvedConnectorGrants as unknown[]).filter((g): g is string => typeof g === 'string')
    : [];
  const trust = typeof detail.receipt?.trust === 'string' ? detail.receipt.trust : null;
  const updatedFrom = typeof detail.receipt?.updatedFrom === 'string' ? detail.receipt.updatedFrom : null;
  const blockingDependents = detail.dependents.filter((d) => d.required);

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-950/40 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-500 dark:text-slate-400">
        <span className="font-mono text-[11px] text-gray-600 dark:text-slate-300 break-all">{detail.packageId}</span>
        <span>by {detail.publisherId}</span>
        {trust && <Badge variant={trust === 'official' ? 'success' : trust === 'community' ? 'default' : 'info'} size="sm">{trust}</Badge>}
        {updatedFrom && <span>updated from v{updatedFrom}</span>}
      </div>

      {/* PKG-107: an installation that committed but has not activated must say so — its nodes
          are deliberately withheld, and silence would read as "the extension is broken". */}
      {detail.active === false && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-200">
          <p className="flex items-start gap-1.5 font-semibold">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            Not active yet
          </p>
          <ul className="mt-1 space-y-0.5 pl-5">
            {(detail.components ?? [])
              .filter((component) => component.state !== 'active')
              .map((component) => (
                <li key={component.key}>
                  <span className="font-medium">{component.key}</span>
                  {component.state === 'pending'
                    ? ` — waiting for ${component.deviceId ? `device ${component.deviceId}` : 'a device'} to report`
                    : component.state === 'failed'
                      ? ` — ${component.detail || 'health check failed'}`
                      : ' — committed, not yet checked'}
                </li>
              ))}
          </ul>
          <p className="mt-1">This extension&rsquo;s nodes stay out of the editor until every required part is healthy.</p>
        </div>
      )}

      <section>
        <h4 className="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-slate-200">
          <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Contributed flow nodes ({detail.nodes.length})
        </h4>
        {detail.nodes.length === 0 ? (
          <p className="mt-1 text-gray-500 dark:text-slate-400">This package contributes no flow nodes.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {detail.nodes.map((node) => (
              <li key={node.type} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-gray-700 dark:text-slate-200 break-all">{node.type}</span>
                <Badge variant="default" size="sm">v{node.version}</Badge>
                {!node.enabled && <Badge variant="warning" size="sm">disabled</Badge>}
                <span className="font-mono text-[10px] text-gray-500 dark:text-slate-400" title={`Definition digest ${node.digest}`}>
                  {node.digest.slice(0, 12)}…
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* SRV-405: the slots this package declares, and which service fills each. */}
      <ServiceSlotBindings installationId={detail.id} />

      {detail.dependencies.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-slate-200">
            <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
            Requires
          </h4>
          <ul className="mt-1 space-y-1">
            {detail.dependencies.map((dep) => (
              <li key={dep.packageId} className="flex flex-wrap items-center gap-2 text-gray-600 dark:text-slate-300">
                <span className="font-mono text-[11px] break-all">{dep.packageId}</span>
                <span className="text-gray-500 dark:text-slate-400">{dep.range} → v{dep.resolvedVersion}</span>
                {!dep.required && <Badge variant="default" size="sm">optional</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.dependents.length > 0 && (
        <section>
          <h4 className="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-slate-200">
            <ArrowUpFromLine className="h-3.5 w-3.5" aria-hidden="true" />
            Required by
          </h4>
          <ul className="mt-1 space-y-1">
            {detail.dependents.map((dep) => (
              <li key={dep.packageId} className="flex flex-wrap items-center gap-2 text-gray-600 dark:text-slate-300">
                <span>{dep.displayName} v{dep.version}</span>
                <span className="text-gray-500 dark:text-slate-400">needs {dep.range}</span>
                {!dep.required && <Badge variant="default" size="sm">optional</Badge>}
              </li>
            ))}
          </ul>
          {/* Name the blocker: "this package" read as if it meant the extension itself. */}
          {blockingDependents.length > 0 && (
            <p className="mt-1 text-amber-600 dark:text-amber-400">
              {blockingDependents.length === 1
                ? `Uninstall is blocked while “${blockingDependents[0].displayName}” still requires this extension, and updates must stay inside the range above.`
                : `Uninstall is blocked while ${blockingDependents.length} installed packages still require this extension, and updates must stay inside the ranges above.`}
            </p>
          )}
        </section>
      )}

      <section>
        <h4 className="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-slate-200">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Approved connector access
        </h4>
        {grants.length === 0 ? (
          <p className="mt-1 text-gray-500 dark:text-slate-400">None — this extension was installed with no connector grants approved.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {grants.map((grant) => (
              <li key={grant}>
                <Badge variant="info" size="sm">{grant}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-gray-500 dark:text-slate-400">
        Installed {new Date(detail.installedAt).toLocaleString()} · source {detail.source} · state {detail.state}
      </p>
    </div>
  );
}
