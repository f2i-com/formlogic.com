// Admin → Platform: "AI for apps" card (GET/PUT /api/admin/app-ai, PUT /api/admin/app-ai/apps/{id}).
//
// A setup checklist first (AdminAppAiSetup): where the site's AI runs, whether apps may use it, the
// picture model, and a test. Then the limits a new app's owner starts with, the site's daily ceiling
// across apps, words a prompt may not use, the pause for every app, every app's use today, and a stop
// for one app. See docs/FREE_PLANS_AND_AI_SETUP.md, "AI for apps".
import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api, type SiteAiDesktopState } from '../../lib/api';
import type { AppAiAdminView, AppAiLimits, AppAiSiteSettings } from '../../lib/appAi';
import { onSiteAiChanged } from '../../lib/siteAiEvents';
import { toast } from '../../stores/toastStore';
import { AdminAppAiSetup } from './AdminAppAiSetup';
import { AdminError, AdminSpinner } from './adminUi';

const LIMITS: { key: keyof AppAiLimits; label: string; hint: string }[] = [
  { key: 'perIpDay', label: 'Per network address a day', hint: 'An app\'s free rounds for visitors.' },
  { key: 'perRequesterDay', label: 'Per person a day', hint: 'One visitor or member.' },
  { key: 'perIpHour', label: 'Per network address an hour', hint: 'Stops a burst.' },
  { key: 'perAppDay', label: 'Per app a day', hint: 'Also the most an owner may set.' },
];
const field = 'mt-1 block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
/** The limits edited below the checklist, saved together. */
type LimitsDraft = Pick<AppAiSiteSettings, 'defaults' | 'siteDay'>;

export function AdminAppAiCard() {
  const [view, setView] = useState<AppAiAdminView | null>(null);
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  const [words, setWords] = useState('');
  const [desktop, setDesktop] = useState<SiteAiDesktopState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'limits' | 'pause' | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The settings and the computers, read together. The first read also starts the limits' form from
  // what is saved; a later one (the checklist changed something) leaves what is being typed there alone.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.adminGetAppAi(), api.adminGetSiteAiDesktop()]).then(([result, computers]) => {
      if (cancelled) return;
      if (result.error || !result.data) { setLoadError(result.error ?? 'Could not read this setting.'); return; }
      setView(result.data);
      setDraft({ defaults: result.data.settings.defaults, siteDay: result.data.settings.siteDay });
      setWords(result.data.settings.words.join('\n'));
      if (computers.data && Array.isArray(computers.data.candidates)) setDesktop(computers.data);
    });
    return () => { cancelled = true; };
  }, [attempt]);
  const reload = useCallback(async () => {
    const [result, computers] = await Promise.all([api.adminGetAppAi(), api.adminGetSiteAiDesktop()]);
    if (result.data) setView(result.data);
    if (computers.data && Array.isArray(computers.data.candidates)) setDesktop(computers.data);
  }, []);
  // The Plans card, above, changes where the site's AI runs too: show what it did.
  useEffect(() => onSiteAiChanged(() => void reload()), [reload]);

  if (loadError) return <Card><CardContent className="p-5"><AdminError message={loadError} onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }} /></CardContent></Card>;
  if (!view || !draft) return <Card><CardContent className="p-5"><AdminSpinner label="Loading AI for apps" /></CardContent></Card>;

  const saved = view.settings;
  const saveLimits = async () => {
    setSaving('limits');
    const result = await api.adminPutAppAi({ ...saved, ...draft, words: words.split('\n').map((w) => w.trim()).filter(Boolean) });
    setSaving(null);
    if (result.error || !result.data) { toast.error('Not saved', result.error ?? ''); return; }
    setView(result.data);
    setDraft({ defaults: result.data.settings.defaults, siteDay: result.data.settings.siteDay });
    setWords(result.data.settings.words.join('\n'));
    toast.success('Saved');
  };
  const pause = async (paused: boolean) => {
    setSaving('pause');
    const result = await api.adminPutAppAi({ ...saved, paused });
    setSaving(null);
    if (result.error || !result.data) { toast.error('Not changed', result.error ?? ''); return; }
    setView(result.data);
  };
  const block = async (appId: string, blocked: boolean) => {
    const reason = blocked ? window.prompt('Why is this app\'s AI stopped? Its owner sees this.') ?? undefined : undefined;
    const result = await api.adminBlockAppAi(appId, blocked, reason || undefined);
    if (result.error || !result.data) { toast.error('Not changed', result.error ?? ''); return; }
    setView(result.data);
  };
  // The checklist says a picture model is missing (its fourth line) and that no worker runs (above
  // its steps); the same warnings below it would say them twice.
  const warnings = view.warnings.filter((warning) => !(view.setup && (warning.code === 'picture_model_unset' || warning.code === 'worker_idle')));

  return (
    <Card>
      <CardContent className="space-y-5 p-5" data-testid="admin-app-ai">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white"><Sparkles className="h-5 w-5" aria-hidden="true" />AI for apps</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            Apps you host can ask this site for AI: pictures, picture edits and chat. Set it up here once. Each app&apos;s owner then turns it on
            for their own app, and its visitors&apos; requests take turns, one picture at a time.
          </p>
        </div>
        {view.setup && <AdminAppAiSetup setup={view.setup} settings={saved} desktop={desktop} onReload={reload} onSaved={setView} />}
        {warnings.length > 0 && (
          <ul className="space-y-2" aria-label="Warnings">
            {warnings.map((warning) => <li key={warning.code + warning.message} role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{warning.message}</li>)}
          </ul>
        )}

        <div className="space-y-4 border-t border-gray-200 pt-5 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Limits and safety</h3>
          <Switch
            label="Pause every app's AI"
            description={saved.paused ? 'Paused. Apps are told their AI is paused, and nothing is sent anywhere.' : 'Stops every app\'s AI at once. Apps are told it is paused.'}
            checked={saved.paused}
            disabled={saving !== null}
            onChange={(on) => void pause(on)}
          />
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-slate-300">Requests each new app starts with</legend>
            <p className="text-xs text-gray-500 dark:text-slate-400">An app&apos;s owner can lower these for their app.</p>
            <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {LIMITS.map(({ key, label, hint }) => (
                <label key={key} className="flex flex-col text-xs text-gray-600 dark:text-slate-400">
                  {/* Two lines' room, so the boxes line up when one label wraps. */}
                  <span className="flex min-h-8 items-end">{label}</span>
                  <input type="number" min={0} className={field} value={draft.defaults[key]} onChange={(e) => setDraft({ ...draft, defaults: { ...draft.defaults, [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })} />
                  <span className="mt-1 block">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-gray-700 dark:text-slate-300">Requests a day, all apps together</span>
              <input type="number" min={0} className={field} value={draft.siteDay} onChange={(e) => setDraft({ ...draft, siteDay: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              <span className="mt-1 block text-xs text-gray-500 dark:text-slate-400">Once used up, apps on the site&apos;s AI wait until tomorrow (UTC).</span>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-gray-700 dark:text-slate-300">Words a request may not use</span>
              <textarea className={`${field} min-h-20 py-2`} value={words} placeholder="One word or phrase per line" onChange={(e) => setWords(e.target.value)} />
              <span className="mt-1 block text-xs text-gray-500 dark:text-slate-400">A request that uses one is refused, and the app is told.</span>
            </label>
          </div>
          <Button size="sm" isLoading={saving === 'limits'} disabled={saving !== null} onClick={() => void saveLimits()}>Save limits</Button>
        </div>

        <div className="border-t border-gray-200 pt-5 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Apps using AI</h3>
          {view.apps.length === 0 ? <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">No app has turned its AI on yet.</p> : (
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-slate-800 dark:text-slate-400"><tr><th className="px-3 py-2">App</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2">AI</th><th className="px-3 py-2">Today</th><th className="px-3 py-2"><span className="sr-only">Stop</span></th></tr></thead>
                <tbody>
                  {view.apps.map((app) => (
                    <tr key={app.appId} className="border-t border-gray-100 dark:border-slate-800">
                      <td className="px-3 py-2">{app.name}</td>
                      <td className="px-3 py-2 text-gray-500 dark:text-slate-400">{app.ownerEmail}</td>
                      <td className="px-3 py-2">{app.blocked ? 'Stopped' : app.mode === 'site' ? 'This site\'s' : app.mode === 'own' ? 'The owner\'s OAIY' : 'Off'}{app.pausedUntil && !app.blocked ? ' (resting)' : ''}</td>
                      <td className="px-3 py-2">{app.jobsToday}{app.failedToday > 0 ? `, ${app.failedToday} failed` : ''}</td>
                      <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => void block(app.appId, !app.blocked)}>{app.blocked ? 'Allow again' : 'Stop its AI'}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
