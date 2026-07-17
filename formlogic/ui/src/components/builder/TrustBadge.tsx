import type { ReactNode } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Cpu, Plug, KeyRound, LayoutGrid, Code2, BadgeCheck } from 'lucide-react';
import { Badge } from '../ui/Badge';
import type { PackCapabilitySummary, PackVendorSigning } from '../../lib/api';

/** A pack permission string is a powered connector grant (vs a low-risk effect perm). */
export function isConnectorGrant(p: string): boolean {
  return p.startsWith('connector.');
}

/**
 * The REVIEWABLE connector grants for a pack — the set importPack can actually
 * strip (APP-502): the server's connectorGrants field, with a connector-prefixed
 * permissions fallback for an older server that doesn't send it. Every install
 * surface (builder pack browser, marketplace page) must derive its checklist +
 * approved set from THIS so the UI never offers a decline import can't honor.
 */
export function reviewableConnectorGrants(caps: PackCapabilitySummary): string[] {
  return caps.connectorGrants ?? caps.permissions.filter(isConnectorGrant);
}

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
      {vendorSigning?.signed && (vendorSigning.verified?.length ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
          <BadgeCheck className="h-3.5 w-3.5" />
          {`${vendorSigning.verified!.length} screen${vendorSigning.verified!.length === 1 ? '' : 's'} verified from the vendor's signature`}
          {(vendorSigning.modified?.length ?? 0) > 0 && (
            <span className="text-amber-600 dark:text-amber-400">· {vendorSigning.modified!.length} modified</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {chip(<LayoutGrid className="h-3 w-3" />, `${caps.forms} form${caps.forms === 1 ? '' : 's'}`)}
        {chip(<LayoutGrid className="h-3 w-3" />, `${caps.apps} app${caps.apps === 1 ? '' : 's'}`)}
        {caps.hasScreens && chip(<Code2 className="h-3 w-3" />, 'Custom screens')}
        {caps.hasCustomLogic && chip(<Cpu className="h-3 w-3" />, `${caps.logicScripts} logic script${caps.logicScripts === 1 ? '' : 's'}`)}
      </div>
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
          <span className="text-xs text-gray-500 dark:text-slate-400 inline-flex items-center gap-1"><KeyRound className="h-3 w-3" />Device &amp; connector access — approve what to allow:</span>
          <div className="space-y-0.5">
            {connectorGrants.map((p) => (
              <label key={p} className="flex items-center gap-2 text-[11px] text-gray-700 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-gray-300 dark:border-slate-600"
                  checked={selectedGrants!.has(p)}
                  onChange={(e) => onToggleGrant!(p, e.target.checked)}
                />
                <span className="font-mono">{p}</span>
              </label>
            ))}
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
