/**
 * Typed wrapper around the companion's localhost HTTP API.
 *
 * One module per concern (services / models / python) so the components
 * each pull a focused slice. All requests are JSON in/out and surface
 * non-2xx as thrown errors with the body's `error` field when present.
 */

export const API_BASE = 'http://127.0.0.1:17872';

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  // Bound every call so a wedged companion handler (TCP accepted but no response)
  // can't leave the promise pending forever and stack up under the 1.5-2s pollers.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
      signal: ac.signal,
    });
    if (!resp.ok) {
      // Try to surface the API's error message — falls back to status text.
      // Handles both the legacy `{error: "msg"}` shape and the FormLogic
      // Desktop envelope `{ok:false, error:{code, message}}`.
      let detail = resp.statusText;
      try {
        const body = await resp.json();
        if (typeof body?.error === 'string') detail = body.error;
        else if (body?.error?.message) {
          // Keep the typed code (e.g. connector 'stale_call') so callers can
          // branch on it — the message alone is free-form prose.
          detail = body.error.code
            ? `${body.error.code}: ${body.error.message}`
            : body.error.message;
        }
      } catch {
        /* not JSON — ignore */
      }
      throw new Error(`${resp.status}: ${detail}`);
    }
    // Empty body → no JSON to parse. Covers 204 No Content AND 202 Accepted
    // (fire-and-forget endpoints like /api/python/install return an empty
    // 202). Reading text first avoids "Unexpected end of JSON input" that
    // `resp.json()` throws on an empty body.
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ----- services -----

export type ServiceStatus =
  | 'stopped'
  | 'installing'
  | 'starting'
  | 'running'
  | 'errored';

export interface ServiceSnapshot {
  id: string;
  name: string;
  description: string;
  category: string;
  status: ServiceStatus;
  error: string | null;
  port: number;
  defaultPort: number;
  pid: number | null;
  startedAt: string | null;
  lastStatusChange: string;
  docsUrl: string | null;
  installable: boolean;
  /** True when the service declares an `uninstall` spec — show an Uninstall button. */
  uninstallable: boolean;
  /** True when the run executable exists on disk. Drives a single Install/Uninstall toggle
   *  button (Install when not installed, Uninstall when installed) instead of two buttons. */
  installed: boolean;
  /** GPU index this service is pinned to (CUDA_VISIBLE_DEVICES), or null for default
   *  placement. Set via the GPU picker. */
  gpu: number | null;
  /** PROC-001: boot-autostart policy — auto (restore last session), always, never. */
  autostart: 'auto' | 'always' | 'never';
  /** PROC-001: the last spontaneous exit's diagnostics, when one happened. */
  lastExit: {
    code: number | null;
    at: string;
    stderrTail: string[];
  } | null;
}

/** A CUDA GPU present on the machine (from nvidia-smi). */
export interface GpuInfo {
  index: number;
  name: string;
}

export interface RegistrySnapshot {
  services: ServiceSnapshot[];
  dataDir: string;
}

export interface LogLine {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

/**
 * Service template — same shape as the on-disk JSON, used both for
 * snapshot replies AND POST /api/services bodies.
 */
export interface ServiceTemplateInput {
  id: string;
  name: string;
  description: string;
  category: string;
  defaultPort: number;
  install?: { kind: 'none' } | {
    kind: 'script';
    windows?: string;
    unix?: string;
  };
  run: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string | null;
  };
  health?: {
    url: string;
    timeoutSecs: number;
  };
  docsUrl?: string | null;
  /**
   * Bundled scripts (filename → contents) that make this a self-contained,
   * plug-and-play package. Written into the scripts dir on load so install/run
   * commands resolve. Empty for built-ins; populated by Export + on Import.
   */
  files?: Record<string, string>;
}

export const services = {
  list: () => request<RegistrySnapshot>('/api/services'),
  add: (template: ServiceTemplateInput) =>
    request<void>('/api/services', {
      method: 'POST',
      body: JSON.stringify(template),
    }),
  /** Import a self-contained service package (same shape as add). */
  import: (pkg: ServiceTemplateInput) =>
    request<void>('/api/services', {
      method: 'POST',
      body: JSON.stringify(pkg),
    }),
  /** Export a service as a self-contained package (template + bundled scripts). */
  export: (id: string) =>
    request<ServiceTemplateInput>(
      `/api/services/${encodeURIComponent(id)}/export`,
    ),
  delete: (id: string) =>
    request<void>(`/api/services/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  start: (id: string) =>
    request<void>(`/api/services/${encodeURIComponent(id)}/start`, {
      method: 'POST',
    }),
  stop: (id: string) =>
    request<void>(`/api/services/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
  /** PROC-001 one-click repair: reset the crash-loop breaker + stale state,
   *  verify the port is actually free, and start fresh. */
  repair: (id: string) =>
    request<void>(`/api/services/${encodeURIComponent(id)}/repair`, {
      method: 'POST',
    }),
  /** PROC-001: persist the boot-autostart policy for one service. */
  setAutostart: (id: string, policy: 'auto' | 'always' | 'never') =>
    request<void>(`/api/services/${encodeURIComponent(id)}/autostart`, {
      method: 'POST',
      body: JSON.stringify({ policy }),
    }),
  install: (id: string) =>
    request<void>(`/api/services/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    }),
  /** Remove a service's installed files so it can be cleanly reinstalled. */
  uninstall: (id: string) =>
    request<{ removed: number }>(
      `/api/services/${encodeURIComponent(id)}/uninstall`,
      { method: 'POST' },
    ),
  cancelInstall: (id: string) =>
    request<void>(`/api/services/${encodeURIComponent(id)}/cancel-install`, {
      method: 'POST',
    }),
  logs: (id: string, tail = 200) =>
    request<LogLine[]>(
      `/api/services/${encodeURIComponent(id)}/logs?tail=${tail}`,
    ),
};

// ----- models / downloads -----

export interface ModelFile {
  name: string;
  path: string;
  sizeBytes: number;
  modified: string | null;
  /** Digest recorded at install time (null = predates MODEL-001 / copied in by hand). */
  sha256: string | null;
  /**
   * Cheap status for the list view: 'verified' (manifest digest + size still
   * match), 'modified' (size drifted since install) or 'unverified' (nothing
   * recorded). A full re-hash is the explicit Verify action.
   */
  verification: 'verified' | 'modified' | 'unverified';
}

export interface ModelsSnapshot {
  rootDir: string;
  models: ModelFile[];
  /** Free space on the drive holding the models dir (null if unknown). */
  freeBytes: number | null;
}

export type DownloadStatus =
  | 'queued'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadProgress {
  id: string;
  url: string;
  filename: string;
  subdir: string | null;
  destPath: string;
  status: DownloadStatus;
  bytesDownloaded: number;
  bytesTotal: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  resumable: boolean | null;
  speedBps: number | null;
  etaSecs: number | null;
  /** SHA-256 the transfer is pinned to (null = nothing to check against). */
  expectedSha256: string | null;
  expectedSize: number | null;
  /** Computed digest of the completed file. */
  sha256: string | null;
  /** true = pin matched before install; false = mismatch (never installed); null = no pin. */
  verified: boolean | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  url: string;
  filename: string;
  subdir: string | null;
  sizeBytes: number;
  /** Pinned content digest — the download refuses to install on mismatch. */
  sha256: string | null;
  license: string | null;
  provenance: string | null;
  /** 'builtin' = matches the entry compiled into the app; 'local' = user-edited/added. */
  source: 'builtin' | 'local';
}

export interface CatalogCategory {
  id: string;
  name: string;
  description: string;
  models: CatalogModel[];
}

export interface CatalogSnapshot {
  sourcePath: string;
  catalog: {
    categories: CatalogCategory[];
  };
}

export interface VerifyResult {
  name: string;
  ok: boolean;
  expectedSha256: string;
  actualSha256: string | null;
  action: string | null;
}

export interface VerifyReport {
  checked: VerifyResult[];
  untracked: string[];
  missing: string[];
}

export const models = {
  list: () => request<ModelsSnapshot>('/api/models'),
  catalog: () => request<CatalogSnapshot>('/api/models/catalog'),
  download: (url: string, filename?: string, subdir?: string, sha256?: string, sizeBytes?: number) =>
    request<{ downloadId: string }>('/api/models/download', {
      method: 'POST',
      body: JSON.stringify({ url, filename, subdir, sha256, sizeBytes }),
    }),
  /** Re-hash every manifest-tracked model; mismatches are quarantined. Slow on big libraries. */
  verify: () =>
    request<VerifyReport>('/api/models/verify', { method: 'POST' }),
  downloads: () => request<DownloadProgress[]>('/api/models/downloads'),
  pause: (id: string) =>
    request<void>(`/api/models/downloads/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
    }),
  resume: (id: string) =>
    request<void>(`/api/models/downloads/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  cancel: (id: string) =>
    request<void>(`/api/models/downloads/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  delete: (name: string) =>
    request<void>(`/api/models/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
};

// ----- python -----

export interface VenvInfo {
  name: string;
  path: string;
  pythonExecutable: string | null;
  sizeBytes: number;
  created: string | null;
  boundServices: string[];
}

export type PythonJobKind = 'installruntime' | 'createvenv';

export interface PythonJobStatus {
  kind: PythonJobKind;
  target: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface PythonSnapshot {
  installed: boolean;
  runtimeDir: string;
  interpreterPath: string | null;
  venvsDir: string;
  venvs: VenvInfo[];
  currentJob: PythonJobStatus | null;
}

export const python = {
  status: () => request<PythonSnapshot>('/api/python'),
  install: () => request<void>('/api/python/install', { method: 'POST' }),
  logs: (tail = 200) => request<LogLine[]>(`/api/python/logs?tail=${tail}`),
  createVenv: (name: string, requirements: string[] = []) =>
    request<{ path: string }>('/api/python/venvs', {
      method: 'POST',
      body: JSON.stringify({ name, requirements }),
    }),
  deleteVenv: (name: string) =>
    request<void>(`/api/python/venvs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
};

// ----- plugins (FormLogic Desktop plugin host) -----

export type PluginState =
  | 'installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'crashed'
  | 'disabled';

export interface PluginConnectorDecl {
  id: string;
  name: string;
  commands: string[];
}

export interface PluginHealthReport {
  at: string;
  ok: boolean;
  /** "ok" | "degraded" | "error" from the plugin, "unreachable" on a miss. */
  status: string;
  detail?: string;
  /** The plugin's full component readiness, verbatim (radio/responder/outbox/…). */
  components?: Record<string, unknown>;
}

export interface PluginSnapshot {
  id: string;
  name: string;
  version: string;
  description?: string;
  state: PluginState;
  /** Why it's disabled/crashed (invalid manifest, version incompat, …). */
  reason?: string;
  dir: string;
  pluginApiVersion: number | null;
  minDesktopVersion?: string;
  capabilities: string[];
  connectors: PluginConnectorDecl[];
  events: string[];
  pid: number | null;
  startedAt: string | null;
  lastHealth: PluginHealthReport | null;
  restartAttempts: number;
}

/** A bundled first-party plugin TEMPLATE (e.g. Aokie) offered for install. */
export interface BuiltinPluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** True when `<plugins>/<id>/manifest.json` already exists on disk. */
  installed: boolean;
  /** Version-compat problem with this desktop build (undefined = installable). */
  incompatible?: string;
}

export interface PluginsListResponse {
  pluginsDir: string;
  /** Dev mode drives dev-only affordances (Aokie's "Simulate incoming call"). */
  devMode: boolean;
  plugins: PluginSnapshot[];
  /** Bundled templates + installed flags — the "Install Aokie plugin" cards. */
  builtins: BuiltinPluginInfo[];
}

export const plugins = {
  list: () => request<PluginsListResponse>('/api/plugins'),
  get: (id: string) =>
    request<PluginSnapshot>(`/api/plugins/${encodeURIComponent(id)}`),
  /** Materialise a bundled built-in template into the plugins dir. */
  installBuiltin: (id: string) =>
    request<void>(`/api/plugins/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    }),
  start: (id: string) =>
    request<void>(`/api/plugins/${encodeURIComponent(id)}/start`, {
      method: 'POST',
    }),
  stop: (id: string) =>
    request<void>(`/api/plugins/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
  restart: (id: string) =>
    request<void>(`/api/plugins/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
    }),
  /** Stop + remove the plugin folder (manifest + binary). Plugin data under
   *  `plugin-data/<id>` is kept; bundled built-ins become installable again. */
  uninstall: (id: string) =>
    request<void>(`/api/plugins/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  health: (id: string) =>
    request<{ health: PluginHealthReport }>(
      `/api/plugins/${encodeURIComponent(id)}/health`,
    ),
  logs: (id: string, tail = 200) =>
    request<LogLine[]>(
      `/api/plugins/${encodeURIComponent(id)}/logs?tail=${tail}`,
    ),
  /** Admin/dev direct command — forwarded as a connector.request. */
  command: (id: string, command: string, payload?: unknown) =>
    request<{ ok: true; data?: unknown }>(
      `/api/plugins/${encodeURIComponent(id)}/commands/${encodeURIComponent(command)}`,
      { method: 'POST', body: JSON.stringify({ payload }) },
    ),
  /**
   * CONSENT-001: issue a Desktop-SIGNED consent grant (the operator accepted
   * the wizard) and record it in the plugin. Only the Desktop window (or the
   * server token) may call this — never a paired web page.
   */
  issueConsent: (
    id: string,
    body: {
      scopes: Record<string, unknown>;
      version?: number;
      acceptedBy?: string;
      expiresDays?: number;
    },
  ) =>
    request<{ ok: true; data?: unknown }>(
      `/api/plugins/${encodeURIComponent(id)}/consent`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

// ----- connectors (exposed by running plugins) -----

export interface DesktopConnectorInfo {
  id: string;
  name: string;
  pluginId: string;
  commands: string[];
  available: boolean;
  pluginState: PluginState;
}

export const desktopConnectors = {
  list: () => request<DesktopConnectorInfo[]>('/api/connectors'),
  status: (id: string) =>
    request<{
      connectorId: string;
      pluginId: string;
      pluginState: PluginState;
      available: boolean;
      lastHealth?: PluginHealthReport;
    }>(`/api/connectors/${encodeURIComponent(id)}/status`),
};

// ----- pairing (origin-bound tokens for FormLogic Web) -----

export interface PairingRequestInfo {
  id: string;
  origin: string;
  status: 'pending';
  createdAt: string;
}

export interface TrustedOrigin {
  origin: string;
  createdAt: string;
  /** Live (unexpired) tokens bound to this origin. */
  tokens: number;
}

export const pairing = {
  /** Pending pairing requests awaiting the user's Approve/Deny. */
  pending: () => request<PairingRequestInfo[]>('/api/desktop/pairing-requests'),
  approve: (id: string) =>
    request<void>(
      `/api/desktop/pairing-requests/${encodeURIComponent(id)}/approve`,
      { method: 'POST' },
    ),
  deny: (id: string) =>
    request<void>(
      `/api/desktop/pairing-requests/${encodeURIComponent(id)}/deny`,
      { method: 'POST' },
    ),
};

export const trustedOrigins = {
  list: () => request<TrustedOrigin[]>('/api/origins'),
  /** Revoke an origin's trust — deletes all its tokens. */
  revoke: (origin: string) =>
    request<{ removed: number }>(
      `/api/origins/${encodeURIComponent(origin)}`,
      { method: 'DELETE' },
    ),
};

// ----- formatting helpers used by multiple components -----

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

export function formatSpeed(bps: number | null | undefined): string {
  if (bps == null || bps === 0) return '';
  // `formatBytes` is already per-unit; just append /s.
  return `${formatBytes(bps)}/s`;
}

export function formatEta(secs: number | null | undefined): string {
  if (secs == null || secs < 0) return '';
  if (secs < 60) return `${secs}s left`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m ${s}s left` : `${m}m left`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
}

/**
 * Call a Tauri command on the companion's Rust side. Inside the
 * companion webview the `__TAURI_INTERNALS__` global is always present;
 * in a plain browser tab it's absent, so we reject with a clear message.
 */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__;
  if (!tauri) {
    return Promise.reject(new Error('Not running in the FormLogic Desktop app.'));
  }
  return tauri.invoke(cmd, args ?? {}) as Promise<T>;
}

/** Whether we're running inside the companion's Tauri webview. */
export function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Open a folder or file in the OS file manager. */
export function openInExplorer(path: string): Promise<void> {
  return tauriInvoke<void>('open_path', { path });
}

/**
 * Open an external URL in the system default browser. In the Tauri app this
 * invokes the native `open_url` command; in a plain dev browser (vite :1420)
 * it falls back to window.open so the link works there too.
 */
export function openExternal(url: string): void {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
    }
  ).__TAURI_INTERNALS__;
  if (internals?.invoke) {
    internals.invoke('open_url', { url }).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// ----- config (data dir) — Tauri commands, desktop-only -----

export interface CompanionConfig {
  /** The dir the running app is actually using right now. */
  activeDir: string;
  /** OS default (what "Reset" returns to). */
  defaultDir: string;
  /** Override written to the pointer file, if any. */
  configuredDir: string | null;
  /** A custom dir is configured (differs from default). */
  isCustom: boolean;
  /** A change is pending — app must restart to apply it. */
  restartRequired: boolean;

  // ----- models dir (separate override; defaults to <dataDir>/models) -----
  /** The models dir the running app is actually using. */
  modelsActiveDir: string;
  /** Where the models dir falls back to (`<activeDataDir>/models`). */
  modelsDefaultDir: string;
  /** The `modelsDir` override written to the pointer, if any. */
  modelsConfiguredDir: string | null;
  /** A custom models dir is configured. */
  modelsIsCustom: boolean;
  /** A models-dir change is pending — restart to apply. */
  modelsRestartRequired: boolean;

  /** The GGUF a single-model server (llama.cpp) is set to load, if the user
   * picked one in its Model selector (null = the `model.gguf` default). */
  llamaModel: string | null;

  /** The model name the Ollama node uses, if the user picked one in its Model
   * selector (null = the pre-pulled default qwen2.5:0.5b). */
  ollamaModel: string | null;
}

/** What a data-folder migration would move (old → pending folder). */
export interface MigratePlan {
  oldDir: string;
  newDir: string;
  fileCount: number;
  totalBytes: number;
  /** Migratable subdirs present in the old folder (models/templates/bin). */
  subdirs: string[];
  /** True when there's a pending change AND something to move. */
  canMigrate: boolean;
}

// ----- local operational journals (DATA-PRIV-001) -----

/** Counts + retention of the local event journals — the Clear-history preview. */
export interface JournalsSnapshot {
  /** Per-plugin receipt-journal entry counts. */
  receipts: Record<string, number>;
  eventWork: { pending: number; completed: number; dead: number };
  retention?: { receiptsDays: number; completedHours: number; deadDays: number };
  /** True when payloads are sealed at rest (credential-store data key). */
  encrypted?: boolean;
}

export interface JournalsCleared {
  cleared: { completed: number; dead: number; receipts: number; processedMarkers: number };
}

export const journals = {
  get: () => request<JournalsSnapshot>('/api/desktop/journals'),
  clear: () => request<JournalsCleared>('/api/desktop/journals/clear', { method: 'POST' }),
};

/** Live migration progress (polled while a copy/move runs). */
export interface MigrationProgress {
  running: boolean;
  mode: string;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  current: string;
  done: boolean;
  error: string | null;
}

export const appConfig = {
  get: () => tauriInvoke<CompanionConfig>('get_config'),
  setDataDir: (path: string) => tauriInvoke<void>('set_data_dir', { path }),
  /** Set (or reset, with '') the models folder — separate from the data dir. */
  setModelsDir: (path: string) => tauriInvoke<void>('set_models_dir', { path }),
  pickFolder: () => tauriInvoke<string | null>('pick_folder'),
  restart: () => tauriInvoke<void>('restart_app'),
  migrationPlan: () => tauriInvoke<MigratePlan>('migration_plan'),
  startMigration: (mode: 'copy' | 'move') =>
    tauriInvoke<void>('start_migration', { mode }),
  migrationStatus: () => tauriInvoke<MigrationProgress>('migration_status'),
  /** Whether a HuggingFace token is saved (never returns the token itself). */
  getHfTokenStatus: () => tauriInvoke<boolean>('get_hf_token_status'),
  /** Save (or clear, with '') the HuggingFace token for gated downloads. */
  setHfToken: (token: string) => tauriInvoke<void>('set_hf_token', { token }),

  // ----- additional model folders (extra search roots beyond the primary) -----
  /** The extra model folders registered beyond the primary models dir. */
  listModelDirs: () => tauriInvoke<string[]>('list_model_dirs'),
  /** Register an extra (read-only) model folder; returns the updated list. */
  addModelDir: (path: string) => tauriInvoke<string[]>('add_model_dir', { path }),
  /** Remove a registered extra model folder; returns the updated list. */
  removeModelDir: (path: string) => tauriInvoke<string[]>('remove_model_dir', { path }),

  // ----- single-model server (llama.cpp) model selection -----
  /** Loadable GGUFs discovered across the model folders — the picker options. */
  listGgufModels: () => tauriInvoke<string[]>('list_gguf_models'),
  /** Set (or reset, with '') which GGUF the llama.cpp server loads. Applies to
   * the next start of the service — no app restart needed. */
  setLlamaModel: (path: string) => tauriInvoke<void>('set_llama_model', { path }),

  // ----- multi-model server (Ollama) model selection -----
  /** Models pulled into the running Ollama server — the Ollama picker options
   * (empty + throws when Ollama isn't running). */
  listOllamaModels: () => tauriInvoke<string[]>('list_ollama_models'),
  /** Set (or reset, with '') the model NAME the Ollama node uses. Applies to
   * the next flow run — no app restart needed. */
  setOllamaModel: (model: string) => tauriInvoke<void>('set_ollama_model', { model }),

  // ----- per-service GPU pinning -----
  /** CUDA GPUs present (index + name). Empty on a box without an NVIDIA GPU. */
  listGpus: () => tauriInvoke<GpuInfo[]>('list_gpus'),
  /** Pin a service to a GPU index (CUDA_VISIBLE_DEVICES), or pass null to clear. Applies to
   * the service's next start — no app restart needed. */
  setServiceGpu: (id: string, gpu: number | null) =>
    tauriInvoke<void>('set_service_gpu', { id, gpu }),
};

// ----- FormLogic Cloud link + headless flow runtime -----

/** FormLogic Cloud link config the Settings panel shows (never the key). */
export interface FormLogicConfigView {
  baseUrl: string;
  hasKey: boolean;
  linked: boolean;
  /** Device label recorded by the OAuth link (null for a manually pasted key). */
  deviceName: string | null;
}

/** Live flow-runtime status (GET /api/desktop/info flowRuntime + Tauri command). */
export interface FlowRuntimeStatus {
  linked: boolean;
  baseUrl: string | null;
  lastOk: boolean | null;
  lastEventAt: string | null;
  lastClaimAt: string | null;
  runsExecuted: number;
  recordsWritten: number;
  errors: number;
  lastError: string | null;
  /** Remote command relay (connector:relay): last long-poll ok, commands handled. */
  relayPollOk: boolean | null;
  commandsHandled: number;
  lastCommandAt: string | null;
}

/** One collapsed entry from GET /api/flows/runtime-errors (mirrors RuntimeErrorEntry). */
export interface RuntimeErrorEntry {
  firstAt: string;
  lastAt: string;
  message: string;
  count: number;
}

/** Phase of the OAuth "Link account" flow (mirrors oauth::LinkPhase). */
export type OAuthLinkPhase =
  | 'idle'
  | 'starting'
  | 'awaiting_browser'
  | 'exchanging'
  | 'linked'
  | 'cancelled'
  | 'error';

/** Snapshot of the OAuth link machine (polled while linking). */
export interface OAuthLinkStatus {
  phase: OAuthLinkPhase;
  inProgress: boolean;
  message: string | null;
  deviceName: string | null;
}

export const formlogic = {
  /** Current link config (base URL + whether a key is set + linked flag + device). */
  getConfig: () => tauriInvoke<FormLogicConfigView>('get_formlogic_config'),
  /** Save the link. Empty baseUrl clears it; empty apiKey leaves the key unchanged. */
  setConfig: (baseUrl: string, apiKey: string) =>
    tauriInvoke<void>('set_formlogic_config', { baseUrl, apiKey }),
  /** Clear the link (disconnect the account; best-effort revokes the key server-side). */
  disconnect: () => tauriInvoke<void>('disconnect_formlogic'),
  /** Cheap authenticated probe for the "Test connection" button. */
  testConnection: () => tauriInvoke<void>('test_formlogic_connection'),
  /** Live flow-runtime status (linked, last poll, run/record/command counts). */
  status: () => tauriInvoke<FlowRuntimeStatus>('formlogic_status'),
  /** Inspectable error history behind the bare `errors` counter (repeats collapsed). */
  runtimeErrors: () =>
    request<{ count: number; lastError: string | null; errors: RuntimeErrorEntry[] }>(
      '/api/flows/runtime-errors',
    ),
  /** Operator reset of the diagnostic error counter + history. */
  clearRuntimeErrors: () =>
    request<void>('/api/flows/runtime-errors/clear', { method: 'POST' }),

  // ----- OAuth "Link FormLogic account" (device-link) -----
  /** Begin the OAuth link: opens the system browser; poll oauthStatus for progress. */
  oauthStart: (baseUrl: string) => tauriInvoke<void>('formlogic_oauth_start', { baseUrl }),
  /** Cancel an in-progress link attempt. */
  oauthCancel: () => tauriInvoke<void>('formlogic_oauth_cancel'),
  /** Current link phase/message (polled by the UI while linking). */
  oauthStatus: () => tauriInvoke<OAuthLinkStatus>('formlogic_oauth_status'),
};
