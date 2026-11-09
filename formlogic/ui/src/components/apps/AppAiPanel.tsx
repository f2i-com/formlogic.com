import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { AI_KIND_WORDS, aiStatusWords, type AppAiMode, type AppAiOwnChoice, type AppAiTestResult, type AppAiView } from '../../lib/appAi';
import { Button } from '../ui/Button';
import { AppAiOwnComputer } from './AppAiOwnComputer';

const USE_WORDS: Record<string, string> = { pictures: 'pictures', 'picture-edits': 'picture edits', chat: 'chat' };
const LIMITS: { key: 'perRequesterDay' | 'perIpDay' | 'perIpHour' | 'perAppDay'; label: string; hint: string }[] = [
  { key: 'perIpDay', label: 'Free requests per address a day', hint: 'Your visitors\' free rounds, counted by their network.' },
  { key: 'perRequesterDay', label: 'Per visitor or member a day', hint: 'Each person, counted by their browser or account.' },
  { key: 'perIpHour', label: 'Per address an hour', hint: 'Stops a burst from one network.' },
  { key: 'perAppDay', label: 'For the whole app a day', hint: 'Your app\'s own ceiling.' },
];

/**
 * "AI for this app" (the owner, in the SoftN app's settings): where the app's AI comes from, its
 * limits, a Test that runs a real small request, and what its requests did lately. Shown only for an
 * app whose manifest declares formlogicAi. See docs/HOSTED_APPS.md, "App AI, visitors and payments".
 */
export function AppAiPanel({ appId }: { appId: string }) {
  const [view, setView] = useState<AppAiView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AppAiMode>('off');
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ kind: 'picture' | 'chat'; id: string; result: AppAiTestResult | null } | null>(null);
  const [ownChoice, setOwnChoice] = useState<AppAiOwnChoice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const take = useCallback((next: AppAiView) => {
    setView(next);
    setMode(next.settings.mode);
    setLimits({ perRequesterDay: next.settings.perRequesterDay, perIpDay: next.settings.perIpDay, perIpHour: next.settings.perIpHour, perAppDay: next.settings.perAppDay });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.getAppAi(appId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setError(result.error ?? 'This setting could not be read.'); return; }
      take(result.data);
    });
    return () => { cancelled = true; };
  }, [appId, take]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const reload = useCallback(async () => {
    const result = await api.getAppAi(appId);
    if (result.data) take(result.data);
  }, [appId, take]);

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    const result = await api.putAppAi(appId, { mode, ...limits, ...(mode === 'own' && ownChoice ? { own: ownChoice } : {}) });
    setBusy(false);
    if (result.error || !result.data) { setError(result.error ?? 'It could not be saved.'); return; }
    take(result.data);
    setSaved(true);
  };

  const runTest = async (kind: 'picture' | 'chat') => {
    setError(null);
    const started = await api.testAppAi(appId, kind);
    if (started.error || !started.data) { setError(started.error ?? 'The test could not start.'); return; }
    const id = started.data.jobId;
    setTest({ kind, id, result: null });
    const follow = async () => {
      const result = await api.getAppAiTest(appId, id);
      if (result.data) setTest((current) => (current && current.id === id ? { ...current, result: result.data! } : current));
      if (!result.data || result.data.status === 'queued' || result.data.status === 'running') timer.current = setTimeout(() => void follow(), 2000);
    };
    timer.current = setTimeout(() => void follow(), 1500);
  };

  if (!view) return error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  if (!view.declared) return null;
  const uses = view.declared.uses.map((use) => USE_WORDS[use] ?? use);
  const statusColour = view.status.state === 'idle' || view.status.state === 'busy' ? 'bg-green-500' : view.status.state === 'off' ? 'bg-gray-400' : 'bg-amber-500';
  return (
    <div className="space-y-4" data-testid="app-ai-panel">
      <div>
        <p className="text-sm text-gray-600 dark:text-slate-300">
          This app asks for AI for {uses.length > 1 ? `${uses.slice(0, -1).join(', ')} and ${uses[uses.length - 1]}` : uses[0]}: <em>{view.declared.purpose}</em>
        </p>
        <p className="mt-1 flex items-center gap-2 text-sm" role="status">
          <span className={`h-2 w-2 rounded-full ${statusColour}`} aria-hidden="true" />
          {view.status.message}
        </p>
      </div>

      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">Where its AI comes from</legend>
        <label className="flex cursor-pointer gap-2"><input type="radio" name="app-ai-mode" checked={mode === 'off'} onChange={() => setMode('off')} />
          <span><strong>Off</strong>: the app is told its AI is off.</span></label>
        <label className={`flex gap-2 ${view.siteOffers ? 'cursor-pointer' : 'opacity-60'}`}>
          <input type="radio" name="app-ai-mode" checked={mode === 'site'} disabled={!view.siteOffers && mode !== 'site'} onChange={() => setMode('site')} />
          <span><strong>Use this site&apos;s AI</strong>{view.siteOffers ? ': the site\'s own AI answers, within the limits below.' : ': the site does not offer its AI to apps.'}</span></label>
        {view.computers !== undefined && <label className="flex cursor-pointer gap-2">
          <input type="radio" name="app-ai-mode" checked={mode === 'own'} onChange={() => setMode('own')} />
          <span><strong>Use my OAIY</strong>: one of your own linked computers answers, its engines draw the pictures.</span></label>}
      </fieldset>
      {mode === 'own' && view.computers !== undefined && (
        <AppAiOwnComputer appId={appId} computers={view.computers} current={view.settings.own} wantsPictures={view.declared.uses.some((use) => use !== 'chat')}
          onChange={setOwnChoice} onLinked={() => void reload()} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {LIMITS.map(({ key, label, hint }) => (
          <label key={key} className="block text-sm">
            <span className="font-medium">{label}</span>
            <input type="number" min={0} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 dark:border-slate-600 dark:bg-slate-800" value={limits[key] ?? 0}
              onChange={(event) => setLimits((current) => ({ ...current, [key]: Math.max(0, Math.floor(Number(event.target.value) || 0)) }))} />
            <span className="text-xs text-gray-500 dark:text-slate-400">{hint}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" isLoading={busy} onClick={() => void save()}>Save</Button>
        {view.declared.uses.some((use) => use !== 'chat') && <Button size="sm" variant="outline" disabled={!view.availability.enabled} onClick={() => void runTest('picture')}>Test a picture</Button>}
        {view.declared.uses.includes('chat') && <Button size="sm" variant="outline" disabled={!view.availability.enabled} onClick={() => void runTest('chat')}>Test chat</Button>}
        {saved && <span className="text-sm text-green-700 dark:text-green-300" role="status">Saved.</span>}
      </div>
      {!view.availability.enabled && view.reasonText && <p className="text-sm text-gray-500 dark:text-slate-400">{view.reasonText}</p>}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {test && (
        <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-slate-700" data-testid="app-ai-test">
          <p className="font-medium"><Sparkles className="mr-1 inline h-4 w-4" aria-hidden="true" />Test {test.kind === 'chat' ? 'chat' : 'picture'}: {test.result ? aiStatusWords(test.result.status, test.result.code ?? null) : 'Waiting'}</p>
          {test.result?.picture && <img src={test.result.picture} alt="The test picture" className="mt-2 max-h-64 rounded" />}
          {test.result?.text && <p className="mt-2 whitespace-pre-wrap">{test.result.text}</p>}
          {test.result?.status === 'failed' && <p className="mt-2 text-red-600 dark:text-red-400">{test.result.message}</p>}
          {test.result?.status === 'done' && (
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
              {test.result.seconds != null ? `${test.result.seconds.toFixed(1)} s` : ''}{test.result.model ? ` · ${test.result.model}` : ''}{test.result.seed != null ? ` · seed ${test.result.seed}` : ''}
            </p>
          )}
        </div>
      )}

      <div>
        <p className="text-sm font-medium">Today: {view.today.jobs} requests, {view.today.failed} failed, {view.today.refused} refused</p>
        {view.log.length > 0 && (
          <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-slate-700">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 dark:bg-slate-800"><tr><th className="px-2 py-1">When</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1">Outcome</th><th className="px-2 py-1">Who</th><th className="px-2 py-1">Time</th></tr></thead>
              <tbody>
                {view.log.map((entry) => (
                  <tr key={entry.id} className="border-t border-gray-100 dark:border-slate-800" title={entry.message ?? undefined}>
                    <td className="px-2 py-1">{new Date(entry.createdAt.replace(' ', 'T') + 'Z').toLocaleString()}</td>
                    <td className="px-2 py-1">{AI_KIND_WORDS[entry.kind] ?? entry.kind}{entry.test ? ' (test)' : ''}</td>
                    <td className="px-2 py-1">{aiStatusWords(entry.status, entry.code)}</td>
                    <td className="px-2 py-1 font-mono">{entry.requester}</td>
                    <td className="px-2 py-1">{entry.seconds != null ? `${entry.seconds.toFixed(1)} s` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
