import { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import { api, type SiteAiDesktopState } from '../../lib/api';
import { Button } from '../../components/ui/Button';

/**
 * The site's AI served from the administrator's own OAIY: pick one of your linked computers, and
 * members' Site AI requests go to it instead of the provider in .env. Saved at once, apart from
 * the plan settings above it.
 */
export function AdminSiteAiDesktop() {
  const [state, setState] = useState<SiteAiDesktopState | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.adminGetSiteAiDesktop().then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setError(result.error ?? 'Could not read this setting.'); return; }
      setState(result.data);
    });
    return () => { cancelled = true; };
  }, []);

  const apply = async (call: () => ReturnType<typeof api.adminGetSiteAiDesktop>) => {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (result.error || !result.data) { setError(result.error ?? 'It could not be saved.'); return; }
    setState(result.data);
    setChoice('');
  };

  if (!state) {
    return error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  }
  const current = state.current;
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-slate-700">
      <div>
        <strong className="flex items-center gap-2 text-sm"><Monitor className="h-4 w-4" aria-hidden="true" />Serve it from your OAIY</strong>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          Members&apos; Site AI requests go to one of your computers running OAIY, instead of the provider in your server settings.
          It answers one request at a time, so members wait their turn or are told it&apos;s busy. It never runs tools or flows for them.
          The computer has to be on and linked for the Site AI to answer.
        </p>
      </div>
      {current ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm dark:bg-green-500/10">
          <span className="text-green-900 dark:text-green-200">
            Serving from <strong>{current.deviceName || 'your computer'}</strong> · key {current.fingerprint}
            {!current.yours && ' (linked to another administrator)'}
          </span>
          <Button size="sm" variant="outline" isLoading={busy} onClick={() => void apply(() => api.adminDeleteSiteAiDesktop())}>Stop</Button>
        </div>
      ) : null}
      {state.candidates.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          None of your linked computers has published its chat key. Link OAIY on your computer in Settings → AI &amp; devices, open it, and come back.
        </p>
      ) : (
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="sr-only">Your linked computers</legend>
          {state.candidates.map((candidate) => (
            <label key={candidate.connectionId} className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="radio" name="site-ai-desktop" className="mt-1" checked={choice === candidate.connectionId}
                onChange={() => setChoice(candidate.connectionId)} />
              <span>
                <span className="font-medium text-gray-900 dark:text-white">{candidate.deviceName || candidate.instanceId}</span>
                <span className={candidate.online ? 'ml-2 text-xs text-green-700 dark:text-green-300' : 'ml-2 text-xs text-gray-400'}>{candidate.online ? 'online' : 'offline'}</span>
                {current?.connectionId === candidate.connectionId && <span className="ml-2 text-xs text-gray-500">serving now</span>}
                <span className="block text-xs text-gray-500 dark:text-slate-400">key {candidate.fingerprint}</span>
              </span>
            </label>
          ))}
          <Button size="sm" disabled={!choice} isLoading={busy} onClick={() => void apply(() => api.adminPutSiteAiDesktop(choice))}>
            Serve the Site AI from this computer
          </Button>
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
