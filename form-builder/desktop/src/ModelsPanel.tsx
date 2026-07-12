import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes,
  formatEta,
  formatSpeed,
  formatTimestamp,
  models,
  openInExplorer,
  type CatalogSnapshot,
  type DownloadProgress,
  type DownloadStatus,
  type ModelsSnapshot,
} from './api';
import { useConfirm } from './ConfirmDialog';
import { AlertTriangleIcon, CheckIcon, XIcon } from './Icons';
import { useToast } from './Toasts';

/**
 * Models panel — manage model downloads + the on-disk files. Four parts:
 *   1. Designated-folder banner (where everything lands)
 *   2. New-download form (paste HF URL or direct link)
 *   3. In-flight downloads with pause/resume/cancel
 *   4. Already-downloaded files with size + delete
 *
 * Polls both lists every 1.5s so progress bars tick smoothly.
 */
export default function ModelsPanel() {
  const [snapshot, setSnapshot] = useState<ModelsSnapshot | null>(null);
  const [downloads, setDownloads] = useState<DownloadProgress[]>([]);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [subdir, setSubdir] = useState('');
  const [sha256, setSha256] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const toast = useToast();
  const { confirm: requestConfirm } = useConfirm();
  // Track status of each download across renders so we can fire a toast
  // on the active→completed (or →failed) transition exactly once.
  const seenStatusRef = useRef<Map<string, DownloadStatus>>(new Map());
  // First-poll flag independent of list length, and a request sequence so a
  // slow poll response can't clobber a newer one out of order.
  const firstPollRef = useRef(true);
  const reqSeqRef = useRef(0);

  // Catalog only changes when the user edits the JSON, so we fetch once.
  useEffect(() => {
    models
      .catalog()
      .then(setCatalog)
      .catch(() => {
        // Non-fatal — Quick add stays hidden if companion is offline; the
        // flag stops the section spinner from spinning forever.
        setCatalogFailed(true);
      });
  }, []);

  // Download progress only — cheap (an in-memory snapshot server-side), so it
  // can tick fast enough for smooth progress bars.
  const refreshDownloads = useCallback(async () => {
    try {
      const dls = await models.downloads();
      // Fire completion / failure toasts before swapping state in. The
      // first poll seeds the map without firing — we only care about
      // transitions, not the initial "this entry already exists" state.
      const seen = seenStatusRef.current;
      const firstPoll = firstPollRef.current;
      let finishedOne = false;
      for (const d of dls) {
        const prev = seen.get(d.id);
        if (prev !== d.status && !firstPoll) {
          if (d.status === 'completed' && prev !== undefined) {
            finishedOne = true;
            toast.push({
              kind: 'success',
              title: 'Download complete',
              body: d.filename,
            });
          } else if (d.status === 'failed' && prev !== undefined) {
            toast.push({
              kind: 'error',
              title: `Download failed: ${d.filename}`,
              body: d.error ?? undefined,
              timeoutMs: 8000,
            });
          }
        }
        seen.set(d.id, d.status);
      }
      firstPollRef.current = false;
      setDownloads(dls);
      setError(null);
      return finishedOne;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [toast]);

  // On-disk scan — the server walks every model root (can take a while on a
  // big library), so poll it an order of magnitude slower than the download
  // progress, plus immediately after anything that changes the disk.
  const refreshDisk = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    try {
      const snap = await models.list();
      if (seq !== reqSeqRef.current) return; // superseded by a newer refresh
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    const [finishedOne] = await Promise.all([refreshDownloads(), refreshDisk()]);
    return finishedOne;
  }, [refreshDownloads, refreshDisk]);

  useEffect(() => {
    refresh();
    const fast = setInterval(async () => {
      // A download finishing changes the disk — rescan right away instead of
      // waiting for the slow tick.
      if (await refreshDownloads()) refreshDisk();
    }, 1500);
    const slow = setInterval(refreshDisk, 8000);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [refresh, refreshDownloads, refreshDisk]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.trim() || submitting) return;
      setActionError(null);
      setSubmitting(true);
      try {
        await models.download(
          url.trim(),
          filename.trim() || undefined,
          subdir.trim() || undefined,
          sha256.trim() || undefined,
        );
        setUrl('');
        setFilename('');
        setSubdir('');
        setSha256('');
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setSubmitting(false);
      }
    },
    [url, filename, subdir, sha256, submitting, refresh],
  );

  // Deep re-verification: re-hashes every manifest-tracked model, so it can
  // take a while on a big library. Mismatching files are quarantined
  // (renamed aside) server-side; the toast summarises what happened.
  const onVerify = useCallback(async () => {
    if (verifying) return;
    setActionError(null);
    setVerifying(true);
    try {
      const report = await models.verify();
      const bad = report.checked.filter((r) => !r.ok);
      if (bad.length === 0) {
        toast.push({
          kind: 'success',
          title: 'All models verified',
          body:
            report.untracked.length > 0
              ? `${report.checked.length} checked — ${report.untracked.length} file(s) have no recorded digest to check`
              : `${report.checked.length} checked`,
        });
      } else {
        toast.push({
          kind: 'error',
          title: `${bad.length} model(s) failed verification`,
          body: bad
            .map((r) => `${r.name}: ${r.action ?? 'mismatch'}`)
            .join('; '),
          timeoutMs: 12000,
        });
      }
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  }, [verifying, toast, refresh]);

  const onAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  // Partition: active/queued/paused at top, completed below, failures
  // surface in their group so the user notices.
  const inFlight = useMemo(
    () =>
      downloads.filter((d) =>
        ['queued', 'active', 'paused', 'failed'].includes(d.status),
      ),
    [downloads],
  );
  const finished = useMemo(
    () =>
      downloads.filter((d) =>
        ['completed', 'cancelled'].includes(d.status),
      ),
    [downloads],
  );

  return (
    <div className="panel">
      {error && (
        <div className="banner banner-err">
          Couldn't reach the FormLogic Desktop API: {error}
        </div>
      )}
      {!snapshot && !error && (
        <SectionLoading label="Loading models folder…" />
      )}
      {snapshot && (
        <div className="datadir-note">
          Designated downloads folder:{' '}
          <code className="path-code">{snapshot.rootDir}</code>
          <button
            className="btn-tiny"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(snapshot.rootDir);
                toast.push({ kind: 'success', title: 'Path copied', timeoutMs: 3000 });
              } catch {
                setActionError('Clipboard unavailable — select the path manually.');
              }
            }}
            title="Copy path"
          >
            copy
          </button>
          <button
            className="btn-tiny"
            onClick={() =>
              openInExplorer(snapshot.rootDir).catch((e) =>
                setActionError(e instanceof Error ? e.message : String(e)),
              )
            }
            title="Open folder in file explorer"
          >
            open
          </button>
          {snapshot.freeBytes != null && (
            <span
              className="badge badge-neutral"
              style={{ marginLeft: 8 }}
              title="Free space on this drive"
            >
              {formatBytes(snapshot.freeBytes)} free
            </span>
          )}
        </div>
      )}

      <section className="model-section">
        <h3 className="section-title">Download a model</h3>
        <form className="dl-form" onSubmit={onSubmit}>
          <label className="form-row">
            <span>URL</span>
            <input
              type="text"
              placeholder="https://huggingface.co/..  or  https://example.com/model.gguf"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className="form-row-pair">
            <label className="form-row">
              <span>Filename (optional)</span>
              <input
                type="text"
                placeholder="auto from URL"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
              />
            </label>
            <label className="form-row">
              <span>Subfolder (optional)</span>
              <input
                type="text"
                placeholder="e.g. llm, diffusion"
                value={subdir}
                onChange={(e) => setSubdir(e.target.value)}
              />
            </label>
          </div>
          <label className="form-row">
            <span>SHA-256 (optional)</span>
            <input
              type="text"
              placeholder="pin the file's checksum — the download won't install on mismatch"
              value={sha256}
              onChange={(e) => setSha256(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!url.trim() || submitting}>
              Start download
            </button>
          </div>
          <p className="form-hint">
            HuggingFace browser URLs (containing <code>/blob/</code>) are
            rewritten to direct downloads automatically. Quick-add models are
            checksum-verified automatically; paste a SHA-256 to get the same
            protection for your own URLs.
          </p>
        </form>
        {actionError && (
          <div className="banner banner-err banner-dismissable">
            <span>
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {actionError}
            </span>
            <button
              type="button"
              className="banner-dismiss"
              aria-label="Dismiss error"
              onClick={() => setActionError(null)}
            >
              <XIcon size={14} />
            </button>
          </div>
        )}
      </section>

      {!catalog && !catalogFailed && (
        <section className="model-section">
          <h3 className="section-title">Quick add</h3>
          <SectionLoading label="Loading the model catalog…" />
        </section>
      )}
      {catalog && catalog.catalog.categories.length > 0 && (
        <section className="model-section">
          <div className="section-title-row">
            <h3 className="section-title">Quick add</h3>
            <span className="form-hint">
              From <code className="path-code-small">model-catalog.json</code> —
              edit it to add your own
            </span>
          </div>
          {catalog.catalog.categories.map((cat) => (
            <div key={cat.id} className="catalog-category">
              <div className="catalog-cat-name">{cat.name}</div>
              <div className="catalog-cat-desc">{cat.description}</div>
              <div className="catalog-grid">
                {cat.models.map((m) => {
                  const onDisk = snapshot?.models.some(
                    (f) => f.name.split(/[\\/]/).pop() === m.filename,
                  );
                  const active = downloads.find(
                    (d) =>
                      d.url === m.url &&
                      ['queued', 'active', 'paused'].includes(d.status),
                  );
                  return (
                    <div key={m.id} className="catalog-card">
                      <div className="catalog-name">{m.name}</div>
                      <div className="catalog-desc">{m.description}</div>
                      <div className="catalog-meta">
                        {m.sizeBytes ? formatBytes(m.sizeBytes) : 'size unknown'}
                        {m.license && <> · {m.license}</>}
                      </div>
                      <div className="catalog-meta">
                        {m.sha256 ? (
                          <span
                            title={`Pinned sha256 ${m.sha256}${m.provenance ? ` — from ${m.provenance}` : ''}${m.source === 'local' ? ' (local catalog edit)' : ''}`}
                          >
                            checksum-verified download
                            {m.source === 'local' && ' · local entry'}
                          </span>
                        ) : (
                          <span
                            className="warn"
                            title="This catalog entry has no sha256 — the download will install without an integrity check."
                          >
                            no pinned digest
                          </span>
                        )}
                      </div>
                      {onDisk ? (
                        <button className="btn btn-ghost" disabled>
                          <span className="icon-button-label">
                            <CheckIcon size={14} />
                            On disk
                          </span>
                        </button>
                      ) : active ? (
                        <button className="btn btn-ghost" disabled>
                          {active.status}…
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary"
                          onClick={() =>
                            onAction(() =>
                              models.download(
                                m.url,
                                m.filename,
                                m.subdir ?? undefined,
                                m.sha256 ?? undefined,
                                m.sizeBytes || undefined,
                              ),
                            )
                          }
                        >
                          Download
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {inFlight.length > 0 && (
        <section className="model-section">
          <h3 className="section-title">In progress</h3>
          {inFlight.map((d) => (
            <DownloadRow
              key={d.id}
              dl={d}
              onPause={() => onAction(() => models.pause(d.id))}
              onResume={() => onAction(() => models.resume(d.id))}
              onCancel={() => onAction(() => models.cancel(d.id))}
            />
          ))}
        </section>
      )}

      <section className="model-section">
        <div className="section-title-row">
          <h3 className="section-title">
            On disk{' '}
            {snapshot && (
              <span className="section-count">({snapshot.models.length})</span>
            )}
          </h3>
          {snapshot && snapshot.models.length > 0 && (
            <button
              className="btn btn-ghost"
              onClick={onVerify}
              disabled={verifying}
              title="Re-hash every downloaded model against its recorded checksum. Files that no longer match are quarantined (renamed aside)."
            >
              {verifying ? 'Verifying…' : 'Verify files'}
            </button>
          )}
        </div>
        {!snapshot && !error && (
          <SectionLoading label="Scanning models on disk…" />
        )}
        {snapshot?.models.length === 0 && (
          <div className="empty-state">No models downloaded yet.</div>
        )}
        {snapshot?.models.map((m) => (
          <div key={m.path} className="model-row">
            <div className="model-info">
              <div className="model-name">
                {m.name} <VerificationBadge state={m.verification} />
              </div>
              <div className="model-meta">
                {formatBytes(m.sizeBytes)} ·{' '}
                <span className="path-code">{m.path}</span>
              </div>
            </div>
            <div className="row-actions">
              <button
                className="btn btn-ghost"
                onClick={() =>
                  openInExplorer(m.path).catch((e) =>
                    setActionError(e instanceof Error ? e.message : String(e)),
                  )
                }
                title="Show in file explorer"
              >
                Reveal
              </button>
              <button
                className="btn btn-ghost btn-danger"
                onClick={async () => {
                  if (
                    await requestConfirm({
                      title: `Delete ${m.name}?`,
                      body: 'This removes the model file from disk.',
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                  ) {
                    onAction(() => models.delete(m.name));
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </section>

      {finished.length > 0 && (
        <section className="model-section">
          <h3 className="section-title">Recent downloads</h3>
          {finished.slice(0, 10).map((d) => (
            <DownloadRow key={d.id} dl={d} />
          ))}
        </section>
      )}
    </div>
  );
}

/// Inline per-section loading indicator: the page paints instantly and each
/// data section shows its own spinner until its fetch lands, instead of the
/// whole panel sitting blank while the (potentially slow) disk scan runs.
function SectionLoading({ label }: { label: string }) {
  return (
    <div className="section-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

interface RowProps {
  dl: DownloadProgress;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}

function DownloadRow({ dl, onPause, onResume, onCancel }: RowProps) {
  const { confirm: requestConfirm } = useConfirm();
  const pct =
    dl.bytesTotal && dl.bytesTotal > 0
      ? Math.min(100, (dl.bytesDownloaded / dl.bytesTotal) * 100)
      : 0;
  const indeterminate =
    dl.status === 'active' && (!dl.bytesTotal || dl.bytesTotal === 0);
  return (
    <div className={`dl-row dl-${dl.status}`}>
      <div className="dl-head">
        <span className="dl-name">{dl.filename}</span>
        <DownloadStatusBadge status={dl.status} />
      </div>
      <div className="dl-meta">
        <code className="path-code">{dl.destPath}</code>
      </div>
      <div className="dl-meta">
        {formatBytes(dl.bytesDownloaded)} /{' '}
        {dl.bytesTotal ? formatBytes(dl.bytesTotal) : 'unknown size'}
        {dl.status === 'active' && dl.speedBps != null && (
          <> · <span className="speed">{formatSpeed(dl.speedBps)}</span></>
        )}
        {dl.status === 'active' && dl.etaSecs != null && (
          <> · {formatEta(dl.etaSecs)}</>
        )}
        {dl.finishedAt && <> · finished {formatTimestamp(dl.finishedAt)}</>}
        {dl.verified === true && (
          <> · <span title={`sha256 ${dl.sha256 ?? ''}`}>checksum verified</span></>
        )}
        {dl.status === 'active' && dl.expectedSha256 && (
          <> · <span title={`Will refuse to install unless it hashes to sha256 ${dl.expectedSha256}`}>pinned</span></>
        )}
        {dl.resumable === false && (
          <> · <span className="warn">no resume support</span></>
        )}
      </div>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label={`${dl.filename} download`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(pct)}
        aria-valuetext={indeterminate ? 'downloading' : undefined}
      >
        <div
          className={`progress-fill ${indeterminate ? 'progress-indet' : ''}`}
          style={{ width: indeterminate ? '40%' : `${pct}%` }}
        />
      </div>
      {dl.error && (
        <div className="dl-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {dl.error}
        </div>
      )}
      <div className="dl-actions">
        {dl.status === 'active' && onPause && (
          <button className="btn-tiny" onClick={onPause}>
            Pause
          </button>
        )}
        {(dl.status === 'paused' || dl.status === 'failed') && onResume && (
          <button className="btn-tiny" onClick={onResume}>
            {/* Non-resumable failures restart from 0 (the server refuses Range), so
                label it "Restart" to match the "no resume support" warning above —
                but keep the button: it's the only one-click recovery path. */}
            {dl.resumable === false ? 'Restart' : 'Resume'}
          </button>
        )}
        {['active', 'queued', 'paused', 'failed'].includes(dl.status) &&
          onCancel && (
            <button
              className="btn-tiny btn-danger"
              onClick={async () => {
                if (
                  await requestConfirm({
                    title: `Cancel ${dl.filename}?`,
                    body: 'Partial data will be discarded.',
                    confirmLabel: 'Cancel download',
                    danger: true,
                  })
                ) {
                  onCancel();
                }
              }}
            >
              Cancel
            </button>
          )}
      </div>
    </div>
  );
}

/**
 * On-disk integrity badge (MODEL-001). "verified" is the cheap list-time
 * check (recorded digest exists + size unchanged); "modified" means the
 * bytes drifted since install — run Verify files (or re-download) before
 * trusting it; unverified files simply have nothing recorded to check.
 */
function VerificationBadge({
  state,
}: {
  state: 'verified' | 'modified' | 'unverified';
}) {
  if (state === 'verified') {
    return (
      <span className="badge badge-ok" title="Checksum recorded at install; size unchanged since.">
        verified
      </span>
    );
  }
  if (state === 'modified') {
    return (
      <span
        className="badge badge-err"
        title="This file changed since it was downloaded — its recorded checksum no longer describes it. Run 'Verify files' or re-download."
      >
        modified
      </span>
    );
  }
  return (
    <span
      className="badge badge-neutral"
      title="No recorded checksum (downloaded before verification existed, or copied in by hand)."
    >
      unverified
    </span>
  );
}

function DownloadStatusBadge({ status }: { status: DownloadStatus }) {
  const cls =
    status === 'completed'
      ? 'badge-ok'
      : status === 'failed' || status === 'cancelled'
        ? 'badge-err'
        : status === 'paused'
          ? 'badge-neutral'
          : 'badge-pending';
  return <span className={`badge ${cls}`}>{status}</span>;
}
