import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appConfig,
  openExternal,
  openInExplorer,
  services,
  type GpuInfo,
  type ServiceSnapshot,
  type ServiceStatus,
  type ServiceTemplateInput,
} from './api';
import AiProvidersPanel from './AiProvidersPanel';
import { useConfirm } from './ConfirmDialog';
import { AlertTriangleIcon, DownloadIcon, TrashIcon, UploadIcon, XIcon } from './Icons';
import LogsViewer from './LogsViewer';
import { refreshServices, useServicesStore } from './servicesStore';
import {
  composeEngineArgs,
  parseEngineArgs,
  STT_ENGINE_FLAGS,
  TTS_ENGINE_FLAGS,
  type EngineFlagSpec,
} from './speechEngineArgs';
import { useToast } from './Toasts';

/**
 * Services panel — list every template, surface status, and offer
 * install / start / stop / logs actions per row.
 *
 * SRV-002/SRV-004: data comes from the SHARED services store (instant paint
 * from the cached snapshot on every visit + background revalidation), the
 * header shows live status counts, search, and snapshot freshness/build
 * instrumentation, cold start renders skeleton cards, and logs open in a
 * slide-over drawer instead of accordioning the list.
 */
export default function ServicesPanel() {
  const { snapshot, error, refreshing, lastFetchedAt } = useServicesStore();
  const [logsId, setLogsId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [filter, setFilter] = useState('');
  // Per-service ids with an action in flight — disables that row's buttons so a
  // double-click can't fire duplicate start/stop/install/delete requests.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement>(null);

  const toast = useToast();
  const { confirm: requestConfirm } = useConfirm();
  // Track previous status per service so we fire toasts on transition,
  // not every snapshot. The first snapshot seen by THIS mount seeds the map
  // silently (no toast spam for pre-existing states — including the cached
  // snapshot the shared store hands us instantly on a revisit).
  const seenStatusRef = useRef<Map<string, ServiceStatus>>(new Map());
  const firstPollRef = useRef(true);
  const cancelledInstallIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!snapshot) return;
    const seen = seenStatusRef.current;
    const firstPoll = firstPollRef.current;
    for (const svc of snapshot.services) {
      const prev = seen.get(svc.id);
      if (prev !== svc.status && !firstPoll && prev !== undefined) {
        if (svc.status === 'errored') {
          toast.push({
            kind: 'error',
            title: `${svc.name} errored`,
            body: svc.error ?? undefined,
            timeoutMs: 8000,
          });
        } else if (svc.status === 'running' && prev !== 'running') {
          toast.push({
            kind: 'success',
            title: `${svc.name} is running`,
            body: `port ${svc.port}`,
          });
        } else if (svc.status === 'stopped' && prev === 'installing') {
          const cancelled = cancelledInstallIdsRef.current.delete(svc.id);
          if (!svc.installed || cancelled) {
            seen.set(svc.id, svc.status);
            continue;
          }
          toast.push({
            kind: 'success',
            title: `${svc.name} installed`,
            body: 'Click Start to launch it.',
          });
        }
      }
      seen.set(svc.id, svc.status);
    }
    firstPollRef.current = false;
  }, [snapshot, toast]);

  const refresh = useCallback(() => refreshServices(), []);

  // Esc closes the logs drawer.
  useEffect(() => {
    if (!logsId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogsId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logsId]);

  const runAction = useCallback(
    async (fn: () => Promise<void>, key?: string) => {
      setActionError(null);
      if (key) setPendingIds((p) => new Set(p).add(key));
      try {
        await fn();
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        if (key) {
          setPendingIds((p) => {
            const n = new Set(p);
            n.delete(key);
            return n;
          });
        }
      }
    },
    [refresh],
  );

  // Import a self-contained service package (a .json with template + bundled
  // `files`). POSTs to /api/services, which materializes the scripts so it's
  // immediately installable — no recompile.
  const importPackage = useCallback(
    async (file: File) => {
      setActionError(null);
      try {
        // Bound the file before reading/parsing — a service package is small (template
        // + a few scripts); reject an oversized blob with a clear error instead of
        // buffering + parsing hundreds of MB.
        const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
        if (file.size > MAX_PACKAGE_BYTES) {
          throw new Error(`File too large (${Math.round(file.size / 1048576)} MB; max 16 MB).`);
        }
        const pkg = JSON.parse(await file.text());
        if (!pkg || typeof pkg !== 'object' || !pkg.id || !pkg.run) {
          throw new Error('Not a service package (missing id/run).');
        }
        await services.import(pkg);
        await refresh();
        toast.push({
          kind: 'success',
          title: `Imported "${pkg.name ?? pkg.id}"`,
          body: 'Run Install (if it needs it), then Start.',
        });
      } catch (e) {
        setActionError(
          `Import failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [refresh, toast],
  );

  // Export a service to a downloadable, shareable package .json.
  const exportPackage = useCallback(async (id: string, name: string) => {
    setActionError(null);
    try {
      const pkg = await services.export(id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}.formlogic-service.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.push({
        kind: 'success',
        title: `Exported "${name}"`,
        body: `${id}.formlogic-service.json — share it; import on any machine.`,
      });
    } catch (e) {
      setActionError(
        `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [toast]);

  // Group by category for cleaner sectioning, after the search filter.
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (s: ServiceSnapshot) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q);
    const map = new Map<string, ServiceSnapshot[]>();
    for (const s of snapshot?.services ?? []) {
      if (!match(s)) continue;
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [snapshot, filter]);

  // SRV-004 summary counts (from the UNFILTERED snapshot — the chips describe
  // the machine, not the current search).
  const counts = useMemo(() => {
    const c = { running: 0, stopped: 0, errored: 0, busy: 0 };
    for (const s of snapshot?.services ?? []) {
      if (s.status === 'running') c.running += 1;
      else if (s.status === 'errored') c.errored += 1;
      else if (s.status === 'installing' || s.status === 'starting') c.busy += 1;
      else c.stopped += 1;
    }
    return c;
  }, [snapshot]);

  const logsService = logsId
    ? snapshot?.services.find((s) => s.id === logsId) ?? null
    : null;
  // Stable loader per service id — LogsViewer restarts its poll effect when
  // the `load` identity changes, so an inline lambda would reset it on every
  // 2 s store update.
  const loadLogs = useMemo(
    () => (logsId ? () => services.logs(logsId, 200) : null),
    [logsId],
  );
  // Snapshot freshness: with a 2 s poll anything over ~3 missed polls is
  // worth flagging as stale (backend down / tab was hidden).
  const ageSecs = lastFetchedAt ? Math.round((Date.now() - lastFetchedAt) / 1000) : null;
  const stale = ageSecs !== null && ageSecs > 6;

  return (
    <div className="panel">
      {error && (
        <div className="banner banner-err">
          Couldn't reach the FormLogic Desktop API: {error}
          {snapshot && ' — showing the last known state.'}
        </div>
      )}
      {snapshot && (
        <div className="services-summary">
          <div className="services-summary-chips">
            <span className="summary-chip summary-chip-ok">{counts.running} running</span>
            <span className="summary-chip summary-chip-neutral">{counts.stopped} stopped</span>
            {counts.busy > 0 && (
              <span className="summary-chip summary-chip-pending">{counts.busy} busy</span>
            )}
            {counts.errored > 0 && (
              <span className="summary-chip summary-chip-err">{counts.errored} errored</span>
            )}
          </div>
          <input
            type="search"
            className="services-search"
            placeholder="Filter services…"
            aria-label="Filter services"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span
            className={`services-freshness${stale ? ' services-freshness-stale' : ''}`}
            title={
              snapshot.generatedAt
                ? `Snapshot built ${new Date(snapshot.generatedAt).toLocaleTimeString()} in ${
                    snapshot.buildMs?.toFixed(2) ?? '?'
                  } ms (revision ${snapshot.revision ?? '?'})`
                : undefined
            }
          >
            {refreshing ? 'refreshing…' : stale ? `stale (${ageSecs}s)` : 'live'}
            {snapshot.buildMs !== undefined && (
              <span className="services-buildms"> · built in {snapshot.buildMs.toFixed(1)} ms</span>
            )}
          </span>
        </div>
      )}
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
      {snapshot && (
        <div className="datadir-note">
          Service configs + scripts live under{' '}
          <code>{snapshot.dataDir}</code>.{' '}
          <button
            className="btn-tiny"
            onClick={() =>
              openInExplorer(snapshot.dataDir).catch((e) =>
                setActionError(e instanceof Error ? e.message : String(e)),
              )
            }
            title="Open data folder in file explorer"
          >
            open
          </button>{' '}
          Services are plug-and-play: drop a package <code>*.json</code> into{' '}
          <code>templates/</code> (or use <strong>Import package</strong> below)
          to register one without rebuilding. A package can bundle its own
          scripts in a <code>"files"</code> map, so a single JSON is everything
          needed to install + run it — <strong>Export</strong> any service to
          get one.
        </div>
      )}
      {grouped.length === 0 && snapshot && !error && (
        <div className="empty-state">
          {filter.trim()
            ? 'No services match the filter.'
            : 'No service templates loaded. Built-ins should appear on first run — if you just installed FormLogic Desktop, try restarting it.'}
        </div>
      )}
      {!snapshot && !error && (
        // SRV-004: stable skeleton rows on a true cold start (no cached
        // snapshot yet) — never a bare text line, and no layout shift when
        // the data arrives.
        <section className="service-section" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="service-card service-skeleton">
              <div className="skeleton-line skeleton-line-title" />
              <div className="skeleton-line skeleton-line-body" />
            </div>
          ))}
        </section>
      )}
      {/* SRV-004/AI-407: local processes are grouped by category; external AI
          endpoints are a semantically-distinct group (no pid/logs — health is
          a reachability probe). Rendered below the local services. */}
      {grouped.map(([category, svcs]) => (
        <section key={category} className="service-section">
          <h3 className="section-title">Local processes · {category}</h3>
          {svcs.map((svc) => (
            <ServiceCard
              key={svc.id}
              service={svc}
              logsOpen={logsId === svc.id}
              pending={pendingIds.has(svc.id)}
              onToggleLogs={() => setLogsId(logsId === svc.id ? null : svc.id)}
              onStart={() => runAction(() => services.start(svc.id), svc.id)}
              onStop={() => runAction(() => services.stop(svc.id), svc.id)}
              onRepair={() => runAction(() => services.repair(svc.id), svc.id)}
              onAutostart={(policy) =>
                runAction(() => services.setAutostart(svc.id, policy), svc.id)
              }
              onInstall={() =>
                runAction(async () => {
                  cancelledInstallIdsRef.current.delete(svc.id);
                  await services.install(svc.id);
                }, svc.id)
              }
              onUninstall={async () => {
                if (
                  await requestConfirm({
                    title: `Uninstall "${svc.name}"?`,
                    body: 'This removes its installed files (binaries) so you can reinstall cleanly. Your models and flows are not touched.',
                    confirmLabel: 'Uninstall',
                    danger: true,
                  })
                ) {
                  runAction(async () => {
                    const r = await services.uninstall(svc.id);
                    toast.push({
                      kind: 'success',
                      title: `Uninstalled "${svc.name}"`,
                      body: `Removed ${r.removed} file(s) — click Install to reinstall.`,
                    });
                  }, svc.id);
                }
              }}
              onCancelInstall={() =>
                runAction(async () => {
                  await services.cancelInstall(svc.id);
                  cancelledInstallIdsRef.current.add(svc.id);
                }, svc.id)
              }
              onExport={() => exportPackage(svc.id, svc.name)}
              onDelete={async () => {
                if (
                  await requestConfirm({
                    title: `Remove "${svc.name}"?`,
                    body: 'The on-disk service template JSON will be deleted too.',
                    confirmLabel: 'Remove',
                    danger: true,
                  })
                ) {
                  runAction(() => services.delete(svc.id), svc.id);
                }
              }}
            />
          ))}
        </section>
      ))}

      {/* AI-407: external AI endpoints. Only render once the local-services
          snapshot exists so a cold API failure doesn't show a half page. */}
      {snapshot && <AiProvidersPanel />}

      <section className="service-section">
        {showAddForm ? (
          <AddServiceForm
            onCancel={() => setShowAddForm(false)}
            onSaved={() => {
              setShowAddForm(false);
              refresh();
              toast.push({
                kind: 'success',
                title: 'Custom service added',
                body: 'Click Start to launch it.',
              });
            }}
            onError={(msg) => setActionError(msg)}
          />
        ) : (
          <div className="inline-actions">
            <button
              className="btn btn-secondary"
              onClick={() => setShowAddForm(true)}
            >
              + Add custom service
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => importInputRef.current?.click()}
              title="Import a self-contained service package (.json with bundled scripts)"
            >
              <span className="icon-button-label">
                <DownloadIcon size={14} />
                Import package
              </span>
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importPackage(f);
                e.currentTarget.value = '';
              }}
            />
          </div>
        )}
      </section>

      {/* SRV-004: logs open in a slide-over drawer (no accordion jumping the
          card list around). Esc, the scrim, or the viewer's close all exit. */}
      {logsService && loadLogs && (
        <div
          className="drawer-scrim"
          onClick={() => setLogsId(null)}
          role="presentation"
        >
          <div
            className="logs-drawer"
            role="dialog"
            aria-label={`${logsService.name} logs`}
            onClick={(e) => e.stopPropagation()}
          >
            <LogsViewer
              load={loadLogs}
              title={`${logsService.name} · logs`}
              onClose={() => setLogsId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface AddFormProps {
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}

/**
 * Minimal "register a custom service" form. The most common use case is
 * "my Python script speaks HTTP on port X — make it manageable from
 * here". The full template surface is richer (env vars, install scripts,
 * health-check URL) — users with bigger needs edit the JSON directly.
 * This form is the 80% common case.
 */
function AddServiceForm({ onCancel, onSaved, onError }: AddFormProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Custom');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [port, setPort] = useState(8000);
  const [healthUrl, setHealthUrl] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const template: ServiceTemplateInput = {
      id: id.trim().toLowerCase(),
      name: name.trim() || id.trim(),
      description: description.trim() || `Custom service: ${command}`,
      category: category.trim() || 'Custom',
      defaultPort: port,
      install: { kind: 'none' },
      run: {
        command: command.trim(),
        // Split args on whitespace, preserving placeholder tokens like ${port}.
        // Users with quoted args can edit the JSON afterwards.
        args: argsText.split(/\s+/).filter(Boolean),
        env: {},
      },
      health: healthUrl.trim()
        ? { url: healthUrl.trim(), timeoutSecs: 10 }
        : undefined,
    };
    try {
      await services.add(template);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <form className="dl-form" onSubmit={onSubmit}>
      <div className="section-title-row">
        <h3 className="section-title">Add custom service</h3>
        <button type="button" className="btn-tiny" onClick={onCancel}>
          cancel
        </button>
      </div>
      <div className="form-row-pair">
        <label className="form-row">
          <span>ID (lowercase, no spaces)</span>
          <input
            type="text"
            placeholder="my-server"
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
          />
        </label>
        <label className="form-row">
          <span>Display name</span>
          <input
            type="text"
            placeholder="My Server"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      <label className="form-row">
        <span>Description</span>
        <input
          type="text"
          placeholder="Short blurb shown in the list"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="form-row-pair">
        <label className="form-row">
          <span>Category</span>
          <input
            type="text"
            placeholder="LLM / Image / Custom"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
        <label className="form-row">
          <span>Default port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 0)}
          />
        </label>
      </div>
      <label className="form-row">
        <span>Command (executable or path)</span>
        <input
          type="text"
          placeholder="python or C:\\path\\to\\app.exe"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          required
        />
      </label>
      <label className="form-row">
        <span>
          Arguments (space-separated; use{' '}
          <code>${'{port}'}</code>, <code>${'{modelsDir}'}</code> placeholders)
        </span>
        <input
          type="text"
          placeholder="-m my_module --port ${port}"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
        />
      </label>
      <label className="form-row">
        <span>Health-check URL (optional)</span>
        <input
          type="text"
          placeholder="http://127.0.0.1:${port}/health"
          value={healthUrl}
          onChange={(e) => setHealthUrl(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!id || !command}>
          Add service
        </button>
        <span className="form-hint">
          Saves to <code className="path-code-small">templates/&lt;id&gt;.json</code>
          {' '}— editable on disk afterwards for env vars, install scripts, etc.
        </span>
      </div>
    </form>
  );
}

interface CardProps {
  service: ServiceSnapshot;
  /** This service's logs drawer is open (highlights the button). */
  logsOpen: boolean;
  /** An action for this service is in flight — disable its buttons. */
  pending: boolean;
  onToggleLogs: () => void;
  onStart: () => void;
  onStop: () => void;
  /** PROC-001: reset crash-loop state + stale processes, then start fresh. */
  onRepair: () => void;
  /** PROC-001: persist the boot-autostart policy. */
  onAutostart: (policy: 'auto' | 'always' | 'never') => void;
  onInstall: () => void;
  onUninstall: () => void;
  onCancelInstall: () => void;
  onExport: () => void;
  onDelete: () => void;
}

// The GPU list is machine-global — fetch it once and cache so every card's picker shares it
// (avoids one nvidia-smi per card).
let gpusCache: GpuInfo[] | null = null;
let gpusPromise: Promise<GpuInfo[]> | null = null;
function useGpus(): GpuInfo[] {
  const [gpus, setGpus] = useState<GpuInfo[]>(gpusCache ?? []);
  useEffect(() => {
    if (gpusCache) return;
    if (!gpusPromise) gpusPromise = appConfig.listGpus().catch(() => [] as GpuInfo[]);
    let alive = true;
    void gpusPromise.then((g) => {
      gpusCache = g;
      if (alive) setGpus(g);
    });
    return () => {
      alive = false;
    };
  }, []);
  return gpus;
}

/** Split an args line into spawn-vector entries: whitespace-separated, with
 *  double-quote grouping so paths with spaces survive
 *  (`--model "C:\models with spaces\x.gguf"`). */
function splitArgsLine(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * Extra launch arguments — the generic per-service tuning lever: `-t 16
 * --parallel 2 -ngl 99` on llama-cpp, any flag on a custom service — WITHOUT
 * editing the template JSON (a hand-edited template opts itself out of future
 * built-in template updates). Appended after the template args at spawn;
 * applies on the next start.
 */
function ExtraArgsEditor({ service }: { service: ServiceSnapshot }) {
  const toast = useToast();
  const saved = (service.extraArgs ?? []).join(' ');
  const [value, setValue] = useState(saved);
  const [savedBase, setSavedBase] = useState(saved);
  const [pending, setPending] = useState(false);
  // Re-seed when another window/session changed the persisted value — but
  // never while the user is mid-edit (their draft differs from OUR baseline).
  useEffect(() => {
    setSavedBase((prevBase) => {
      if (saved !== prevBase) {
        setValue((v) => (v === prevBase ? saved : v));
        return saved;
      }
      return prevBase;
    });
  }, [saved]);
  const dirty = value.trim() !== savedBase.trim();
  const apply = async () => {
    setPending(true);
    try {
      const args = splitArgsLine(value.trim());
      await services.setExtraArgs(service.id, args);
      setSavedBase(args.join(' '));
      setValue(args.join(' '));
      await refreshServices();
      toast.push({
        kind: 'success',
        title: `${service.name}: extra arguments saved`,
        body:
          service.status === 'running' || service.status === 'starting'
            ? 'Applies on the next start — restart the service to pick them up.'
            : 'Applies on the next start.',
      });
    } catch (e) {
      toast.push({
        kind: 'error',
        title: 'Could not save extra arguments',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="service-config-row">
      <span className="service-config-label">Extra args</span>
      <input
        className="service-config-control-wide"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          service.id === 'llama-cpp'
            ? 'e.g. -t 16 --parallel 2 -ngl 99'
            : 'extra launch arguments (optional)'
        }
      />
      {dirty && (
        <button className="btn btn-ghost" onClick={apply} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      )}
      <span className="service-config-note">appended at launch · applies on next start</span>
    </div>
  );
}

/** Engine choices per split speech service (value '' = the service default —
 *  the flag is removed from the extra args entirely). */
const SPEECH_ENGINE_OPTIONS: Record<
  string,
  { spec: EngineFlagSpec; dirLabel: string; options: { value: string; label: string }[] }
> = {
  'aokie-stt': {
    spec: STT_ENGINE_FLAGS,
    dirLabel: 'Model folder (optional)',
    options: [
      { value: '', label: 'Default (Parakeet)' },
      { value: 'parakeet', label: 'Parakeet — NVIDIA ONNX (accurate)' },
      { value: 'moonshine', label: 'Moonshine — small & fast' },
      { value: 'qwen3-asr', label: 'Qwen3-ASR' },
    ],
  },
  'aokie-tts': {
    spec: TTS_ENGINE_FLAGS,
    dirLabel: 'Voice model folder (optional)',
    options: [
      { value: '', label: 'Default (Pocket-TTS)' },
      { value: 'pocket', label: 'Pocket-TTS — expressive (slower)' },
      { value: 'sherpa', label: 'Sherpa — Piper/VITS voices (fast)' },
    ],
  },
};

/**
 * Structured engine config for the split speech services (aokie-stt /
 * aokie-tts): an Engine select + model-folder input that COMPOSE the same
 * saved extra-args array the raw editor below edits (`--stt-engine X
 * --stt-model-dir DIR` resp. `--tts-*`) — one persistence lane, two views.
 * Any other user tokens in the extra args are preserved verbatim.
 */
function SpeechEngineConfig({ service }: { service: ServiceSnapshot }) {
  const conf = SPEECH_ENGINE_OPTIONS[service.id];
  const toast = useToast();
  const saved = useMemo(
    () => parseEngineArgs(service.extraArgs ?? [], conf.spec),
    [service.extraArgs, conf.spec],
  );
  const [engine, setEngine] = useState(saved.engine);
  const [modelDir, setModelDir] = useState(saved.modelDir);
  const [base, setBase] = useState({ engine: saved.engine, modelDir: saved.modelDir });
  const [pending, setPending] = useState(false);
  // Re-seed when another window/session changed the persisted args — but never
  // while the user is mid-edit (their draft differs from OUR baseline).
  useEffect(() => {
    setBase((prev) => {
      if (saved.engine !== prev.engine || saved.modelDir !== prev.modelDir) {
        setEngine((e) => (e === prev.engine ? saved.engine : e));
        setModelDir((d) => (d === prev.modelDir ? saved.modelDir : d));
        return { engine: saved.engine, modelDir: saved.modelDir };
      }
      return prev;
    });
  }, [saved.engine, saved.modelDir]);
  const dirty = engine !== base.engine || modelDir.trim() !== base.modelDir.trim();
  // A hand-typed engine we don't list (raw extra-args lane) still renders as a
  // matching option so the controlled select doesn't silently misreport it.
  const unknownEngine =
    engine !== '' && !conf.options.some((o) => o.value === engine) ? engine : null;
  const apply = async () => {
    setPending(true);
    try {
      const args = composeEngineArgs(service.extraArgs ?? [], conf.spec, engine, modelDir);
      await services.setExtraArgs(service.id, args);
      const next = parseEngineArgs(args, conf.spec);
      setBase({ engine: next.engine, modelDir: next.modelDir });
      setEngine(next.engine);
      setModelDir(next.modelDir);
      await refreshServices();
      toast.push({
        kind: 'success',
        title: `${service.name}: engine settings saved`,
        body:
          service.status === 'running' || service.status === 'starting'
            ? 'Applies on the next start — restart the service to pick them up.'
            : 'Applies on the next start.',
      });
    } catch (e) {
      toast.push({
        kind: 'error',
        title: 'Could not save engine settings',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="service-config-row">
        <span className="service-config-label">Engine</span>
        <select
          className="service-config-control"
          value={engine}
          disabled={pending}
          onChange={(e) => setEngine(e.target.value)}
        >
          {conf.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {unknownEngine && <option value={unknownEngine}>{unknownEngine} (custom)</option>}
        </select>
        <span className="service-config-note">applies on next start</span>
      </div>
      <div className="service-config-row">
        <span className="service-config-label">{conf.dirLabel}</span>
        <input
          className="service-config-control-wide"
          type="text"
          spellCheck={false}
          value={modelDir}
          disabled={pending}
          onChange={(e) => setModelDir(e.target.value)}
          placeholder="blank = the bundled/default model location"
        />
        {dirty && (
          <button className="btn btn-ghost" onClick={apply} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Per-service GPU picker. Pins the service to a CUDA GPU (CUDA_VISIBLE_DEVICES) so heavy
 * services don't all default to GPU 0 and exhaust its VRAM — e.g. put llama.cpp on GPU 1 so
 * krea2 keeps GPU 0. Hidden when fewer than 2 GPUs. Applies on the service's next start.
 */
function GpuSelector({ serviceId, currentGpu }: { serviceId: string; currentGpu: number | null }) {
  const gpus = useGpus();
  const [value, setValue] = useState<string>(currentGpu == null ? '' : String(currentGpu));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue(currentGpu == null ? '' : String(currentGpu));
  }, [currentGpu]);
  // Hide the picker when there's no meaningful choice (0/1 GPU) — UNLESS a pin is already
  // set, so a stale pin left over from a removed card stays visible and can be cleared
  // (selecting "Auto" calls setServiceGpu(id, null)).
  if (gpus.length < 2 && currentGpu == null) return null;
  // If the pin points at an index not among the detected GPUs (card removed / re-enumerated),
  // surface it as an explicit "unavailable" option so the controlled value matches and the
  // user can switch back to Auto to clear it.
  const pinnedMissing = currentGpu != null && !gpus.some((g) => g.index === currentGpu);
  return (
    <div className="service-config-row">
      <label className="service-config-label">GPU</label>
      <select
        value={value}
        disabled={pending}
        onChange={async (e) => {
          const v = e.target.value;
          const prev = value;
          setValue(v);
          setError(null);
          setPending(true);
          try {
            await appConfig.setServiceGpu(serviceId, v === '' ? null : Number(v));
          } catch (err) {
            // Persist failed — roll the optimistic value back (the 2s poll won't revert it,
            // since the backend value is unchanged) and surface the error like the sibling
            // model selectors do.
            setValue(prev);
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setPending(false);
          }
        }}
        className="service-config-control"
      >
        <option value="">Auto (default placement)</option>
        {gpus.map((g) => (
          <option key={g.index} value={g.index}>
            GPU {g.index} — {g.name}
          </option>
        ))}
        {pinnedMissing && (
          <option value={String(currentGpu)}>GPU {currentGpu} (unavailable)</option>
        )}
      </select>
      <span className="service-config-note">applies on next start</span>
      {error && (
        <span className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Model selector for single-model servers (llama.cpp). Lists the GGUFs found
 * across the model folders and lets the user pick one — or type a custom path.
 * The choice persists (companion-config `llamaModel`) and applies the next time
 * the service starts, so it's safe to change while stopped (the normal
 * "load on flow demand" case). A running service needs a restart to swap models.
 */
function LlamaModelSelector({ running }: { running: boolean }) {
  const [models, setModels] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>(''); // '' = default model.gguf
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mmproj, setMmproj] = useState<string>(''); // '' = none (text-only)

  useEffect(() => {
    let alive = true;
    Promise.all([appConfig.listGgufModels(), appConfig.get()])
      .then(([list, cfg]) => {
        if (!alive) return;
        setModels(list);
        const sel = cfg.llamaModel ?? '';
        setCurrent(sel);
        setMmproj(cfg.llamaMmproj ?? '');
        if (sel && !list.includes(sel)) {
          setCustomMode(true);
          setCustomPath(sel);
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const apply = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await appConfig.setLlamaModel(path);
      setCurrent(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPick = (val: string) => {
    if (val === '__custom__') {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    void apply(val); // '' resets to the default model.gguf
  };

  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;

  return (
    <div className="llama-model service-config-row">
      <span className="service-config-label">Model</span>
      {customMode ? (
        <>
          <input
            type="text"
            spellCheck={false}
            placeholder="C:\path\to\model.gguf"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            className="service-config-control-wide"
          />
          <button
            className="btn btn-secondary"
            disabled={busy || !customPath.trim()}
            onClick={() => void apply(customPath.trim())}
          >
            Set
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setError(null);
              // Only leave custom mode if a discovered model is selected; a
              // configured custom path isn't in the dropdown, so falling back to
              // the disabled placeholder would falsely read "no model selected".
              setCustomMode(!!current && !models.includes(current));
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <select
          value={models.includes(current) ? current : ''}
          disabled={busy}
          onChange={(e) => onPick(e.target.value)}
        >
          <option value="" disabled>
            — Select a model —
          </option>
          {models.map((m) => (
            <option key={m} value={m}>
              {baseName(m)}
            </option>
          ))}
          <option value="__custom__">Custom path…</option>
        </select>
      )}
      <span className="service-config-note">
        {!current && !customMode
          ? "Pick a model — the service has no default and won't start without one."
          : running
            ? 'Restart the service to load a different model.'
            : 'Loads when a flow starts the service.'}
      </span>
      {error && (
        <span className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </span>
      )}
      {/* Optional multimodal projector: shown once a GGUF is picked. Audio/
          vision GGUFs (Gemma 4 E2B class) need their mmproj loaded via
          --mmproj before llama-server accepts input_audio/image parts; leave
          "None" for ordinary text models. */}
      {(current || customPath).toLowerCase().endsWith('.gguf') && (
        <MmprojSelector
          models={models}
          value={mmproj}
          running={running}
          onChange={async (path) => {
            setError(null);
            try {
              await appConfig.setLlamaMmproj(path);
              setMmproj(path);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Optional mmproj (multimodal projector) picker for the llama service - the
 * companion appends `--mmproj <path>` at spawn when set. Candidates are the
 * discovered GGUFs whose filename mentions "mmproj"; anything else via the
 * custom path. Clearing returns the model to text-only.
 */
function MmprojSelector({
  models,
  value,
  running,
  onChange,
}: {
  models: string[];
  value: string;
  running: boolean;
  onChange: (path: string) => void | Promise<void>;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
  const candidates = models.filter((m) => baseName(m).toLowerCase().includes('mmproj'));
  useEffect(() => {
    if (value && !candidates.includes(value)) {
      setCustomMode(true);
      setCustomPath(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="llama-model service-config-row">
      <span className="service-config-label">Projector (mmproj)</span>
      {customMode ? (
        <>
          <input
            type="text"
            spellCheck={false}
            placeholder="C:\\path\\to\\mmproj.gguf"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            className="service-config-control-wide"
          />
          <button
            className="btn btn-secondary"
            disabled={!customPath.trim()}
            onClick={() => void onChange(customPath.trim())}
          >
            Set
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setCustomMode(false);
              setCustomPath('');
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <select
          value={candidates.includes(value) ? value : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__custom__') {
              setCustomMode(true);
              return;
            }
            void onChange(v); // '' = clear -> text-only
          }}
        >
          <option value="">None (text-only)</option>
          {candidates.map((m) => (
            <option key={m} value={m}>
              {baseName(m)}
            </option>
          ))}
          <option value="__custom__">Custom path…</option>
        </select>
      )}
      <span className="service-config-note">
        {value
          ? running
            ? 'Loaded via --mmproj. Restart the service to apply a change.'
            : 'Loads via --mmproj - enables audio/vision input for capable models.'
          : 'Optional: pick this model matching mmproj file to enable audio/vision input.'}
      </span>
    </div>
  );
}

/**
 * Model selector for multi-model servers (Ollama). Lists the models PULLED into
 * the running Ollama server (its /api/tags) and lets the user pick one — or type
 * a name they've pulled. The choice is the model NAME sent in each request,
 * persisted to companion-config `ollamaModel` and applied on the next flow run
 * (no restart). Empty = the pre-pulled default (qwen2.5:0.5b).
 */
function OllamaModelSelector() {
  const [models, setModels] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>(''); // '' = default
  const [customMode, setCustomMode] = useState(false);
  const [customName, setCustomName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      appConfig.listOllamaModels().catch(() => [] as string[]),
      appConfig.get(),
    ])
      .then(([list, cfg]) => {
        if (!alive) return;
        setModels(list);
        const sel = cfg.ollamaModel ?? '';
        setCurrent(sel);
        if (sel && !list.includes(sel)) {
          setCustomMode(true);
          setCustomName(sel);
        }
        if (list.length === 0) {
          setNote('Start Ollama (or pull a model) to list pulled models — or type a name.');
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const apply = async (model: string) => {
    setBusy(true);
    setError(null);
    try {
      await appConfig.setOllamaModel(model);
      setCurrent(model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPick = (val: string) => {
    if (val === '__custom__') {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    void apply(val); // '' resets to the default
  };

  return (
    <div className="ollama-model service-config-row">
      <span className="service-config-label">Model</span>
      {customMode ? (
        <>
          <input
            type="text"
            spellCheck={false}
            placeholder="e.g. llama3.1:8b"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            className="service-config-control-medium"
          />
          <button
            className="btn btn-secondary"
            disabled={busy || !customName.trim()}
            onClick={() => void apply(customName.trim())}
          >
            Set
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setError(null);
              setCustomMode(!!current && !models.includes(current));
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <select
          value={models.includes(current) ? current : ''}
          disabled={busy}
          onChange={(e) => onPick(e.target.value)}
        >
          <option value="">Default (qwen2.5:0.5b)</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="__custom__">Custom name…</option>
        </select>
      )}
      <span className="service-config-note">
        {current ? `Sends model "${current}".` : 'Sends the default qwen2.5:0.5b.'}
      </span>
      {note && <span className="service-config-note">{note}</span>}
      {error && (
        <span className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </span>
      )}
    </div>
  );
}

/** Chip label per declared capability name (the /api/ai/sources vocabulary). */
const CAPABILITY_CHIP_LABELS: Record<string, string> = {
  chat: 'chat',
  transcription: 'speech-to-text',
  speech: 'text-to-speech',
  image: 'image',
};

/** Which AI lanes a service can serve — template-DECLARED capabilities when
 *  present (authoritative: a split service like aokie-stt declares exactly one
 *  lane, where its "Speech-to-Text" category would heuristically match both),
 *  else the legacy category heuristic — mirroring the desktop's
 *  /api/ai/sources mapping so the chips and the source pickers agree on what
 *  e.g. the Speech service is for. */
function serviceCapabilityChips(category: string, declared?: string[]): string[] {
  if (declared && declared.length > 0) {
    return declared.map((cap) => CAPABILITY_CHIP_LABELS[cap] ?? cap);
  }
  const c = category.toLowerCase();
  if (c.includes('llm')) return ['chat'];
  if (c.includes('speech') || c.includes('voice')) return ['speech-to-text', 'text-to-speech'];
  if (c.includes('image')) return ['image'];
  return [];
}

function ServiceCard({
  service,
  logsOpen,
  pending,
  onToggleLogs,
  onStart,
  onStop,
  onRepair,
  onAutostart,
  onInstall,
  onUninstall,
  onCancelInstall,
  onExport,
  onDelete,
}: CardProps) {
  // llama-cpp refuses to start without a model — surface that on the card
  // header (the picker itself lives behind Configure).
  const needsModelHint = service.id === 'llama-cpp';
  // Lazy-mount the Configure content: children of a CLOSED <details> still
  // MOUNT in React, so the model pickers used to fire their disk scans
  // (listGgufModels over the whole model library) on every Services visit.
  const [configOpen, setConfigOpen] = useState(false);
  const capChips = serviceCapabilityChips(service.category, service.capabilities);

  return (
    <div className={`service-card service-card-${service.status}`}>
      <div className="service-row">
        <div className="service-info">
          <div className="service-name">
            {service.name}
            <StatusBadge status={service.status} />
            {!service.installed && service.installable && service.status === 'stopped' && (
              <span className="badge badge-neutral">not installed</span>
            )}
            {/* Which AI lanes this service serves (chat / STT / TTS / image) —
                the same mapping the Receptionist source pickers use. */}
            {capChips.map((c) => (
              <span key={c} className="badge badge-neutral">
                {c}
              </span>
            ))}
          </div>
          <div className="service-meta">
            port {service.port}
            {service.pid != null && <> · pid {service.pid}</>}
            {service.model && (
              <>
                {' '}
                · model{' '}
                <span title={service.model}>
                  {service.model.split(/[\\/]/).pop()}
                </span>
              </>
            )}
            {service.startedAt && (
              <> · up since {new Date(service.startedAt).toLocaleTimeString()}</>
            )}
            {service.docsUrl && /^https?:\/\//i.test(service.docsUrl) && (
              <>
                {' · '}
                {/* Route through openExternal (OS browser via the Rust open_url
                    command) instead of a raw target=_blank, which in a Tauri
                    webview either no-ops or navigates the app window away. Only
                    http(s) is rendered — blocks a javascript:/data: docsUrl from
                    an imported service package. */}
                <a
                  href={service.docsUrl}
                  rel="noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    openExternal(service.docsUrl!);
                  }}
                >
                  docs
                </a>
              </>
            )}
          </div>
          <div className="service-desc" title={service.description}>
            {service.description}
          </div>
          {service.error && (
            <div className="service-error">
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {service.error}
            </div>
          )}
          {/* PROC-001: the last spontaneous exit, summarised — code, when, and
              the final stderr lines (hover) — so a crash names itself without
              a trip through Logs. */}
          {service.lastExit && service.status !== 'running' && (
            <div
              className="service-meta"
              title={service.lastExit.stderrTail.join('\n')}
            >
              Last exit: code {service.lastExit.code ?? '—'} at{' '}
              {new Date(service.lastExit.at).toLocaleTimeString()}
              {service.lastExit.stderrTail.length > 0 &&
                ` — ${service.lastExit.stderrTail[service.lastExit.stderrTail.length - 1]}`}
            </div>
          )}
          {/* SRV-004: configuration (model/projector/GPU/autostart pickers)
              lives behind an expander — the card header stays status-first
              and the list stops shifting as pickers load. */}
          <details
            className="service-config"
            onToggle={(e) => setConfigOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>
              Configure
              {needsModelHint && <span className="service-config-hint"> · model & GPU</span>}
              {(service.extraArgs?.length ?? 0) > 0 && (
                <span className="service-config-hint"> · custom args</span>
              )}
            </summary>
            {/* Content mounts only while open — the pickers' disk scans used
                to run for every card on every Services visit. */}
            {configOpen && (
              <>
                {service.id === 'llama-cpp' && (
                  <LlamaModelSelector
                    running={service.status === 'running' || service.status === 'starting'}
                  />
                )}
                {service.id === 'ollama' && <OllamaModelSelector />}
                {/* Split speech services: structured engine/model-folder pickers
                    that compose the SAME extra-args array the raw editor below
                    edits (advanced escape hatch stays visible). */}
                {SPEECH_ENGINE_OPTIONS[service.id] && <SpeechEngineConfig service={service} />}
                <GpuSelector serviceId={service.id} currentGpu={service.gpu} />
                <ExtraArgsEditor service={service} />
                {/* PROC-001: explicit per-service boot policy. Auto = restore whatever
                    was running last session (the default); Always/Never override it. */}
                <label className="service-config-row service-meta">
                  Start at launch:
                  <select
                    value={service.autostart}
                    disabled={pending}
                    onChange={(e) => onAutostart(e.target.value as 'auto' | 'always' | 'never')}
                  >
                    <option value="auto">Auto (restore last session)</option>
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                  </select>
                </label>
              </>
            )}
          </details>
        </div>
        <div className="service-actions">
          {/* Start / Stop — only meaningful once installed (you can't start what isn't
              installed). */}
          {service.status === 'running' || service.status === 'starting' ? (
            <button onClick={onStop} disabled={pending} className="btn btn-warn">Stop</button>
          ) : (service.installed || !service.installable) && service.status !== 'installing' ? (
            // Show Start once installed; ALSO for non-installable custom services
            // (install:none) whose run.command we can't verify on disk — otherwise the card
            // would have NO actionable button. start() surfaces the real error if the command
            // is genuinely missing.
            <button onClick={onStart} disabled={pending} className="btn btn-primary">
              Start
            </button>
          ) : null}
          {/* PROC-001 one-click repair: visible on a faulted service — resets the
              crash-loop breaker + stale state, verifies the port is free (naming a
              foreign holder), and starts fresh. */}
          {service.status === 'errored' && (
            <button
              onClick={onRepair}
              disabled={pending}
              className="btn btn-secondary"
              title="Reset crash-loop state, verify the port is free, and start fresh"
            >
              Repair
            </button>
          )}

          {/* A SINGLE install-state button (not separate Install + Uninstall):
              Install when not installed → Uninstall when installed (or Reinstall if the
              service has no uninstall spec, e.g. the system-installed ollama). */}
          {service.status === 'installing' ? (
            <button onClick={onCancelInstall} disabled={pending} className="btn btn-warn">
              Cancel install
            </button>
          ) : service.status === 'running' || service.status === 'starting' ? null : !service.installed ? (
            service.installable ? (
              <button onClick={onInstall} disabled={pending} className="btn btn-secondary">
                Install
              </button>
            ) : null
          ) : service.uninstallable ? (
            <button
              onClick={onUninstall}
              disabled={pending}
              className="btn btn-ghost"
              title="Remove this service's installed files so you can reinstall cleanly"
            >
              Uninstall
            </button>
          ) : service.installable ? (
            <button
              onClick={onInstall}
              disabled={pending}
              className="btn btn-ghost"
              title="Re-run the installer (update or repair)"
            >
              Reinstall
            </button>
          ) : null}
          <button onClick={onToggleLogs} className={`btn btn-ghost${logsOpen ? ' btn-active' : ''}`}>
            {logsOpen ? 'Hide logs' : 'Logs'}
          </button>
          <button
            onClick={onExport}
            className="btn btn-ghost"
            title="Export as a self-contained package (.json with bundled scripts)"
          >
            <span className="icon-button-label">
              <UploadIcon size={14} />
              Export
            </span>
          </button>
          <button
            onClick={onDelete}
            disabled={
              pending || service.status === 'running' || service.status === 'installing'
            }
            className="btn btn-ghost btn-danger"
            title="Delete this service template (stop it first)"
            aria-label="Delete service template"
          >
            <TrashIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ServiceStatus }) {
  const cls =
    status === 'running'
      ? 'badge-ok'
      : status === 'errored'
        ? 'badge-err'
        : status === 'installing' || status === 'starting'
          ? 'badge-pending'
          : 'badge-neutral';
  return <span className={`badge ${cls}`}>{status}</span>;
}
