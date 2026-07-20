import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appConfig,
  aiProviders,
  openExternal,
  openInExplorer,
  servicePlatform,
  services,
  type AiProviderProfile,
  type AiProviderView,
  type AiProtocol,
  type AokieCodexPhoneConfiguration,
  type CodexLoginStart,
  type CodexModelView,
  type CodexServiceStatus,
  type GpuInfo,
  type ServiceDefinitionSummary,
  type ServiceSnapshot,
  type ServiceStatus,
  type ServiceTemplateInput,
} from './api';
import {
  AiProviderCard,
  createBlankAiProviderProfile,
  ProviderForm,
} from './AiProvidersPanel';
import { useConfirm } from './ConfirmDialog';
import { AlertTriangleIcon, DownloadIcon, TrashIcon, UploadIcon, XIcon } from './Icons';
import LogsViewer from './LogsViewer';
import { PANEL_CACHE_KEYS, getPanelCache, setPanelCache } from './panelCache';
import {
  buildServiceCenterItems,
  CODEX_LOGIN_TIMEOUT_MS,
  formatCodexReasoningEffort,
  formatCodexResponseDuration,
  getPersistedServiceCenterQuery,
  getCodexReasoningEfforts,
  getCodexTryoutDefaults,
  getServiceCenterFacetOptions,
  isSafeBrowserAuthUrl,
  isSafeDeviceVerificationUrl,
  isCodexLoginExpired,
  queryServiceCenter,
  setPersistedServiceCenterQuery,
  shouldFocusServiceSearch,
  type ServiceCenterPageSize,
  type ServiceCenterQuery,
  type ServiceCenterSort,
} from './serviceCenterModel';
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
  const [providers, setProviders] = useState<AiProviderView[] | null>(
    () =>
      getPanelCache<{ providers: AiProviderView[] }>(PANEL_CACHE_KEYS.aiProviders)?.providers ??
      null,
  );
  const [providerError, setProviderError] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<AiProviderProfile | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [serviceDefinitions, setServiceDefinitions] = useState<ServiceDefinitionSummary[]>([]);
  const [codexStatus, setCodexStatus] = useState<CodexServiceStatus | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexBusy, setCodexBusy] = useState<'login' | 'logout' | 'cancel' | null>(null);
  const [codexLogin, setCodexLogin] = useState<CodexLoginStart | null>(null);
  const [codexLoginStartedAt, setCodexLoginStartedAt] = useState<number | null>(null);
  const [query, setQuery] = useState<ServiceCenterQuery>(getPersistedServiceCenterQuery);
  const [debouncedSearch, setDebouncedSearch] = useState(query.search);
  // Per-service ids with an action in flight — disables that row's buttons so a
  // double-click can't fire duplicate start/stop/install/delete requests.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const toast = useToast();
  const { confirm: requestConfirm } = useConfirm();
  // Track previous status per service so we fire toasts on transition,
  // not every snapshot. The first snapshot seen by THIS mount seeds the map
  // silently (no toast spam for pre-existing states — including the cached
  // snapshot the shared store hands us instantly on a revisit).
  const seenStatusRef = useRef<Map<string, ServiceStatus>>(new Map());
  const firstPollRef = useRef(true);
  const cancelledInstallIdsRef = useRef<Set<string>>(new Set());

  const refreshProviders = useCallback(async () => {
    try {
      const response = await aiProviders.list();
      setPanelCache(PANEL_CACHE_KEYS.aiProviders, response);
      setProviders(response.providers);
      setProviderError(null);
    } catch (providerLoadError) {
      setProviderError(
        providerLoadError instanceof Error ? providerLoadError.message : String(providerLoadError),
      );
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const refreshCodexStatus = useCallback(async (): Promise<CodexServiceStatus | null> => {
    try {
      const status = await servicePlatform.codexStatus();
      setCodexStatus(status);
      setCodexError(null);
      return status;
    } catch (statusError) {
      setCodexError(statusError instanceof Error ? statusError.message : String(statusError));
      return null;
    }
  }, []);

  useEffect(() => {
    void servicePlatform.catalog()
      .then((catalog) => setServiceDefinitions(catalog.definitions))
      .catch(() => {
        // The normalized built-in fallback keeps the catalog usable against an
        // older Desktop host; status/action failures are surfaced separately.
      });
    void refreshCodexStatus();
  }, [refreshCodexStatus]);

  useEffect(() => {
    if (!codexLogin || codexLoginStartedAt === null) return;
    let disposed = false;
    let settled = false;
    let pollTimer: number | undefined;
    let timeoutTimer: number | undefined;

    const clearTimers = () => {
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
    };
    const expire = () => {
      if (disposed || settled) return;
      settled = true;
      clearTimers();
      void servicePlatform.cancelCodexLogin(codexLogin.loginId).catch(() => undefined);
      setCodexLogin(null);
      setCodexLoginStartedAt(null);
      setCodexError('ChatGPT sign-in timed out after 10 minutes. Start a new sign-in to try again.');
    };
    const poll = async () => {
      const status = await refreshCodexStatus();
      if (disposed || settled) return;
      if (status && !status.requiresOpenaiAuth && status.account) {
        settled = true;
        clearTimers();
        setCodexLogin(null);
        setCodexLoginStartedAt(null);
        toast.push({
          kind: 'success',
          title: 'ChatGPT account connected',
          body: status.account.email ?? status.account.planType ?? undefined,
        });
        return;
      }
      pollTimer = window.setTimeout(() => void poll(), 2000);
    };

    const elapsed = Date.now() - codexLoginStartedAt;
    if (isCodexLoginExpired(codexLoginStartedAt)) {
      expire();
    } else {
      timeoutTimer = window.setTimeout(
        expire,
        Math.max(0, CODEX_LOGIN_TIMEOUT_MS - elapsed),
      );
      pollTimer = window.setTimeout(() => void poll(), 1200);
    }
    return () => {
      disposed = true;
      clearTimers();
    };
  }, [codexLogin, codexLoginStartedAt, refreshCodexStatus, toast]);

  useEffect(() => {
    setPersistedServiceCenterQuery(query);
  }, [query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(query.search), 200);
    return () => window.clearTimeout(timeout);
  }, [query.search]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldFocusServiceSearch({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        target: event.target instanceof HTMLElement ? event.target : null,
      })) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  const testProvider = useCallback(
    async (id: string, protocol: AiProtocol) => {
      setTestingProvider(id);
      try {
        const result = await aiProviders.test(id);
        toast.push(
          result.ok
            ? {
                kind: 'success',
                title: `"${id}" looks good`,
                body:
                  protocol === 'openai'
                    ? 'Endpoint answered and the key (if set) is accepted.'
                    : "URL and egress policy check out — this protocol's test does not contact the server.",
              }
            : { kind: 'error', title: `"${id}" test failed` },
        );
      } catch (providerTestError) {
        toast.push({
          kind: 'error',
          title: `"${id}" test failed`,
          body:
            providerTestError instanceof Error
              ? providerTestError.message
              : String(providerTestError),
        });
      } finally {
        setTestingProvider(null);
      }
    },
    [toast],
  );

  const startCodexSignIn = useCallback(async (deviceCode = false) => {
    if (codexBusy) return;
    setCodexBusy('login');
    setCodexError(null);
    let loginId: string | null = null;
    try {
      const login = await servicePlatform.startCodexLogin(deviceCode);
      loginId = login.loginId;
      const targetUrl = deviceCode ? login.verificationUrl : login.authUrl;
      const safeTarget = targetUrl && (
        deviceCode ? isSafeDeviceVerificationUrl(targetUrl) : isSafeBrowserAuthUrl(targetUrl)
      );
      if (!targetUrl || !safeTarget) {
        throw new Error(
          deviceCode
            ? 'Codex did not return a safe device verification URL.'
            : 'Codex did not return a safe browser sign-in URL.',
        );
      }
      if (deviceCode && !login.userCode) {
        throw new Error('Codex did not return a device sign-in code.');
      }
      setCodexLogin(login);
      setCodexLoginStartedAt(Date.now());
      await openExternal(targetUrl);
      toast.push({
        kind: 'info',
        title: deviceCode ? 'Enter the code shown on the Codex card' : 'Finish signing in in your browser',
        body: 'FormLogic will update the card when the ChatGPT account is connected.',
      });
    } catch (loginError) {
      if (loginId) {
        await servicePlatform.cancelCodexLogin(loginId).catch(() => undefined);
      }
      setCodexLogin(null);
      setCodexLoginStartedAt(null);
      setCodexError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setCodexBusy(null);
    }
  }, [codexBusy, toast]);

  const cancelCodexSignIn = useCallback(async () => {
    if (!codexLogin || codexBusy) return;
    const loginId = codexLogin.loginId;
    setCodexBusy('cancel');
    setCodexError(null);
    setCodexLogin(null);
    setCodexLoginStartedAt(null);
    try {
      await servicePlatform.cancelCodexLogin(loginId);
      await refreshCodexStatus();
      toast.push({ kind: 'info', title: 'ChatGPT sign-in cancelled' });
    } catch (cancelError) {
      setCodexError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setCodexBusy(null);
    }
  }, [codexBusy, codexLogin, refreshCodexStatus, toast]);

  const logoutCodex = useCallback(async () => {
    if (codexBusy) return;
    const confirmed = await requestConfirm({
      title: 'Sign out of ChatGPT for FormLogic?',
      body: 'This clears the dedicated Codex account connection. OpenAI API providers and their keys are not changed.',
      confirmLabel: 'Sign out',
      danger: true,
    });
    if (!confirmed) return;
    setCodexBusy('logout');
    setCodexError(null);
    try {
      await servicePlatform.logoutCodex();
      setCodexLogin(null);
      setCodexLoginStartedAt(null);
      await refreshCodexStatus();
      toast.push({ kind: 'info', title: 'ChatGPT account disconnected' });
    } catch (logoutError) {
      setCodexError(logoutError instanceof Error ? logoutError.message : String(logoutError));
    } finally {
      setCodexBusy(null);
    }
  }, [codexBusy, refreshCodexStatus, requestConfirm, toast]);

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

  // One normalized catalog drives searching/facets while source-specific cards
  // keep their established process and provider controls.
  const codexDefinition = useMemo(
    () => serviceDefinitions.find((definition) => definition.id === 'openai-codex-agent'),
    [serviceDefinitions],
  );
  const catalogItems = useMemo(
    () => buildServiceCenterItems(
      snapshot?.services ?? [],
      providers ?? [],
      true,
      codexDefinition,
      codexStatus ?? undefined,
    ),
    [snapshot, providers, codexDefinition, codexStatus],
  );
  const facets = useMemo(() => getServiceCenterFacetOptions(catalogItems), [catalogItems]);
  const result = useMemo(
    () => queryServiceCenter(catalogItems, { ...query, search: debouncedSearch }),
    [catalogItems, debouncedSearch, query],
  );
  const serviceById = useMemo(
    () => new Map((snapshot?.services ?? []).map((service) => [service.id, service])),
    [snapshot],
  );
  const providerById = useMemo(
    () => new Map((providers ?? []).map((provider) => [provider.id, provider])),
    [providers],
  );

  // Counts come from the unfiltered catalog, not the current result page.
  const counts = useMemo(() => {
    const count = { running: 0, configured: 0, attention: 0, unavailable: 0 };
    for (const item of catalogItems) {
      if (item.status === 'running') count.running += 1;
      else if (item.status === 'configured') count.configured += 1;
      else if (item.status === 'unavailable') count.unavailable += 1;
      else if (item.status === 'error' || item.status === 'needs-setup') count.attention += 1;
    }
    return count;
  }, [catalogItems]);

  const updateQuery = useCallback((patch: Partial<ServiceCenterQuery>, resetPage = true) => {
    setQuery((current) => ({ ...current, ...patch, page: resetPage ? 1 : patch.page ?? current.page }));
  }, []);

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
            <span className="summary-chip summary-chip-neutral">{counts.configured} configured</span>
            {counts.attention > 0 && (
              <span className="summary-chip summary-chip-err">{counts.attention} need attention</span>
            )}
            {counts.unavailable > 0 && (
              <span className="summary-chip summary-chip-neutral">{counts.unavailable} unavailable</span>
            )}
          </div>
          <input
            ref={searchInputRef}
            type="search"
            className="services-search"
            placeholder="Search services, capabilities or tags…  /"
            aria-label="Search Service Center"
            value={query.search}
            onChange={(e) => updateQuery({ search: e.target.value })}
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
      {snapshot && (
        <div className="service-center-controls" aria-label="Service filters">
          <label>
            <span>Category</span>
            <select value={query.category} onChange={(e) => updateQuery({ category: e.target.value })}>
              <option value="">All categories</option>
              {facets.categories.map((category) => <option key={category}>{category}</option>)}
            </select>
          </label>
          <label>
            <span>Tag</span>
            <select value={query.tag} onChange={(e) => updateQuery({ tag: e.target.value })}>
              <option value="">All tags</option>
              {facets.tags.map((tag) => <option key={tag}>{tag}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={query.status} onChange={(e) => updateQuery({ status: e.target.value })}>
              <option value="">All statuses</option>
              {facets.statuses.map((status) => <option key={status} value={status}>{status.replace('-', ' ')}</option>)}
            </select>
          </label>
          <label>
            <span>Kind</span>
            <select value={query.kind} onChange={(e) => updateQuery({ kind: e.target.value })}>
              <option value="">All kinds</option>
              {facets.kinds.map((kind) => <option key={kind} value={kind}>{kind.replace('-', ' ')}</option>)}
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select
              value={query.sort}
              onChange={(e) => updateQuery({ sort: e.target.value as ServiceCenterSort })}
            >
              <option value="relevance">Relevance</option>
              <option value="name">Name</option>
              <option value="status">Status</option>
              <option value="kind">Kind</option>
            </select>
          </label>
          <label>
            <span>Per page</span>
            <select
              value={query.pageSize}
              onChange={(e) => updateQuery({ pageSize: Number(e.target.value) as ServiceCenterPageSize })}
            >
              <option value={12}>12</option>
              <option value={24}>24</option>
              <option value={48}>48</option>
            </select>
          </label>
        </div>
      )}
      {snapshot && (
        <div className="service-center-actions">
          <button className="btn btn-secondary" onClick={() => setShowAddForm(true)}>
            + Add local service
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setEditingProvider(createBlankAiProviderProfile())}
          >
            + Add API provider
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => importInputRef.current?.click()}
            title="Import a self-contained service package"
          >
            <span className="icon-button-label"><DownloadIcon size={14} />Import package</span>
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importPackage(file);
              e.currentTarget.value = '';
            }}
          />
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
      {providerError && (
        <div className="banner banner-err">
          Couldn't load AI providers: {providerError}. Local services and the catalog remain available.
        </div>
      )}
      {showAddForm && (
        <section className="service-section service-center-editor">
          <AddServiceForm
            onCancel={() => setShowAddForm(false)}
            onSaved={() => {
              setShowAddForm(false);
              void refresh();
              toast.push({
                kind: 'success',
                title: 'Custom service added',
                body: 'Click Start to launch it.',
              });
            }}
            onError={(message) => setActionError(message)}
          />
        </section>
      )}
      {editingProvider && (
        <section className="service-section service-center-editor">
          <ProviderForm
            key={editingProvider.id || 'new'}
            initial={editingProvider}
            onCancel={() => setEditingProvider(null)}
            onKeyRemoved={() => void refreshProviders()}
            onSaved={() => {
              setEditingProvider(null);
              void refreshProviders();
            }}
          />
        </section>
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
          <code>templates/</code> (or use <strong>Import package</strong> in the toolbar)
          to register one without rebuilding. A package can bundle its own
          scripts in a <code>"files"</code> map, so a single JSON is everything
          needed to install + run it — <strong>Export</strong> any service to
          get one.
        </div>
      )}
      {result.total === 0 && snapshot && !error && (
        <div className="empty-state">
          No services match the current search and filters.
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
      {snapshot && result.total > 0 && (
        <section className="service-section service-center-results">
          <div className="service-center-result-meta" aria-live="polite">
            <span>{result.total} result{result.total === 1 ? '' : 's'}</span>
            <span>Page {result.page} of {result.pageCount}</span>
          </div>
          {result.items.map((item) => {
            if (item.source === 'runtime') {
              const svc = serviceById.get(item.id);
              if (!svc) return null;
              return (
            <ServiceCard
              key={item.key}
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
              );
            }

            if (item.source === 'provider') {
              const provider = providerById.get(item.id);
              if (!provider) return null;
              return (
                <AiProviderCard
                  key={item.key}
                  provider={provider}
                  displayName={item.name}
                  description={item.description}
                  status={item.status}
                  kind={item.kind}
                  tags={item.tags}
                  testing={testingProvider === provider.id}
                  onTest={() => void testProvider(provider.id, provider.protocol)}
                  onEdit={() => setEditingProvider(provider)}
                  onRemove={async () => {
                    const confirmed = await requestConfirm({
                      title: `Remove "${provider.name}"?`,
                      body: 'The provider config and its stored API key are deleted.',
                      confirmLabel: 'Remove',
                      danger: true,
                    });
                    if (!confirmed) return;
                    try {
                      await aiProviders.remove(provider.id);
                      await refreshProviders();
                      toast.push({ kind: 'success', title: `"${provider.name}" removed` });
                    } catch (removeError) {
                      toast.push({
                        kind: 'error',
                        title: 'Remove failed',
                        body: removeError instanceof Error ? removeError.message : String(removeError),
                      });
                    }
                  }}
                />
              );
            }

            const codexConnected = Boolean(
              codexStatus?.available && !codexStatus.requiresOpenaiAuth && codexStatus.account,
            );
            const codexStatusLabel = codexLogin
              ? 'sign-in pending'
              : codexConnected
                ? 'connected'
                : codexStatus?.available
                  ? 'needs sign-in'
                  : codexStatus
                    ? 'unavailable'
                    : 'checking';
            return (
              <div key={item.key} className="service-card service-center-card service-center-card--pilot">
                <div className="service-row">
                  <div className="service-info">
                    <div className="service-name">
                      {item.name}
                      <span className="badge badge-neutral">delegated agent</span>
                      <span className={`badge ${codexConnected ? 'badge-ok' : 'badge-neutral'}`}>
                        {codexStatusLabel}
                      </span>
                      {codexStatus?.running && <span className="badge badge-ok">agent running</span>}
                    </div>
                    <div className="service-desc">{item.description}</div>
                    <div className="service-meta">
                      {codexStatus?.account?.email ?? codexStatus?.account?.accountType ?? 'Eligible ChatGPT plan'}
                      {codexStatus?.account?.planType && <> · {codexStatus.account.planType}</>}
                      {codexStatus?.version && <> · Codex {codexStatus.version}</>}
                    </div>
                    <div className="service-center-boundary">
                      ChatGPT sign-in uses eligible ChatGPT/Codex plan entitlements. It is separate
                      from OpenAI Platform API keys and API billing. Aokie can optionally use it as
                      an experimental text-only call LLM with reasoning Off or Low; speech-to-text
                      and text-to-speech remain separate, and this is not OpenAI Realtime voice.
                    </div>
                    {codexLogin?.method === 'device-code' && codexLogin.userCode && codexLogin.verificationUrl && (
                      <div className="service-center-device-code" role="status">
                        <span>Device sign-in code</span>
                        <code>{codexLogin.userCode}</code>
                        <span className="service-center-device-url">{codexLogin.verificationUrl}</span>
                        <button
                          type="button"
                          className="btn-tiny"
                          onClick={() => {
                            if (!isSafeDeviceVerificationUrl(codexLogin.verificationUrl!)) return;
                            void openExternal(codexLogin.verificationUrl!).catch((openError) =>
                              setCodexError(openError instanceof Error ? openError.message : String(openError)),
                            );
                          }}
                        >
                          Open verification page
                        </button>
                      </div>
                    )}
                    {codexStatus && (
                      <div className="service-center-safety">
                        Safe defaults: files {codexStatus.safeDefaults.fileSystem} · network{' '}
                        {codexStatus.safeDefaults.network} · approvals {codexStatus.safeDefaults.approvals}
                        {' '}· credentials {codexStatus.safeDefaults.credentials}
                      </div>
                    )}
                    {(codexError || codexStatus?.error) && (
                      <div className="service-error">
                        <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
                        {codexError ?? codexStatus?.error}
                      </div>
                    )}
                    <div className="service-center-tags" aria-label="Tags">
                      {item.tags.map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                  </div>
                  <div className="service-actions">
                    {codexLogin ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={codexBusy !== null}
                        onClick={() => void cancelCodexSignIn()}
                      >
                        {codexBusy === 'cancel' ? 'Cancelling…' : 'Cancel sign-in'}
                      </button>
                    ) : codexConnected ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={codexBusy !== null}
                        onClick={() => void logoutCodex()}
                      >
                        {codexBusy === 'logout' ? 'Signing out…' : 'Sign out'}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={!codexStatus?.available || codexBusy !== null}
                          onClick={() => void startCodexSignIn(false)}
                        >
                          {codexBusy === 'login' ? 'Opening browser…' : 'Sign in with ChatGPT'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={!codexStatus?.available || codexBusy !== null}
                          onClick={() => void startCodexSignIn(true)}
                        >
                          Use device code
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={codexBusy !== null}
                      onClick={() => void refreshCodexStatus()}
                    >
                      Refresh
                    </button>
                  </div>
                </div>
                {codexConnected && <CodexAssistantTryout />}
              </div>
            );
          })}
          <div className="service-center-pagination" aria-label="Service result pages">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={result.page <= 1}
              onClick={() => updateQuery({ page: result.page - 1 }, false)}
            >
              Previous
            </button>
            <span>Page {result.page} of {result.pageCount}</span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={result.page >= result.pageCount}
              onClick={() => updateQuery({ page: result.page + 1 }, false)}
            >
              Next
            </button>
          </div>
        </section>
      )}

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

function CodexAssistantTryout() {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<CodexModelView[] | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [serviceTier, setServiceTier] = useState<'' | 'priority'>('');
  const [phoneConfiguration, setPhoneConfiguration] =
    useState<AokieCodexPhoneConfiguration | null>(null);
  const [matchesPhoneConfiguration, setMatchesPhoneConfiguration] = useState(false);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<{ text: string; durationMs: number } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsAttempted, setModelsAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestStartedAt, setRequestStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const laneSignatureRef = useRef<string | null>(null);

  const loadModels = useCallback(async () => {
    if (loadingModels) return;
    setLoadingModels(true);
    setModelsAttempted(true);
    setError(null);
    setConfigurationError(null);
    try {
      const [modelsResult, phoneResult] = await Promise.allSettled([
        servicePlatform.codexModels(),
        servicePlatform.aokieCodexPhoneConfiguration(),
      ]);
      if (modelsResult.status === 'rejected') throw modelsResult.reason;
      const response = modelsResult.value;
      const available = response.models.filter((model) => model.model.trim() !== '');
      const phone = phoneResult.status === 'fulfilled' ? phoneResult.value : null;
      const defaults = getCodexTryoutDefaults(available, phone);
      setModels(available);
      setPhoneConfiguration(phone);
      setMatchesPhoneConfiguration(defaults.matchesPhoneConfiguration);
      setSelectedModel(defaults.model);
      setReasoningEffort(defaults.reasoningEffort);
      setServiceTier(defaults.serviceTier ?? '');
      setConfigurationError(
        phoneResult.status === 'rejected'
          ? 'Could not read Aokie receptionist phone settings. Retry before testing so the model is not silently different.'
          : defaults.configurationError ?? null,
      );

      const laneSignature = [
        defaults.model,
        defaults.reasoningEffort,
        defaults.serviceTier ?? 'default',
      ].join('\u0000');
      if (laneSignatureRef.current !== null && laneSignatureRef.current !== laneSignature) {
        setThreadId(null);
        setAnswer(null);
      }
      laneSignatureRef.current = laneSignature;
    } catch (modelError) {
      setModels(null);
      setError(modelError instanceof Error ? modelError.message : String(modelError));
    } finally {
      setLoadingModels(false);
    }
  }, [loadingModels]);

  useEffect(() => {
    if (open && !modelsAttempted && !loadingModels) void loadModels();
  }, [loadModels, loadingModels, modelsAttempted, open]);

  useEffect(() => {
    if (!sending || requestStartedAt === null) return undefined;
    const update = () => setElapsedMs(performance.now() - requestStartedAt);
    update();
    const timer = window.setInterval(update, 50);
    return () => window.clearInterval(timer);
  }, [requestStartedAt, sending]);

  const selectedModelInfo = useMemo(
    () => models?.find((model) => model.model === selectedModel) ?? null,
    [models, selectedModel],
  );
  const reasoningChoices = useMemo(
    () => getCodexReasoningEfforts(selectedModelInfo),
    [selectedModelInfo],
  );

  useEffect(() => {
    setReasoningEffort((current) => {
      if (reasoningChoices.includes(current)) return current;
      const preferred = selectedModelInfo?.defaultReasoningEffort;
      return preferred && reasoningChoices.includes(preferred)
        ? preferred
        : reasoningChoices[0] ?? '';
    });
  }, [reasoningChoices, selectedModelInfo]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || !selectedModel || sending || configurationError) return;
    const startedAt = performance.now();
    setRequestStartedAt(startedAt);
    setElapsedMs(0);
    setSending(true);
    setError(null);
    try {
      const response = await servicePlatform.codexChat({
        prompt: cleanPrompt,
        threadId: threadId ?? undefined,
        model: selectedModel,
        reasoningEffort: reasoningEffort || undefined,
        serviceTier: serviceTier || undefined,
      });
      const durationMs = performance.now() - startedAt;
      setThreadId(response.threadId);
      setAnswer({ text: response.text, durationMs });
      setElapsedMs(durationMs);
      setPrompt('');
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : String(chatError));
      setElapsedMs(performance.now() - startedAt);
    } finally {
      setRequestStartedAt(null);
      setSending(false);
    }
  };

  return (
    <details
      className="service-center-try"
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen) setModelsAttempted(false);
      }}
    >
      <summary>Try assistant</summary>
      <div className="service-center-try__body">
        <div className="service-center-try__notice">
          Read-only workspace · file access off · agent tools cannot use the network · your prompt
          is sent to OpenAI through Codex · no raw agent events are shown
        </div>
        {loadingModels && <div className="section-loading"><span className="spinner" />Loading models…</div>}
        {!loadingModels && models?.length === 0 && (
          <div className="empty-state">This ChatGPT workspace did not return any available Codex models.</div>
        )}
        {models && models.length > 0 && (
          <form className="service-center-try__form" onSubmit={submit}>
            {matchesPhoneConfiguration && phoneConfiguration && (
              <div className="service-center-try__phone-config" role="status">
                Using receptionist phone settings: {selectedModel}
                {' · '}{formatCodexReasoningEffort(reasoningEffort)} reasoning
                {' · '}{serviceTier === 'priority' ? 'Fast mode' : 'Default mode'}
              </div>
            )}
            <div className="service-center-try__options">
              <label>
                <span>Model</span>
                <select
                  value={selectedModel}
                  disabled={matchesPhoneConfiguration}
                  onChange={(event) => {
                    setSelectedModel(event.target.value);
                    setServiceTier('');
                  }}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.model}>
                      {model.displayName}{model.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {reasoningChoices.length > 0 && (
                <label>
                  <span>Reasoning</span>
                  <select
                    value={reasoningEffort}
                    disabled={matchesPhoneConfiguration}
                    onChange={(event) => setReasoningEffort(event.target.value)}
                  >
                    {reasoningChoices.map((effort) => (
                      <option key={effort} value={effort}>{formatCodexReasoningEffort(effort)}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {selectedModelInfo?.description && (
              <div className="service-center-try__model-desc">{selectedModelInfo.description}</div>
            )}
            <label className="service-center-try__prompt">
              <span>{threadId ? 'Continue this conversation' : 'Ask the assistant'}</span>
              <textarea
                rows={4}
                maxLength={200_000}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the form, app or flow you want help with…"
              />
            </label>
            <div className="service-center-try__actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending || !prompt.trim() || !selectedModel || configurationError !== null}
              >
                {sending ? 'Thinking…' : threadId ? 'Continue' : 'Ask assistant'}
              </button>
              {sending && (
                <output className="service-center-try__timer" aria-label="Elapsed response time">
                  Elapsed {formatCodexResponseDuration(elapsedMs)}
                </output>
              )}
              {threadId && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={sending}
                  onClick={() => {
                    setThreadId(null);
                    setAnswer(null);
                    setPrompt('');
                    setError(null);
                    setElapsedMs(0);
                  }}
                >
                  New conversation
                </button>
              )}
            </div>
          </form>
        )}
        {configurationError && (
          <div className="service-error">
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
            {configurationError}{' '}
            {!loadingModels && (
              <button type="button" className="btn-tiny" onClick={() => void loadModels()}>
                Retry
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="service-error">
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
            {error}{' '}
            {models === null && !loadingModels && (
              <button type="button" className="btn-tiny" onClick={() => void loadModels()}>Retry</button>
            )}
          </div>
        )}
        {answer !== null && (
          <div className="service-center-try__answer" role="region" aria-label="Assistant response">
            <div>
              <span>Assistant</span>
              <span>Response time {formatCodexResponseDuration(answer.durationMs)}</span>
            </div>
            <pre>{answer.text}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

interface AddFormProps {
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}

function parseTagList(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  const [tagsText, setTagsText] = useState('');
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
      tags: parseTagList(tagsText),
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
        <span>Tags (comma-separated)</span>
        <input
          type="text"
          placeholder="automation, internal, image"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
        />
        <span className="form-hint">Used by Service Center search and filters.</span>
      </label>
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
                    void openExternal(service.docsUrl!).catch(() => undefined);
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
