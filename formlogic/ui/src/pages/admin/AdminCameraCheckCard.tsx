import { useEffect, useState } from 'react';
import { Camera } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { CameraCheckPanel } from '../../components/plugins/CameraCheckPanel';
import { api, type AdminCameraCheckState } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { InstalledPlugin } from '../../types/app';

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Which AI reads the pictures of the camera checks plugins use: one of your linked OAIY computers,
 * and a provider on it, listed by asking the computer now. OAIY's own engine answers with the model
 * chosen in OAIY; another provider, with the model picked here. Then: does it read images (one
 * control picture), and the whole check tried on yourself, with the model's answer shown.
 */
export function AdminCameraCheckCard({ plugins }: { plugins: InstalledPlugin[] }) {
  const [state, setState] = useState<AdminCameraCheckState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [providers, setProviders] = useState<Array<{ id: string; label: string; model: string | null }> | null>(null);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }> | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [plugin, setPlugin] = useState(plugins[0]?.manifestId ?? '');
  const [probe, setProbe] = useState<string | null>(null);
  const [trial, setTrial] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.adminGetCameraCheck().then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setError(result.error ?? 'Could not read this setting.'); return; }
      setState(result.data);
    });
    return () => { cancelled = true; };
  }, [revision]);

  const listProviders = async (id: string) => {
    setConnectionId(id);
    setProviders(null);
    setProviderId('');
    setModels(null);
    setBusy('providers');
    const result = await api.adminCameraCheckProviders(id);
    setBusy(null);
    if (result.error || !result.data) { toast.error('That computer did not answer', result.error ?? ''); return; }
    setProviders(result.data.providers);
  };
  const listModels = async (id: string) => {
    setProviderId(id);
    setModels(null);
    setModel('');
    if (!state || id === state.engineProvider) return;
    setBusy('models');
    const result = await api.adminCameraCheckModels(connectionId, id);
    setBusy(null);
    if (result.error || !result.data) { toast.error('That provider did not list its models', result.error ?? ''); return; }
    setModels(result.data.models);
  };
  const save = async () => {
    setBusy('save');
    const result = await api.adminPutCameraCheck({ connectionId, providerId, model: providerId === state?.engineProvider ? null : model });
    setBusy(null);
    if (result.error) { toast.error('Not saved', result.error); return; }
    toast.success('Camera checks are set up');
    setProviders(null);
    setRevision((n) => n + 1);
  };
  const turnOff = async () => {
    setBusy('off');
    const result = await api.adminDeleteCameraCheck();
    setBusy(null);
    if (result.error) { toast.error('Not turned off', result.error); return; }
    setRevision((n) => n + 1);
  };
  const runProbe = async () => {
    setProbe('Sending a control picture to the model…');
    const started = await api.adminProbeCameraCheck(plugin);
    if (started.error || !started.data) { setProbe(started.error ?? 'The test could not start.'); return; }
    let current = started.data;
    const until = Date.now() + 600_000;
    while (current.status !== 'done' && Date.now() < until) {
      await sleep(2500);
      const next = await api.getCameraCheck(current.id);
      if (next.data) current = next.data;
    }
    setProbe(current.message ?? 'The test ended.');
  };

  if (!state) return error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  const current = state.current;
  const chosenPlugin = plugins.find((p) => p.manifestId === plugin) ?? plugins[0];
  const canSave = connectionId !== '' && providerId !== '' && (providerId === state.engineProvider || model !== '');

  return (
    <Card>
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2"><Camera className="h-4 w-4" aria-hidden="true" />Camera checks</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            {plugins.map((p) => p.name).join(', ')} use{plugins.length === 1 ? 's' : ''} the camera. The pictures are read by an AI on one of your computers running OAIY:
            sealed to it, deleted once read, and never seen by the plugin. Choose a model that reads images.
            Some OAIY engines keep a model's working state on disk; turning on OAIY&apos;s privacy (incognito) setting stops that.
          </p>
        </div>
        {current && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm dark:bg-green-500/10">
            <span className="text-green-900 dark:text-green-200">
              Read on <strong>{current.deviceName || 'your computer'}</strong> · {current.providerId === state.engineProvider ? 'OAIY\'s own engine, with the model chosen in OAIY' : `${current.providerId}: ${current.model}`} · key {current.fingerprint}
              {current.online ? '' : ' · offline now'}
            </span>
            <Button size="sm" variant="outline" isLoading={busy === 'off'} onClick={() => void turnOff()}>Turn off</Button>
          </div>
        )}
        {state.candidates.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">None of your linked computers has published its chat key. Link OAIY on your computer in Settings → AI &amp; devices, open it, and come back.</p>
        ) : (
          <fieldset className="space-y-2" disabled={busy !== null}>
            <legend className="text-sm font-medium text-gray-700 dark:text-slate-300">{current ? 'Change where they are read' : 'Where the pictures are read'}</legend>
            {state.candidates.map((candidate) => (
              <label key={candidate.connectionId} className="flex cursor-pointer items-start gap-3 text-sm">
                <input type="radio" name="camera-check-computer" className="mt-1" checked={connectionId === candidate.connectionId} onChange={() => void listProviders(candidate.connectionId)} />
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
                <label htmlFor="camera-check-provider" className="text-sm font-medium text-gray-700 dark:text-slate-300">Provider</label>
                <select id="camera-check-provider" value={providerId} onChange={(e) => void listModels(e.target.value)}
                  className="block min-h-10 rounded-lg border border-gray-300 bg-white px-2.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
                  <option value="">Choose…</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.label}{p.id === state.engineProvider && p.model ? ` (${p.model})` : ''}</option>)}
                </select>
                {providerId === state.engineProvider && <p className="text-xs text-gray-500 dark:text-slate-400">OAIY&apos;s own engine answers with the model chosen in OAIY&apos;s Engines. Choose one there that reads images.</p>}
              </div>
            )}
            {busy === 'models' && <p role="status" className="text-sm text-gray-500">Listing its models…</p>}
            {models && (
              <div className="space-y-1">
                <label htmlFor="camera-check-model" className="text-sm font-medium text-gray-700 dark:text-slate-300">Model</label>
                <select id="camera-check-model" value={model} onChange={(e) => setModel(e.target.value)}
                  className="block min-h-10 rounded-lg border border-gray-300 bg-white px-2.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
                  <option value="">Choose…</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            )}
            {canSave && <Button size="sm" isLoading={busy === 'save'} onClick={() => void save()}>Read the pictures here</Button>}
          </fieldset>
        )}
        {current && chosenPlugin && (
          <div className="space-y-2 border-t border-gray-200 pt-4 dark:border-slate-700">
            {plugins.length > 1 && (
              <select aria-label="Plugin to try" value={plugin} onChange={(e) => setPlugin(e.target.value)}
                className="block min-h-10 rounded-lg border border-gray-300 bg-white px-2.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
                {plugins.map((p) => <option key={p.manifestId} value={p.manifestId}>{p.name}</option>)}
              </select>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void runProbe()}>Does it read images?</Button>
              <Button size="sm" variant="outline" onClick={() => setTrial(true)}>Try it on yourself</Button>
            </div>
            {probe && <p role="status" className="text-sm text-gray-700 dark:text-slate-300">{probe}</p>}
            <p className="text-xs text-gray-500 dark:text-slate-400">Trying it records nothing, and shows you what the model answered, so you can see how well it reads you before members use it.</p>
          </div>
        )}
        {trial && chosenPlugin && (
          <CameraCheckPanel mode="trial" pluginName={chosenPlugin.name}
            start={() => api.adminTrialCameraCheck(chosenPlugin.manifestId, chosenPlugin.grants[0]?.default)}
            onClose={() => setTrial(false)} />
        )}
      </CardContent>
    </Card>
  );
}
