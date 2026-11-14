import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

/** A choice of where something runs on the administrator's OAIY: the computer, the provider on it, and its model. */
export interface OaiyTarget {
  connectionId: string;
  providerId: string;
  /** Null for OAIY's own engine, which answers with the model chosen in OAIY. */
  model: string | null;
}

type Candidate = { connectionId: string; instanceId: string; deviceName: string; fingerprint: string; online: boolean };

/**
 * One of the administrator's linked OAIY computers, then a provider on it and that provider's
 * model, each listed by asking the computer now. OAIY's own engine needs no model here: it uses
 * the one chosen in OAIY. `onChange` hears a complete choice, or null while it is not one.
 */
export function OaiyTargetPicker({ candidates, name, onChange, disabled, engineHint }: {
  candidates: Candidate[];
  /** Tells this picker's radios apart from another's on the same page. */
  name: string;
  onChange: (target: OaiyTarget | null) => void;
  disabled?: boolean;
  /** What to say about OAIY's own engine for this use. */
  engineHint?: string;
}) {
  const [connectionId, setConnectionId] = useState('');
  const [providers, setProviders] = useState<Array<{ id: string; label: string; model: string | null }> | null>(null);
  const [engine, setEngine] = useState('oaiy-engine');
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }> | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'providers' | 'models' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const complete = connectionId !== '' && providerId !== '' && (providerId === engine || model !== '');
    onChange(complete ? { connectionId, providerId, model: providerId === engine ? null : model } : null);
  }, [connectionId, providerId, model, engine, onChange]);

  // The listing asked for now, let go when another is asked, the picker goes, or the page closes (followListing sends
  // its letGo with keepalive): a computer is not kept listing, and an owner's place held, for nobody.
  const asking = useRef<AbortController | null>(null);
  const ask = () => {
    asking.current?.abort();
    const next = new AbortController();
    asking.current = next;
    return next.signal;
  };
  useEffect(() => {
    const leaving = () => asking.current?.abort();
    window.addEventListener('pagehide', leaving);
    return () => {
      window.removeEventListener('pagehide', leaving);
      asking.current?.abort();
    };
  }, []);

  const pickComputer = async (id: string) => {
    setConnectionId(id);
    setProviders(null);
    setProviderId('');
    setModels(null);
    setModel('');
    setError(null);
    setBusy('providers');
    const signal = ask();
    const result = await api.adminOaiyProviders(id, signal);
    if (signal.aborted) return;
    setBusy(null);
    if (result.error || !result.data) { setError(result.error ?? 'That computer did not answer.'); return; }
    setEngine(result.data.engineProvider);
    setProviders(result.data.providers);
  };
  const pickProvider = async (id: string) => {
    setProviderId(id);
    setModels(null);
    setModel('');
    setError(null);
    if (id === '' || id === engine) return;
    setBusy('models');
    const signal = ask();
    const result = await api.adminOaiyModels(connectionId, id, signal);
    if (signal.aborted) return;
    setBusy(null);
    if (result.error || !result.data) { setError(result.error ?? 'That provider did not list its models.'); return; }
    // Chat and reading pictures need a language model: a picture or video model cannot answer.
    setModels(result.data.models.filter((m) => m.type !== 'image' && m.type !== 'video'));
  };

  const select = 'block min-h-10 rounded-lg border border-gray-300 bg-white px-2.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
  return (
    <fieldset className="space-y-2" disabled={disabled || busy !== null}>
      <legend className="sr-only">Your linked computers</legend>
      {candidates.map((candidate) => (
        <label key={candidate.connectionId} className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="radio" name={name} className="mt-1" checked={connectionId === candidate.connectionId} onChange={() => void pickComputer(candidate.connectionId)} />
          <span>
            <span className="font-medium text-gray-900 dark:text-white">{candidate.deviceName || candidate.instanceId}</span>
            <span className={candidate.online ? 'ml-2 text-xs text-green-700 dark:text-green-300' : 'ml-2 text-xs text-gray-400'}>{candidate.online ? 'online' : 'offline'}</span>
            <span className="block text-xs text-gray-500 dark:text-slate-400">key {candidate.fingerprint}</span>
          </span>
        </label>
      ))}
      {busy === 'providers' && <p role="status" className="text-sm text-gray-500">Asking the computer what it offers…</p>}
      {providers && (
        <div className="space-y-1">
          <label htmlFor={`${name}-provider`} className="text-sm font-medium text-gray-700 dark:text-slate-300">Provider</label>
          <select id={`${name}-provider`} value={providerId} onChange={(e) => void pickProvider(e.target.value)} className={select}>
            <option value="">Choose…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}{p.id === engine && p.model ? ` (${p.model})` : ''}</option>)}
          </select>
          {providers.length === 0 && <p className="text-xs text-gray-500 dark:text-slate-400">This computer has no provider that chats. Add one in OAIY, or choose a model in OAIY&apos;s Engines.</p>}
          {providerId === engine && <p className="text-xs text-gray-500 dark:text-slate-400">{engineHint ?? 'OAIY\'s own engine answers with the model chosen in OAIY\'s Engines.'}</p>}
        </div>
      )}
      {busy === 'models' && <p role="status" className="text-sm text-gray-500">Listing its models…</p>}
      {models && (
        <div className="space-y-1">
          <label htmlFor={`${name}-model`} className="text-sm font-medium text-gray-700 dark:text-slate-300">Model</label>
          <select id={`${name}-model`} value={model} onChange={(e) => setModel(e.target.value)} className={select}>
            <option value="">Choose…</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </fieldset>
  );
}
