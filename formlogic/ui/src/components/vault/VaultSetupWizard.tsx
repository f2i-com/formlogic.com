// Vault setup wizard (docs/E2EE_PRIVATE_FORMS_PLAN.md §5, §10, §16-P2).
// Steps: passphrase → recovery kit → typed-back confirmation → done. The recovery kit is
// MANDATORY (D5) and is the ONLY way back in if the passphrase is lost; FormLogic cannot
// recover the vault.
//
// Ordering (D5): the vault is only PREPARED when the passphrase is entered — the wrappers
// and the kit are generated locally and nothing is sent. The vault is created on the
// server after the kit has been shown AND typed back (the checksum catches a mistype
// before any KDF work). Closing the tab, cancelling, or losing the session before that
// creates nothing; the user simply starts again.
//
// The kit is shown ONCE, so from the moment it is on screen until it has been confirmed
// the wizard cannot be dismissed — not by the close button, a click outside, or Escape.
// The only way out is the explicit "Cancel and start over", which says what it discards.
//
// If the create request goes out and no answer comes back, the vault may exist and the kit
// the user saved may be the only way into it. From then on nothing here says the kit can be
// thrown away or that nothing was saved until the server has been asked and has said there
// is no vault ("Cancel and start over" asks first).

import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { ShieldCheck, Copy, Check, Download, Printer, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { PasswordInput } from '../ui/PasswordInput';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/authStore';
import { useVaultStore, type PrepareSetupResult } from '../../stores/vaultStore';
import { toast } from '../../stores/toastStore';
import { copyToClipboard } from '../../lib/utils';
import { downloadRecoveryKit, printRecoveryKit } from '../../lib/crypto/recoveryKitFile';

interface VaultSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the vault exists + is unlocked and the kit was confirmed. */
  onComplete?: () => void;
}

/**
 * What "Cancel and start over" is about to do:
 *  - plain: no request was ever sent, so nothing exists anywhere;
 *  - none-found: a request was sent without an answer, and the server has now said it has no vault;
 *  - unreachable: a request was sent without an answer and the server could not be asked, so
 *    the vault may exist and leaving is a choice made in the dark.
 */
type CancelMode = 'plain' | 'none-found' | 'unreachable';

/**
 * Shown before "Cancel and start over" takes effect: says exactly what is thrown away. It is
 * a labelled group whose warning is also the description of its safe button — focus moves to
 * "Keep this kit" when it opens (see the wizard), so a screen reader reads the warning there.
 */
function DiscardKitNotice({ id, mode, noticeRef, keepRef, onKeep, onDiscard }: {
  id: string;
  mode: CancelMode;
  noticeRef: Ref<HTMLDivElement>;
  keepRef: Ref<HTMLButtonElement>;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const unreachable = mode === 'unreachable';
  return (
    <div
      id={id}
      ref={noticeRef}
      role="group"
      aria-labelledby={titleId}
      className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-3 space-y-3"
    >
      <p id={bodyId} className="text-sm text-red-800 dark:text-red-200">
        {unreachable ? (
          <>
            <strong id={titleId}>Leave without checking?</strong> FormLogic could not be reached to check whether your
            vault was created, so it <strong>may already exist</strong>. If you leave now and it does,
            unlock it with your vault passphrase — or with this recovery kit, so keep every copy of it.
          </>
        ) : (
          <>
            <strong id={titleId}>Discard this recovery kit and start over?</strong>{' '}
            {mode === 'none-found' && <>FormLogic checked: <strong>no vault was created</strong> for your account. </>}
            The kit you were just shown will be discarded and <strong>no vault will be created</strong>.{' '}
            {mode === 'plain' ? 'Nothing has been saved to your account, so you' : 'You'} will begin again
            with a new passphrase and get a new recovery kit — throw away any copy of this one.
          </>
        )}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={keepRef} variant="outline" size="sm" onClick={onKeep} aria-describedby={bodyId}>Keep this kit</Button>
        <Button variant="danger" size="sm" onClick={onDiscard}>{unreachable ? 'Leave anyway' : 'Discard kit and start over'}</Button>
      </div>
    </div>
  );
}

export function VaultSetupWizard({ isOpen, onClose, onComplete }: VaultSetupWizardProps) {
  const user = useAuthStore((s) => s.user);
  const prepareSetup = useVaultStore((s) => s.prepareSetup);
  const commitSetup = useVaultStore((s) => s.commitSetup);
  const checkSetup = useVaultStore((s) => s.checkSetup);
  const abandonSetup = useVaultStore((s) => s.abandonSetup);
  const cancelHintId = useId();
  const noticeId = useId();
  const noticeRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const [step, setStep] = useState<'passphrase' | 'kit' | 'confirm'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `busy`, readable synchronously: a second Enter or click must not start a second run. */
  const busyRef = useRef(false);
  /** Bumped whenever the wizard is closed: a prepare that was started before that is stale. */
  const attemptRef = useRef(0);
  const [recoveryDisplay, setRecoveryDisplay] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  /** When the kit was generated: dates the downloaded file and the print view. */
  const [kitCreatedAt, setKitCreatedAt] = useState<Date | null>(null);
  /** Set when a save action could not be started (blocked download, no print support). */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  /** Token of the vault this wizard prepared (null until a kit has been generated). */
  const [setupId, setSetupId] = useState<string | null>(null);
  /** "Cancel and start over" was pressed and is waiting for its second, explicit click. */
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelMode, setCancelMode] = useState<CancelMode>('plain');
  /** The create request went out and no answer came back: the vault MAY exist. */
  const [uncertain, setUncertain] = useState(false);
  /** Asking the server what became of that request (so "Cancel" can say something true). */
  const [checking, setChecking] = useState(false);

  // The prepared vault belongs to this wizard: whenever the wizard stops holding it (a
  // reset, a parent closing it, unmount) the store is told to drop it — which is a no-op
  // once it was created, and never touches another wizard's setup or an unlocked vault.
  useEffect(() => {
    if (!setupId) return undefined;
    return () => { void abandonSetup(setupId); };
  }, [setupId, abandonSetup]);

  // A prepare that finishes after the wizard is gone must not leave a kit + an unlocked
  // worker behind.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // `busy` is only ever reset in state (reset() runs during render when a parent closes the
  // wizard, where refs must not be written), so the ref follows it here; and a parent closing
  // the wizard makes any prepare still running stale, exactly as close() does.
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => {
    if (!isOpen) attemptRef.current += 1;
  }, [isOpen]);

  const setWorking = (working: boolean) => {
    busyRef.current = working;
    setBusy(working);
  };

  // The notice opens above its trigger, which on a phone is often below the fold: move focus
  // to its safe choice and bring it into view, so a keyboard or screen-reader user (and a
  // thumb) lands on it rather than on <body>.
  useEffect(() => {
    if (!confirmingCancel) return;
    keepRef.current?.focus();
    noticeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [confirmingCancel, cancelMode]);

  const keepKit = () => {
    setConfirmingCancel(false);
    cancelRef.current?.focus();
  };

  const reset = () => {
    setStep('passphrase');
    setPassphrase('');
    setPassphrase2('');
    setError(null);
    setBusy(false);
    setRecoveryDisplay(null);
    setCopied(false);
    setDownloaded(false);
    setKitCreatedAt(null);
    setSaveNotice(null);
    setConfirmText('');
    setSetupId(null);
    setConfirmingCancel(false);
    setCancelMode('plain');
    setUncertain(false);
    setChecking(false);
  };

  // A parent that closes the wizard without going through onClose must not leave a kit on
  // screen (or a prepared vault behind) for the next time it opens.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) reset();
  }

  const close = () => {
    attemptRef.current += 1; // a prepare still running is stale from here on
    reset();
    onClose();
  };

  // Dismissal (close button, backdrop click, Escape) is possible only on the passphrase
  // step: from the moment the kit is shown until it is confirmed — including while the
  // create request is out — every attempt is ignored, because the kit is displayed once and
  // closing would silently discard it (or leave the request's outcome with nobody to show it
  // to). While a vault is still being PREPARED no kit exists, so nothing is at stake: the user
  // can leave (a stalled connection must not trap them), and a prepare that finishes after
  // that is dropped, not shown.
  const dismissible = step === 'passphrase';
  const requestClose = () => {
    if (dismissible) close();
  };

  const startSetup = async () => {
    if (busyRef.current) return; // a second Enter while the first run is still going
    setError(null);
    if (passphrase.length < 12) {
      setError('Passphrase must be at least 12 characters.');
      return;
    }
    if (passphrase !== passphrase2) {
      setError('The passphrases do not match.');
      return;
    }
    if (!user) {
      setError('You must be signed in.');
      return;
    }
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setWorking(true);
    // Generates the wrappers and the kit locally — NOTHING is sent to the server yet.
    let result: PrepareSetupResult;
    try {
      result = await prepareSetup(user.id, passphrase);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : 'Vault setup failed.' };
    }
    // Closed (or unmounted) while it ran: nothing shows this attempt any more, so it must not
    // leave a kit and an unlocked worker behind.
    if (!mountedRef.current || attempt !== attemptRef.current) {
      if (result.setupId) void abandonSetup(result.setupId);
      return;
    }
    setWorking(false);
    setPassphrase('');
    setPassphrase2('');
    if (!result.ok || !result.recoveryDisplay || !result.setupId) {
      setError(result.error ?? 'Vault setup failed.');
      return;
    }
    setSetupId(result.setupId);
    setRecoveryDisplay(result.recoveryDisplay);
    setKitCreatedAt(new Date());
    setStep('kit');
  };

  // The kit leaves the page only through the browser's own download / print — never
  // to the server (nothing here touches the network).
  const saveKitFile = () => {
    if (!recoveryDisplay || !kitCreatedAt) return;
    try {
      downloadRecoveryKit(recoveryDisplay, kitCreatedAt);
      setDownloaded(true);
      setSaveNotice(null);
    } catch {
      setSaveNotice("Your browser couldn't start the download — copy the kit or print it instead.");
    }
  };

  const printKit = () => {
    if (!recoveryDisplay || !kitCreatedAt) return;
    let started: boolean;
    try {
      started = printRecoveryKit(recoveryDisplay, kitCreatedAt);
    } catch {
      started = false;
    }
    setSaveNotice(started ? null : "Printing isn't available here — copy the kit or download it instead.");
  };

  const confirmKit = async () => {
    if (!setupId || busyRef.current) return;
    setError(null);
    setWorking(true);
    // The store checks the typed-back kit (a wrong one sends nothing) and only then
    // creates the vault on the server. The kit has been shown by now (D5).
    const result = await commitSetup(setupId, confirmText);
    if (!mountedRef.current) return;
    // A second press while the first request is still out: that one will report.
    if (result.code === 'setup_busy') return;
    if (result.ok) {
      reset();
      onClose();
      onComplete?.();
      return;
    }
    if (result.code === 'vault_exists') {
      // A DIFFERENT vault already exists, so this one can never be created: close with the
      // reason (the store now has that vault, locked, so the next attempt routes to unlock)
      // rather than leaving a create form under a message saying a vault exists.
      toast.warning('A vault already exists', result.error);
      reset();
      onClose();
      return;
    }
    if (result.discarded) {
      // The prepared vault is gone (signed out, locked, refused). The message says whether
      // the kit is void (no request was sent) or the vault may exist (one was).
      reset();
      setError(result.error ?? 'Vault setup failed — start again.');
      return;
    }
    setWorking(false);
    // No verdict (the request may have got through): the vault may exist, so from here on
    // nothing may call the kit void — "Cancel and start over" asks the server first.
    if (result.code === 'save_failed') setUncertain(true);
    setError(result.error ?? 'Could not create the vault.');
  };

  /** "Cancel and start over": one click to say what it discards, a second to do it. */
  const startCancel = async () => {
    if (busyRef.current || confirmingCancel) return;
    if (!uncertain || !setupId) {
      setCancelMode('plain');
      setConfirmingCancel(true);
      return;
    }
    // A create request went out and nothing came back, so the vault may exist and the kit
    // the user saved may be the only way into it: find out BEFORE saying anything is
    // discarded.
    setError(null);
    setWorking(true);
    setChecking(true);
    const check = await checkSetup(setupId);
    if (!mountedRef.current) return;
    setWorking(false);
    setChecking(false);
    switch (check.outcome) {
      case 'created':
        // It was created after all: adopted and unlocked. They asked to cancel, so the flow
        // that opened the wizard is not resumed — but the vault exists and they are told so.
        toast.success('Your vault was created', 'The confirmation was lost on the way, but the vault is ready — and the recovery kit you saved is its kit.');
        reset();
        onClose();
        return;
      case 'other_vault':
        toast.warning('A vault already exists', check.error);
        reset();
        onClose();
        return;
      case 'interrupted':
        reset();
        setError(check.error ?? 'Vault setup was interrupted — start again.');
        return;
      case 'not_created':
        setCancelMode('none-found');
        setConfirmingCancel(true);
        return;
      default:
        setCancelMode('unreachable');
        setConfirmingCancel(true);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      showCloseButton={dismissible}
      title={step === 'passphrase' ? 'Create your encryption vault' : 'Save your recovery kit'}
      size="md"
    >
      {step === 'passphrase' && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <div className="flex gap-3 p-3 rounded-lg bg-primary-50 dark:bg-primary-500/10 text-sm text-primary-900 dark:text-primary-200">
            <ShieldCheck className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <p>
              Your vault passphrase encrypts Private form responses end-to-end (beta) in your browser.
              FormLogic stores only ciphertext and <strong>cannot recover this passphrase</strong>.
            </p>
          </div>
          <div className="space-y-3">
            <PasswordInput
              label="Vault passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="At least 12 characters"
              autoComplete="new-password"
              autoFocus
            />
            <PasswordInput
              label="Confirm passphrase"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
              placeholder="Repeat the passphrase"
              autoComplete="new-password"
              onKeyDown={(e) => { if (e.key === 'Enter') void startSetup(); }}
            />
          </div>
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 ring-1 ring-red-200/70 dark:ring-red-500/20 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={() => void startSetup()} isLoading={busy}>Create vault</Button>
          </div>
        </div>
      )}

      {step === 'kit' && recoveryDisplay && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <div className="flex gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-900 dark:text-amber-200">
            <TriangleAlert className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <p>
              This is your <strong>only</strong> backup. If you lose your passphrase and this kit,
              your encrypted responses are gone forever — FormLogic cannot recover them.
            </p>
          </div>
          <div className="p-3 rounded-lg bg-gray-100 dark:bg-slate-800 font-mono text-sm break-all select-all text-gray-900 dark:text-slate-100">
            {recoveryDisplay}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void copyToClipboard(recoveryDisplay).then((ok) => { if (ok) setCopied(true); });
              }}
              leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            >
              {copied ? 'Copied' : 'Copy to clipboard'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={saveKitFile}
              leftIcon={downloaded ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            >
              {downloaded ? 'Downloaded' : 'Download'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={printKit}
              leftIcon={<Printer className="h-4 w-4" />}
            >
              Print
            </Button>
          </div>
          {saveNotice && (
            <p className="text-sm text-amber-800 dark:text-amber-200" role="status">{saveNotice}</p>
          )}
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Save it somewhere safe — download it, print it or write it down — then continue.
            FormLogic never receives the kit: the file and the printout are made in your browser.{' '}
            {uncertain ? (
              <>
                FormLogic did not confirm whether your vault was created, so it{' '}
                <strong>may already exist</strong> — keep this kit either way.
              </>
            ) : (
              <>
                Your vault is <strong>not created yet</strong>: that happens only after you confirm
                this kit on the next step.
              </>
            )}
          </p>
          {checking && (
            <p className="text-sm text-gray-600 dark:text-slate-400" role="status">Checking with FormLogic whether your vault was created…</p>
          )}
          {confirmingCancel && (
            <DiscardKitNotice id={noticeId} mode={cancelMode} noticeRef={noticeRef} keepRef={keepRef} onKeep={keepKit} onDiscard={reset} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              ref={cancelRef}
              onClick={() => void startCancel()}
              disabled={busy}
              aria-expanded={confirmingCancel}
              aria-controls={confirmingCancel ? noticeId : undefined}
              aria-describedby={cancelHintId}
            >
              Cancel and start over
            </Button>
            <Button onClick={() => { setStep('confirm'); setError(null); setConfirmingCancel(false); }} disabled={busy}>I saved it — continue</Button>
          </div>
          <p id={cancelHintId} className="text-xs text-gray-500 dark:text-slate-400">
            This window stays open until you have confirmed your kit, so it cannot be lost by accident.{' '}
            {uncertain
              ? <>&ldquo;Cancel and start over&rdquo; first checks with FormLogic whether your vault was created.</>
              : <>&ldquo;Cancel and start over&rdquo; discards the kit and creates no vault.</>}
          </p>
        </div>
      )}

      {step === 'confirm' && (
        <div className="px-4 py-5 sm:px-6 space-y-5">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Type or paste your recovery kit back to confirm you saved it correctly. Your vault is
            created as soon as it matches.
          </p>
          <Input
            label="Recovery kit"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="FLRK1-XXXX-XXXX-…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          {error && (
            <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 ring-1 ring-red-200/70 dark:ring-red-500/20 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}
          {checking && (
            <p className="text-sm text-gray-600 dark:text-slate-400" role="status">Checking with FormLogic whether your vault was created…</p>
          )}
          {busy && !checking && (
            <p className="text-sm text-gray-600 dark:text-slate-400" role="status">
              Saving your vault… this can take a moment. If it stalls, check your connection — your recovery kit stays valid.
            </p>
          )}
          {confirmingCancel && (
            <DiscardKitNotice id={noticeId} mode={cancelMode} noticeRef={noticeRef} keepRef={keepRef} onKeep={keepKit} onDiscard={reset} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              ref={cancelRef}
              onClick={() => void startCancel()}
              disabled={busy}
              aria-expanded={confirmingCancel}
              aria-controls={confirmingCancel ? noticeId : undefined}
              aria-describedby={cancelHintId}
            >
              Cancel and start over
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setStep('kit'); setConfirmingCancel(false); }} disabled={busy}>Back</Button>
              <Button onClick={() => void confirmKit()} isLoading={busy} disabled={!confirmText.trim()}>
                Confirm &amp; create vault
              </Button>
            </div>
          </div>
          <p id={cancelHintId} className="text-xs text-gray-500 dark:text-slate-400">
            This window stays open until your vault is created, so the kit cannot be lost by accident.{' '}
            {uncertain
              ? <>&ldquo;Cancel and start over&rdquo; first checks with FormLogic whether your vault was created.</>
              : <>&ldquo;Cancel and start over&rdquo; discards the kit and creates no vault.</>}
          </p>
        </div>
      )}
    </Modal>
  );
}
