// Settings → AI source card (Site AI plan §5.5, Phase 2 step 6).
//
// The user picks which AI answers chats and default-source flow nodes:
//   - 'FormLogic Site AI' (hosted, allowance-metered — shows live monthly usage),
//   - 'My Desktop AI' (E2E-tunneled to a provider configured in FormLogic Desktop;
//     provider dropdown from the paired desktop's /api/ai/sources union, model dropdown
//     from the tunnel catalog kind=models with a 5-minute cache — both degrade to a
//     free-text input when unreachable, per plan §5.5),
//   - 'Custom (this browser)' (the browser-local AI services registry).
// Saved via GET/PUT /api/ai/preferences; the saved state also primes
// websiteAiRouting.resolveDefaultAiSource() for default-source consumers.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CODEX_PROVIDER_ID, CODEX_REASONING_EFFORTS } from '../../client-runtime/desktop/desktopTunnel';
import { Laptop, RefreshCw, Settings2 } from 'lucide-react';
import {
  api,
  type AiChatToolMode,
  type AiPreferencesState,
  type AiSourceSetting,
  type AiUsageInfo,
} from '../../lib/api';
import { cacheAiPreferences } from '../../lib/websiteAiRouting';
import { fetchModelCatalog, fetchProviderCatalog } from '../../client-runtime/desktop/desktopTunnel';
import { listAiSources, type AiSourceListing } from '../../client-runtime/flows/desktopService';
import { listProviders, providerSupports, type AiProviderConfig } from '../../client-runtime/flows/aiProviders';
import { useFlowsDesktopPresence } from '../flows/useFlowsDesktopPresence';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { logger } from '../../lib/logger';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  deleteModelCatalogCache,
  modelOptionFrom,
  providerListingFromTunnel,
  readModelCatalogCache,
  readProviderCatalogCache,
  writeModelCatalogCache,
  writeProviderCatalogCache,
  type ModelOption,
} from './aiModelCatalog';

const AiServicesDialog = lazy(() => import('../flows/AiServicesDialog'));

/**
 * Chat-capable sources out of the desktop's /api/ai/sources union: gateway providers
 * (empty capability set = all) AND chat-capable local services (llama-cpp, ollama, …) —
 * the tunnel chat lane executes against both.
 */
function chatProvidersFrom(sources: AiSourceListing[]): AiSourceListing[] {
  return sources.filter(
    (s) =>
      s.enabled &&
      (s.kind === 'provider'
        ? s.capabilities.length === 0 || s.capabilities.includes('chat')
        : s.kind === 'service' && s.capabilities.includes('chat')),
  );
}

/**
 * The value saved as desktop_provider_id: providers save their bare id; services save
 * the union's prefixed form ('service:llama-cpp'), which the desktop chat lane resolves.
 * Tunnel-listed rows arrive with the resolvable token already in refId.
 */
function desktopSourceValue(s: AiSourceListing): string {
  return s.kind === 'service' && !s.refId.startsWith('service:') ? s.id : s.refId;
}

function chatCapableCustomProviders(userId: string | null | undefined): AiProviderConfig[] {
  return listProviders(userId).filter((p) => p.enabled && providerSupports(p, 'chat'));
}

function usageLine(usage: AiUsageInfo | null | undefined): string {
  if (!usage) return 'Monthly usage is not tracked on this instance yet.';
  return usage.limit !== null
    ? `${usage.used} of ${usage.limit} messages this month`
    : `${usage.used} messages this month`;
}

type LoadState = 'loading' | 'error' | 'ready';

/** The last settled catalog fetch for one provider id ('loading' is derived, never stored). */
interface CatalogResult {
  providerId: string;
  state: 'ready' | 'error';
  error: string | null;
  models: ModelOption[];
}

export function AiSourceCard() {
  const user = useAuthStore((s) => s.user);
  const readOnly = !!user?.isDemo;
  const desktopPresence = useFlowsDesktopPresence();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [loaded, setLoaded] = useState<AiPreferencesState | null>(null);

  // Editable fields (kept independently of the active source so flipping sources
  // doesn't destroy a configured provider on save).
  const [source, setSource] = useState<AiSourceSetting>('site');
  const [desktopProviderId, setDesktopProviderId] = useState('');
  const [desktopModel, setDesktopModel] = useState('');
  const [customProviderId, setCustomProviderId] = useState('');
  const [chatToolMode, setChatToolMode] = useState<AiChatToolMode>('auto');
  const [desktopReasoning, setDesktopReasoning] = useState('');

  const [desktopProviders, setDesktopProviders] = useState<AiSourceListing[]>([]);
  const [customProviders, setCustomProviders] = useState<AiProviderConfig[]>(() => chatCapableCustomProviders(user?.id));
  const [catalogResult, setCatalogResult] = useState<CatalogResult | null>(null);
  const [catalogReloadTick, setCatalogReloadTick] = useState(0);

  const [saving, setSaving] = useState(false);
  const [showAiServices, setShowAiServices] = useState(false);
  const saveSeqRef = useRef(0);

  // Load the preferences; all state updates land in the async callback.
  useEffect(() => {
    let cancelled = false;
    api.getAiPreferences().then((res) => {
      if (cancelled) return;
      if (res.error || !res.data) {
        setLoadState('error');
        setLoadError(res.error ?? 'Could not load AI settings');
        return;
      }
      const prefs = res.data;
      setLoaded(prefs);
      setSource(prefs.aiSource);
      setDesktopProviderId(prefs.desktopProviderId ?? '');
      setDesktopModel(prefs.desktopModel ?? '');
      setCustomProviderId(prefs.customProviderId ?? '');
      setChatToolMode(prefs.chatToolMode);
      setDesktopReasoning(prefs.desktopReasoning ?? '');
      cacheAiPreferences(prefs);
      setLoadState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // Desktop provider dropdown options: the paired desktop's chat-capable providers
  // first (loopback /api/ai/sources); when that yields nothing but a desktop IS
  // linked (local pairing broken, or a different machine), the SAME dropdown is
  // populated over the E2E tunnel (kind:'providers', 5-min cache). The free-text
  // input remains only for the genuinely-unreachable case.
  const presenceKind = desktopPresence.kind;
  useEffect(() => {
    let cancelled = false;
    listAiSources()
      .then(async (sources) => {
        if (cancelled) return;
        const local = chatProvidersFrom(sources);
        if (local.length > 0) {
          setDesktopProviders(local);
          return;
        }
        if (presenceKind === 'none') return;
        const cached = readProviderCatalogCache();
        if (cached) {
          setDesktopProviders(chatProvidersFrom(cached));
          return;
        }
        const res = await fetchProviderCatalog();
        if (cancelled) return;
        if (!res.ok) {
          logger.warn('[ai-settings] tunnel provider listing failed:', res.error.message);
          return;
        }
        const listed = res.data.providers
          .map(providerListingFromTunnel)
          .filter((p): p is AiSourceListing => p !== null);
        writeProviderCatalogCache(listed);
        setDesktopProviders(chatProvidersFrom(listed));
      })
      .catch((e) => {
        logger.warn('[ai-settings] desktop provider listing failed:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [presenceKind]);

  // Browser-local custom providers refresh when the AI services registry changes
  // (the AiServicesDialog dispatches this event on save; mount state is the lazy initializer).
  useEffect(() => {
    const onChanged = () => setCustomProviders(chatCapableCustomProviders(user?.id));
    window.addEventListener('formlogic:ai-services-changed', onChanged);
    return () => window.removeEventListener('formlogic:ai-services-changed', onChanged);
  }, [user?.id]);

  const activeDesktopProvider = source === 'desktop' ? desktopProviderId.trim() : '';
  const cachedCatalogModels = activeDesktopProvider ? readModelCatalogCache(activeDesktopProvider) : null;

  // Desktop model catalog over the E2E tunnel (kind=models); the settled result is
  // stored per provider id, and cache hits are read during render — no sync resets.
  useEffect(() => {
    if (loadState !== 'ready' || !activeDesktopProvider || cachedCatalogModels) return;
    const providerId = activeDesktopProvider;
    let cancelled = false;
    fetchModelCatalog(providerId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setCatalogResult({ providerId, state: 'error', error: res.error.message, models: [] });
        return;
      }
      const models = res.data.models.map(modelOptionFrom).filter((m): m is ModelOption => m !== null);
      writeModelCatalogCache(providerId, models);
      setCatalogResult({ providerId, state: 'ready', error: null, models });
    });
    return () => {
      cancelled = true;
    };
  }, [loadState, activeDesktopProvider, cachedCatalogModels, catalogReloadTick]);

  const settledCatalog = catalogResult && catalogResult.providerId === activeDesktopProvider ? catalogResult : null;
  const catalogState: 'idle' | 'loading' | 'ready' | 'error' = !activeDesktopProvider
    ? 'idle'
    : cachedCatalogModels || settledCatalog?.state === 'ready'
      ? 'ready'
      : settledCatalog?.state === 'error'
        ? 'error'
        : 'loading';
  const catalogModels = cachedCatalogModels ?? settledCatalog?.models ?? [];
  const catalogError = settledCatalog?.error ?? null;

  const isDirty =
    loaded !== null &&
    (source !== loaded.aiSource ||
      (desktopProviderId.trim() || null) !== loaded.desktopProviderId ||
      (desktopModel.trim() || null) !== loaded.desktopModel ||
      (customProviderId || null) !== loaded.customProviderId ||
      chatToolMode !== loaded.chatToolMode ||
      (desktopReasoning || null) !== (loaded.desktopReasoning ?? null));

  /**
   * Auto-persist a discrete control change (radio, dropdown, toggle) — the user asked for
   * picks to stick without a Save click. Incomplete intermediates (desktop/custom source
   * with no provider chosen yet) stay local until completed — no mid-flow error toasts;
   * free-text inputs keep the explicit Save button. Latest-wins: a newer auto-save
   * supersedes an in-flight one (stale responses are dropped, never applied).
   */
  const autoSave = async (patch: {
    source?: AiSourceSetting;
    desktopProviderId?: string;
    desktopModel?: string;
    customProviderId?: string;
    chatToolMode?: AiChatToolMode;
    desktopReasoning?: string;
  }) => {
    if (readOnly || loaded === null) return;
    const next = {
      aiSource: patch.source ?? source,
      desktopProviderId: (patch.desktopProviderId ?? desktopProviderId).trim() || null,
      desktopModel: (patch.desktopModel ?? desktopModel).trim() || null,
      customProviderId: (patch.customProviderId ?? customProviderId) || null,
      chatToolMode: patch.chatToolMode ?? chatToolMode,
      desktopReasoning: (patch.desktopReasoning ?? desktopReasoning) || null,
    };
    if (next.aiSource === 'desktop' && !next.desktopProviderId) return;
    if (next.aiSource === 'custom' && !next.customProviderId) return;
    const seq = ++saveSeqRef.current;
    setSaving(true);
    const res = await api.putAiPreferences(next);
    if (seq !== saveSeqRef.current) return;
    setSaving(false);
    if (res.error || !res.data) {
      toast.error('Could not save AI settings', res.error ?? undefined);
      return;
    }
    // Only the baseline updates — never the editable fields (they may already be ahead).
    setLoaded(res.data);
    cacheAiPreferences(res.data);
  };

  const save = async () => {
    if (saving || readOnly) return;
    if (source === 'desktop' && !desktopProviderId.trim()) {
      toast.error('Pick a desktop provider', 'Choose the FormLogic Desktop provider to use, or switch AI source.');
      return;
    }
    if (source === 'custom' && !customProviderId) {
      toast.error('Pick a custom provider', 'Choose an AI service configured in this browser, or switch AI source.');
      return;
    }
    saveSeqRef.current += 1; // an explicit save supersedes any in-flight auto-save
    setSaving(true);
    const res = await api.putAiPreferences({
      aiSource: source,
      desktopProviderId: desktopProviderId.trim() || null,
      desktopModel: desktopModel.trim() || null,
      customProviderId: customProviderId || null,
      chatToolMode,
      desktopReasoning: desktopReasoning || null,
    });
    setSaving(false);
    if (res.error || !res.data) {
      if (res.code === 'ai_allowance_exceeded') {
        toast.error('Site AI allowance reached', res.error ?? 'The monthly Site AI allowance for this plan is used up.');
      } else {
        toast.error('Could not save AI settings', res.error ?? undefined);
      }
      return;
    }
    const saved = res.data;
    setLoaded(saved);
    setSource(saved.aiSource);
    setDesktopProviderId(saved.desktopProviderId ?? '');
    setDesktopModel(saved.desktopModel ?? '');
    setCustomProviderId(saved.customProviderId ?? '');
    setChatToolMode(saved.chatToolMode);
    setDesktopReasoning(saved.desktopReasoning ?? '');
    cacheAiPreferences(saved);
    toast.success('AI settings saved');
  };

  if (loadState === 'loading') {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500" role="status" aria-label="Loading AI settings" />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/10 p-5 text-center space-y-3">
        <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadState('loading');
            setLoadError(null);
            setReloadTick((t) => t + 1);
          }}
          leftIcon={<RefreshCw className="h-4 w-4" />}
        >
          Try again
        </Button>
      </div>
    );
  }

  const providerOptions = desktopProviders;
  // A saved provider id that the local listing doesn't know still renders (remote-only desktop).
  const savedProviderMissing = desktopProviderId !== '' && !providerOptions.some((p) => desktopSourceValue(p) === desktopProviderId);
  const showProviderSelect = providerOptions.length > 0 || desktopProviderId !== '';
  const showModelSelect = catalogState === 'ready' && catalogModels.length > 0;
  const savedModelMissing = desktopModel !== '' && !catalogModels.some((m) => m.id === desktopModel);

  return (
    <div className="space-y-5">
      {readOnly && (
        <p className="text-sm text-amber-700 dark:text-amber-300 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-3 py-2">
          The shared demo account can&apos;t change AI settings — this view is read-only.
        </p>
      )}

      <fieldset disabled={readOnly} className="space-y-3 border-0 p-0 m-0 min-w-0 disabled:opacity-70">
        <legend className="sr-only">AI source</legend>

        {/* FormLogic Site AI */}
        <label
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 transition-colors',
            source === 'site'
              ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10'
              : 'border-gray-200 dark:border-slate-700',
            readOnly ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary-300 dark:hover:border-primary-500/50',
          )}
        >
          <input
            type="radio"
            name="fl-ai-source"
            value="site"
            className="mt-1"
            checked={source === 'site'}
            onChange={() => {
              setSource('site');
              void autoSave({ source: 'site' });
            }}
            disabled={readOnly}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-gray-900 dark:text-white">FormLogic Site AI</span>
            <span className="block text-sm text-gray-500 dark:text-slate-400">
              Hosted by FormLogic Cloud — works with no desktop connected.
            </span>
            <span className="block text-xs fl-mono text-gray-400 dark:text-slate-500 mt-1">{usageLine(loaded?.usage)}</span>
          </span>
        </label>

        {/* My Desktop AI */}
        <label
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 transition-colors',
            source === 'desktop'
              ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10'
              : 'border-gray-200 dark:border-slate-700',
            readOnly ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary-300 dark:hover:border-primary-500/50',
          )}
        >
          <input
            type="radio"
            name="fl-ai-source"
            value="desktop"
            className="mt-1"
            checked={source === 'desktop'}
            onChange={() => {
              setSource('desktop');
              void autoSave({ source: 'desktop' });
            }}
            disabled={readOnly}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-gray-900 dark:text-white">My Desktop AI</span>
            <span className="block text-sm text-gray-500 dark:text-slate-400">
              A provider in your FormLogic Desktop — end-to-end encrypted, nothing is stored on the server.
            </span>
          </span>
        </label>

        {source === 'desktop' && (
          <div className="ml-8 space-y-3 rounded-xl border border-gray-100 dark:border-slate-800 p-4">
            {showProviderSelect ? (
              <div>
                <label htmlFor="fl-ai-desktop-provider" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                  Desktop provider
                </label>
                <select
                  id="fl-ai-desktop-provider"
                  aria-label="Desktop provider"
                  value={desktopProviderId}
                  onChange={(e) => {
                    setDesktopProviderId(e.target.value);
                    setDesktopModel('');
                    void autoSave({ desktopProviderId: e.target.value, desktopModel: '' });
                  }}
                  disabled={readOnly}
                  className="block w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 px-3.5 py-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 disabled:opacity-60"
                >
                  <option value="">Pick a provider…</option>
                  {providerOptions.map((p) => (
                    <option key={desktopSourceValue(p)} value={desktopSourceValue(p)}>
                      {p.name}
                    </option>
                  ))}
                  {savedProviderMissing && <option value={desktopProviderId}>{desktopProviderId} (saved)</option>}
                </select>
              </div>
            ) : (
              <Input
                label="Desktop provider id"
                aria-label="Desktop provider id"
                placeholder="e.g. codex"
                value={desktopProviderId}
                onChange={(e) => {
                  setDesktopProviderId(e.target.value);
                  setDesktopModel('');
                }}
                disabled={readOnly}
                hint="No paired desktop was found here — enter the provider id as it appears in FormLogic Desktop."
              />
            )}

            {desktopProviderId.trim() !== '' &&
              (catalogState === 'loading' ? (
                <p className="text-sm text-gray-500 dark:text-slate-400 flex items-center gap-2">
                  <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary-500" role="status" />
                  Loading models from your desktop…
                </p>
              ) : showModelSelect ? (
                <div>
                  <label htmlFor="fl-ai-desktop-model" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                    Model
                  </label>
                  <select
                    id="fl-ai-desktop-model"
                    aria-label="Desktop model"
                    value={desktopModel}
                    onChange={(e) => {
                      setDesktopModel(e.target.value);
                      void autoSave({ desktopModel: e.target.value });
                    }}
                    disabled={readOnly}
                    className="block w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 px-3.5 py-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 disabled:opacity-60"
                  >
                    <option value="">Provider default</option>
                    {catalogModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                    {savedModelMissing && <option value={desktopModel}>{desktopModel} (saved)</option>}
                  </select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Input
                    label="Model (optional)"
                    aria-label="Desktop model"
                    placeholder="Provider default"
                    value={desktopModel}
                    onChange={(e) => setDesktopModel(e.target.value)}
                    disabled={readOnly}
                  />
                  {catalogState === 'error' && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      The model catalog couldn&apos;t be loaded ({catalogError}) — enter a model id, or leave blank for the provider default.{' '}
                      <button
                        type="button"
                        className="underline cursor-pointer"
                        onClick={() => {
                          deleteModelCatalogCache(activeDesktopProvider);
                          setCatalogResult(null);
                          setCatalogReloadTick((t) => t + 1);
                        }}
                      >
                        Retry
                      </button>
                    </p>
                  )}
                </div>
              ))}

            {desktopProviderId.trim() === CODEX_PROVIDER_ID && (
              <div>
                <label htmlFor="fl-ai-desktop-reasoning" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                  Default reasoning
                </label>
                <select
                  id="fl-ai-desktop-reasoning"
                  aria-label="Default reasoning effort"
                  value={desktopReasoning}
                  onChange={(e) => {
                    setDesktopReasoning(e.target.value);
                    void autoSave({ desktopReasoning: e.target.value });
                  }}
                  disabled={readOnly}
                  className="block w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 px-3.5 py-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 disabled:opacity-60"
                >
                  <option value="">Provider default</option>
                  {CODEX_REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                  How hard Codex/ChatGPT thinks by default — you can change it per task inside the chat.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Custom (this browser) */}
        <label
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 transition-colors',
            source === 'custom'
              ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10'
              : 'border-gray-200 dark:border-slate-700',
            readOnly ? 'cursor-not-allowed' : 'cursor-pointer hover:border-primary-300 dark:hover:border-primary-500/50',
          )}
        >
          <input
            type="radio"
            name="fl-ai-source"
            value="custom"
            className="mt-1"
            checked={source === 'custom'}
            onChange={() => {
              setSource('custom');
              void autoSave({ source: 'custom' });
            }}
            disabled={readOnly}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-gray-900 dark:text-white">Custom (this browser)</span>
            <span className="block text-sm text-gray-500 dark:text-slate-400">
              An AI service configured in this browser only — it won&apos;t follow you to other devices.
            </span>
          </span>
        </label>

        {source === 'custom' && (
          <div className="ml-8 space-y-3 rounded-xl border border-gray-100 dark:border-slate-800 p-4">
            {customProviders.length > 0 ? (
              <div>
                <label htmlFor="fl-ai-custom-provider" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                  Custom provider
                </label>
                <select
                  id="fl-ai-custom-provider"
                  aria-label="Custom provider"
                  value={customProviderId}
                  onChange={(e) => {
                    setCustomProviderId(e.target.value);
                    void autoSave({ customProviderId: e.target.value });
                  }}
                  disabled={readOnly}
                  className="block w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/60 px-3.5 py-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 disabled:opacity-60"
                >
                  <option value="">Pick a provider…</option>
                  {customProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {customProviderId !== '' && !customProviders.some((p) => p.id === customProviderId) && (
                    <option value={customProviderId}>{customProviderId} (saved — not in this browser)</option>
                  )}
                </select>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-slate-400">
                No AI services are configured in this browser yet.
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Chat tool mode</p>
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden" role="group" aria-label="Chat tool mode">
          {(['auto', 'confirm'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={chatToolMode === mode}
              disabled={readOnly}
              onClick={() => {
                setChatToolMode(mode);
                void autoSave({ chatToolMode: mode });
              }}
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors',
                chatToolMode === mode
                  ? 'bg-primary-600 text-primary-foreground'
                  : 'bg-white dark:bg-slate-900/60 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800',
                readOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              )}
            >
              {mode === 'auto' ? 'Auto' : 'Confirm'}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 dark:text-slate-400 mt-1.5">
          {chatToolMode === 'auto'
            ? 'The AI runs approved tools right away during a chat.'
            : 'You approve every tool action before it runs during a chat.'}
        </p>
      </div>

      <p className="text-xs text-gray-400 dark:text-slate-500">Default flows use this too.</p>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={!isDirty || saving || readOnly} isLoading={saving}>
          Save AI settings
        </Button>
        <Button variant="outline" onClick={() => setShowAiServices(true)} leftIcon={<Settings2 className="h-4 w-4" />}>
          Manage AI services
        </Button>
        {desktopPresence.kind === 'local' && (
          <span className="text-xs text-gray-400 dark:text-slate-500 inline-flex items-center gap-1">
            <Laptop className="h-3.5 w-3.5" /> Desktop connected
          </span>
        )}
      </div>

      <Suspense fallback={null}>
        {showAiServices && (
          <AiServicesDialog
            isOpen={showAiServices}
            onClose={() => {
              setShowAiServices(false);
              setCustomProviders(chatCapableCustomProviders(user?.id));
            }}
            desktopPresence={desktopPresence}
          />
        )}
      </Suspense>
    </div>
  );
}
