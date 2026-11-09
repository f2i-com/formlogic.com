// Admin → Platform: "AI for apps" card (GET/PUT /api/admin/app-ai, PUT /api/admin/app-ai/apps/{id}).
//
// Whether SoftN apps that declare formlogicAi may use this site's own AI (its OAIY, or the .env upstream), which
// picture model they get, the limits a new app's owner starts from, the site's daily ceiling across apps, words a
// prompt may not use, every app's use today, and a stop for one app. See docs/FREE_PLANS_AND_AI_SETUP.md, "AI for apps".
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api, type SiteAiDesktopState } from '../../lib/api';
import type { AppAiAdminView, AppAiLimits, AppAiSiteSettings } from '../../lib/appAi';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';

const LIMITS: { key: keyof AppAiLimits; label: string }[] = [
  { key: 'perIpDay', label: 'Per address a day' },
  { key: 'perRequesterDay', label: 'Per visitor or member a day' },
  { key: 'perIpHour', label: 'Per address an hour' },
  { key: 'perAppDay', label: 'Per app a day (the most an owner may set)' },
];
const field = 'mt-1 block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';

export function AdminAppAiCard() {
  const [view, setView] = useState<AppAiAdminView | null>(null);
  const [draft, setDraft] = useState<AppAiSiteSettings | null>(null);
  const [words, setWords] = useState('');
  const [computer, setComputer] = useState<SiteAiDesktopState | null>(null);
  const [pictureModels, setPictureModels] = useState<{ id: string; name: string }[] | null>(null);
  const [listing, setListing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.adminGetAppAi(), api.adminGetSiteAiDesktop()]).then(([result, desktop]) => {
      if (cancelled) return;
      if (result.error || !result.data) { setLoadError(result.error ?? 'Could not read this setting.'); return; }
      setView(result.data);
      setDraft(result.data.settings);
      setWords(result.data.settings.words.join('\n'));
      if (desktop.data && Array.isArray(desktop.data.candidates)) setComputer(desktop.data);
    });
    return () => { cancelled = true; };
  }, [attempt]);

  if (loadError) return <Card><CardContent className="p-5"><AdminError message={loadError} onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }} /></CardContent></Card>;
  if (!view || !draft) return <Card><CardContent className="p-5"><AdminSpinner label="Loading AI for apps" /></CardContent></Card>;

  const current = computer?.current ?? null;
  const set = <K extends keyof AppAiSiteSettings>(key: K, value: AppAiSiteSettings[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const listPictureModels = async () => {
    if (!current) return;
    setListing(true);
    const result = await api.adminOaiyModels(current.connectionId, computer?.engineProvider ?? 'oaiy-engine');
    setListing(false);
    if (result.error || !result.data) { toast.error('The computer did not list its models', result.error ?? ''); return; }
    setPictureModels(result.data.models.filter((m) => m.type === 'image'));
  };
  const save = async () => {
    setSaving(true);
    const result = await api.adminPutAppAi({ ...draft, words: words.split('\n').map((w) => w.trim()).filter(Boolean) });
    setSaving(false);
    if (result.error || !result.data) { toast.error('Not saved', result.error ?? ''); return; }
    setView(result.data);
    setDraft(result.data.settings);
    setWords(result.data.settings.words.join('\n'));
    toast.success('Saved');
  };
  const block = async (appId: string, blocked: boolean) => {
    const reason = blocked ? window.prompt('Why is this app\'s AI stopped? Its owner sees this.') ?? undefined : undefined;
    const result = await api.adminBlockAppAi(appId, blocked, reason || undefined);
    if (result.error || !result.data) { toast.error('Not changed', result.error ?? ''); return; }
    setView(result.data);
  };

  return (
    <Card>
      <CardContent className="space-y-5 p-5" data-testid="admin-app-ai">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white"><Sparkles className="h-5 w-5" aria-hidden="true" />AI for apps</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            SoftN apps that ask for AI (pictures, picture edits, chat) can use this site&apos;s AI: {current ? <>your OAIY on <strong>{current.deviceName}</strong></> : 'the provider in your server settings'}.
            Their visitors&apos; requests wait their turn, one picture at a time, and a chat is never held up by a picture.
          </p>
        </div>
        {view.warnings.length > 0 && (
          <ul className="space-y-2" aria-label="Warnings">
            {view.warnings.map((warning) => <li key={warning.code + warning.message} role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{warning.message}</li>)}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Switch label="Apps may use this site's AI" description="Each app's owner still turns it on for their app." checked={draft.allowApps} onChange={(on) => set('allowApps', on)} />
          <Switch label="Pause every app's AI" description="Apps are told their AI is paused. Nothing is sent anywhere." checked={draft.paused} onChange={(on) => set('paused', on)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-gray-700 dark:text-slate-300">Picture model</span>
            {pictureModels && pictureModels.length > 0 ? (
              <select className={field} value={draft.pictureModel ?? ''} onChange={(e) => set('pictureModel', e.target.value || null)}>
                <option value="">None: no pictures</option>
                {pictureModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            ) : (
              <input className={field} value={draft.pictureModel ?? ''} placeholder="flux-3-image-klein" onChange={(e) => set('pictureModel', e.target.value.trim() || null)} />
            )}
            <span className="mt-1 block text-xs text-gray-500 dark:text-slate-400">
              An OAIY Engines picture model, named exactly. None chosen: apps can ask for chat only.{' '}
              {current && <button type="button" className="text-indigo-600 underline dark:text-indigo-300" disabled={listing} onClick={() => void listPictureModels()}>{listing ? 'Asking the computer…' : 'List the computer\'s picture models'}</button>}
              {pictureModels && pictureModels.length === 0 && ' The computer lists no picture model that is switched on.'}
            </span>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700 dark:text-slate-300">Chat model (optional)</span>
            <input className={field} value={draft.chatModel ?? ''} placeholder="The site AI's own" onChange={(e) => set('chatModel', e.target.value.trim() || null)} />
            <span className="mt-1 block text-xs text-gray-500 dark:text-slate-400">Left empty, apps chat with the model the site&apos;s AI uses.</span>
          </label>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 dark:text-slate-300">What a new app&apos;s owner starts from</legend>
          <div className="mt-1 grid gap-3 sm:grid-cols-4">
            {LIMITS.map(({ key, label }) => (
              <label key={key} className="block text-xs text-gray-600 dark:text-slate-400">{label}
                <input type="number" min={0} className={field} value={draft.defaults[key]} onChange={(e) => set('defaults', { ...draft.defaults, [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-gray-700 dark:text-slate-300">Requests a day, every app together</span>
            <input type="number" min={0} className={field} value={draft.siteDay} onChange={(e) => set('siteDay', Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-gray-700 dark:text-slate-300">Words a prompt may not use</span>
            <textarea className={`${field} min-h-20 py-2`} value={words} placeholder="One word or phrase a line" onChange={(e) => setWords(e.target.value)} />
          </label>
        </div>
        <Button size="sm" isLoading={saving} onClick={() => void save()}>Save</Button>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Apps using AI</h3>
          {view.apps.length === 0 ? <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">No app has set up its AI yet.</p> : (
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
