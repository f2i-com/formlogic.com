// Data workspace (N1 — operational only, no record CRUD; data-nodes plan §19,
// D9). Lists locally hosted encrypted datasets, node identity, key-store
// health, and the independent high-water verdicts; actions are Verify,
// Create sample dataset, Delete sample, and Open folder. Record viewing stays
// in the Web App.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dataNodes,
  formatBytes,
  isTauri,
  openInExplorer,
  type DataBackupEntry,
  type DataCloudForm,
  type DataScheduleEntry,
  type DataSelfTestReport,
  type DataStatusSnapshot,
  type DataTestRestoreReport,
  type DataVerifyReport,
} from './api';
import {
  backupTestBadge,
  datasetLabel,
  headComparisonLabel,
  healthBadge,
  keyStoreBanner,
  provenanceBadge,
  summarize,
} from './dataPanelModel';
import { getPanelCache, setPanelCache, PANEL_CACHE_KEYS } from './panelCache';
import { PanelRefresh } from './PanelRefresh';
import { useToast } from './Toasts';
import { useConfirm } from './ConfirmDialog';

const POLL_MS = 5000;

export default function DataPanel() {
  const [status, setStatus] = useState<DataStatusSnapshot | null>(
    () => getPanelCache<DataStatusSnapshot>(PANEL_CACHE_KEYS.dataStatus) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<DataVerifyReport | null>(null);
  const [backups, setBackups] = useState<DataBackupEntry[]>([]);
  const [cloudForms, setCloudForms] = useState<DataCloudForm[] | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [pullFormId, setPullFormId] = useState('');
  const [lastRestore, setLastRestore] = useState<DataTestRestoreReport | null>(null);
  const [lastSelfTest, setLastSelfTest] = useState<DataSelfTestReport | null>(null);
  const [schedule, setSchedule] = useState<DataScheduleEntry[]>([]);
  const [cloudNode, setCloudNode] = useState<{ status: string; approved: boolean } | null | 'unlinked'>('unlinked');
  const toast = useToast();
  const { confirm } = useConfirm();
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const next = await dataNodes.status();
      if (seq !== reqSeq.current) return;
      setError(null);
      setPanelCache(PANEL_CACHE_KEYS.dataStatus, next);
      setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshBackups = useCallback(async () => {
    try {
      const res = await dataNodes.backups();
      setBackups(res.backups);
      const sched = await dataNodes.schedule();
      setSchedule(sched.entries);
    } catch {
      // Backups list is local; a failure surfaces via the main error banner.
    }
  }, []);

  const scheduled = (kind: string, formId: string | null) =>
    schedule.some((e) => e.kind === kind && (kind === 'account' || e.formId === formId));

  // Cloud form listing is on-demand (link + network), not polled.
  const loadCloudForms = useCallback(async () => {
    try {
      const res = await dataNodes.cloudForms();
      setCloudForms(res.forms);
      setCloudError(null);
      setPullFormId((prev) => prev || res.forms[0]?.formId || '');
    } catch (e) {
      setCloudForms(null);
      setCloudError(e instanceof Error ? e.message : String(e));
    }
    try {
      const status = await dataNodes.nodeCloudStatus();
      setCloudNode(status.node);
    } catch {
      setCloudNode('unlinked');
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshBackups();
    void loadCloudForms();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh, refreshBackups, loadCloudForms]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      try {
        await action();
      } catch (e) {
        toast.push({
          kind: 'error',
          title: 'Data workspace',
          body: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(null);
        void refresh();
      }
    },
    [refresh, toast],
  );

  const toggleSchedule = (kind: string, formId: string | null, formTitle: string | null) =>
    run(`sched-${kind}-${formId ?? ''}`, async () => {
      const on = scheduled(kind, formId);
      const res = await dataNodes.setSchedule(kind, formId, formTitle, on ? null : 24);
      setSchedule(res.entries);
      toast.push({
        kind: 'success',
        title: on ? 'Daily backup disabled' : 'Daily backup enabled',
        body: on ? undefined : 'Runs in the background about once a day; the newest 5 are kept.',
      });
    });

  const summary = summarize(status);
  const failClosed = keyStoreBanner(status);

  return (
    <div className="panel">
      <PanelRefresh onRefresh={refresh} />

      {error && <div className="banner banner-err">Data status unavailable: {error}</div>}
      {failClosed && <div className="banner banner-err">{failClosed}</div>}

      <section className="model-section">
        <h3 className="section-title">Encrypted data node</h3>
        <p className="datadir-note">
          Private-form datasets hosted on this computer are whole-file encrypted (SQLCipher) on
          top of record-level E2EE. This workspace is operational only — records are viewed and
          edited in the Web App. Beta: sample datasets exercise the real signed write path.
        </p>
        {status?.node ? (
          <div className="service-row">
            <div style={{ minWidth: 0 }}>
              <div>
                Node identity{' '}
                <code className="path-code">{status.node.displayFingerprint}</code>
              </div>
              <div className="datadir-note">
                key id <code className="path-code">{status.node.keyId}</code> · created{' '}
                {status.node.createdAt} · store:{' '}
                <code className="path-code">{status.dataRoot}</code>
              </div>
              <div className="datadir-note">
                Cloud enrolment:{' '}
                {cloudNode === 'unlinked' || cloudNode === null ? (
                  <span className="badge badge-neutral">Not enrolled yet</span>
                ) : cloudNode.approved ? (
                  <span className="badge badge-ok">Approved by owner</span>
                ) : cloudNode.status === 'revoked' ? (
                  <span className="badge badge-err">Revoked</span>
                ) : (
                  <span className="badge badge-pending" title="Approve this node in the web app: Settings → Linked Desktops → Data nodes.">
                    Awaiting approval in web Settings
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {isTauri() && (
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  onClick={() => void openInExplorer(status.dataRoot)}
                >
                  Open folder
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                disabled={busy !== null || !!failClosed}
                title="Creates a throwaway encrypted sample dataset through the real signed write path, verifies it end-to-end, then deletes it."
                onClick={() =>
                  void run('selftest', async () => {
                    const res = await dataNodes.selfTest();
                    setLastSelfTest(res.report);
                    toast.push({
                      kind: res.report.ok ? 'success' : 'error',
                      title: res.report.ok ? 'Storage self-test passed' : 'Storage self-test FAILED',
                      body: `${res.report.records} sample records written, verified and removed`,
                    });
                  })
                }
              >
                {busy === 'selftest' ? 'Testing…' : 'Run storage self-test'}
              </button>
            </div>
          </div>
        ) : (
          !failClosed && <div className="datadir-note">Node identity is initialising…</div>
        )}
        <div className="datadir-note">
          {summary.datasets} dataset{summary.datasets === 1 ? '' : 's'} · {summary.records}{' '}
          encrypted records · {summary.operations} operations · {formatBytes(summary.sizeBytes)}
          {summary.unhealthy > 0 && (
            <span className="badge badge-err" style={{ marginLeft: 8 }}>
              {summary.unhealthy} need attention
            </span>
          )}
        </div>
        {lastSelfTest && (
          <div className="datadir-note">
            Self-test: {lastSelfTest.ok ? 'passed' : 'FAILED'} · {lastSelfTest.checkedOperations}{' '}
            operations and {lastSelfTest.checkedEnvelopes} envelopes verified
            {lastSelfTest.issues.length > 0 && (
              <ul>
                {lastSelfTest.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="model-section">
        <h3 className="section-title">Hosted datasets</h3>
        {status && status.datasets.length === 0 && status.datasetErrors.length === 0 ? (
          <div className="empty-state">
            No datasets are hosted on this node yet. Create a sample dataset to exercise the
            encrypted store, or assign a Private form to this Desktop from the Web App when
            placement ships.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {status?.datasets.map((d) => {
              const badge = healthBadge(d.health);
              return (
                <div key={d.datasetId} className="service-row">
                  <div style={{ minWidth: 0 }}>
                    <div>
                      {datasetLabel(d)}{' '}
                      <span
                        className={`badge badge-${badge.tone}`}
                        title={headComparisonLabel(d.headComparison)}
                      >
                        {badge.label}
                      </span>
                    </div>
                    <div className="datadir-note">
                      {d.role} · epoch {d.storageEpoch} · seq {d.lastSequence} · {d.records}{' '}
                      records · {d.operations} ops · {formatBytes(d.sizeBytes)} ·{' '}
                      <code className="path-code">{d.fileName}</code>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-tiny"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`verify-${d.datasetId}`, async () => {
                          const res = await dataNodes.verify(d.datasetId);
                          setLastReport(res.report);
                          toast.push({
                            kind: res.report.ok ? 'success' : 'error',
                            title: res.report.ok
                              ? 'Integrity verified'
                              : `Verification found problems (${res.report.health})`,
                            body: `${res.report.checkedOperations} operations, ${res.report.checkedEnvelopes} envelopes checked`,
                          });
                        })
                      }
                    >
                      {busy === `verify-${d.datasetId}` ? 'Verifying…' : 'Verify'}
                    </button>
                    {d.isSample && (
                      <button
                        type="button"
                        className="btn btn-danger btn-tiny"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`delete-${d.datasetId}`, async () => {
                            const ok = await confirm({
                              title: 'Delete this sample dataset?',
                              body: 'The encrypted sample database, its wrapped key, and its high-water anchor are removed from this computer. Real datasets are never deletable here.',
                              confirmLabel: 'Delete sample',
                              danger: true,
                            });
                            if (!ok) return;
                            await dataNodes.deleteSample(d.datasetId);
                            setLastReport((r) => (r?.datasetId === d.datasetId ? null : r));
                            toast.push({ kind: 'success', title: 'Sample dataset deleted' });
                          })
                        }
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {status?.datasetErrors.map((e) => (
          <div key={e.datasetId} className="banner banner-err">
            Dataset <code className="path-code">{e.datasetId}</code>: {e.code} — {e.message}
          </div>
        ))}
      </section>

      <section className="model-section">
        <h3 className="section-title">Cloud form backups</h3>
        <p className="datadir-note">
          Pull a signed, verified snapshot of a Private form from FormLogic Cloud into a
          copy-safe <code className="path-code">.flbackup</code> on this computer. Everything
          inside stays end-to-end encrypted; this node never receives a decryption key.
        </p>
        {cloudError && (
          <div className="banner banner-err banner-dismissable">
            Cloud unavailable: {cloudError}
            <button type="button" className="btn btn-ghost btn-tiny" onClick={() => void loadCloudForms()}>
              Retry
            </button>
          </div>
        )}
        {cloudForms && cloudForms.length === 0 && (
          <div className="empty-state">
            No Private forms found on the linked account. Only Private (end-to-end encrypted)
            forms can be hosted or backed up on a data node.
          </div>
        )}
        {cloudForms && cloudForms.length > 0 && (
          <div className="service-row">
            <select
              value={pullFormId}
              onChange={(e) => setPullFormId(e.target.value)}
              style={{ minWidth: 0, flex: 1 }}
            >
              {cloudForms.map((f) => (
                <option key={f.formId} value={f.formId}>
                  {f.title} · {f.responses} record{f.responses === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <label className="datadir-note" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <input
                type="checkbox"
                checked={scheduled('form', pullFormId)}
                disabled={busy !== null || !pullFormId}
                onChange={() => {
                  const form = cloudForms.find((f) => f.formId === pullFormId);
                  void toggleSchedule('form', pullFormId, form?.title || null);
                }}
              />
              Daily
            </label>
            <button
              type="button"
              className="btn btn-primary btn-tiny"
              disabled={busy !== null || !pullFormId}
              onClick={() =>
                void run('pull', async () => {
                  const form = cloudForms.find((f) => f.formId === pullFormId);
                  const res = await dataNodes.pullBackup(pullFormId, form?.title || '');
                  await refreshBackups();
                  toast.push({
                    kind: 'success',
                    title: 'Backup created and verified',
                    body: `${res.backup.responses} encrypted records → ${res.backup.fileName}`,
                  });
                })
              }
            >
              {busy === 'pull' ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        )}

        <div className="service-row">
          <div style={{ minWidth: 0 }}>
            <div>Whole-account backup</div>
            <div className="datadir-note">
              Everything on the linked account — ALL forms (plaintext ones too), apps and flows —
              sealed end-to-end to this desktop before it leaves the Cloud, and stored encrypted
              here (readable only by this desktop; the Cloud stays the primary copy).
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <label className="datadir-note" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <input
                type="checkbox"
                checked={scheduled('account', null)}
                disabled={busy !== null}
                onChange={() => void toggleSchedule('account', null, null)}
              />
              Daily
            </label>
            <button
              type="button"
              className="btn btn-primary btn-tiny"
              disabled={busy !== null || !!failClosed}
              onClick={() =>
                void run('acct', async () => {
                  const res = await dataNodes.accountBackup();
                  await refreshBackups();
                  toast.push({
                    kind: 'success',
                    title: 'Account backup sealed and stored',
                    body: `${formatBytes(res.backup.bytes)} → ${res.backup.fileName}`,
                  });
                })
              }
            >
              {busy === 'acct' ? 'Backing up…' : 'Back up account now'}
            </button>
          </div>
        </div>

        {backups.length === 0 ? (
          <div className="empty-state">No local backups yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {backups.map((b) => {
              const prov = provenanceBadge(b.provenance);
              const test = backupTestBadge(b.lastTestOk, b.lastTestAt);
              return (
                <div key={b.backupId} className="service-row">
                  <div style={{ minWidth: 0 }}>
                    <div>
                      {b.formTitle || b.formId}{' '}
                      <span className={`badge badge-${prov.tone}`}>{prov.label}</span>{' '}
                      <span className={`badge badge-${test.tone}`}>{test.label}</span>
                    </div>
                    <div className="datadir-note">
                      {b.createdAt} · {b.responses} records · {formatBytes(b.bytes)} ·{' '}
                      <code className="path-code">{b.fileName}</code>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-tiny"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`test-${b.backupId}`, async () => {
                          const res = await dataNodes.testRestore(b.backupId);
                          setLastRestore(res.report);
                          await refreshBackups();
                          toast.push({
                            kind: res.report.ok ? 'success' : 'error',
                            title: res.report.ok
                              ? 'Test restore passed'
                              : 'Test restore found problems',
                            body: `${res.report.responses} records restored into an isolated encrypted store`,
                          });
                        })
                      }
                    >
                      {busy === `test-${b.backupId}` ? 'Testing…' : 'Test restore'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-tiny"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`delbk-${b.backupId}`, async () => {
                          const ok = await confirm({
                            title: 'Delete this backup?',
                            body: 'The local .flbackup file is removed from this computer. The Cloud copy of the form is not affected.',
                            confirmLabel: 'Delete backup',
                            danger: true,
                          });
                          if (!ok) return;
                          await dataNodes.deleteBackup(b.backupId);
                          await refreshBackups();
                          toast.push({ kind: 'success', title: 'Backup deleted' });
                        })
                      }
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {lastRestore && (
          <div className="datadir-note">
            Last test restore ({datasetShort(lastRestore.backupId)}…):{' '}
            {lastRestore.ok ? 'passed' : 'FAILED'} · {lastRestore.responses} records,{' '}
            {lastRestore.artifacts} control artifacts
            {lastRestore.issues.length > 0 && (
              <ul>
                {lastRestore.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {lastReport && (
        <section className="model-section">
          <h3 className="section-title">
            Last verification — {datasetShort(lastReport.datasetId)}
          </h3>
          <div className="datadir-note">
            {lastReport.ok ? 'Healthy.' : `Health: ${lastReport.health}.`}{' '}
            {headComparisonLabel(lastReport.headComparison)} · {lastReport.checkedOperations}{' '}
            operations and {lastReport.checkedEnvelopes} envelopes checked
            {lastReport.logicalRoot && (
              <>
                {' '}
                · logical root <code className="path-code">{lastReport.logicalRoot.slice(0, 16)}…</code>
              </>
            )}
          </div>
          {lastReport.issues.length > 0 && (
            <ul>
              {lastReport.issues.map((issue) => (
                <li key={issue} className="datadir-note">
                  {issue}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function datasetShort(id: string): string {
  return id.slice(0, 8);
}
