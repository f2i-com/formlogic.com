import type { ReactNode } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Cpu, Plug, KeyRound, LayoutGrid, Code2, BadgeCheck, Workflow, Boxes } from 'lucide-react';
import { Badge } from '../ui/Badge';
import type { PackCapabilitySummary, PackVendorSigning } from '../../lib/api';
// isConnectorGrant/reviewableConnectorGrants moved to lib/packTrust.ts so this
// file only exports components (react-refresh rule).
import { isConnectorGrant, reviewableConnectorGrants } from '../../lib/packTrust';
import { grantLabel } from '../../lib/grantLabels';

/**
 * Trust badge for a marketplace listing / application package. `trust` is ALWAYS server-computed
 * (spec §30.1) — the UI only renders it, it never derives or asserts trust itself.
 */
export function TrustBadge({ trust }: { trust?: string | null }) {
  const t = (trust || '').toLowerCase();
  switch (t) {
    case 'official':
      return <Badge variant="success" size="sm"><ShieldCheck className="h-3 w-3 mr-1" />Official</Badge>;
    case 'verified':
      return <Badge variant="info" size="sm"><ShieldCheck className="h-3 w-3 mr-1" />Verified</Badge>;
    case 'local-only':
      return <Badge variant="default" size="sm"><ShieldCheck className="h-3 w-3 mr-1" />Signed (local)</Badge>;
    case 'unverified':
      return <Badge variant="error" size="sm"><ShieldAlert className="h-3 w-3 mr-1" />Unverified</Badge>;
    case 'private':
      return <Badge variant="default" size="sm">Private</Badge>;
    case 'community':
    default:
      return <Badge variant="warning" size="sm"><ShieldQuestion className="h-3 w-3 mr-1" />Community</Badge>;
  }
}

/**
 * Capability review panel (spec §30.1 / APP-502): what the package can do, surfaced from the
 * server's PackCapabilities describe() BEFORE the user installs.
 *
 * The powered CONNECTOR grants become an approve/deny checklist when `selectedGrants` +
 * `onToggleGrant` are supplied (the install then activates only the ticked ones — the server
 * strips the rest from both grant carriers); without them it stays a read-only summary.
 * Low-risk effect permissions (toast, storage, responses.write, …) are always display-only.
 */
export function CapabilityReview({
  caps,
  trust,
  vendorSigning,
  selectedGrants,
  onToggleGrant,
}: {
  caps: PackCapabilitySummary;
  trust?: string | null;
  vendorSigning?: PackVendorSigning;
  /** When provided, connector grants render as checkboxes (the approve/deny set). */
  selectedGrants?: Set<string>;
  onToggleGrant?: (grant: string, next: boolean) => void;
}) {
  const chip = (icon: ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 dark:bg-slate-800 px-2 py-1 text-xs text-gray-600 dark:text-slate-300">
      {icon}
      {label}
    </span>
  );
  const connectorGrants = reviewableConnectorGrants(caps);
  const otherPerms = caps.permissions.filter((p) => !isConnectorGrant(p));
  const interactive = !!selectedGrants && !!onToggleGrant;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-slate-300">Capability review</h4>
        {trust !== undefined && <TrustBadge trust={trust} />}
      </div>
      {/* SAFE-002: a MODIFIED component must stay visible even when the verified count is zero —
          the old render skipped the whole line unless something verified, which hid exactly the
          worst case (every signed screen edited after signing). */}
      {vendorSigning?.signed && ((vendorSigning.verified?.length ?? 0) > 0 || (vendorSigning.modified?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {(vendorSigning.verified?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
              <BadgeCheck className="h-3.5 w-3.5" />
              {`${vendorSigning.verified!.length} screen${vendorSigning.verified!.length === 1 ? '' : 's'} verified from the vendor's signature`}
            </span>
          )}
          {(vendorSigning.modified?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
              <ShieldAlert className="h-3.5 w-3.5" />
              {`${vendorSigning.modified!.length} screen${vendorSigning.modified!.length === 1 ? '' : 's'} modified after signing`}
            </span>
          )}
        </div>
      )}
      {/* ADR-010: an Application Package v2 aggregate — package meta + contributed nodes replace
          the Pack v1 form/app counts (which are zeros for a node-only extension). */}
      {caps.packageV2 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="info" size="sm">{caps.packageV2.kind}</Badge>
            <span className="text-xs font-medium text-gray-700 dark:text-slate-300">{caps.packageV2.displayName}</span>
            <span className="text-[11px] text-gray-500 dark:text-slate-400 font-mono">{caps.packageV2.id} · v{caps.packageV2.version}</span>
          </div>
          {caps.packageV2.nodes.length > 0 && (
            <div className="space-y-0.5">
              <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><Workflow className="h-3 w-3" />Contributed flow nodes:</span>
              <div className="flex flex-wrap gap-1.5">
                {caps.packageV2.nodes.map((n) => (
                  <span key={n.type} title={n.type} className="rounded bg-primary-50 dark:bg-primary-500/10 px-1.5 py-0.5 text-[11px] font-medium text-primary-700 dark:text-primary-300">
                    {n.label || n.type}{n.version ? ` v${n.version}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
          {caps.packageV2.requirementSlots.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><Plug className="h-3 w-3" />Needs a service for:</span>
              {caps.packageV2.requirementSlots.map((s) => (
                <span key={s} className="rounded bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-amber-700 dark:text-amber-300">{s}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Pack v1 content counts (all zeros for a v2 node-only extension — hidden there). */}
      {!caps.packageV2 && (
        <div className="flex flex-wrap gap-1.5">
          {chip(<LayoutGrid className="h-3 w-3" />, `${caps.forms} form${caps.forms === 1 ? '' : 's'}`)}
          {chip(<LayoutGrid className="h-3 w-3" />, `${caps.apps} app${caps.apps === 1 ? '' : 's'}`)}
          {(caps.flows ?? 0) > 0 && chip(<Workflow className="h-3 w-3" />, `${caps.flows} flow${caps.flows === 1 ? '' : 's'}`)}
          {(caps.flowBindings ?? 0) > 0 && chip(<Workflow className="h-3 w-3" />, `${caps.flowBindings} trigger${caps.flowBindings === 1 ? '' : 's'}`)}
          {caps.hasScreens && chip(<Code2 className="h-3 w-3" />, 'Custom screens')}
          {caps.hasCustomLogic && chip(<Cpu className="h-3 w-3" />, `${caps.logicScripts} logic script${caps.logicScripts === 1 ? '' : 's'}`)}
        </div>
      )}
      {/* SAFE-002: App Features bundled with the pack's apps (the apps[].services toggle — NOT
          Desktop services; those arrive with Package v2). Informational — toggled post-install. */}
      {(caps.services?.length ?? 0) > 0 && (
        <div className="space-y-0.5">
          <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><Boxes className="h-3 w-3" />App features (toggle after install):</span>
          <div className="flex flex-wrap gap-1.5">
            {caps.services!.map((s) => (
              <span key={s.id} title={s.description || undefined} className="rounded bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:text-slate-300">
                {s.title}{s.defaultEnabled ? '' : ' (off by default)'}
              </span>
            ))}
          </div>
        </div>
      )}
      {caps.connectors.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><Plug className="h-3 w-3" />Connectors:</span>
          {caps.connectors.map((c) => (
            <span key={c} className="rounded bg-primary-50 dark:bg-primary-500/10 px-1.5 py-0.5 text-[11px] font-medium text-primary-700 dark:text-primary-300">{c}</span>
          ))}
        </div>
      )}
      {connectorGrants.length > 0 && interactive && (
        <div className="space-y-1">
          <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><KeyRound className="h-3 w-3" />This template is asking to:</span>
          {/* Sentence first, id second. This list used to be monospace grant ids under the
              heading "Device & connector access" — the most consequential question in the
              install flow, asked in a vocabulary the person answering does not have. */}
          <div className="space-y-1.5">
            {connectorGrants.map((p) => {
              const label = grantLabel(p);
              const allowed = selectedGrants!.has(p);
              return (
                <label key={p} className="flex cursor-pointer items-start gap-2 text-[11px] text-gray-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-gray-300 dark:border-slate-600"
                    checked={allowed}
                    onChange={(e) => onToggleGrant!(p, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block">{label.sentence}</span>
                    {!allowed && (
                      <span className="mt-0.5 block text-gray-500 dark:text-slate-400">{label.ifOff}</span>
                    )}
                    <span className="mt-0.5 block font-mono text-[10px] text-gray-400 dark:text-slate-500" title={p}>{p}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {connectorGrants.length > 0 && !interactive && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><KeyRound className="h-3 w-3" />Connector access:</span>
          {connectorGrants.map((p) => (
            <span key={p} className="rounded bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-amber-700 dark:text-amber-300">{p}</span>
          ))}
        </div>
      )}
      {otherPerms.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><KeyRound className="h-3 w-3" />Permissions:</span>
          {otherPerms.map((p) => (
            <span key={p} className="rounded bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:text-slate-300">{p}</span>
          ))}
        </div>
      )}
    </div>
  );
}
