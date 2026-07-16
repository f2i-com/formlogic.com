import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  aokieCompanionPairing,
  formlogic,
  isTauri,
  type AokieEndpointIdentityStatus,
  type AokiePairingOffer,
} from '../api';
import { AlertTriangleIcon, CircleCheckIcon, SmartphoneIcon } from '../Icons';
import { useConfirm } from '../ConfirmDialog';
import { useToast } from '../Toasts';
import {
  COMPANION_ENROLLMENT_HEADING,
  COMPANION_MEDIA_PRIVACY_COPY,
  COMPANION_TOPOLOGY_COPY,
  companionPairingSummary,
  fullEndpointThumbprint,
  shortEndpointThumbprint,
} from './companionPairingUi';

/**
 * Owner-confirmed enrollment for the Companion media endpoint.
 *
 * The Companion is the microphone/speaker WebRTC endpoint (the Android/iOS or
 * Windows companion app). It never opens the Bluetooth dongle. Same-PC use is
 * deliberately supported for development; production can relay the signed
 * pairing response through FormLogic or a custom signalling service.
 */
export function CompanionPairingPanel() {
  const [status, setStatus] = useState<AokieEndpointIdentityStatus | null>(null);
  const [offer, setOffer] = useState<AokiePairingOffer | null>(null);
  const [appId, setAppId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [responseJson, setResponseJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const next = await aokieCompanionPairing.status();
      setStatus(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh();
    if (isTauri()) {
      void formlogic.getConfig().then((config) => {
        if (!cancelled && config.connectionId) setConnectionId(config.connectionId);
      }).catch(() => undefined);
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const qrSrc = useMemo(
    () => offer ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(offer.qrSvg)}` : null,
    [offer],
  );
  const summary = companionPairingSummary(status);

  const createOffer = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await aokieCompanionPairing.createOffer({
        appId: appId.trim() || undefined,
        workspaceId: workspaceId.trim() || undefined,
        desktopConnectionId: connectionId.trim() || undefined,
      });
      setOffer(next);
      toast.push({
        kind: 'success',
        title: 'Pairing QR ready',
        body: 'Scan it in the Companion app. It expires in 10 minutes and contains no bearer token.',
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [appId, connectionId, toast, workspaceId]);

  const copyPayload = useCallback(async () => {
    if (!offer) return;
    try {
      await navigator.clipboard.writeText(offer.encodedPayload);
      toast.push({ kind: 'success', title: 'Pairing payload copied' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [offer, toast]);

  const submitResponse = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(responseJson) as unknown;
      await aokieCompanionPairing.receiveResponse(parsed);
      setResponseJson('');
      await refresh();
      toast.push({
        kind: 'success',
        title: 'Mobile proof verified',
        body: 'Compare its fingerprint, then approve it locally.',
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [refresh, responseJson, toast]);

  const approve = useCallback(async (id: string, name: string, fingerprint: string) => {
    const accepted = await confirm({
      title: `Approve ${name}?`,
      body: `Confirm this fingerprint on the Companion before approving:\n\n${fingerprint}`,
      confirmLabel: 'Approve endpoint',
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await aokieCompanionPairing.approve(id);
      await refresh();
      toast.push({ kind: 'success', title: 'Companion endpoint approved' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [confirm, refresh, toast]);

  const deny = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await aokieCompanionPairing.deny(id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const revoke = useCallback(async (thumbprint: string, name: string) => {
    const accepted = await confirm({
      title: `Revoke ${name}?`,
      body: 'Its current and future remote media admissions will be rejected. Reconnecting requires a fresh pairing ceremony.',
      confirmLabel: 'Revoke endpoint',
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await aokieCompanionPairing.revoke(thumbprint);
      await refresh();
      toast.push({ kind: 'success', title: 'Companion endpoint revoked' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [confirm, refresh, toast]);

  const rotate = useCallback(async () => {
    const accepted = await confirm({
      title: 'Rotate the Desktop endpoint key?',
      body: 'All approved Companion endpoints will be revoked locally. This build intentionally requires fresh owner-confirmed pairing instead of accepting an unsigned key replacement.',
      confirmLabel: 'Rotate and revoke all',
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await aokieCompanionPairing.rotateDesktopKey();
      setOffer(null);
      await refresh();
      toast.push({ kind: 'success', title: 'Desktop key rotated', body: 'Pair each Companion again.' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [confirm, refresh, toast]);

  return (
    <section className="aokie-companion-pairing">
      <div className="aokie-companion-pairing__head">
        <div>
          <span className="desktop-card-eyebrow">COMPANION DEVICE TRUST</span>
          <h3>{COMPANION_ENROLLMENT_HEADING}</h3>
          <p>{COMPANION_TOPOLOGY_COPY}</p>
        </div>
        <span className={`desktop-status-pill ${summary.tone}`}>
          <i />
          {summary.label}
        </span>
      </div>

      <div className="aokie-companion-security-note">
        <SmartphoneIcon size={17} />
        <span>{COMPANION_MEDIA_PRIVACY_COPY} The QR contains public binding data plus a one-use expiry; no API key or admission bearer.</span>
      </div>

      {status && (
        <div className="aokie-companion-identity-grid">
          <span className="aokie-companion-identity-grid__thumbprint"><small>Desktop thumbprint (compare in full)</small><code>{fullEndpointThumbprint(status.endpointKey?.thumbprint)}</code></span>
          <span><small>Key protection</small><strong>{status.protectionLabel ?? 'Unavailable'}</strong></span>
          <span><small>Roster revision</small><strong>{status.rosterRevision}</strong></span>
          <span><small>Approved endpoints</small><strong>{status.approvedMobiles.length}</strong></span>
        </div>
      )}

      {status?.warning && (
        <div className="aokie-companion-warning"><AlertTriangleIcon size={15} /> {status.warning}</div>
      )}
      {error && <div className="aokie-companion-warning"><AlertTriangleIcon size={15} /> {error}</div>}

      <div className="aokie-companion-pairing__form">
        <label>
          <span>App id <small>(leave blank to use Aokie's assignment)</small></span>
          <input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="app identifier" />
        </label>
        <label>
          <span>Workspace id <small>(optional/custom servers)</small></span>
          <input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="workspace identifier" />
        </label>
        <label>
          <span>Desktop connection id <small>(managed link or stable local id)</small></span>
          <input value={connectionId} onChange={(event) => setConnectionId(event.target.value)} placeholder="filled from FormLogic when linked" />
        </label>
        <button type="button" className="desktop-button primary" disabled={busy || !summary.canGenerateOffer} onClick={() => void createOffer()}>
          Generate one-use enrollment QR
        </button>
      </div>

      {offer && qrSrc && (
        <div className="aokie-companion-offer">
          <img src={qrSrc} alt="One-use Aokie Companion enrollment QR" />
          <div>
            <strong>Scan in the Companion app</strong>
            <p>Expires {new Date(offer.payload.expiresAt * 1000).toLocaleTimeString()}.</p>
            <small>Desktop thumbprint - compare this complete value in Companion</small>
            <code className="aokie-companion-full-thumbprint">{fullEndpointThumbprint(offer.payload.desktopEndpointKey.thumbprint)}</code>
            <button type="button" className="desktop-button" onClick={() => void copyPayload()}>Copy JSON payload</button>
          </div>
        </div>
      )}

      {(status?.pendingApprovals.length ?? 0) > 0 && (
        <div className="aokie-companion-list">
          <h4>Waiting for your approval</h4>
          {status!.pendingApprovals.map((entry) => (
            <div className="aokie-companion-row" key={entry.id}>
              <span className="aokie-companion-row__icon"><SmartphoneIcon size={16} /></span>
              <div>
                <strong>{entry.displayName}</strong>
                <small>{entry.deviceId}</small>
                <code>{entry.fingerprint}</code>
              </div>
              <button type="button" className="desktop-button" disabled={busy} onClick={() => void deny(entry.id)}>Deny</button>
              <button type="button" className="desktop-button primary" disabled={busy} onClick={() => void approve(entry.id, entry.displayName, entry.fingerprint)}>Approve</button>
            </div>
          ))}
        </div>
      )}

      {(status?.approvedMobiles.length ?? 0) > 0 && (
        <div className="aokie-companion-list">
          <h4>Approved Companion apps</h4>
          {status!.approvedMobiles.map((entry) => (
            <div className="aokie-companion-row" key={entry.endpointKey.thumbprint}>
              <span className="aokie-companion-row__icon is-ok"><CircleCheckIcon size={16} /></span>
              <div>
                <strong>{entry.displayName}</strong>
                <small>{entry.deviceId} / {shortEndpointThumbprint(entry.endpointKey.thumbprint)}</small>
              </div>
              <button type="button" className="desktop-button danger" disabled={busy} onClick={() => void revoke(entry.endpointKey.thumbprint, entry.displayName)}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      <details className="aokie-companion-relay-test">
        <summary>Custom relay / local testing</summary>
        <p>Paste a signed mobile response here when a custom server or same-PC test app does not forward it automatically. Desktop still verifies the mobile key, app, Desktop binding, nonce, JTI and expiry before it appears above.</p>
        <textarea value={responseJson} onChange={(event) => setResponseJson(event.target.value)} placeholder='{"kind":"aokie_mobile_pairing_response", ...}' />
        <button type="button" className="desktop-button" disabled={busy || responseJson.trim() === ''} onClick={() => void submitResponse()}>Verify signed response</button>
      </details>

      <div className="aokie-companion-rotate">
        <div><strong>Desktop endpoint key</strong><p>Rotate only after suspected compromise. Every Companion app must enroll again.</p></div>
        <button type="button" className="desktop-button danger" disabled={busy || status?.available === false} onClick={() => void rotate()}>Rotate key</button>
      </div>
    </section>
  );
}
