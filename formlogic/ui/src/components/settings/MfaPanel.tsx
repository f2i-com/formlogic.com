import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Laptop, Loader2, RefreshCcw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PasswordInput } from '../ui/PasswordInput';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useAccountTimezone, formatDateTimeInZone } from '../../lib/timezone';

type MfaStatus = {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
  trustedBrowsers: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean }>;
};

/** A friendly one-liner from a stored User-Agent string. */
function browserLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

const rowClass = 'flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60';

/**
 * Two-factor authentication management (Settings → Security): enrollment wizard
 * (QR + verify), one-time recovery codes, and the remembered-browser list with
 * per-device revocation. Optional — accounts work fine without it.
 */
export function MfaPanel() {
  const user = useAuthStore((s) => s.user);
  const tz = useAccountTimezone();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Enrollment wizard state.
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [enableCode, setEnableCode] = useState('');
  // Shown exactly once, right after enabling / regenerating.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // Disable + regenerate confirmations.
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenCode, setRegenCode] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getMfaStatus().then((r) => {
      if (!cancelled && r.data) setStatus(r.data);
    }).catch(() => { /* the panel degrades to its loading row rather than erroring the page */ });
    return () => { cancelled = true; };
  }, [refreshTick]);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  const startSetup = async () => {
    setBusy(true);
    const r = await api.startMfaSetup();
    setBusy(false);
    if (r.error || !r.data) {
      toast.error('Could not start setup', r.error);
      return;
    }
    setSetup(r.data);
    setEnableCode('');
  };

  const confirmEnable = async () => {
    if (!enableCode.trim()) return;
    setBusy(true);
    const r = await api.enableMfa(enableCode.trim());
    setBusy(false);
    if (r.error || !r.data) {
      toast.error('Verification failed', r.error);
      return;
    }
    setSetup(null);
    setEnableCode('');
    setRecoveryCodes(r.data.recoveryCodes);
    refresh();
    // Keep the header/store truthful without a full reload.
    useAuthStore.setState((s) => (s.user ? { user: { ...s.user, mfaEnabled: true } } : s));
    toast.success('Two-factor authentication is on', 'Save your recovery codes somewhere safe.');
  };

  const confirmDisable = async () => {
    setBusy(true);
    const r = await api.disableMfa(disablePassword);
    setBusy(false);
    if (r.error) {
      toast.error('Could not turn off two-factor', r.error);
      return;
    }
    setDisableOpen(false);
    setDisablePassword('');
    setRecoveryCodes(null);
    refresh();
    useAuthStore.setState((s) => (s.user ? { user: { ...s.user, mfaEnabled: false } } : s));
    toast.success('Two-factor authentication is off');
  };

  const confirmRegen = async () => {
    setBusy(true);
    const r = await api.regenerateMfaRecoveryCodes(regenCode.trim());
    setBusy(false);
    if (r.error || !r.data) {
      toast.error('Could not regenerate codes', r.error);
      return;
    }
    setRegenOpen(false);
    setRegenCode('');
    setRecoveryCodes(r.data.recoveryCodes);
    refresh();
    toast.success('New recovery codes issued', 'The previous set no longer works.');
  };

  const revokeBrowser = async (id: string) => {
    const r = await api.revokeMfaTrustedBrowser(id);
    if (r.error) {
      toast.error('Could not forget the browser', r.error);
      return;
    }
    refresh();
    toast.success('Browser forgotten', 'It will ask for a code on its next sign-in.');
  };

  const copyRecoveryCodes = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      toast.success('Copied', 'Recovery codes copied to the clipboard.');
    } catch {
      toast.error('Copy failed', 'Select and copy the codes manually.');
    }
  };

  if (user?.isDemo) return null;

  return (
    <div className="space-y-3">
      {/* Status / entry row */}
      <div className={rowClass}>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
            {status?.enabled
              ? <ShieldCheck className="h-4 w-4 text-emerald-500" />
              : <ShieldOff className="h-4 w-4 text-gray-400 dark:text-slate-500" />}
            Two-factor authentication
            {status?.enabled && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30">On</span>
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
            {status?.enabled
              ? `One-time codes from your authenticator app protect sign-ins on unknown browsers. ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? '' : 's'} left.`
              : 'Add a one-time code from Google Authenticator (or any TOTP app) to sign-ins from unknown browsers. Optional, recommended.'}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {status?.enabled ? (
            <>
              <Button variant="outline" size="sm" onClick={() => { setRegenOpen(true); setRegenCode(''); }} leftIcon={<RefreshCcw className="h-4 w-4" />}>
                New recovery codes
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setDisableOpen(true); setDisablePassword(''); }}>
                Turn off
              </Button>
            </>
          ) : setup === null ? (
            <Button variant="outline" size="sm" onClick={() => { void startSetup(); }} isLoading={busy} leftIcon={<ShieldCheck className="h-4 w-4" />}>
              Set up
            </Button>
          ) : null}
        </div>
      </div>

      {/* Enrollment wizard */}
      {setup && !status?.enabled && (
        <div className="p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60 space-y-4">
          <p className="text-sm text-gray-700 dark:text-slate-300">
            <span className="font-medium">1.</span> Scan this QR code with Google Authenticator (or any TOTP app):
          </p>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <div className="inline-block rounded-xl bg-white p-3 border border-gray-200/80 dark:border-slate-700/60">
              <QRCodeSVG value={setup.uri} size={148} level="M" aria-label="Authenticator enrollment QR code" />
            </div>
            <div className="min-w-0 text-xs text-gray-500 dark:text-slate-400 space-y-1.5">
              <p>Can't scan? Enter this key manually:</p>
              <p className="font-mono text-[11px] break-all select-all bg-gray-50 dark:bg-slate-800 rounded-lg px-2.5 py-1.5 border border-gray-200/80 dark:border-slate-700/60">{setup.secret}</p>
              <p>Time-based · SHA-1 · 6 digits · 30s</p>
            </div>
          </div>
          <p className="text-sm text-gray-700 dark:text-slate-300">
            <span className="font-medium">2.</span> Enter the 6-digit code the app shows to finish:
          </p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="w-full sm:w-52">
              <Input
                label="Verification code"
                value={enableCode}
                onChange={(e) => setEnableCode(e.target.value)}
                placeholder="123 456"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { void confirmEnable(); }} isLoading={busy} disabled={!enableCode.trim()}>
                Verify &amp; enable
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setSetup(null); setEnableCode(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Recovery codes — shown exactly once after enable/regenerate */}
      {recoveryCodes && (
        <div className="p-4 rounded-xl border border-amber-200/80 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 space-y-3">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Save these recovery codes — they're shown only once
          </p>
          <p className="text-xs text-amber-700/90 dark:text-amber-400/80">
            Each code signs you in once if you lose access to your authenticator.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-sm text-gray-900 dark:text-white">
            {recoveryCodes.map((c) => (
              <span key={c} className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900/60 border border-amber-200/80 dark:border-amber-500/20 text-center select-all">{c}</span>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { void copyRecoveryCodes(); }} leftIcon={<Copy className="h-4 w-4" />}>
              Copy all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRecoveryCodes(null)}>
              I've saved them
            </Button>
          </div>
        </div>
      )}

      {/* Remembered browsers */}
      {status?.enabled && status.trustedBrowsers.length > 0 && (
        <div className="p-4 rounded-xl border border-gray-200/80 dark:border-slate-700/60">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">Remembered browsers</p>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
            These skip the code prompt for 60 days. Forget any you don't recognize.
          </p>
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {status.trustedBrowsers.map((b) => (
              <li key={b.id} className="py-2.5 flex items-center gap-3">
                <Laptop className="h-4 w-4 text-gray-400 dark:text-slate-500 flex-none" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 dark:text-white truncate">
                    {browserLabel(b.label)}
                    {b.current && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400">This browser</span>}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-slate-500">
                    Last used {formatDateTimeInZone(b.lastUsedAt, tz)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { void revokeBrowser(b.id); }}
                  aria-label={`Forget ${browserLabel(b.label)}`}
                  className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === null && (
        <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500 px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading two-factor status…
        </div>
      )}

      {/* Turn off: password re-entry required */}
      <ConfirmDialog
        isOpen={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={() => { void confirmDisable(); }}
        title="Turn off two-factor authentication?"
        message="Sign-ins will only need your password again, and every remembered browser and recovery code is forgotten. Confirm with your password below."
        confirmLabel="Turn off"
        variant="danger"
        isLoading={busy}
      >
        <PasswordInput
          label="Password"
          value={disablePassword}
          onChange={(e) => setDisablePassword(e.target.value)}
          placeholder="Your password"
          autoComplete="current-password"
        />
      </ConfirmDialog>

      {/* Regenerate recovery codes: current TOTP code required */}
      <ConfirmDialog
        isOpen={regenOpen}
        onClose={() => setRegenOpen(false)}
        onConfirm={() => { void confirmRegen(); }}
        title="Issue new recovery codes?"
        message="Your current codes stop working immediately. Enter a code from your authenticator app to confirm."
        confirmLabel="Regenerate"
        isLoading={busy}
      >
        <Input
          label="Verification code"
          value={regenCode}
          onChange={(e) => setRegenCode(e.target.value)}
          placeholder="123 456"
          inputMode="numeric"
          autoComplete="one-time-code"
        />
      </ConfirmDialog>
    </div>
  );
}
