// Custom-domains panel for the Deploy & Share page.
//
// Owners connect their own domain (e.g. mine.management), see the DNS TXT record to
// add, verify it, and open/remove it. Verification is server-side (real DNS in
// production; a dev shortcut on non-production hosts so the flow is testable locally).
//
// TLS policy is surfaced prominently: in flexible mode (APP_DOMAIN_REQUIRE_TLS_ACTIVE=0,
// the default) ownership alone connects the domain and any pending HTTPS is noted but not
// blocking; in strict mode the server holds the domain at status='verified' (ownership
// proven, HTTPS pending) until a live TLS handshake promotes it to 'active'.
import { useEffect, useState } from 'react';
import { Globe2, Plus, Trash2, RefreshCw, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Sliders, Lock, Smartphone } from 'lucide-react';
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
    verified: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/20',
    pending: 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20',
    failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20',
  };
  const label =
    status === 'active' ? 'Connected'
    : status === 'verified' ? 'Verified · HTTPS pending'
    : status === 'failed' ? 'Not verified'
    : 'Pending verification';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[status] ?? map.pending}`}>
      {label}
    </span>
  );
}

/** Prominent HTTPS/TLS indicator (measured during verification). Live = emerald; anything else = amber. */
function TlsBadge({ tlsStatus }: { tlsStatus?: string }) {
  const live = tlsStatus === 'active';
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${live ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
      title="HTTPS/TLS status measured during verification"
    >
      <Lock className="h-3 w-3 shrink-0" />
      {live ? 'HTTPS live' : 'HTTPS pending'}
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

// Per-domain native-runtime config. Round-trips through app_domains.native_config; the dynamic
// /.well-known/assetlinks.json route reads packageName + sha256CertFingerprints from it so a
// white-label Android build can App-Link-verify this custom domain. `nativeConfig` isn't declared on
// the AppDomain type yet, so read it through a narrow cast (robust whether or not it's typed elsewhere).
type NativeConfig = {
  packageName?: string;
  sha256CertFingerprints?: string[];
  minRuntimeVersion?: string;
  installUrl?: string;
  requireNativeRuntime?: boolean;
  showNativeCta?: boolean;
};

function readNativeConfig(domain: AppDomain): NativeConfig {
  const raw = (domain as unknown as { nativeConfig?: NativeConfig }).nativeConfig;
  return raw && typeof raw === 'object' ? raw : {};
}

// Inline validation for the native-app editor — mirrors the backend sanitizer (AppDomainService) so the
// owner sees a clear inline error instead of silently having a value dropped on save.
const ANDROID_PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const SHA256_FP_RE = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/; // 32 colon-separated hex byte-pairs
const VERSION_RE = /^\d+(\.\d+)*([-.+][0-9A-Za-z.-]+)?$/;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

type NativeConfigErrors = {
  packageName?: string;
  fingerprints?: string;
  minRuntimeVersion?: string;
  installUrl?: string;
};

function FieldError({ msg }: { msg?: string }) {
  return msg ? <span className="mt-1 block text-[11px] text-red-500 dark:text-red-400">{msg}</span> : null;
}

function validateNativeConfig(input: {
  packageName: string;
  fingerprints: string;
  minRuntimeVersion: string;
  installUrl: string;
}): NativeConfigErrors {
  const errors: NativeConfigErrors = {};
  const pkg = input.packageName.trim();
  if (pkg && !ANDROID_PKG_RE.test(pkg)) {
    errors.packageName = 'Use a valid Android package name, e.g. com.yourcompany.app';
  }
  const fps = input.fingerprints.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (fps.some((fp) => !SHA256_FP_RE.test(fp))) {
    errors.fingerprints = 'Each fingerprint must be 32 colon-separated hex pairs (AB:CD:EF:…).';
  }
  const url = input.installUrl.trim();
  // HTTPS only: this link downloads an installable binary and is emitted in the SIGNED client
  // manifest — the server drops non-https values, so surface it here instead of silently losing it.
  if (url && (!isHttpUrl(url) || !/^https:\/\//i.test(url))) {
    errors.installUrl = 'Enter an https:// URL (app downloads must be served over TLS).';
  }
  const ver = input.minRuntimeVersion.trim();
  if (ver && (ver.length > 32 || !VERSION_RE.test(ver))) {
    errors.minRuntimeVersion = 'Enter a version like 0.1.0.';
  }
  return errors;
}

/** Per-domain native app / App Links editor — persists into app_domains.native_config. */
function NativeConfigEditor({ appId, domain, onSaved }: { appId: string; domain: AppDomain; onSaved: (d: AppDomain) => void }) {
  const [open, setOpen] = useState(false);
  const initial = readNativeConfig(domain);
  const [packageName, setPackageName] = useState(initial.packageName ?? '');
  const [fingerprints, setFingerprints] = useState((initial.sha256CertFingerprints ?? []).join('\n'));
  const [minRuntimeVersion, setMinRuntimeVersion] = useState(initial.minRuntimeVersion ?? '');
  const [installUrl, setInstallUrl] = useState(initial.installUrl ?? '');
  const [requireNativeRuntime, setRequireNativeRuntime] = useState(!!initial.requireNativeRuntime);
  const [showNativeCta, setShowNativeCta] = useState(!!initial.showNativeCta);
  const [saving, setSaving] = useState(false);

  const errors = validateNativeConfig({ packageName, fingerprints, minRuntimeVersion, installUrl });
  const hasErrors = Object.keys(errors).length > 0;

  const save = async () => {
    // Block saving invalid config so the owner fixes it here rather than having values silently dropped.
    if (hasErrors) return;
    setSaving(true);
    const sha256CertFingerprints = fingerprints
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const nativeConfig: NativeConfig = {
      packageName: packageName.trim() || undefined,
      sha256CertFingerprints,
      minRuntimeVersion: minRuntimeVersion.trim() || undefined,
      installUrl: installUrl.trim() || undefined,
      requireNativeRuntime,
      showNativeCta,
    };
    const res = await api.updateAppDomain(appId, domain.id, { nativeConfig });
    setSaving(false);
    if (res.error) {
      toast.error('Could not save native app settings', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    if (res.data?.domain) {
      onSaved(res.data.domain);
      toast.success('Native app settings saved');
    }
  };

  return (
    <div className="mt-2 border-t border-gray-100 dark:border-slate-700/60 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Smartphone className="h-3.5 w-3.5" /> Native app &amp; App Links
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] leading-relaxed text-gray-500 dark:text-slate-400">
            For a white-label Android build. The package name + certificate fingerprints are served at{' '}
            <span className="font-mono">/.well-known/assetlinks.json</span> so your app can App-Link-verify this domain.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className="block text-[11px] font-medium text-gray-500 dark:text-slate-400 mb-1">Android package name</span>
              <input
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                placeholder="com.yourcompany.app"
                aria-invalid={!!errors.packageName}
                className={`w-full px-3 py-2 border rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-xs font-mono focus:ring-2 ${errors.packageName ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : 'border-gray-300 dark:border-slate-600 focus:ring-primary-500'}`}
              />
              <FieldError msg={errors.packageName} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] font-medium text-gray-500 dark:text-slate-400 mb-1">Minimum runtime version</span>
              <input
                value={minRuntimeVersion}
                onChange={(e) => setMinRuntimeVersion(e.target.value)}
                placeholder="0.1.0"
                aria-invalid={!!errors.minRuntimeVersion}
                className={`w-full px-3 py-2 border rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-xs font-mono focus:ring-2 ${errors.minRuntimeVersion ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : 'border-gray-300 dark:border-slate-600 focus:ring-primary-500'}`}
              />
              <FieldError msg={errors.minRuntimeVersion} />
            </label>
          </div>
          <label className="block min-w-0">
            <span className="block text-[11px] font-medium text-gray-500 dark:text-slate-400 mb-1">SHA-256 certificate fingerprints</span>
            <textarea
              value={fingerprints}
              onChange={(e) => setFingerprints(e.target.value)}
              rows={2}
              placeholder={'One per line\nAB:CD:EF:…'}
              aria-invalid={!!errors.fingerprints}
              className={`w-full px-3 py-2 border rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-xs font-mono focus:ring-2 resize-y break-all ${errors.fingerprints ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : 'border-gray-300 dark:border-slate-600 focus:ring-primary-500'}`}
            />
            {errors.fingerprints ? (
              <FieldError msg={errors.fingerprints} />
            ) : (
              <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-1">One fingerprint per line (or comma-separated).</span>
            )}
          </label>
          <label className="block min-w-0">
            <span className="block text-[11px] font-medium text-gray-500 dark:text-slate-400 mb-1">Native install URL</span>
            <input
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              placeholder="https://play.google.com/store/apps/details?id=…"
              aria-invalid={!!errors.installUrl}
              className={`w-full px-3 py-2 border rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-xs focus:ring-2 ${errors.installUrl ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : 'border-gray-300 dark:border-slate-600 focus:ring-primary-500'}`}
            />
            <FieldError msg={errors.installUrl} />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
              <input type="checkbox" checked={showNativeCta} onChange={(e) => setShowNativeCta(e.target.checked)} className="rounded" />
              Show “Get the native app” prompt
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
              <input type="checkbox" checked={requireNativeRuntime} onChange={(e) => setRequireNativeRuntime(e.target.checked)} className="rounded" />
              Require the native runtime
            </label>
          </div>
          {/* FL-NATIVE-001: make the lockout consequences of require-native explicit before saving. */}
          {requireNativeRuntime && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
              <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                The launch page will steer every visitor to the native app instead of the web app.
                {installUrl.trim()
                  ? ' Visitors without it are sent to your install URL.'
                  : ' No install URL is set, so visitors without it are sent to the generic FormLogic download page — set your store listing above for a branded path.'}{' '}
                A “continue in your browser” recovery link stays available so nobody is locked out.
              </p>
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            {hasErrors && <span className="text-[11px] text-red-500 dark:text-red-400">Fix the highlighted fields to save.</span>}
            <Button size="sm" onClick={save} isLoading={saving} disabled={saving || hasErrors}>Save native settings</Button>
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
    const status = res.data?.domain?.status ?? res.data?.status;
    if (res.data?.ok || status === 'active') {
      toast.success('Domain verified', 'Your app is now reachable on this domain.');
    } else if (status === 'verified') {
      toast.info('Ownership verified', res.data?.message || 'Waiting for HTTPS to go live before this domain activates.');
    } else {
      toast.warning('Not verified yet', res.data?.message || 'Add the DNS TXT record and try again.');
    }
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
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-white truncate">{d.domain}</span>
                  <StatusBadge status={d.status} />
                  {(d.status === 'active' || d.status === 'verified') && d.tlsStatus && (
                    <TlsBadge tlsStatus={d.tlsStatus} />
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {d.status !== 'active' && (
                    <Button variant="outline" size="sm" onClick={() => verify(d)} isLoading={busyId === d.id} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
                      {d.status === 'verified' ? 'Re-check' : 'Verify'}
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

              {/* Strict-mode holding state: ownership proven, waiting for HTTPS before it goes live. */}
              {d.status === 'verified' && (
                <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  Ownership is verified. This domain goes live automatically once HTTPS is detected — DNS routing or the TLS
                  certificate may still be provisioning. Click <span className="font-medium">Re-check</span> to try again.
                </div>
              )}

              {/* Flexible-mode note: connected, but HTTPS isn't confirmed yet (non-blocking). */}
              {d.status === 'active' && d.tlsStatus && d.tlsStatus !== 'active' && (
                <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  Connected. HTTPS isn’t confirmed yet — DNS routing or the TLS certificate may still be provisioning. This
                  doesn’t block the domain; re-check later to confirm HTTPS is live.
                </div>
              )}

              {(d.status === 'pending' || d.status === 'failed') && (
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
              <NativeConfigEditor
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
