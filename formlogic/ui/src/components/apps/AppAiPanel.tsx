import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { AI_KIND_WORDS, aiStatusWords, sinceWords, SITE_AI_REASON_WORDS, utcStamp, type AppAiMode, type AppAiOwnChoice, type AppAiSiteOffer, type AppAiView } from '../../lib/appAi';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { AiTestResult } from './AiTestResult';
import { AppAiOwnComputer } from './AppAiOwnComputer';
import { useAiTest } from './useAiTest';

const USE_WORDS: Record<string, string> = { pictures: 'pictures', 'picture-edits': 'picture edits', chat: 'chat' };
const LIMITS: { key: 'perRequesterDay' | 'perIpDay' | 'perIpHour' | 'perAppDay'; label: string; hint: string }[] = [
  { key: 'perIpDay', label: 'Free requests per network address a day', hint: 'Your visitors\' free rounds. People on one network share them.' },
  { key: 'perRequesterDay', label: 'Per person a day', hint: 'Each visitor, by their browser, or member, by their account.' },
  { key: 'perIpHour', label: 'Per network address an hour', hint: 'Stops a burst from one network.' },
  { key: 'perAppDay', label: 'For the whole app a day', hint: 'The most your app may ask for in a day.' },
];
const link = 'font-medium text-primary-600 underline underline-offset-2 dark:text-primary-300';

/** How the app's AI is doing, in a word and a sentence: ready, busy with how many, offline since when, off and why. */
function statusWords(view: AppAiView): { tone: 'ready' | 'warn' | 'off' | 'stopped'; lead: string; detail: string } {
  const status = view.status;
  const wantsPictures = (view.declared?.uses ?? []).some((use) => use !== 'chat');
  switch (status.state) {
    case 'idle': {
      const chatOnly = wantsPictures && !view.availability.kinds.includes('picture');
      return { tone: 'ready', lead: 'Ready', detail: `${view.availability.label || 'Its AI'} answers${chatOnly ? ', for chat only: no picture model is chosen yet' : ''}.` };
    }
    case 'busy':
      return { tone: 'ready', lead: 'Busy', detail: `${status.running} being made, ${status.waiting} waiting.` };
    case 'offline':
      // (the server's words say why: the computer is off, or OAIY is closed there, and its link may still be alive)
      return { tone: 'warn', lead: `Offline ${sinceWords(status.offlineSince)}`.trim(), detail: status.message || 'The computer its AI runs on is not answering. Requests wait for it, for up to 30 minutes.' };
    case 'paused':
      return { tone: 'warn', lead: 'Paused', detail: status.message };
    case 'blocked':
      return { tone: 'stopped', lead: 'Stopped', detail: status.message };
    default:
      return { tone: 'off', lead: view.settings.mode === 'off' ? 'Off' : 'Not working', detail: view.settings.mode === 'off' ? 'Choose where its AI comes from, then save.' : status.message };
  }
}

const DOT = { ready: 'bg-green-500', warn: 'bg-amber-500', off: 'bg-gray-400', stopped: 'bg-red-500' };

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
  const [ownChoice, setOwnChoice] = useState<AppAiOwnChoice | null>(null);
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);

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

  // Read it again without touching what is being chosen: a computer was linked, or a test ended.
  const refresh = useCallback(async () => {
    const result = await api.getAppAi(appId);
    if (result.data) setView(result.data);
  }, [appId]);

  const { test, error: testError, run, running } = useAiTest((kind) => api.testAppAi(appId, kind), (id) => api.getAppAiTest(appId, id), () => void refresh());

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    const result = await api.putAppAi(appId, { mode, ...limits, ...(mode === 'own' && ownChoice ? { own: ownChoice } : {}) });
    setBusy(false);
    if (result.error || !result.data) { setError(result.error ?? 'It could not be saved.'); return; }
    take(result.data);
    setSaved(true);
  };

  if (!view) return error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  if (!view.declared) return null;
  const uses = view.declared.uses.map((use) => USE_WORDS[use] ?? use);
  const wantsPictures = view.declared.uses.some((use) => use !== 'chat');
  const status = statusWords(view);
  // "Use this site's AI", as it would be for this app now. An older server says only whether it is offered.
  const site: AppAiSiteOffer = view.site ?? { offered: view.siteOffers, working: view.siteOffers, reason: view.siteOffers ? null : 'site_ai_closed', kinds: [], missing: null };
  const siteWhy = site.working ? null : SITE_AI_REASON_WORDS[site.reason ?? ''] ?? 'It is not available right now.';
  const siteMissing = site.working && site.missing ? SITE_AI_REASON_WORDS[site.missing.reason] ?? null : null;
  const setUpSite = isAdmin
    ? <Link className={link} to="/admin/platform#app-ai">Set up the site&apos;s AI</Link>
    : <span>Ask this site&apos;s administrator to set it up.</span>;
  const unsaved = mode !== view.settings.mode;
  // "Use my OAIY" with no computer to use yet: there is nothing to save.
  const noComputer = mode === 'own' && ownChoice === null;
  const statusLine = (
    <>
      <span className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${DOT[status.tone]}`} aria-hidden="true" />
      <strong>{status.lead}.</strong> {status.detail}
    </>
  );

  return (
    <div className="space-y-4" data-testid="app-ai-panel">
      <div>
        <p className="text-sm text-gray-600 dark:text-slate-300">
          This app asks for AI for {uses.length > 1 ? `${uses.slice(0, -1).join(', ')} and ${uses[uses.length - 1]}` : uses[0]}: <em>{view.declared.purpose}</em>
        </p>
        <p className="mt-1 text-sm" role="status" data-testid="app-ai-status">{statusLine}</p>
      </div>

      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">Where this app&apos;s AI comes from</legend>
        <label className="flex cursor-pointer gap-2"><input type="radio" name="app-ai-mode" className="mt-1" checked={mode === 'off'} onChange={() => setMode('off')} />
          <span><strong>Off</strong>: the app is told its AI is off, and nothing is sent anywhere.</span></label>
        <div>
          <label className={`flex gap-2 ${site.offered || mode === 'site' ? 'cursor-pointer' : 'opacity-70'}`}>
            <input type="radio" name="app-ai-mode" className="mt-1" checked={mode === 'site'} disabled={!site.offered && mode !== 'site'} onChange={() => setMode('site')} />
            <span><strong>Use this site&apos;s AI</strong>: {site.working ? 'this site\'s own AI answers, within the limits below.' : 'not available yet.'}</span>
          </label>
          {(siteWhy || siteMissing) && (
            <p className="ml-6 mt-1 text-sm text-gray-600 dark:text-slate-300" data-testid="app-ai-site-why">
              {siteWhy ?? `For now it can do chat only. ${siteMissing}`} {setUpSite}
            </p>
          )}
        </div>
        {view.computers !== undefined && <label className="flex cursor-pointer gap-2">
          <input type="radio" name="app-ai-mode" className="mt-1" checked={mode === 'own'} onChange={() => setMode('own')} />
          <span><strong>Use my OAIY</strong>: a computer of your own that runs OAIY answers, and makes the pictures.</span></label>}
      </fieldset>
      {mode === 'own' && view.computers !== undefined && (
        <AppAiOwnComputer appId={appId} computers={view.computers} current={view.settings.own} wantsPictures={wantsPictures} onChange={setOwnChoice} onLinked={refresh} />
      )}

      <fieldset>
        <legend className="text-sm font-medium">How much each visitor may use</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {LIMITS.map(({ key, label, hint }) => (
            <label key={key} className="block text-sm">
              <span className="font-medium">{label}</span>
              <input type="number" min={0} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 dark:border-slate-600 dark:bg-slate-800" value={limits[key] ?? 0}
                onChange={(event) => setLimits((current) => ({ ...current, [key]: Math.max(0, Math.floor(Number(event.target.value) || 0)) }))} />
              <span className="text-xs text-gray-500 dark:text-slate-400">{hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" isLoading={busy} disabled={noComputer} onClick={() => void save()}>Save</Button>
          {wantsPictures && <Button size="sm" variant="outline" disabled={!view.availability.enabled || unsaved || running} isLoading={running && test?.kind !== 'chat'} onClick={() => void run('picture')}>Test a picture</Button>}
          {view.declared.uses.includes('chat') && <Button size="sm" variant="outline" disabled={!view.availability.enabled || unsaved || running} isLoading={running && test?.kind === 'chat'} onClick={() => void run('chat')}>Test chat</Button>}
        </div>
        {saved && <p className="text-sm" role="status" data-testid="app-ai-saved"><span className="font-medium text-green-700 dark:text-green-300">Saved.</span> {statusLine}</p>}
        {noComputer ? <p className="text-sm text-gray-500 dark:text-slate-400">Link a computer above first. Then you can save.</p>
          : unsaved
          ? <p className="text-sm text-gray-500 dark:text-slate-400">Save first. A test uses what is saved.</p>
          : !view.availability.enabled && <p className="text-sm text-gray-500 dark:text-slate-400">{view.settings.mode === 'off' ? 'Turn its AI on and save, then test it here.' : view.reasonText}</p>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {testError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{testError}</p>}
        {test && <AiTestResult test={test} computer={view.settings.own?.deviceName || undefined} />}
      </div>

      <div>
        <p className="text-sm font-medium">Today: {view.today.jobs} {view.today.jobs === 1 ? 'request' : 'requests'}, {view.today.failed} failed, {view.today.refused} refused</p>
        {view.log.length > 0 && (
          <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-slate-700">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 dark:bg-slate-800"><tr><th className="px-2 py-1">When</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1">Outcome</th><th className="px-2 py-1">Who</th><th className="px-2 py-1">Time</th></tr></thead>
              <tbody>
                {view.log.map((entry) => (
                  <tr key={entry.id} className="border-t border-gray-100 dark:border-slate-800" title={entry.message ?? undefined}>
                    <td className="px-2 py-1">{utcStamp(entry.createdAt).toLocaleString()}</td>
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
