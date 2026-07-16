import { useCallback, useEffect, useState } from 'react';
import {
  aiProviders,
  type AiCapability,
  type AiProviderProfile,
  type AiProviderView,
  type AiProtocol,
} from './api';
import { AlertTriangleIcon, CheckIcon, TrashIcon } from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toasts';

/**
 * AI-407 — the "AI Providers" section of the Services workspace.
 *
 * External AI endpoints (OpenAI/ChatGPT, Anthropic, Ollama, LM Studio, or a
 * fully custom HTTP endpoint) live here as PROVIDERS, distinct from supervised
 * local processes. A provider carries a base URL, capabilities, custom headers,
 * and (for Custom) a request template + response path. The API key is stored in
 * the OS credential store and never returned — the UI only knows whether one is
 * set. The desktop AI Gateway (/api/ai/*) attaches the key server-side, so
 * flows and the receptionist can use cloud AI without ever holding the key.
 */

const CAPS: AiCapability[] = ['chat', 'transcription', 'speech', 'embeddings', 'realtime'];

const PRESETS: Record<string, Partial<AiProviderProfile>> = {
  openai: {
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    capabilities: ['chat', 'transcription', 'speech', 'embeddings', 'realtime'],
    allowLocal: false,
  },
  anthropic: {
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    capabilities: ['chat'],
    allowLocal: false,
  },
  ollama: {
    name: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434',
    capabilities: ['chat', 'embeddings'],
    allowLocal: true,
  },
  lmstudio: {
    name: 'LM Studio (local)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234',
    capabilities: ['chat'],
    allowLocal: true,
  },
  custom: {
    name: 'Custom HTTP',
    protocol: 'custom',
    baseUrl: 'https://',
    capabilities: ['chat'],
    allowLocal: false,
  },
};

export default function AiProvidersPanel() {
  const [providers, setProviders] = useState<AiProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AiProviderProfile | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const toast = useToast();
  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const { providers } = await aiProviders.list();
      setProviders(providers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onTest = useCallback(
    async (id: string) => {
      setTesting(id);
      try {
        const r = await aiProviders.test(id);
        toast.push(
          r.ok
            ? { kind: 'success', title: `"${id}" reachable`, body: 'Endpoint answered and the key (if set) is accepted.' }
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
          <button className="btn btn-secondary" onClick={() => setEditing(blankProfile())}>
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
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {providers?.length === 0 && !editing && (
        <div className="empty-state">
          No AI providers yet. Add one to use ChatGPT or any custom endpoint with your own key.
        </div>
      )}
      {providers?.map((p) => (
        <div key={p.id} className="service-card">
          <div className="service-row">
            <div className="service-info">
              <div className="service-name">
                {p.name}
                <span className="badge badge-neutral">{p.protocol}</span>
                {p.hasKey ? (
                  <span className="badge badge-ok" title="An API key is stored for this provider">
                    <CheckIcon className="inline-icon icon-leading" size={11} />
                    key set
                  </span>
                ) : (
                  <span className="badge badge-neutral">no key</span>
                )}
                {!p.enabled && <span className="badge badge-neutral">disabled</span>}
                {p.allowLocal && <span className="badge badge-neutral">local</span>}
              </div>
              <div className="service-meta">
                {p.baseUrl}
                {p.model && <> · model {p.model}</>}
                {p.capabilities.length > 0 && <> · {p.capabilities.join(', ')}</>}
              </div>
            </div>
            <div className="service-actions">
              <button
                className="btn btn-secondary"
                disabled={testing === p.id}
                onClick={() => void onTest(p.id)}
              >
                {testing === p.id ? 'Testing…' : 'Test'}
              </button>
              <button className="btn btn-ghost" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button
                className="btn btn-ghost btn-danger"
                aria-label={`Remove ${p.name}`}
                onClick={async () => {
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
              >
                <TrashIcon size={15} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function blankProfile(): AiProviderProfile {
  return {
    id: '',
    name: '',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    model: '',
    capabilities: ['chat'],
    headers: [],
    allowLocal: false,
    enabled: true,
  };
}

function ProviderForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: AiProviderProfile;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isNew = !initial.id;
  const [p, setP] = useState<AiProviderProfile>({ ...initial });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const applyPreset = (preset: string) => {
    const base = PRESETS[preset];
    if (!base) return;
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

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { id } = await aiProviders.upsert({ ...p, id: p.id.trim().toLowerCase() });
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
            <option value="openai">OpenAI (ChatGPT API)</option>
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
          <span>Protocol</span>
          <select value={p.protocol} onChange={(e) => setP({ ...p, protocol: e.target.value as AiProtocol })}>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="custom">Custom HTTP</option>
          </select>
        </label>
        <label className="form-row">
          <span>Default model</span>
          <input type="text" value={p.model ?? ''} onChange={(e) => setP({ ...p, model: e.target.value })} placeholder="gpt-4o-mini" />
        </label>
      </div>
      <label className="form-row">
        <span>Base URL</span>
        <input
          type="text"
          spellCheck={false}
          value={p.baseUrl}
          onChange={(e) => setP({ ...p, baseUrl: e.target.value })}
          placeholder="https://api.openai.com"
          required
        />
      </label>
      <label className="form-row">
        <span>API key {initial.id && '(leave blank to keep the stored key)'}</span>
        <input
          type="password"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={initial.id ? '•••••• (unchanged)' : 'sk-…'}
          autoComplete="off"
        />
      </label>
      <div className="form-row">
        <span>Capabilities</span>
        <div className="cap-checks">
          {CAPS.map((c) => (
            <label key={c} className="cap-check">
              <input type="checkbox" checked={p.capabilities.includes(c)} onChange={() => toggleCap(c)} />
              {c}
            </label>
          ))}
        </div>
      </div>
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
        <button type="submit" className="btn btn-primary" disabled={busy || !p.id.trim() || !p.baseUrl.trim()}>
          {busy ? 'Saving…' : 'Save provider'}
        </button>
      </div>
    </form>
  );
}
