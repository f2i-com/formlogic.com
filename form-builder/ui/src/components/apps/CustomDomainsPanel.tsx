// Custom-domains panel for the Deploy & Share page.
//
// Owners connect their own domain (e.g. mine.management), see the DNS TXT record to
// add, verify it, and open/remove it. Verification is server-side (real DNS in
// production; a dev shortcut on non-production hosts so the flow is testable locally).
import { useEffect, useState } from 'react';
import { Globe2, Plus, Trash2, RefreshCw, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Sliders } from 'lucide-react';
import { api, type AppDomain } from '../../lib/api';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';

const MODE_OPTIONS = [
  { value: 'launch_page', label: 'Launch page (branded landing + open app)' },
  { value: 'runtime_direct', label: 'Open the app directly' },
];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20',
    pending: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20',
    failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20',
  };
  const label = status === 'active' ? 'Connected' : status === 'failed' ? 'Not verified' : 'Pending verification';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[status] ?? map.pending}`}>
      {label}
    </span>
  );
}

// The owner-authored launch-page fields (mirror AppDomainService::resolveLaunchConfig defaults).
type LandingConfig = {
  headline?: string;
  subheadline?: string;
  description?: string;
  logoUrl?: string;
  showOpenWebApp?: boolean;
  showInstallPwa?: boolean;
  showInstallNative?: boolean;
  showPoweredBy?: boolean;
  supportEmail?: string;
  privacyUrl?: string;
  termsUrl?: string;
};

const LANDING_TEXT_FIELDS: { key: keyof LandingConfig; label: string; placeholder: string }[] = [
  { key: 'headline', label: 'Headline', placeholder: 'Shown big on the launch page' },
  { key: 'subheadline', label: 'Subheadline', placeholder: 'One line under the headline' },
  { key: 'logoUrl', label: 'Logo URL', placeholder: 'https://…/logo.png' },
  { key: 'supportEmail', label: 'Support email', placeholder: 'help@yourcompany.com' },
  { key: 'privacyUrl', label: 'Privacy URL', placeholder: 'https://…/privacy' },
  { key: 'termsUrl', label: 'Terms URL', placeholder: 'https://…/terms' },
];

const LANDING_TOGGLES: { key: keyof LandingConfig; label: string; fallback: boolean }[] = [
  { key: 'showOpenWebApp', label: 'Show “Open web app”', fallback: true },
  { key: 'showInstallPwa', label: 'Show “Install app” (PWA)', fallback: true },
  { key: 'showInstallNative', label: 'Show “Get the native app”', fallback: false },
  { key: 'showPoweredBy', label: 'Show “Powered by FormLogic”', fallback: true },
];

/** Per-domain launch-page editor — persists into app_domains.landing_config (backend already round-trips it). */
function LaunchPageEditor({ appId, domain, onSaved }: { appId: string; domain: AppDomain; onSaved: (d: AppDomain) => void }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<LandingConfig>(() => (domain.landingConfig ?? {}) as LandingConfig);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<LandingConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const save = async () => {
    setSaving(true);
    const res = await api.updateAppDomain(appId, domain.id, { landingConfig: cfg });
    setSaving(false);
    if (res.error) {
      toast.error('Could not save launch page', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    if (res.data?.domain) {
      onSaved(res.data.domain);
      toast.success('Launch page saved');
    }
  };

  return (
    <div className="mt-3 border-t border-gray-100 dark:border-slate-700/60 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Sliders className="h-3.5 w-3.5" /> Customize launch page
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {LANDING_TEXT_FIELDS.map((f) => (
              <label key={f.key} className="block min-w-0">
                <span className="block text-[11px] font-medium text-gray-500 dark:text-slate-400 mb-1">{f.label}</span>
                <input
                  value={(cfg[f.key] as string) ?? ''}
                  onChange={(e) => set({ [f.key]: e.target.value } as Partial<LandingConfig>)}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-xs focus:ring-2 focus:ring-primary-500"
                />
              </label>
            ))}
          </div>
          <label className="block">
            <span className="block text-[11px] font-medium text-gray-500 dark:text-slate-400 mb-1">Description</span>
            <textarea
              value={cfg.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              rows={2}
              placeholder="A sentence shown on the launch page."
              className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-xs focus:ring-2 focus:ring-primary-500 resize-y"
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {LANDING_TOGGLES.map((t) => (
              <label key={t.key} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                <input
                  type="checkbox"
                  checked={(cfg[t.key] as boolean) ?? t.fallback}
                  onChange={(e) => set({ [t.key]: e.target.checked } as Partial<LandingConfig>)}
                  className="rounded"
                />
                {t.label}
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={save} isLoading={saving} disabled={saving}>Save launch page</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CustomDomainsPanel({ appId }: { appId: string; appSlug?: string }) {
  const [domains, setDomains] = useState<AppDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState('');
  const [mode, setMode] = useState('launch_page');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AppDomain | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getAppDomains(appId).then((res) => {
      if (cancelled) return;
      if (res.data?.domains) setDomains(res.data.domains);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [appId]);

  const add = async () => {
    if (!newDomain.trim() || adding) return;
    setAdding(true);
    const res = await api.createAppDomain(appId, { domain: newDomain.trim(), mode });
    setAdding(false);
    if (res.error) {
      toast.error('Could not add domain', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    if (res.data?.domain) {
      setDomains((d) => [...d, res.data!.domain]);
      setNewDomain('');
      toast.success('Domain added', 'Add the DNS record below, then verify.');
    }
  };

  const verify = async (d: AppDomain) => {
    setBusyId(d.id);
    const res = await api.verifyAppDomain(appId, d.id);
    setBusyId(null);
    if (res.data?.domain) {
      setDomains((list) => list.map((x) => (x.id === d.id ? res.data!.domain! : x)));
    }
    if (res.data?.ok) toast.success('Domain verified', 'Your app is now reachable on this domain.');
    else toast.warning('Not verified yet', res.data?.message || 'Add the DNS TXT record and try again.');
  };

  const remove = async (d: AppDomain) => {
    setRemoveTarget(null);
    setBusyId(d.id);
    const res = await api.deleteAppDomain(appId, d.id);
    setBusyId(null);
    if (!res.error) {
      setDomains((list) => list.filter((x) => x.id !== d.id));
      toast.success('Domain removed');
    } else {
      toast.error('Could not remove domain');
    }
  };

  const copyDns = async (d: AppDomain) => {
    try {
      await navigator.clipboard.writeText(d.dns.value);
      setCopiedId(d.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
      <div className="flex items-center gap-3 mb-4">
        <Globe2 className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        <h3 className="font-medium text-gray-900 dark:text-white tracking-tight">Custom domains</h3>
      </div>
      <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
        Run this app on your own domain, so it feels like your product — not a page inside FormLogic.
      </p>

      {/* Add */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-4">
        <input
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="app.yourcompany.com"
          aria-label="Custom domain"
          className="flex-1 min-w-0 px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          aria-label="Domain mode"
          className="px-3 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500"
        >
          {MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button onClick={add} isLoading={adding} disabled={adding || !newDomain.trim()} leftIcon={<Plus className="h-4 w-4" />}>
          Add
        </Button>
      </div>

      {/* List */}
      {loading ? (
        <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
      ) : domains.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-slate-500">No custom domains yet.</p>
      ) : (
        <ul className="space-y-3">
          {domains.map((d) => (
            <li key={d.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-white truncate">{d.domain}</span>
                  <StatusBadge status={d.status} />
                  {d.status === 'active' && d.tlsStatus && (
                    <span
                      className={`text-[11px] font-medium ${d.tlsStatus === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
                      title="HTTPS/TLS status measured at verification"
                    >
                      HTTPS {d.tlsStatus === 'active' ? '✓' : d.tlsStatus}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {d.status !== 'active' && (
                    <Button variant="outline" size="sm" onClick={() => verify(d)} isLoading={busyId === d.id} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
                      Verify
                    </Button>
                  )}
                  {d.status === 'active' && (
                    <Button variant="outline" size="sm" onClick={() => window.open(`https://${d.domain}`, '_blank', 'noopener,noreferrer')} leftIcon={<ExternalLink className="h-3.5 w-3.5" />}>
                      Open
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(d)} aria-label={`Remove ${d.domain}`}>
                    <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                  </Button>
                </div>
              </div>

              {d.status !== 'active' && (
                <div className="mt-3 bg-gray-50 dark:bg-slate-800 rounded-lg p-3 text-xs text-gray-600 dark:text-slate-400 overflow-x-auto">
                  <p className="font-medium mb-2 text-gray-700 dark:text-slate-300">Add this DNS record, then click Verify:</p>
                  <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 font-mono whitespace-nowrap">
                    <span className="text-gray-400">Type</span><span>{d.dns.type}</span>
                    <span className="text-gray-400">Name</span><span>{d.dns.name}</span>
                    <span className="text-gray-400">Value</span>
                    <span className="flex items-center gap-2">
                      <span className="truncate">{d.dns.value}</span>
                      <button type="button" onClick={() => copyDns(d)} className="shrink-0 text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-1">
                        {copiedId === d.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                        {copiedId === d.id ? 'Copied' : 'Copy'}
                      </button>
                    </span>
                  </div>
                  {d.lastError && d.status === 'failed' && (
                    <p className="mt-2 text-red-500">{d.lastError}</p>
                  )}
                </div>
              )}

              <LaunchPageEditor
                appId={appId}
                domain={d}
                onSaved={(u) => setDomains((list) => list.map((x) => (x.id === u.id ? u : x)))}
              />
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && remove(removeTarget)}
        title="Remove this domain?"
        message={`${removeTarget?.domain ?? ''} will stop pointing at this app.`}
        confirmLabel="Remove"
        variant="danger"
      />
    </div>
  );
}
