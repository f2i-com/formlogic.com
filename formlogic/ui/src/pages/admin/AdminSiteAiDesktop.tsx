import { useCallback, useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import { api, type SiteAiDesktopState } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { OaiyTargetPicker, type OaiyTarget } from '../../components/admin/OaiyTargetPicker';
import { ConnectOaiyServer } from '../../components/desktop/ConnectOaiyServer';
import { announceSiteAiChanged, onSiteAiChanged } from '../../lib/siteAiEvents';

/**
 * The site's AI served from the administrator's own OAIY: pick one of your linked computers and a
 * provider on it, listed by asking the computer, and members' Site AI requests go to it instead of
 * the provider in .env. Saved at once, apart from the plan settings above it.
 */
export function AdminSiteAiDesktop() {
  const [state, setState] = useState<SiteAiDesktopState | null>(null);
  const [choice, setChoice] = useState<OaiyTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.adminGetSiteAiDesktop().then((result) => {
      if (cancelled) return;
      // (an answer without its list, as from a server older than this card, is not one it can show)
      if (result.error || !result.data || !Array.isArray(result.data.candidates)) { setError(result.error ?? 'Could not read this setting.'); return; }
      setState(result.data);
    });
    return () => { cancelled = true; };
  }, [revision]);
  // The AI for apps card's checklist chooses the computer too: show what it chose.
  useEffect(() => onSiteAiChanged(() => setRevision((n) => n + 1)), []);

  const apply = async (call: () => ReturnType<typeof api.adminGetSiteAiDesktop>) => {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (result.error || !result.data || !Array.isArray(result.data.candidates)) { setError(result.error ?? 'It could not be saved.'); return; }
    setState(result.data);
    setChoice(null);
    setRevision((n) => n + 1);
    announceSiteAiChanged();
  };
  const onChange = useCallback((target: OaiyTarget | null) => setChoice(target), []);

  if (!state) {
    return error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  }
  const current = state.current;
  const engine = state.engineProvider ?? 'oaiy-engine';
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-slate-700">
      <div>
        <strong className="flex items-center gap-2 text-sm"><Monitor className="h-4 w-4" aria-hidden="true" />Serve it from your OAIY</strong>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          Members&apos; Site AI requests go to one of your computers running OAIY, instead of the provider in your server settings.
          It answers one request at a time, so members wait their turn or are told it&apos;s busy. It never runs tools or flows for them:
          chat works, without the actions the site&apos;s own AI can take.
          The computer has to be on and linked for the Site AI to answer.
        </p>
      </div>
      {current ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm dark:bg-green-500/10">
          <span className="text-green-900 dark:text-green-200">
            Serving from <strong>{current.deviceName || 'your computer'}</strong>
            {' · '}{!current.providerId || current.providerId === engine ? 'OAIY\'s own engine' : `${current.providerId}: ${current.model}`}
            {' · '}key {current.fingerprint}
            {!current.yours && ' (linked to another administrator)'}
          </span>
          <Button size="sm" variant="outline" isLoading={busy} onClick={() => void apply(() => api.adminDeleteSiteAiDesktop())}>Stop</Button>
        </div>
      ) : null}
      {!current && state.gone ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-500/10">
          <span className="text-amber-900 dark:text-amber-200">
            <strong>{state.gone.deviceName || 'The computer you chose'}</strong> (key {state.gone.fingerprint}) was unlinked, has a new key, or
            is no longer an administrator&apos;s, so nothing is sent to it and apps are not offered it. Choose a computer again.
          </span>
          <Button size="sm" variant="outline" isLoading={busy} onClick={() => void apply(() => api.adminDeleteSiteAiDesktop())}>Forget it</Button>
        </div>
      ) : null}
      {state.candidates.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          None of your linked computers has published its chat key. Link OAIY on your computer in Settings → AI &amp; devices, open it, and come back.
        </p>
      ) : (
        <div className="space-y-2">
          <OaiyTargetPicker key={revision} name="site-ai-desktop" candidates={state.candidates} onChange={onChange} disabled={busy}
            engineHint="OAIY's own engine answers with the model chosen in OAIY's Engines." />
          <Button size="sm" disabled={!choice} isLoading={busy}
            onClick={() => choice && void apply(() => api.adminPutSiteAiDesktop(choice.connectionId, choice.providerId, choice.model))}>
            Serve the Site AI from this computer
          </Button>
        </div>
      )}
      {/* An always-on OAIY server, linked with a one-time code (App AI contract §2), serves as well as a desktop. */}
      <ConnectOaiyServer compact onLinked={() => setRevision((n) => n + 1)} />
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
