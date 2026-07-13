import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formlogic,
  isTauri,
  type FlowRuntimeStatus,
  type FormLogicConfigView,
  type OAuthLinkStatus,
  type RuntimeErrorEntry,
} from './api';
import { useConfirm } from './ConfirmDialog';
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from './Icons';
import { useToast } from './Toasts';

/**
 * FormLogic Cloud — link this desktop to a FormLogic account so it becomes the
 * HEADLESS runtime for flows + the Aokie receptionist (the web app then only
 * views state remotely). The PRIMARY path is a one-click OAuth "Link account"
 * flow (device-link): it opens the system browser to FormLogic's consent page,
 * captures the redirect on a loopback listener, and stores the minted scoped
 * key (`flk_…`, scopes `flows:read`/`flows:write`/`responses:write`/
 * `connector:relay`) in the desktop config dir. Pasting a key by hand stays
 * available under "Advanced" for offline/air-gapped setups. Rendered inside the
 * Settings panel.
 */
export default function FormLogicCloudSection() {
  const [cfg, setCfg] = useState<FormLogicConfigView | null>(null);
  const [status, setStatus] = useState<FlowRuntimeStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [oauth, setOauth] = useState<OAuthLinkStatus | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Runtime error log: null = collapsed; [] = expanded but empty.
  const [errorLog, setErrorLog] = useState<RuntimeErrorEntry[] | null>(null);
  const [clearingErrors, setClearingErrors] = useState(false);
  const toast = useToast();
  const { confirm: requestConfirm } = useConfirm();
  const seqRef = useRef(0);
  const seededRef = useRef(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const [c, s] = await Promise.all([formlogic.getConfig(), formlogic.status()]);
      if (seq !== seqRef.current) return;
      setCfg(c);
      setStatus(s);
      // Seed the base-URL input once, so we don't clobber the user's typing.
      if (!seededRef.current) {
        seededRef.current = true;
        setBaseUrl(c.baseUrl || 'https://formlogic.com');
      }
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Stop the OAuth status poller on unmount.
  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    },
    [],
  );

  const linking = oauth?.inProgress ?? false;

  // Expand/collapse the inspectable error history behind the errors counter.
  const toggleErrorLog = useCallback(async () => {
    if (errorLog !== null) {
      setErrorLog(null);
      return;
    }
    try {
      const r = await formlogic.runtimeErrors();
      setErrorLog(r.errors);
    } catch (e) {
      toast.push({ kind: 'error', title: 'Could not load the error log', body: e instanceof Error ? e.message : String(e) });
    }
  }, [errorLog, toast]);

  const clearErrors = useCallback(async () => {
    setClearingErrors(true);
    try {
      await formlogic.clearRuntimeErrors();
      setErrorLog(null);
      toast.push({ kind: 'success', title: 'Runtime errors cleared', body: 'The counter and history are reset; new errors keep recording.' });
      await refresh();
    } catch (e) {
      toast.push({ kind: 'error', title: 'Clear failed', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setClearingErrors(false);
    }
  }, [toast, refresh]);

  const link = useCallback(async () => {
    const base = baseUrl.trim();
    if (base === '') {
      setError('Enter your FormLogic base URL first (e.g. https://formlogic.com).');
      return;
    }
    setError(null);
    setTestResult(null);
    setBusy(true);
    try {
      await formlogic.oauthStart(base);
      setOauth({ phase: 'starting', inProgress: true, message: 'Opening your browser…', deviceName: null });
      // Poll the link machine until it reaches a terminal phase.
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await formlogic.oauthStatus();
          setOauth(s);
          if (!s.inProgress) {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
            if (s.phase === 'linked') {
              toast.push({
                kind: 'success',
                title: 'Account linked',
                body: s.deviceName ? `Linked as ${s.deviceName}.` : 'The headless runtime is active.',
              });
            }
            await refresh();
          }
        } catch {
          /* transient — keep polling */
        }
      }, 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, refresh, toast]);

  const cancelLink = useCallback(async () => {
    try {
      await formlogic.oauthCancel();
    } catch {
      /* ignore */
    }
  }, []);

  const saveManual = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      await formlogic.setConfig(baseUrl.trim(), apiKey.trim());
      setApiKey('');
      toast.push({ kind: 'success', title: 'FormLogic Cloud saved', body: 'The headless flow runtime is reconfiguring.' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, apiKey, refresh, toast]);

  const test = useCallback(async () => {
    setBusy(true);
    setTestResult(null);
    try {
      await formlogic.testConnection();
      setTestResult({ ok: true, msg: 'Connected — the API key + scopes are valid.' });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  const unlink = useCallback(async () => {
    if (
      !(await requestConfirm({
        title: 'Unlink FormLogic Cloud?',
        body: 'The headless flow runtime stops.',
        confirmLabel: 'Unlink',
        danger: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await formlogic.disconnect();
      setApiKey('');
      setOauth(null);
      setTestResult(null);
      toast.push({ kind: 'info', title: 'Unlinked', body: 'FormLogic Cloud link cleared.' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh, requestConfirm, toast]);

  if (!isTauri()) return null;

  const linked = cfg?.linked ?? false;

  return (
    <section className="model-section">
      <h3 className="section-title">
        FormLogic Cloud{' '}
        <span className={`badge ${linked ? 'badge-ok' : 'badge-pending'}`}>
          {linked ? 'linked · runtime active' : 'not linked'}
        </span>
      </h3>
      <p className="form-hint" style={{ marginBottom: 12 }}>
        Link this desktop to your FormLogic account so it runs your flows and the Aokie receptionist
        headless — polling and claiming queued runs, firing event bindings, relaying remote call
        commands, and writing records — even with no browser open. Linking opens your browser to
        approve access; the scoped key it mints is stored on this machine only (config dir).
      </p>

      {error && (
        <div className="banner banner-err">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </div>
      )}

      <label className="form-row">
        <span>Base URL</span>
        <input
          className="fl-base"
          type="text"
          placeholder="https://formlogic.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={busy || linking}
        />
      </label>

      {!linked && (
        <div className="inline-actions-spaced">
          {!linking ? (
            <button className="btn btn-primary" disabled={busy || baseUrl.trim() === ''} onClick={() => void link()}>
              Link FormLogic account
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => void cancelLink()}>
              Cancel
            </button>
          )}
        </div>
      )}

      {oauth && (oauth.inProgress || oauth.phase === 'error' || oauth.phase === 'cancelled') && (
        <div className={`banner ${oauth.phase === 'error' ? 'banner-err' : 'banner-pending'}`}>
          {oauth.phase === 'error' && (
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          )}
          {oauth.message ?? phaseLabel(oauth.phase)}
        </div>
      )}

      {linked && (
        <div className="inline-actions-spaced">
          <button className="btn btn-ghost" disabled={busy} onClick={() => void test()}>
            Test connection
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => void unlink()}>
            Unlink
          </button>
        </div>
      )}

      {testResult && (
        <div className={`banner ${testResult.ok ? 'banner-pending' : 'banner-err'}`}>
          {testResult.ok ? (
            <CheckIcon className="inline-icon icon-leading" size={14} />
          ) : (
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          )}
          {testResult.msg}
        </div>
      )}

      {status && linked && (
        <div className="settings-grid section-spacer-sm">
          {cfg?.deviceName && (
            <div className="settings-row">
              <span className="settings-label">Device</span>
              <div className="settings-value">
                <span className="form-hint">{cfg.deviceName}</span>
              </div>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label">Runtime</span>
            <div className="settings-value">
              <span className="form-hint">
                {status.runsExecuted} run{status.runsExecuted === 1 ? '' : 's'} ·{' '}
                {status.recordsWritten} record{status.recordsWritten === 1 ? '' : 's'} written ·{' '}
                {status.errors} error{status.errors === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Remote calls</span>
            <div className="settings-value">
              <span className="form-hint">
                {status.commandsHandled} command{status.commandsHandled === 1 ? '' : 's'} handled ·{' '}
                relay {relayLabel(status.relayPollOk)}
                {status.lastCommandAt ? ` · last ${fmt(status.lastCommandAt)}` : ''}
              </span>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Last poll</span>
            <div className="settings-value">
              <span className="form-hint">
                events {fmt(status.lastEventAt)} · claims {fmt(status.lastClaimAt)}
              </span>
            </div>
          </div>
          {status.lastError && (
            <div className="settings-row">
              <span className="settings-label">Last error</span>
              <div className="settings-value">
                <span className="form-hint">{status.lastError}</span>
              </div>
            </div>
          )}
          {(status.errors > 0 || status.lastError) && (
            <div className="settings-row">
              <span className="settings-label">Error log</span>
              <div className="settings-value">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-tiny" onClick={() => void toggleErrorLog()}>
                    {errorLog !== null ? 'Hide details' : 'View details'}
                  </button>
                  <button
                    className="btn btn-tiny"
                    onClick={() => void clearErrors()}
                    disabled={clearingErrors}
                    title="Reset the error counter and history — purely diagnostic; nothing operational changes."
                  >
                    {clearingErrors ? 'Clearing…' : 'Clear errors'}
                  </button>
                </div>
                {errorLog !== null && (
                  <div className="section-spacer-top" style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {errorLog.length === 0 ? (
                      <span className="form-hint">No recorded history (the counter predates this session).</span>
                    ) : (
                      // Newest last from the API — show newest FIRST for reading.
                      [...errorLog].reverse().map((e, i) => (
                        <div key={i} className="form-hint" style={{ padding: '3px 0' }}>
                          <span style={{ opacity: 0.7 }}>
                            {fmtAt(e.lastAt)}
                            {e.count > 1 ? ` ·  ×${e.count} since ${fmtAt(e.firstAt)}` : ''}
                          </span>
                          {' — '}
                          {e.message}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Advanced: manual key entry — the fallback for offline/air-gapped setups. */}
      <div className="section-spacer-top">
        <button
          className="btn btn-tiny"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          <span className="icon-button-label">
            {showAdvanced ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
            Advanced — paste an API key manually
          </span>
        </button>
        {showAdvanced && (
          <div className="section-spacer-sm">
            <p className="form-hint" style={{ marginBottom: 8 }}>
              Create a scoped key (<code className="path-code">flk_…</code>) in FormLogic → Settings → API
              keys with the <code className="path-code">flows:read</code>, <code className="path-code">flows:write</code>,{' '}
              <code className="path-code">responses:read</code>, <code className="path-code">responses:write</code>,{' '}
              <code className="path-code">responses:manage</code> and <code className="path-code">connector:relay</code>{' '}
              scopes, then paste it here. Treat it as a secret.
            </p>
            <label className="form-row">
              <span>API key</span>
              <input
                type="password"
                placeholder={cfg?.hasKey ? '•••••••• (leave blank to keep)' : 'flk_…'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
            </label>
            <div className="inline-actions-compact">
              <button
                className="btn btn-primary"
                disabled={busy || baseUrl.trim() === '' || apiKey.trim() === ''}
                onClick={() => void saveManual()}
              >
                Save key
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function phaseLabel(phase: OAuthLinkStatus['phase']): string {
  switch (phase) {
    case 'starting':
      return 'Starting the secure link…';
    case 'awaiting_browser':
      return 'Waiting for you to approve access in your browser…';
    case 'exchanging':
      return 'Finishing sign-in…';
    case 'linked':
      return 'Linked.';
    case 'cancelled':
      return 'Linking cancelled.';
    case 'error':
      return 'Linking failed.';
    default:
      return '';
  }
}

function relayLabel(ok: boolean | null): string {
  if (ok === null) return 'idle';
  return ok ? 'ok' : 'error';
}

function fmt(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleTimeString();
}

/** Date + time for error-log entries (errors can span days, unlike the poll rows). */
function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
