import { useCallback, useEffect, useState } from 'react';
import {
  aiProviders,
  type AiCapability,
  type AiProviderProfile,
  type AiProviderView,
  type AiProtocol,
} from './api';
import { PANEL_CACHE_KEYS, getPanelCache, setPanelCache } from './panelCache';
import { AlertTriangleIcon, CheckIcon, TrashIcon } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toasts';

/**
 * AI-407 — the "AI Providers" section of the Services workspace.
 *
 * External AI endpoints (OpenAI Platform API, Anthropic, Ollama, LM Studio, or a
 * fully custom HTTP endpoint) live here as PROVIDERS, distinct from supervised
 * local processes. A provider carries a base URL, capabilities, custom headers,
 * and (for Custom) a request template + response path. The API key is stored in
 * the OS credential store and never returned — the UI only knows whether one is
 * set. The desktop AI Gateway (/api/ai/*) attaches the key server-side, so
 * flows and the receptionist can use cloud AI without ever holding the key.
 */

const CAPS: AiCapability[] = ['chat', 'transcription', 'speech', 'embeddings', 'realtime'];

/**
 * What each capability means to the GATEWAY (it routes a request to the first
 * enabled provider whose capability set matches). Only chat (+ model listing)
 * has routes today — the rest are persisted and light up when the streaming/
 * audio routes land (AI-405/406), so they're shown but marked dormant.
 */
const CAP_INFO: Record<AiCapability, { label: string; desc: string; served: boolean }> = {
  chat: { label: 'Chat', desc: 'Text generation — flows and receptionist replies.', served: true },
  transcription: { label: 'Transcription', desc: 'Speech-to-text.', served: false },
  speech: { label: 'Speech', desc: 'Text-to-speech.', served: false },
  embeddings: { label: 'Embeddings', desc: 'Vector embeddings.', served: false },
  realtime: { label: 'Realtime', desc: 'Realtime voice sessions.', served: false },
};

const PRESETS: Record<string, Partial<AiProviderProfile>> = {
  openai: {
    name: 'OpenAI API',
    category: 'Cloud AI APIs',
    tags: ['openai', 'llm', 'chat'],
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    capabilities: ['chat', 'transcription', 'speech', 'embeddings', 'realtime'],
    allowLocal: false,
  },
  anthropic: {
    name: 'Anthropic',
    category: 'Cloud AI APIs',
    tags: ['anthropic', 'llm', 'chat'],
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    capabilities: ['chat'],
    allowLocal: false,
  },
  ollama: {
    name: 'Ollama (local)',
    category: 'Local AI APIs',
    tags: ['ollama', 'local', 'llm'],
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434',
    capabilities: ['chat', 'embeddings'],
    allowLocal: true,
  },
  lmstudio: {
    name: 'LM Studio (local)',
    category: 'Local AI APIs',
    tags: ['lm-studio', 'local', 'llm'],
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234',
    capabilities: ['chat'],
    allowLocal: true,
  },
  custom: {
    name: 'Custom HTTP',
    category: 'Custom AI APIs',
    tags: ['custom', 'http'],
    protocol: 'custom',
    baseUrl: '',
    capabilities: ['chat'],
    allowLocal: false,
  },
};

function parseProviderTags(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => {
      const normalized = tag.toLocaleLowerCase();
      if (!tag || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

export default function AiProvidersPanel() {
  // Seed from the module-level cache (app-start prefetch / last visit) so the
  // section paints instantly instead of popping in on every Services visit.
  const [providers, setProviders] = useState<AiProviderView[] | null>(
    () =>
      getPanelCache<{ providers: AiProviderView[] }>(PANEL_CACHE_KEYS.aiProviders)?.providers ??
      null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AiProviderProfile | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const toast = useToast();
  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const res = await aiProviders.list();
      setPanelCache(PANEL_CACHE_KEYS.aiProviders, res);
      setProviders(res.providers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onTest = useCallback(
    async (id: string, protocol: AiProtocol) => {
      setTesting(id);
      try {
        const r = await aiProviders.test(id);
        // Honest copy per protocol: only the OpenAI-protocol test actually
        // contacts the server (it lists models); Anthropic/Custom tests
        // validate the URL against the egress policy without a request.
        toast.push(
          r.ok
            ? {
                kind: 'success',
                title: `"${id}" looks good`,
                body:
                  protocol === 'openai'
                    ? 'Endpoint answered and the key (if set) is accepted.'
                    : "URL and egress policy check out — this protocol's test doesn't contact the server.",
              }
            : { kind: 'error', title: `"${id}" test failed` },
        );
      } catch (e) {
        toast.push({ kind: 'error', title: `"${id}" test failed`, body: e instanceof Error ? e.message : String(e) });
      } finally {
        setTesting(null);
      }
    },
    [toast],
  );

  return (
    <section className="service-section">
      <div className="section-title-row">
        <h3 className="section-title">AI Providers</h3>
        {!editing && (
          <button className="btn btn-secondary" onClick={() => setEditing(createBlankAiProviderProfile())}>
            + Add provider
          </button>
        )}
      </div>
      <div className="datadir-note">
        Connect an external AI service — OpenAI, Anthropic, a local Ollama/LM Studio, or a fully
        custom HTTP endpoint. Flows and the receptionist reach it through the desktop AI gateway;
        your API key is stored in the OS credential store and never leaves this machine.
      </div>
      {error && (
        <div className="banner banner-err">Couldn't load AI providers: {error}</div>
      )}
      {editing && (
        <ProviderForm
          // Keyed on the edited provider so switching Edit targets REMOUNTS the
          // form (useState initializers re-run) — without this, form state from
          // provider A stays on screen while the id-bearing handlers (Remove
          // stored key, Fetch models, Save) act on provider B.
          key={editing.id || 'new'}
          initial={editing}
          onCancel={() => setEditing(null)}
          onKeyRemoved={() => void refresh()}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {providers?.length === 0 && !editing && (
        <div className="empty-state">
          No AI providers yet. Add an API endpoint to use it with your own provider key.
        </div>
      )}
      {providers?.map((p) => (
        <AiProviderCard
          key={p.id}
          provider={p}
          testing={testing === p.id}
          onTest={() => void onTest(p.id, p.protocol)}
          onEdit={() => setEditing(p)}
          onRemove={async () => {
            const ok = await confirm({
              title: `Remove "${p.name}"?`,
              body: 'The provider config and its stored API key are deleted.',
              confirmLabel: 'Remove',
              danger: true,
            });
            if (!ok) return;
            try {
              await aiProviders.remove(p.id);
              await refresh();
              toast.push({ kind: 'success', title: `"${p.name}" removed` });
            } catch (e) {
              toast.push({ kind: 'error', title: 'Remove failed', body: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      ))}
    </section>
  );
}

export function AiProviderCard({
  provider,
  displayName,
  description,
  status,
  kind,
  tags = [],
  testing,
  onTest,
  onEdit,
  onRemove,
}: {
  provider: AiProviderView;
  displayName?: string;
  description?: string;
  status?: string;
  kind?: string;
  tags?: string[];
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void | Promise<void>;
}) {
  return (
    <div className="service-card service-center-card">
      <div className="service-row">
        <div className="service-info">
          <div className="service-name">
            {displayName ?? provider.name}
            <span className="badge badge-neutral">{provider.protocol}</span>
            {kind && <span className="badge badge-neutral">{kind}</span>}
            {status && (
              <span className={`badge ${status === 'configured' ? 'badge-ok' : 'badge-neutral'}`}>
                {status.replace('-', ' ')}
              </span>
            )}
            {provider.hasKey ? (
              <span className="badge badge-ok" title="An API key is stored for this provider">
                <CheckIcon className="inline-icon icon-leading" size={11} />
                key set
              </span>
            ) : (
              <span className="badge badge-neutral">no key</span>
            )}
            {!provider.enabled && <span className="badge badge-neutral">disabled</span>}
          </div>
          {description && <div className="service-desc">{description}</div>}
          <div className="service-meta">
            {provider.baseUrl}
            {provider.model && <> · model {provider.model}</>}
            <> · {provider.capabilities.length > 0 ? provider.capabilities.join(', ') : 'all capabilities'}</>
          </div>
          {tags.length > 0 && (
            <div className="service-center-tags" aria-label="Tags">
              {tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          )}
        </div>
        <div className="service-actions">
          <button className="btn btn-secondary" disabled={testing} onClick={onTest}>
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button className="btn btn-ghost" onClick={onEdit}>Edit</button>
          <button
            className="btn btn-ghost btn-danger"
            aria-label={`Remove ${provider.name}`}
            onClick={() => void onRemove()}
          >
            <TrashIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function createBlankAiProviderProfile(): AiProviderProfile {
  return {
    id: '',
    name: '',
    category: 'Cloud AI APIs',
    tags: [],
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    model: '',
    capabilities: ['chat'],
    headers: [],
    allowLocal: false,
    enabled: true,
  };
}

export function ProviderForm({
  initial,
  onCancel,
  onKeyRemoved,
  onSaved,
}: {
  initial: AiProviderProfile;
  onCancel: () => void;
  onKeyRemoved: () => void;
  onSaved: () => void;
}) {
  const isNew = !initial.id;
  // Editing an existing provider passes the AiProviderView through, so hasKey
  // is available; a new profile never has a stored key.
  const [hasStoredKey, setHasStoredKey] = useState(
    (initial as Partial<AiProviderView>).hasKey === true,
  );
  // A legacy provider saved with an EMPTY capability set matches everything
  // (supports() rule) — seed the form with the explicit equivalent so the
  // ≥1-capability guard can't force a silent narrowing on re-save.
  const [p, setP] = useState<AiProviderProfile>({
    ...initial,
    capabilities: initial.capabilities.length > 0 ? initial.capabilities : [...CAPS],
  });
  const [key, setKey] = useState('');
  const [tagsText, setTagsText] = useState((initial.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Models discovered through the gateway's per-provider /v1/models proxy —
  // offered as datalist suggestions so the model doesn't have to be typed blind.
  const [modelOptions, setModelOptions] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const toast = useToast();
  const { confirm } = useConfirm();

  const applyPreset = (preset: string) => {
    const base = PRESETS[preset];
    if (!base) return;
    if (base.tags) setTagsText(base.tags.join(', '));
    setP((cur) => ({
      ...cur,
      ...base,
      id: cur.id || preset,
      capabilities: base.capabilities ?? cur.capabilities,
    }));
  };

  const toggleCap = (c: AiCapability) =>
    setP((cur) => ({
      ...cur,
      capabilities: cur.capabilities.includes(c)
        ? cur.capabilities.filter((x) => x !== c)
        : [...cur.capabilities, c],
    }));

  const spec = p.specs?.chat ?? {};
  const setSpec = (patch: Partial<{ path: string; requestTemplate: string; responsePath: string }>) =>
    setP((cur) => {
      const next = { ...(cur.specs?.chat ?? {}), ...patch };
      // Drop empty fields; an all-empty mapping means "use the defaults".
      const cleaned = Object.fromEntries(
        Object.entries(next).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
      );
      const specs = { ...(cur.specs ?? {}) };
      if (Object.keys(cleaned).length === 0) {
        delete specs.chat;
      } else {
        specs.chat = cleaned;
      }
      return { ...cur, specs: Object.keys(specs).length > 0 ? specs : undefined };
    });

  const setHeader = (index: number, patch: Partial<{ name: string; value: string }>) =>
    setP((current) => ({
      ...current,
      headers: current.headers.map((header, headerIndex) =>
        headerIndex === index ? { ...header, ...patch } : header,
      ),
    }));

  const removeHeader = (index: number) =>
    setP((current) => ({
      ...current,
      headers: current.headers.filter((_, headerIndex) => headerIndex !== index),
    }));

  const onFetchModels = async () => {
    if (fetchingModels) return;
    setFetchingModels(true);
    try {
      const res = await aiProviders.modelsFor(initial.id);
      const ids = (res.data ?? []).map((m) => m.id).filter(Boolean);
      setModelOptions(ids);
      toast.push(
        ids.length > 0
          ? { kind: 'success', title: `${ids.length} model(s) found`, body: 'Pick one from the model field suggestions.' }
          : { kind: 'error', title: 'The endpoint listed no models' },
      );
    } catch (e) {
      toast.push({ kind: 'error', title: 'Model listing failed', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setFetchingModels(false);
    }
  };

  const onRemoveKey = async () => {
    const ok = await confirm({
      title: 'Remove the stored API key?',
      body: 'Requests to this provider will be sent without a key until a new one is saved.',
      confirmLabel: 'Remove key',
      danger: true,
    });
    if (!ok) return;
    try {
      await aiProviders.setKey(initial.id, null);
      setHasStoredKey(false);
      setKey('');
      // The list renders hasKey from the parent's providers array — refresh it
      // now so the "key set" badge doesn't keep lying if the form is cancelled.
      onKeyRemoved();
      toast.push({ kind: 'success', title: 'Stored key removed' });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Remove key failed', body: e instanceof Error ? e.message : String(e) });
    }
  };

  // The gateway treats an EMPTY capability set as "supports everything"
  // (legacy rule) — the inverse of what an all-unchecked form implies, so the
  // form requires at least one explicit pick.
  const noCaps = p.capabilities.length === 0;
  const plainHttpWarning = !p.allowLocal && p.baseUrl.trim().toLowerCase().startsWith('http://');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { id } = await aiProviders.upsert({
        ...p,
        id: p.id.trim().toLowerCase(),
        category: p.category?.trim() || undefined,
        tags: parseProviderTags(tagsText),
      });
      if (key.trim()) {
        await aiProviders.setKey(id, key.trim());
      }
      toast.push({ kind: 'success', title: `Provider "${p.name || id}" saved` });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="dl-form service-card" onSubmit={onSubmit}>
      <div className="section-title-row">
        <h3 className="section-title">{isNew ? 'Add AI provider' : `Edit ${initial.name}`}</h3>
        <button type="button" className="btn-tiny" onClick={onCancel}>
          cancel
        </button>
      </div>
      {isNew && (
        <label className="form-row">
          <span>Start from a preset</span>
          <select onChange={(e) => applyPreset(e.target.value)} defaultValue="">
            <option value="" disabled>
              — choose —
            </option>
            <option value="openai">OpenAI API (Platform billing; separate from ChatGPT)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="ollama">Ollama (local)</option>
            <option value="lmstudio">LM Studio (local)</option>
            <option value="custom">Custom HTTP</option>
          </select>
        </label>
      )}
      <div className="form-row-pair">
        <label className="form-row">
          <span>ID (lowercase)</span>
          <input
            type="text"
            value={p.id}
            disabled={!isNew}
            onChange={(e) => setP({ ...p, id: e.target.value })}
            placeholder="openai"
            required
          />
        </label>
        <label className="form-row">
          <span>Display name</span>
          <input type="text" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="OpenAI" />
        </label>
      </div>
      <div className="form-row-pair">
        <label className="form-row">
          <span>Category</span>
          <input
            type="text"
            value={p.category ?? ''}
            onChange={(e) => setP({ ...p, category: e.target.value })}
            placeholder="Cloud AI APIs"
          />
        </label>
        <label className="form-row">
          <span>Tags (comma-separated)</span>
          <input
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="llm, chat, production"
          />
        </label>
      </div>
      <label className="form-row">
        <span>Protocol</span>
        <select value={p.protocol} onChange={(e) => setP({ ...p, protocol: e.target.value as AiProtocol })}>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="custom">Custom HTTP</option>
        </select>
      </label>
      <label className="form-row">
        <span>Default model (optional)</span>
        <div className="input-with-action">
          <input
            type="text"
            value={p.model ?? ''}
            onChange={(e) => setP({ ...p, model: e.target.value })}
            list={!isNew && modelOptions ? `ai-models-${initial.id}` : undefined}
          />
          {!isNew && p.protocol === 'openai' && (
            <button type="button" className="btn-tiny" onClick={() => void onFetchModels()} disabled={fetchingModels}>
              {fetchingModels ? 'Fetching…' : 'Fetch models'}
            </button>
          )}
        </div>
        {!isNew && modelOptions && (
          <datalist id={`ai-models-${initial.id}`}>
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
        <span className="form-hint">
          Used only when a request doesn't name a model — leave blank to let each request choose.
          {!isNew && p.protocol === 'openai' && ' Fetch models asks the endpoint what it serves.'}
        </span>
      </label>
      <label className="form-row">
        <span>Base URL</span>
        <input
          type="text"
          spellCheck={false}
          value={p.baseUrl}
          onChange={(e) => setP({ ...p, baseUrl: e.target.value })}
          placeholder="https://…"
          required
        />
        {plainHttpWarning && (
          <span className="form-hint warn">
            Public endpoints must use https — tick "local endpoint" below for loopback / private hosts.
          </span>
        )}
      </label>
      <label className="form-row">
        <span>API key {hasStoredKey && '(leave blank to keep the stored key)'}</span>
        <div className="input-with-action">
          <input
            type="password"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasStoredKey ? '•••••• (unchanged)' : 'sk-…'}
            autoComplete="off"
          />
          {hasStoredKey && (
            <button type="button" className="btn-tiny btn-danger" onClick={() => void onRemoveKey()}>
              Remove stored key
            </button>
          )}
        </div>
      </label>
      <div className="form-row">
        <span>Capabilities</span>
        <div className="cap-checks cap-checks--stacked">
          {CAPS.map((c) => {
            const info = CAP_INFO[c];
            return (
              <label key={c} className="cap-check">
                <input type="checkbox" checked={p.capabilities.includes(c)} onChange={() => toggleCap(c)} />
                <span className="cap-check__text">
                  <span className="cap-check__name">{info.label}</span>
                  <span className="cap-check__desc">
                    {info.desc}
                    {!info.served && ' Not yet served by the desktop gateway.'}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {noCaps && (
          <span className="form-hint warn">
            Pick at least one capability — an empty set would match every request.
          </span>
        )}
      </div>
      {p.protocol === 'custom' && (
        <details className="custom-mapping">
          <summary>Request mapping (advanced)</summary>
          <label className="form-row">
            <span>Chat endpoint path</span>
            <input
              type="text"
              spellCheck={false}
              value={spec.path ?? ''}
              onChange={(e) => setSpec({ path: e.target.value })}
              placeholder="/v1/chat/completions"
            />
          </label>
          <label className="form-row">
            <span>Request template (JSON)</span>
            <textarea
              rows={4}
              spellCheck={false}
              value={spec.requestTemplate ?? ''}
              onChange={(e) => setSpec({ requestTemplate: e.target.value })}
              placeholder={'{"model":"{{model}}","messages":{{messages}}}'}
            />
            <span className="form-hint">
              Tokens: {'{{model}}'}, {'{{messages}}'}, {'{{prompt}}'}, {'{{input}}'}. Credentials
              cannot be placed in a request body; Desktop injects them into headers only. Leave blank
              to send the OpenAI-compatible body unchanged.
            </span>
          </label>
          <label className="form-row">
            <span>Response path</span>
            <input
              type="text"
              spellCheck={false}
              value={spec.responsePath ?? ''}
              onChange={(e) => setSpec({ responsePath: e.target.value })}
              placeholder="choices.0.message.content"
            />
            <span className="form-hint">
              Dotted path to the reply text in the endpoint's JSON response.
            </span>
          </label>
        </details>
      )}
      <details className="custom-mapping">
        <summary>Headers &amp; credential mapping (advanced)</summary>
        <div className="datadir-note">
          Add non-secret headers here. To send the key held in the OS credential store, use{' '}
          <code>{'{{apiKey}}'}</code> in a header value, for example{' '}
          <code>Authorization: Bearer {'{{apiKey}}'}</code>. Never paste a secret into this table.
        </div>
        {p.headers.length === 0 && (
          <div className="form-hint">
            With no custom authorization header, Desktop uses Bearer authentication automatically.
          </div>
        )}
        {p.headers.map((header, index) => (
          <div className="form-row-pair" key={`header-${index}`}>
            <label className="form-row">
              <span>Header name</span>
              <input
                type="text"
                spellCheck={false}
                value={header.name}
                onChange={(e) => setHeader(index, { name: e.target.value })}
                placeholder="X-API-Key"
              />
            </label>
            <label className="form-row">
              <span>Header value</span>
              <div className="input-with-action">
                <input
                  type="text"
                  spellCheck={false}
                  value={header.value}
                  onChange={(e) => setHeader(index, { value: e.target.value })}
                  placeholder="{{apiKey}}"
                />
                <button
                  type="button"
                  className="btn-tiny btn-danger"
                  aria-label={`Remove header ${index + 1}`}
                  onClick={() => removeHeader(index)}
                >
                  Remove
                </button>
              </div>
            </label>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setP((current) => ({
            ...current,
            headers: [...current.headers, { name: '', value: '' }],
          }))}
        >
          + Add header
        </button>
      </details>
      <label className="cap-check">
        <input type="checkbox" checked={p.allowLocal} onChange={(e) => setP({ ...p, allowLocal: e.target.checked })} />
        This is a local endpoint (allow loopback / private / plaintext http)
      </label>
      <label className="cap-check">
        <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} />
        Enabled
      </label>
      {err && (
        <div className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {err}
        </div>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !p.id.trim() || !p.baseUrl.trim() || noCaps}
        >
          {busy ? 'Saving…' : 'Save provider'}
        </button>
      </div>
    </form>
  );
}
