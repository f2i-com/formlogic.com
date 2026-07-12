import { useCallback, useEffect, useState } from 'react';
import { plugins } from '../api';
import { AlertTriangleIcon, CheckIcon, XIcon } from '../Icons';
import { useToast } from '../Toasts';

/**
 * CONSENT-001 — the consent wizard FormLogic Desktop owns.
 *
 * Before the Aokie receptionist touches a phone line, the OPERATOR must
 * accept a versioned, scoped grant covering exactly what the system will
 * access (Bluetooth link, contacts, SMS, live-call transcription) and where
 * that data can be sent (the configured processing endpoints). Accepting
 * issues a grant SIGNED by this Desktop's per-install key — the plugin
 * refuses grants signed anywhere else — and flips enforcement on
 * (`consentMode=enforce`), so a denied scope is refused at the point of
 * capture, not just hidden in the UI.
 */

interface ConsentStatus {
  grant: {
    version?: number;
    scopes?: Record<string, unknown>;
    acceptedAt?: string;
    acceptedBy?: string;
    expiresAt?: string;
  } | null;
  signed?: boolean;
  note?: string | null;
  requiredVersion: number;
  mode: 'off' | 'warn' | 'enforce';
  signatureRequired?: boolean;
  bluetooth?: { allowed: boolean; reason: string };
  blocked?: string | null;
}

/** The scopes the wizard offers, with honest one-line descriptions. */
const SCOPE_ROWS: Array<{
  key: 'bluetooth' | 'contacts' | 'sms' | 'transcription' | 'recording';
  label: string;
  detail: string;
  defaultOn: boolean;
}> = [
  {
    key: 'bluetooth',
    label: 'Bluetooth phone link',
    detail:
      'Pair with your phone and handle calls through the Aokie dongle. Required for every phone feature — deny it and the receptionist stays offline.',
    defaultOn: true,
  },
  {
    key: 'transcription',
    label: 'Live call transcription',
    detail:
      "Caller audio is transcribed so the receptionist can understand and reply. Deny it and NO audio reaches any speech engine — calls can still ring, but the AI can't converse.",
    defaultOn: true,
  },
  {
    key: 'sms',
    label: 'SMS (read + send)',
    detail:
      'Read message threads and send replies/confirmations through your phone (MAP profile).',
    defaultOn: true,
  },
  {
    key: 'contacts',
    label: 'Contacts (caller names)',
    detail: 'Look up the caller in your phone book (PBAP) so records show a name, not a number.',
    defaultOn: true,
  },
  {
    key: 'recording',
    label: 'Call audio recording',
    detail:
      'Store raw call audio. Not currently used by any feature — leave off unless a future feature asks for it.',
    defaultOn: false,
  },
];

export function ConsentWizard({
  settings,
  onClose,
  onGranted,
}: {
  /** The live connector settings bag (endpoints become the destination list). */
  settings: Record<string, unknown>;
  onClose: () => void;
  onGranted: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<ConsentStatus | null>(null);
  const [scopes, setScopes] = useState<Record<string, boolean>>(
    Object.fromEntries(SCOPE_ROWS.map((s) => [s.key, s.defaultOn])),
  );
  const [retentionDays, setRetentionDays] = useState(90);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    plugins
      .command('aokie', 'consent.get')
      .then((r) => {
        const s = r.data as ConsentStatus;
        setStatus(s);
        // Re-consent starts from what was previously granted.
        if (s?.grant?.scopes) {
          setScopes((prev) => {
            const next = { ...prev };
            for (const row of SCOPE_ROWS) {
              if (typeof s.grant?.scopes?.[row.key] === 'boolean') {
                next[row.key] = s.grant.scopes[row.key] as boolean;
              }
            }
            return next;
          });
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // The remote destinations this configuration would send data to: the
  // configured AI/speech endpoints (loopback = local processing, listed for
  // honesty but consent-exempt). Shown verbatim; accepted verbatim.
  const destinations = (['aiEndpoint', 'sttEndpoint', 'ttsEndpoint'] as const)
    .map((k) => (typeof settings[k] === 'string' ? (settings[k] as string).trim() : ''))
    .filter((v) => v.length > 0);
  const uniqueDestinations = [...new Set(destinations)];

  const accept = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await plugins.issueConsent('aokie', {
        version: status?.requiredVersion ?? 1,
        scopes: {
          bluetooth: !!scopes.bluetooth,
          contacts: !!scopes.contacts,
          sms: !!scopes.sms,
          transcription: !!scopes.transcription,
          recording: !!scopes.recording,
          retentionDays,
          destinations: uniqueDestinations,
        },
        expiresDays: 365,
      });
      // Production posture from here on: enforcement, not warnings.
      await plugins.command('aokie', 'settings.set', { consentMode: 'enforce' });
      toast.push({
        kind: 'success',
        title: 'Consent recorded',
        body: 'Enforcement is on — denied scopes are refused at the point of capture.',
      });
      onGranted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [scopes, retentionDays, uniqueDestinations, status, toast, onGranted, onClose]);

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Aokie consent">
      <div className="confirm-dialog consent-dialog">
        <div className="consent-head">
          <h2 className="confirm-title">Phone receptionist — access &amp; consent</h2>
          <button type="button" className="btn-tiny" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>

        <p className="form-hint" style={{ marginTop: 0 }}>
          Version {status?.requiredVersion ?? 1} · grants expire after 12 months ·{' '}
          signed by this computer, so it can't be copied to another install.{' '}
          <a href="https://formlogic.com/privacy" target="_blank" rel="noreferrer">
            Privacy &amp; data-handling disclosure
          </a>
        </p>

        <div className="consent-scopes">
          {SCOPE_ROWS.map((row) => (
            <label key={row.key} className="consent-scope-row">
              <input
                type="checkbox"
                checked={!!scopes[row.key]}
                onChange={(e) => setScopes((s) => ({ ...s, [row.key]: e.target.checked }))}
              />
              <span>
                <strong>{row.label}</strong>
                <span className="consent-scope-detail">{row.detail}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="consent-block">
          <strong>Where call data goes</strong>
          {uniqueDestinations.length === 0 ? (
            <p className="form-hint">
              All processing endpoints are local to this machine — no transcript leaves it. Linked
              FormLogic records follow each form's own retention settings.
            </p>
          ) : (
            <>
              <p className="form-hint">
                These configured endpoints will receive call data (transcripts/audio for
                processing). Changing them later to somewhere new requires re-consent:
              </p>
              <ul className="consent-dest-list">
                {uniqueDestinations.map((d) => (
                  <li key={d}>
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="consent-block">
          <label className="form-row" style={{ maxWidth: 260 }}>
            <span>Record retention (days)</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Math.max(1, Number(e.target.value) || 90))}
            />
          </label>
        </div>

        <div className="consent-block consent-jurisdiction">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          <span>
            <strong>Your callers, your responsibility:</strong> laws on call recording,
            transcription and AI disclosure differ by jurisdiction. Many require you to TELL
            callers they're speaking with an AI and/or being transcribed — put it in your greeting.
            Confirm your local requirements before going live.
          </span>
        </div>

        {error && (
          <div className="banner banner-err">
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
            {error}
          </div>
        )}

        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" onClick={accept} disabled={submitting}>
            <span className="icon-button-label">
              <CheckIcon size={14} />
              {submitting ? 'Recording…' : 'Accept & enforce'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact consent status line + wizard launcher for the Aokie card. Shows
 * the live gate state (enforced/warn, blocked reason) and opens the wizard.
 */
export function ConsentSection({
  settings,
  onChanged,
}: {
  settings: Record<string, unknown>;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<ConsentStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(() => {
    plugins
      .command('aokie', 'consent.get')
      .then((r) => {
        setStatus(r.data as ConsentStatus);
        setUnavailable(false);
      })
      .catch(() => setUnavailable(true));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (unavailable) return null; // plugin not running — the card already says so

  const grant = status?.grant ?? null;
  const enforced = status?.mode === 'enforce';
  const needsAction =
    !grant || (status && grant.version !== status.requiredVersion) || !enforced || !!status?.note;

  return (
    <div className="aokie-consent">
      <div className="aokie-consent-status">
        {grant && enforced && !needsAction ? (
          <span className="badge badge-ok" title={`Accepted ${grant.acceptedAt ?? ''} by ${grant.acceptedBy ?? 'operator'} · expires ${grant.expiresAt ?? '—'}`}>
            Consent v{grant.version} · enforced
          </span>
        ) : (
          <span
            className="badge badge-pending"
            title={status?.note ?? status?.blocked ?? 'Consent has not been recorded on this device.'}
          >
            {status?.blocked
              ? 'Consent required — phone offline'
              : grant
                ? 'Consent needs review'
                : 'Consent not recorded'}
          </span>
        )}
        {status?.mode === 'warn' && (
          <span className="form-hint" style={{ marginLeft: 8 }}>
            warn mode (developer override) — sensitive processing runs with consent unrecorded
          </span>
        )}
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => setWizardOpen(true)}>
        {grant ? 'Review consent' : 'Set up consent'}
      </button>
      {wizardOpen && (
        <ConsentWizard
          settings={settings}
          onClose={() => setWizardOpen(false)}
          onGranted={() => {
            refresh();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
