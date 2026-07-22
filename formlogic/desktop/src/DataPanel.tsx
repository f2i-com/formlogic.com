// Data workspace (operational only, no record CRUD — data-nodes plan §19, D9).
// Layout: stat strip → node identity card → backups (form snapshots + whole
// account, catalog with Test/Export/Delete) → hosted encrypted datasets.
// Records are viewed and edited in the Web App; restoring an exported account
// archive happens there too (Settings → Backup → Import).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dataNodes,
  formatBytes,
  formatTimestamp,
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
import { CloudIcon, DatabaseIcon, ShieldIcon } from './Icons';

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
      // Local reads; failures surface via the main error banner.
    }
  }, []);

  // Cloud listing + enrolment state: on-demand (link + network), not polled.
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
      const nodeStatus = await dataNodes.nodeCloudStatus();
      setCloudNode(nodeStatus.node);
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

  const scheduled = (kind: string, formId: string | null) =>
    schedule.some((e) => e.kind === kind && (kind === 'account' || e.formId === formId));

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
  const enrolment =
    cloudNode === 'unlinked' || cloudNode === null
      ? { label: 'Not enrolled', tone: 'neutral' as const }
      : cloudNode.approved
        ? { label: 'Approved by owner', tone: 'ok' as const }
        : cloudNode.status === 'revoked'
          ? { label: 'Revoked', tone: 'err' as const }
          : { label: 'Awaiting approval', tone: 'pending' as const };

  return (
    <div className="panel">
      <PanelRefresh
        onRefresh={async () => {
          await Promise.all([refresh(), refreshBackups(), loadCloudForms()]);
        }}
      />

      {error && <div className="banner banner-err">Data status unavailable: {error}</div>}
      {failClosed && <div className="banner banner-err">{failClosed}</div>}

      {/* ── At a glance ─────────────────────────────────────────────── */}
      <div className="data-stats">
        <div className="data-stat">
          <b>{summary.datasets}</b>
          <span>Encrypted datasets</span>
        </div>
        <div className="data-stat">
          <b>{summary.records}</b>
          <span>Records held locally</span>
        </div>
        <div className="data-stat">
          <b>{backups.length}</b>
          <span>Backups kept</span>
        </div>
        <div className="data-stat">
          <b>
            <span className={`badge badge-${enrolment.tone}`}>{enrolment.label}</span>
          </b>
          <span>Cloud enrolment</span>
        </div>
      </div>

      {/* ── This data node ──────────────────────────────────────────── */}
      <section className="model-section">
        <h3 className="section-title">This data node</h3>
        <div className="data-card">
          <div className="service-row">
            <div style={{ minWidth: 0 }}>
              <div className="data-card-title">
                <ShieldIcon size={15} />
                {status?.node ? 'Node identity' : 'Identity initialising…'}
              </div>
              {status?.node && (
                <>
                  <div style={{ marginTop: 7 }}>
                    <span className="data-fingerprint">{status.node.displayFingerprint}</span>
                  </div>
                  <div className="datadir-note" style={{ marginTop: 6 }}>
                    Hosts end-to-end-encrypted form data without ever holding a decryption key.
                    Approve or revoke this node in the web app under Settings → Linked Desktops.
                  </div>
                </>
              )}
              {enrolment.label === 'Awaiting approval' && (
                <div className="datadir-note" style={{ marginTop: 4 }}>
                  <span className="badge badge-pending">Awaiting approval</span>{' '}
                  Compare the fingerprint above when approving in the web app.
                </div>
              )}
            </div>
            <div className="data-row-actions">
              {isTauri() && status && (
                <button
                  type="button"
                  className="btn btn-ghost btn-tiny"
                  onClick={() => void openInExplorer(status.dataRoot)}
                >
                  Open data folder
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                disabled={busy !== null || !!failClosed}
                title="Writes 10 throwaway encrypted sample records through the real signed pipeline, verifies everything, then removes them."
                onClick={() =>
                  void run('selftest', async () => {
                    const res = await dataNodes.selfTest();
                    setLastSelfTest(res.report);
                    toast.push({
                      kind: res.report.ok ? 'success' : 'error',
                      title: res.report.ok ? 'Storage self-test passed' : 'Storage self-test FAILED',
                      body: `${res.report.checkedOperations} operations and ${res.report.checkedEnvelopes} envelopes verified, then cleaned up.`,
                    });
                  })
                }
              >
                {busy === 'selftest' ? 'Testing…' : 'Run self-test'}
              </button>
            </div>
          </div>
          {lastSelfTest && (
            <div className="datadir-note" style={{ marginTop: 8 }}>
              Self-test: {lastSelfTest.ok ? 'passed' : 'FAILED'} · {lastSelfTest.checkedOperations}{' '}
              operations, {lastSelfTest.checkedEnvelopes} envelopes verified
              {lastSelfTest.issues.length > 0 && (
                <ul>
                  {lastSelfTest.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Backups ─────────────────────────────────────────────────── */}
      <section className="model-section">
        <h3 className="section-title">Backups</h3>
        {cloudError && (
          <div className="banner banner-err banner-dismissable">
            Cloud unavailable: {cloudError}
            <button type="button" className="btn btn-ghost btn-tiny" onClick={() => void loadCloudForms()}>
              Retry
            </button>
          </div>
        )}

        <div className="data-actions">
          <div className="data-card">
            <div className="data-card-title">
              <DatabaseIcon size={15} />
              Private form snapshot
            </div>
            <div className="datadir-note" style={{ margin: '6px 0 8px' }}>
              A verified, portable copy of one end-to-end-encrypted form. Everything inside stays
              encrypted — this node can store it but never read it.
            </div>
            {cloudForms && cloudForms.length === 0 && (
              <div className="datadir-note">
                No Private forms on the linked account yet — only end-to-end-encrypted forms can be
                snapshotted here. The whole-account backup covers everything else.
              </div>
            )}
            {cloudForms && cloudForms.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
                        title: 'Snapshot created and verified',
                        body: `${res.backup.responses} encrypted record${res.backup.responses === 1 ? '' : 's'} → ${res.backup.fileName}`,
                      });
                    })
                  }
                >
                  {busy === 'pull' ? 'Backing up…' : 'Back up now'}
                </button>
              </div>
            )}
          </div>

          <div className="data-card">
            <div className="data-card-title">
              <CloudIcon size={15} />
              Whole account
            </div>
            <div className="datadir-note" style={{ margin: '6px 0 8px' }}>
              Everything on the linked account — every form (including unencrypted ones), app and
              flow. Sealed to this desktop before it leaves the Cloud and stored encrypted here.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
                      body: `${res.backup.forms ?? 0} forms, ${res.backup.responses} records · ${formatBytes(res.backup.bytes)}`,
                    });
                  })
                }
              >
                {busy === 'acct' ? 'Backing up…' : 'Back up account now'}
              </button>
            </div>
          </div>
        </div>

        {backups.length === 0 ? (
          <div className="empty-state">No local backups yet — create one above.</div>
        ) : (
          <div>
            {backups.map((b) => {
              const prov = provenanceBadge(b.provenance);
              const test = backupTestBadge(b.lastTestOk, b.lastTestAt);
              const isAccount = b.kind === 'account';
              return (
                <div key={b.backupId} className="data-backup-row">
                  <div className="data-backup-icon">
                    {isAccount ? <CloudIcon size={15} /> : <DatabaseIcon size={15} />}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div>
                      {b.formTitle || b.formId}{' '}
                      <span className={`badge badge-${prov.tone}`}>{prov.label}</span>{' '}
                      <span className={`badge badge-${test.tone}`}>{test.label}</span>
                    </div>
                    <div className="datadir-note">
                      {formatTimestamp(b.createdAt)} ·{' '}
                      {isAccount
                        ? `${b.forms ?? 0} form${(b.forms ?? 0) === 1 ? '' : 's'}, ${b.responses} record${b.responses === 1 ? '' : 's'}`
                        : `${b.responses} encrypted record${b.responses === 1 ? '' : 's'}`}{' '}
                      · {formatBytes(b.bytes)} · <code className="path-code">{b.fileName}</code>
                    </div>
                  </div>
                  <div className="data-row-actions">
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
                            title: res.report.ok ? 'Backup verified' : 'Backup verification found problems',
                            body: isAccount
                              ? 'Decrypted, hash-checked and structure-checked without touching live data.'
                              : `${res.report.responses} records restored into an isolated encrypted store.`,
                          });
                        })
                      }
                    >
                      {busy === `test-${b.backupId}` ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-tiny"
                      disabled={busy !== null}
                      title={isAccount
                        ? 'Decrypts this backup to a restorable .zip in your Downloads folder.'
                        : 'Copies the portable snapshot file to your Downloads folder.'}
                      onClick={() =>
                        void run(`export-${b.backupId}`, async () => {
                          const res = await dataNodes.exportBackup(b.backupId);
                          toast.push({
                            kind: 'success',
                            title: 'Exported to Downloads',
                            body: isAccount
                              ? 'Restore it in the web app: Settings → Backup → Import.'
                              : res.path,
                          });
                          if (isTauri()) {
                            const dir = res.path.slice(0, Math.max(res.path.lastIndexOf('\\'), res.path.lastIndexOf('/')));
                            if (dir) void openInExplorer(dir);
                          }
                        })
                      }
                    >
                      {busy === `export-${b.backupId}` ? 'Exporting…' : 'Export'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-tiny"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`delbk-${b.backupId}`, async () => {
                          const ok = await confirm({
                            title: 'Delete this backup?',
                            body: 'Only the local copy on this computer is removed. Your data in FormLogic Cloud is not affected.',
                            confirmLabel: 'Delete backup',
                            danger: true,
                          });
                          if (!ok) return;
                          await dataNodes.deleteBackup(b.backupId);
                          setLastRestore((r) => (r?.backupId === b.backupId ? null : r));
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

        <div className="data-restore-hint">
          <b>Restoring:</b> use <i>Export</i> to place a copy in your Downloads folder. An account
          backup exports as a plain .zip you can import in the web app (Settings → Backup →
          Import); a form snapshot exports as a portable encrypted .flbackup file.
        </div>

        {lastRestore && (
          <div className="datadir-note">
            Last verification ({lastRestore.backupId.slice(0, 12)}…):{' '}
            {lastRestore.ok ? 'passed' : 'FAILED'}
            {lastRestore.artifacts > 0 && ` · ${lastRestore.artifacts} control artifacts`}
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

      {/* ── Hosted encrypted datasets ───────────────────────────────── */}
      <section className="model-section">
        <h3 className="section-title">Hosted encrypted datasets</h3>
        {status && status.datasets.length === 0 && status.datasetErrors.length === 0 ? (
          <div className="datadir-note">
            None yet. When a Private form assigns this desktop as a replica or primary (coming with
            placement migration), its encrypted dataset appears here.
          </div>
        ) : (
          <div>
            {status?.datasets.map((d) => {
              const badge = healthBadge(d.health);
              return (
                <div key={d.datasetId} className="data-backup-row">
                  <div className="data-backup-icon">
                    <DatabaseIcon size={15} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
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
                  <div className="data-row-actions">
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
                              body: 'The encrypted sample database, its wrapped key, and its rollback anchor are removed from this computer.',
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
        {lastReport && (
          <div className="datadir-note">
            Last dataset verification ({lastReport.datasetId.slice(0, 8)}…):{' '}
            {lastReport.ok ? 'healthy' : `problems (${lastReport.health})`} ·{' '}
            {headComparisonLabel(lastReport.headComparison)}
            {lastReport.issues.length > 0 && (
              <ul>
                {lastReport.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
