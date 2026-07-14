import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Eye, EyeOff, Laptop, Pencil, Plus, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import { desktopClient, type DesktopServiceSnapshot } from '../../client-runtime/desktop/desktopClient';
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_LABELS,
  AI_PROVIDER_PRESETS,
  clearProviderKey,
  deleteProvider,
  exportProviderJson,
  getProviderKey,
  listProviders,
  parseProviderImport,
  resolveProviderRequest,
  saveProvider,
  setProviderKey,
  vaultMode,
  type AiCapability,
  type AiProviderConfig,
  type AiProviderHeader,
  type AiProviderKind,
} from '../../client-runtime/flows/aiProviders';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Modal } from '../ui/Modal';
import { Switch } from '../ui/Switch';
import type { FlowsDesktopPresence } from './useFlowsDesktopPresence';

const AI_SERVICES_CHANGED_EVENT = 'formlogic:ai-services-changed';
const TEST_TIMEOUT_MS = 10_000;
const TEMPLATE_PLACEHOLDERS = [
  '{{model}}',
  '{{messages}}',
  '{{prompt}}',
  '{{system}}',
  '{{temperature}}',
  '{{maxTokens}}',
  '{{input}}',
  '{{voice}}',
  '{{audio}}',
  '{{apiKey}}',
].join(', ');

interface AiServicesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  desktopPresence: FlowsDesktopPresence;
}

type EditorState = { provider: AiProviderConfig | null; key: number };
type AsyncMessage = { kind: 'idle' | 'loading' | 'success' | 'error'; message: string; ids?: string[] };

function notifyAiServicesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AI_SERVICES_CHANGED_EVENT));
}

function nowIso(): string {
  return new Date().toISOString();
}

function newProviderId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `ai_${crypto.randomUUID()}`;
  return `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function providerLabel(kind: AiProviderKind): string {
  return AI_PROVIDER_PRESETS[kind].label;
}

function sanitizeFileName(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'ai-service';
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isPlainHttpNonLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function validateBaseUrl(baseUrl: string): string | null {
  if (baseUrl.trim() === '') return 'Base URL is required.';
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Base URL must use http or https.';
    return null;
  } catch {
    return 'Base URL must be a valid http(s) URL.';
  }
}

function validateProviderConfig(cfg: AiProviderConfig): string | null {
  if (cfg.name.trim() === '') return 'Name is required.';
  if (Array.isArray(cfg.capabilities) && cfg.capabilities.length === 0) {
    return 'Select at least one capability (Chat, Transcription or Speech).';
  }
  return validateBaseUrl(cfg.baseUrl);
}

function hasApiKeyPlaceholder(value: string): boolean {
  return value.includes('{{apiKey}}');
}

/** Turn an HTTP failure into an actionable message: name the exact URL and, on 401/403, whether a key was even sent. */
function describeHttpFailure(method: string, url: string, status: number, sentKey: boolean): string {
  const base = `${method} ${url} responded ${status}`;
  if (status === 401 || status === 403) {
    return sentKey
      ? `${base} — the endpoint rejected the API key. Check the key is valid, not expired, and has access to this endpoint.`
      : `${base} — no API key was sent. Enter and save an API key for this service, then test again.`;
  }
  if (status === 404) {
    return `${base} — check the base URL (OpenAI-compatible servers usually end in /v1).`;
  }
  return base;
}

function headersForDraft(cfg: AiProviderConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let headerReferencedKey = false;
  for (const header of cfg.headers ?? []) {
    if (header.name.trim() === '') continue;
    const nameHasKey = hasApiKeyPlaceholder(header.name);
    const valueHasKey = hasApiKeyPlaceholder(header.value);
    if (nameHasKey || valueHasKey) headerReferencedKey = true;
    const keyForRequest = apiKey;
    const name = header.name.replaceAll('{{apiKey}}', keyForRequest).trim();
    if (name !== '') headers[name] = header.value.replaceAll('{{apiKey}}', keyForRequest);
  }
  if (apiKey !== '' && !headerReferencedKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function extractModelIds(payload: unknown): string[] {
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray((payload as { models?: unknown } | null)?.models)
        ? (payload as { models: unknown[] }).models
        : [];
  return candidates
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (typeof record.id === 'string') return record.id;
        if (typeof record.name === 'string') return record.name;
        if (typeof record.model === 'string') return record.model;
      }
      return null;
    })
    .filter((id): id is string => !!id)
    .slice(0, 8);
}

function formatCorsHint(kind: AiProviderKind, origin: string): string {
  if (kind === 'ollama') return `CORS: set OLLAMA_ORIGINS=${origin} before starting Ollama.`;
  const hint = AI_PROVIDER_PRESETS[kind].corsHint;
  if (hint === 'None') return 'CORS: none required for this preset.';
  return `CORS: ${hint.replace('this site origin', origin)}`;
}

function serviceStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes('running') || normalized.includes('ready') || normalized.includes('healthy')) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300';
  }
  if (normalized.includes('error') || normalized.includes('failed') || normalized.includes('stopped')) {
    return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300';
  }
  return 'border-gray-200 bg-gray-50 text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
}

/** Per-kind model-field placeholder. Never suggests a concrete model id — names churn too fast. */
function modelPlaceholder(kind: AiProviderKind): string {
  switch (kind) {
    case 'openai':
      return 'Required — type a model id or click "Fetch models"';
    case 'ollama':
      return 'blank = first model the server advertises (ollama list)';
    case 'lmstudio':
      return 'blank = the model loaded in LM Studio';
    default:
      return 'Optional model id sent with requests';
  }
}

function createProvider(kind: AiProviderKind = 'openai'): AiProviderConfig {
  const preset = AI_PROVIDER_PRESETS[kind];
  const stamp = nowIso();
  return {
    id: newProviderId(),
    name: `${preset.label} service`,
    kind,
    baseUrl: preset.defaults.baseUrl ?? '',
    model: preset.defaults.model,
    headers: preset.defaults.headers,
    capabilities: preset.defaults.capabilities ? [...preset.defaults.capabilities] : undefined,
    chatPath: preset.defaults.chatPath,
    transcriptionPath: preset.defaults.transcriptionPath,
    speechPath: preset.defaults.speechPath,
    requestTemplate: preset.defaults.requestTemplate,
    responsePath: preset.defaults.responsePath,
    enabled: preset.defaults.enabled,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export default function AiServicesDialog({ isOpen, onClose, desktopPresence }: AiServicesDialogProps) {
  const userId = useAuthStore((state) => state.user?.id);
  // The provider list lives in localStorage (an external store) — derive it during
  // render and re-derive by bumping `providersVersion` after every mutation, instead
  // of mirroring it into state from effects (react-hooks/set-state-in-effect).
  const [providersVersion, setProvidersVersion] = useState(0);
  const refreshProviders = useCallback(() => setProvidersVersion((v) => v + 1), []);
  const providers = useMemo(
    () => (isOpen ? listProviders(userId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providersVersion invalidates the localStorage read
    [isOpen, userId, providersVersion]
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AiProviderConfig | null>(null);
  const [importText, setImportText] = useState('');
  const [importMessage, setImportMessage] = useState<AsyncMessage>({ kind: 'idle', message: '' });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic remount key for the editor (a fresh key = fresh editor state); a ref
  // counter keeps the handlers pure (Date.now() in render-adjacent code is impure).
  const editorSeq = useRef(0);

  const openAdd = () => {
    editorSeq.current += 1;
    setEditor({ provider: null, key: editorSeq.current });
  };
  const openEdit = (provider: AiProviderConfig) => {
    editorSeq.current += 1;
    setEditor({ provider, key: editorSeq.current });
  };
  const onSaved = () => {
    refreshProviders();
    notifyAiServicesChanged();
  };

  const toggleProvider = (provider: AiProviderConfig, enabled: boolean) => {
    saveProvider(userId, { ...provider, enabled, updatedAt: nowIso() });
    refreshProviders();
    notifyAiServicesChanged();
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteProvider(userId, pendingDelete.id);
    setPendingDelete(null);
    refreshProviders();
    notifyAiServicesChanged();
    toast.success('AI service deleted', pendingDelete.name);
  };

  const exportProvider = (provider: AiProviderConfig) => {
    downloadText(exportProviderJson(provider), `${sanitizeFileName(provider.name)}.formlogic-ai.json`);
  };

  const exportAll = () => {
    const body = JSON.stringify(providers.map((provider) => JSON.parse(exportProviderJson(provider))), null, 2);
    downloadText(body, 'formlogic-ai-services.formlogic-ai.json');
  };

  const importProviders = (text: string) => {
    try {
      const parsed = parseProviderImport(text);
      const existingIds = new Set(listProviders(userId).map((provider) => provider.id));
      for (const provider of parsed) {
        const id = existingIds.has(provider.id) ? newProviderId() : provider.id;
        existingIds.add(id);
        const stamp = nowIso();
        const next = { ...provider, id, createdAt: provider.createdAt || stamp, updatedAt: stamp };
        delete next.encryptedKey;
        saveProvider(userId, next);
      }
      refreshProviders();
      notifyAiServicesChanged();
      const message = `${parsed.length} service${parsed.length === 1 ? '' : 's'} imported. API keys are not included; re-enter keys before use.`;
      setImportMessage({ kind: 'success', message });
      toast.success('AI services imported', 'Re-enter API keys for imported services.');
      setImportText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed.';
      setImportMessage({ kind: 'error', message });
    }
  };

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    importProviders(await file.text());
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        title={editor ? (editor.provider ? 'Edit AI service' : 'Add AI service') : 'AI services'}
        description={
          editor
            ? 'Configuration is stored only in this browser — never on the server.'
            : 'Manage browser-stored API services and inspect FormLogic Desktop services for flows.'
        }
      >
        {editor ? (
          /* Focused editor view: adding/editing takes over the modal instead of
             appending a form below the list (which forced scrolling to find it). */
          <div className="p-4 sm:p-6">
            <ProviderEditor
              key={editor.key}
              userId={userId}
              initial={editor.provider}
              onCancel={() => setEditor(null)}
              onSaved={onSaved}
              onDone={() => setEditor(null)}
            />
          </div>
        ) : (
        <div className="space-y-4 p-4 sm:p-6">
          {/* Keyed by presence.kind: a presence change remounts with fresh loading state. */}
          <DesktopServicesSection key={desktopPresence.kind} presence={desktopPresence} />

          <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">API services (stored in this browser)</h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                  These services are saved in local browser storage for the current FormLogic user.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={exportAll} disabled={providers.length === 0} leftIcon={<Download className="h-3.5 w-3.5" />}>
                  Export all
                </Button>
                <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} leftIcon={<Upload className="h-3.5 w-3.5" />}>
                  Import file
                </Button>
                <Button size="sm" onClick={openAdd} leftIcon={<Plus className="h-3.5 w-3.5" />}>
                  Add service
                </Button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.formlogic-ai.json,application/json"
              className="hidden"
              onChange={onImportFile}
            />

            <div className="mt-4">
              {providers.length === 0 ? (
                <EmptyState
                  icon={Sparkles}
                  title="No API services"
                  description="Add OpenAI, Ollama, LM Studio, or a custom HTTP service for browser-run AI nodes."
                  action={<Button size="sm" onClick={openAdd} leftIcon={<Plus className="h-4 w-4" />}>Add service</Button>}
                  className="rounded-lg border border-dashed border-gray-200 py-8 dark:border-slate-700"
                />
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-slate-800">
                  {providers.map((provider) => (
                    <ProviderRow
                      key={provider.id}
                      provider={provider}
                      onToggle={(enabled) => toggleProvider(provider, enabled)}
                      onEdit={() => openEdit(provider)}
                      onExport={() => exportProvider(provider)}
                      onDelete={() => setPendingDelete(provider)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 rounded-lg border border-gray-200/80 bg-gray-50/70 p-3 dark:border-slate-700/60 dark:bg-slate-800/30">
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">Paste AI service JSON</span>
                <textarea
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder='Paste a .formlogic-ai.json object or array here.'
                  className="mt-1 w-full resize-y rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                />
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className={cn(
                  'text-[11px]',
                  importMessage.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-slate-400',
                  importMessage.kind === 'success' && 'text-emerald-700 dark:text-emerald-300',
                )}>
                  {importMessage.message || 'Imported services do not include API keys; keys must be re-entered.'}
                </p>
                <Button size="sm" variant="outline" onClick={() => importProviders(importText)} disabled={importText.trim() === ''}>
                  Import pasted JSON
                </Button>
              </div>
            </div>
          </section>

        </div>
        )}
      </Modal>
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete AI service"
        message={pendingDelete ? `Delete "${pendingDelete.name}"? Saved browser credentials for this service will be removed with it.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}

/**
 * Rendered with `key={presence.kind}` by the dialog, so a presence change remounts it
 * with fresh null state — the effect only performs the async fetch (setState happens
 * in the async callback, never synchronously in the effect body).
 */
function DesktopServicesSection({ presence }: { presence: FlowsDesktopPresence }) {
  const navigate = useNavigate();
  const [services, setServices] = useState<DesktopServiceSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (presence.kind !== 'local') return;
    let cancelled = false;
    desktopClient.services.list().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setServices(res.data);
        return;
      }
      setServices([]);
      setError(res.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [presence.kind]);

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <Laptop className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">FormLogic Desktop services</h3>
          <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
            Managed in FormLogic Desktop -&gt; Services -- add or edit services there via JSON templates.
          </p>

          {presence.kind === 'local' && (
            <div className="mt-3">
              {services === null ? (
                <p className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Loading Desktop services...
                </p>
              ) : error ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">{error}</p>
              ) : services.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-slate-400">No Desktop services were reported by the local pairing.</p>
              ) : (
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200/70 dark:divide-slate-800 dark:border-slate-700/60">
                  {services.map((service) => (
                    <div key={service.id} className="grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-[minmax(0,1fr),auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{service.name || service.id}</p>
                        <p className="truncate text-xs text-gray-500 dark:text-slate-400">{service.category || 'service'} - port {service.port}</p>
                      </div>
                      <span className={cn('inline-flex w-fit rounded-full border px-2 py-0.5 text-[11px] font-medium', serviceStatusClass(service.status))}>
                        {service.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {presence.kind === 'remote' && (
            <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-slate-800/50 dark:text-slate-300">
              Services run on the linked desktop "{presence.label}" and cannot be enumerated from this browser.
            </p>
          )}

          {presence.kind === 'none' && (
            <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-slate-800/50 dark:text-slate-300">
              <p>Link FormLogic Desktop to use default local speech services and Desktop-managed AI tools.</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate('/settings#linked-desktops')}>
                Set up linked Desktop
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderRow({
  provider,
  onToggle,
  onEdit,
  onExport,
  onDelete,
}: {
  provider: AiProviderConfig;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[minmax(0,1fr),auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{provider.name}</p>
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {providerLabel(provider.kind)}
          </span>
          <span className={cn(
            'rounded-full border px-2 py-0.5 text-[11px] font-medium',
            provider.encryptedKey
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
          )}>
            {provider.encryptedKey ? 'key saved' : 'no key'}
          </span>
          {(provider.capabilities ?? AI_CAPABILITIES).map((capability) => (
            <span
              key={capability}
              className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
            >
              {AI_CAPABILITY_LABELS[capability]}
            </span>
          ))}
        </div>
        <div className="mt-1 flex min-w-0 flex-col gap-0.5 text-xs text-gray-500 dark:text-slate-400">
          <span className="truncate font-mono">{provider.baseUrl || 'No base URL'}</span>
          <span className="truncate">{provider.model ? `Model: ${provider.model}` : 'Model: provider default'}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={provider.enabled} onChange={onToggle} label="Enabled" size="sm" />
        <Button size="sm" variant="ghost" onClick={onEdit} leftIcon={<Pencil className="h-3.5 w-3.5" />}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={onExport} leftIcon={<Download className="h-3.5 w-3.5" />}>Export</Button>
        <Button size="sm" variant="ghost" onClick={onDelete} leftIcon={<Trash2 className="h-3.5 w-3.5" />}>Delete</Button>
      </div>
    </div>
  );
}

function ProviderEditor({
  userId,
  initial,
  onCancel,
  onSaved,
  onDone,
}: {
  userId: string | null | undefined;
  initial: AiProviderConfig | null;
  onCancel: () => void;
  onSaved: () => void;
  onDone: () => void;
}) {
  // Add-mode starts at a "what are you connecting?" step (cfg === null) — no
  // preset is silently pre-selected. Edit-mode goes straight to the form.
  const [cfg, setCfg] = useState<AiProviderConfig | null>(() => (initial ? { ...initial, headers: initial.headers ? [...initial.headers] : undefined } : null));
  // Auto-name the service after its preset ("Ollama service") until the user
  // types their own name — then never touch it again.
  const [nameEdited, setNameEdited] = useState(() => !!initial);
  const [apiKey, setApiKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [savedKeyPresent, setSavedKeyPresent] = useState(() => !!initial?.encryptedKey);
  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => initial?.kind === 'custom');
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<AsyncMessage>({ kind: 'idle', message: '' });
  const [test, setTest] = useState<AsyncMessage>({ kind: 'idle', message: '' });

  const patchCfg = (patch: Partial<AiProviderConfig>) => setCfg((current) => (current ? { ...current, ...patch } : current));

  const toggleCapability = (capability: AiCapability) => {
    setCfg((current) => {
      if (!current) return current;
      // Absent list = all three (legacy); materialize it before toggling one off.
      const list = Array.isArray(current.capabilities) ? current.capabilities : [...AI_CAPABILITIES];
      const next = list.includes(capability) ? list.filter((c) => c !== capability) : [...list, capability];
      return { ...current, capabilities: next };
    });
  };

  const applyPreset = (kind: AiProviderKind) => {
    const nextPreset = AI_PROVIDER_PRESETS[kind];
    setCfg((current) => {
      if (!current) {
        const created = createProvider(kind);
        return nameEdited ? created : { ...created, name: `${nextPreset.label} service` };
      }
      return {
        id: current.id,
        name: nameEdited && current.name.trim() !== '' ? current.name : `${nextPreset.label} service`,
        kind,
        baseUrl: nextPreset.defaults.baseUrl ?? '',
        model: nextPreset.defaults.model,
        headers: undefined,
        capabilities: nextPreset.defaults.capabilities ? [...nextPreset.defaults.capabilities] : undefined,
        chatPath: nextPreset.defaults.chatPath,
        transcriptionPath: nextPreset.defaults.transcriptionPath,
        speechPath: nextPreset.defaults.speechPath,
        requestTemplate: undefined,
        responsePath: nextPreset.defaults.responsePath,
        enabled: nextPreset.defaults.enabled,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        encryptedKey: current.encryptedKey,
      };
    });
    setAdvancedOpen(kind === 'custom');
    setModels({ kind: 'idle', message: '' });
    setTest({ kind: 'idle', message: '' });
  };

  // ── Step 1 (add-mode): choose what you're connecting ─────────────────────────
  if (cfg === null) {
    return (
      <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">What are you connecting?</h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
          Pick a starting point — every field stays editable afterwards, and Custom HTTP can describe
          almost any JSON API (request body, headers and response mapping are all configurable).
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(Object.keys(AI_PROVIDER_PRESETS) as AiProviderKind[]).map((kind) => {
            const item = AI_PROVIDER_PRESETS[kind];
            return (
              <button
                key={kind}
                type="button"
                onClick={() => applyPreset(kind)}
                className="rounded-lg border border-gray-200 bg-white p-3.5 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/5"
              >
                <span className="block text-sm font-semibold text-gray-900 dark:text-white">{item.label}</span>
                <span className="mt-1 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">{item.description}</span>
                {item.defaults.baseUrl ? (
                  <span className="mt-2 block truncate font-mono text-[11px] text-gray-400 dark:text-slate-500">{item.defaults.baseUrl}</span>
                ) : (
                  <span className="mt-2 block text-[11px] text-gray-400 dark:text-slate-500">Bring your own endpoint</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-4">
          <Button size="sm" variant="ghost" onClick={onCancel}>Back</Button>
        </div>
      </section>
    );
  }

  // ── Step 2: the form (cfg is set from here on) ────────────────────────────────
  const preset = AI_PROVIDER_PRESETS[cfg.kind];
  const origin = typeof window !== 'undefined' ? window.location.origin : 'this origin';
  const hasSavedKey = savedKeyPresent || !!cfg.encryptedKey;
  const keyIsSet = keyTouched ? apiKey.trim() !== '' : hasSavedKey;
  const httpKeyWarning = keyIsSet && isPlainHttpNonLoopback(cfg.baseUrl)
    ? 'Warning: this key will NOT be sent over unencrypted HTTP to a non-loopback host.'
    : null;
  const keyStorageCopy = vaultMode() === 'plain'
    ? 'This site is not HTTPS, so the key is stored obfuscated rather than encrypted.'
    : 'Encrypted at rest in this browser.';
  // Non-blocking guidance (never blocks Save — endpoints vary too much to be strict).
  const softWarnings: string[] = [];
  if (cfg.kind === 'openai' && (cfg.model ?? '').trim() === '') {
    softWarnings.push('OpenAI requires a model id — type one or click "Fetch models" and pick from the list.');
  }
  if (preset.keyRequired && !keyIsSet) {
    softWarnings.push(`${preset.label} usually requires an API key.`);
  }

  const setHeader = (index: number, patch: Partial<AiProviderHeader>) => {
    const headers = [...(cfg.headers ?? [])];
    headers[index] = { name: headers[index]?.name ?? '', value: headers[index]?.value ?? '', ...patch };
    patchCfg({ headers });
  };

  const removeHeader = (index: number) => {
    patchCfg({ headers: (cfg.headers ?? []).filter((_, i) => i !== index) });
  };

  const addHeader = () => patchCfg({ headers: [...(cfg.headers ?? []), { name: '', value: '' }] });

  const saveDraft = async (quiet = false): Promise<AiProviderConfig | null> => {
    const validation = validateProviderConfig(cfg);
    if (validation) {
      setError(validation);
      return null;
    }
    setError(null);
    const next = { ...cfg, updatedAt: nowIso() };
    saveProvider(userId, next);
    if (keyTouched) {
      if (apiKey === '') {
        clearProviderKey(userId, next.id);
        setSavedKeyPresent(false);
      } else {
        await setProviderKey(userId, next.id, apiKey);
        setSavedKeyPresent(true);
      }
    }
    setCfg(next);
    setKeyTouched(false);
    setApiKey('');
    onSaved();
    if (!quiet) toast.success('AI service saved', next.name);
    return next;
  };

  const saveAndClose = async () => {
    const saved = await saveDraft();
    if (saved) onDone();
  };

  const fetchModels = async () => {
    const validation = validateBaseUrl(cfg.baseUrl);
    if (validation) {
      setModels({ kind: 'error', message: validation });
      return;
    }
    setModels({ kind: 'loading', message: 'Fetching models...' });
    try {
      const modelUrl = joinUrl(cfg.baseUrl, '/models');
      // Use the key typed in this session, else the SAVED key — fetching models
      // must work right after reopening the editor (saved key, untouched field).
      let keyForRequest = keyTouched ? apiKey : '';
      if (!keyTouched && hasSavedKey) keyForRequest = (await getProviderKey(userId, cfg.id)) ?? '';
      if (isPlainHttpNonLoopback(modelUrl)) keyForRequest = '';
      const res = await fetchWithTimeout(modelUrl, { method: 'GET', headers: headersForDraft(cfg, keyForRequest) });
      if (!res.ok) throw new Error(describeHttpFailure('GET', modelUrl, res.status, keyForRequest !== ''));
      const ids = extractModelIds(await res.json().catch(() => null));
      setModels({
        kind: 'success',
        message: ids.length > 0 ? `Found ${ids.length} model${ids.length === 1 ? '' : 's'}.` : 'Models endpoint responded.',
        ids,
      });
    } catch (modelError) {
      setModels({ kind: 'error', message: modelError instanceof Error ? modelError.message : String(modelError) });
    }
  };

  const testService = async () => {
    setTest({ kind: 'loading', message: 'Testing service...' });
    const saved = await saveDraft(true);
    if (!saved) {
      setTest({ kind: 'error', message: 'Fix validation errors before testing.' });
      return;
    }
    const resolved = await resolveProviderRequest(userId, 'chat', saved.id);
    if (!resolved) {
      setTest({ kind: 'error', message: 'Service is disabled or not configured.' });
      return;
    }
    if (resolved.keyBlocked) {
      setTest({
        kind: 'error',
        message: 'The saved API key was withheld: this service uses unencrypted HTTP on a non-loopback host. Switch the base URL to https (or a loopback address).',
      });
      return;
    }
    // Did anything actually carry the key? (Authorization default, or a custom {{apiKey}} header.)
    const sentKey =
      Object.keys(resolved.headers).some((name) => name.toLowerCase() === 'authorization') ||
      (saved.headers ?? []).some((header) => hasApiKeyPlaceholder(header.name) || hasApiKeyPlaceholder(header.value));
    if ((savedKeyPresent || keyIsSet) && !sentKey) {
      // A key is on record but the vault couldn't read it — e.g. it was saved on a
      // different origin/protocol whose encryption mode this one can't open.
      setTest({
        kind: 'error',
        message: 'A key is saved for this service but could not be read in this browser context. Re-enter the API key and save again.',
      });
      return;
    }
    const modelsUrl = joinUrl(saved.baseUrl, '/models');
    let modelErrorText = '';
    try {
      const res = await fetchWithTimeout(modelsUrl, { method: 'GET', headers: resolved.headers });
      if (!res.ok) throw new Error(describeHttpFailure('GET', modelsUrl, res.status, sentKey));
      const ids = extractModelIds(await res.json().catch(() => null));
      setTest({
        kind: 'success',
        message: ids.length > 0 ? `Connected to ${modelsUrl}. Models: ${ids.slice(0, 4).join(', ')}` : `Connected to ${modelsUrl}.`,
        ids,
      });
      return;
    } catch (modelError) {
      modelErrorText = modelError instanceof Error ? modelError.message : String(modelError);
    }

    try {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
      if (saved.model) body.model = saved.model;
      const res = await fetchWithTimeout(resolved.url, { method: 'POST', headers: resolved.headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(describeHttpFailure('POST', resolved.url, res.status, sentKey));
      setTest({ kind: 'success', message: `Chat ping succeeded (${resolved.url}). Models listing was unavailable: ${modelErrorText}` });
    } catch (chatError) {
      const message = chatError instanceof Error ? chatError.message : String(chatError);
      setTest({ kind: 'error', message: `${modelErrorText} ${message}` });
    }
  };

  return (
    <section className="rounded-xl border border-primary-200/80 bg-primary-50/30 p-4 dark:border-primary-500/25 dark:bg-primary-500/5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Service details</h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Pick a different type below to restart from its defaults.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={testService} isLoading={test.kind === 'loading'}>
            Test connection
          </Button>
          <Button size="sm" onClick={saveAndClose}>Save service</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Back</Button>
        </div>
      </div>

      {softWarnings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {softWarnings.map((warning) => (
            <p key={warning} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {warning}
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(AI_PROVIDER_PRESETS) as AiProviderKind[]).map((kind) => {
          const item = AI_PROVIDER_PRESETS[kind];
          const selected = cfg.kind === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => applyPreset(kind)}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                selected
                  ? 'border-primary-300 bg-white text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-200'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
              )}
            >
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="mt-1 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">{item.description}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">Name</span>
          <input
            value={cfg.name}
            onChange={(event) => {
              setNameEdited(true);
              patchCfg({ name: event.target.value });
            }}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">Base URL</span>
          <input
            value={cfg.baseUrl}
            onChange={(event) => patchCfg({ baseUrl: event.target.value })}
            placeholder={preset.defaults.baseUrl}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
        </label>
        <div className="block md:col-span-2">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">Capabilities</span>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-slate-400">
            What this service offers. Flow steps only list services that support their capability -- a
            custom service is often chat-only or speech-only.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {AI_CAPABILITIES.map((capability) => {
              const active = (cfg.capabilities ?? AI_CAPABILITIES).includes(capability);
              return (
                <button
                  key={capability}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => toggleCapability(capability)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    active
                      ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-200'
                      : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-600',
                  )}
                >
                  {AI_CAPABILITY_LABELS[capability]}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block md:col-span-2">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">Model</span>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              value={cfg.model ?? ''}
              onChange={(event) => patchCfg({ model: event.target.value === '' ? undefined : event.target.value })}
              placeholder={modelPlaceholder(cfg.kind)}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
            />
            <Button type="button" size="sm" variant="outline" onClick={fetchModels} isLoading={models.kind === 'loading'} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
              Fetch models
            </Button>
          </div>
        </label>
        {models.kind !== 'idle' && (
          <div className="md:col-span-2">
            <InlineMessage state={models} />
            {models.ids && models.ids.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {models.ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => patchCfg({ model: id })}
                    className="rounded-full border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-gray-600 hover:border-primary-300 hover:text-primary-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-200"
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="block md:col-span-2">
          <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">API key</span>
          <div className="mt-1 flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder={hasSavedKey && !keyTouched ? '(saved)' : preset.keyRequired ? 'Required by this preset' : 'Optional'}
              onChange={(event) => {
                setApiKey(event.target.value);
                setKeyTouched(true);
              }}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
            />
            <Button type="button" size="iconOnly" variant="outline" onClick={() => setShowKey((open) => !open)} aria-label={showKey ? 'Hide API key' : 'Show API key'} title={showKey ? 'Hide API key' : 'Show API key'}>
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-slate-400">
            Stored only in this browser -- never sent to FormLogic servers. {keyStorageCopy}
          </p>
          {httpKeyWarning && <p className="mt-1 text-[11px] leading-snug text-amber-700 dark:text-amber-300">{httpKeyWarning}</p>}
        </label>
      </div>

      <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs text-gray-600 dark:bg-slate-900 dark:text-slate-300">
        {formatCorsHint(cfg.kind, origin)}
      </p>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="text-xs font-semibold text-primary-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-300"
        >
          {advancedOpen ? 'Hide advanced options' : 'Show advanced options'}
        </button>
        {advancedOpen && (
          <div className="mt-3 space-y-3 rounded-lg border border-gray-200/80 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-600 dark:text-slate-300">Extra headers</span>
                <Button type="button" size="sm" variant="outline" onClick={addHeader} leftIcon={<Plus className="h-3.5 w-3.5" />}>Add header</Button>
              </div>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">Header values may contain {'{{apiKey}}'}.</p>
              <div className="mt-2 space-y-2">
                {(cfg.headers ?? []).map((header, index) => (
                  <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto]">
                    <input
                      value={header.name}
                      onChange={(event) => setHeader(index, { name: event.target.value })}
                      placeholder="Header name"
                      className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                    />
                    <input
                      value={header.value}
                      onChange={(event) => setHeader(index, { value: event.target.value })}
                      placeholder="Header value"
                      className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                    />
                    <Button type="button" size="iconOnly" variant="ghost" onClick={() => removeHeader(index)} aria-label="Remove header">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <TextInput
                label="Chat path"
                value={cfg.chatPath ?? ''}
                placeholder="/chat/completions"
                onChange={(value) => patchCfg({ chatPath: value || undefined })}
                disabled={!(cfg.capabilities ?? AI_CAPABILITIES).includes('chat')}
                disabledHint="Chat capability is off"
              />
              <TextInput
                label="Transcription path"
                value={cfg.transcriptionPath ?? ''}
                placeholder="/audio/transcriptions"
                onChange={(value) => patchCfg({ transcriptionPath: value || undefined })}
                disabled={!(cfg.capabilities ?? AI_CAPABILITIES).includes('transcription')}
                disabledHint="Transcription capability is off"
              />
              <TextInput
                label="Speech path"
                value={cfg.speechPath ?? ''}
                placeholder="/audio/speech"
                onChange={(value) => patchCfg({ speechPath: value || undefined })}
                disabled={!(cfg.capabilities ?? AI_CAPABILITIES).includes('speech')}
                disabledHint="Speech capability is off"
              />
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">Request body template</span>
              <textarea
                value={cfg.requestTemplate ?? ''}
                onChange={(event) => patchCfg({ requestTemplate: event.target.value === '' ? undefined : event.target.value })}
                rows={5}
                spellCheck={false}
                placeholder={`{"model": {{model}}, "messages": {{messages}}}\n\nBare placeholders become JSON values. Available: ${TEMPLATE_PLACEHOLDERS}`}
                className="mt-1 w-full resize-y rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
              />
              <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-slate-400">
                Available placeholders: {TEMPLATE_PLACEHOLDERS}. Bare placeholders become JSON values.
              </p>
            </label>

            <TextInput
              label="Response path"
              value={cfg.responsePath ?? ''}
              placeholder="choices.0.message.content"
              onChange={(value) => patchCfg({ responsePath: value || undefined })}
            />
          </div>
        )}
      </div>

      {(error || test.kind !== 'idle') && (
        <div className="mt-4 space-y-2">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
          {test.kind !== 'idle' && <InlineMessage state={test} />}
        </div>
      )}
    </section>
  );
}

function TextInput({
  label,
  value,
  placeholder,
  onChange,
  disabled = false,
  disabledHint,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <label className={cn('block', disabled && 'opacity-60')}>
      <span className="block text-xs font-medium text-gray-600 dark:text-slate-300">{label}</span>
      <input
        value={value}
        placeholder={disabled ? disabledHint ?? placeholder : placeholder}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed dark:border-slate-600 dark:bg-slate-800 dark:text-white"
      />
    </label>
  );
}

function InlineMessage({ state }: { state: AsyncMessage }) {
  return (
    <p className={cn(
      'rounded-lg px-3 py-2 text-xs',
      state.kind === 'success' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
      state.kind === 'error' && 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
      state.kind === 'loading' && 'bg-gray-50 text-gray-600 dark:bg-slate-800 dark:text-slate-300',
    )}>
      {state.message}
    </p>
  );
}
