// Phone sign-in codes for a SoftN app whose manifest names a provider for them
// (`config.app.verificationProvider`, as Coffee.Dating names "twilio-verify"). A plugin on this site
// sends them: this says which one (or that none does, for the site's administrator to install), and
// shows the settings that plugin asks the owner for, whatever they are. A secret is kept on the
// server and never shown again: its field says whether one is kept (NativePhoneVerification).
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { api, type AppSettingField, type AppSignInCodes } from '../../lib/api';
import { toast } from '../../stores/toastStore';

type Value = string | number | boolean;

const LABEL = 'mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300';
const HINT = 'mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400';

/** The values a form starts from: every setting but a secret as kept; a secret always empty. */
function startingValues(state: AppSignInCodes): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const field of state.fields) {
    out[field.key] = field.type === 'secret' ? '' : (state.values[field.key] ?? field.default ?? '');
  }
  return out;
}

/** Where a secret goes, in words: the only hosts this site sends it to. */
function sentTo(hosts: string[]): string {
  if (hosts.length === 0) return 'Sent nowhere: this site sends it to no host.';
  const listed = hosts.length < 2 ? hosts[0] : `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
  return `Sent only to ${listed}, by this site itself.`;
}

/** Whether a required setting is still to be given: an empty text, or a secret neither kept nor typed. */
function missing(field: AppSettingField, value: Value | undefined, kept: boolean): boolean {
  if (field.optional) return false;
  if (field.type === 'secret') return !kept && !String(value ?? '').trim();
  if (field.type === 'text') return !String(value ?? '').trim();
  return false;
}

export function PhoneSignInPanel({ appId, version, disabled = false, onForgotten }: {
  appId: string; version: number; disabled?: boolean;
  /** What was kept for an app that sends no codes now is gone: the page need not show this panel. */
  onForgotten?: () => void;
}) {
  const [state, setState] = useState<AppSignInCodes | null>(null);
  const [failed, setFailed] = useState('');
  const [values, setValues] = useState<Record<string, Value>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    void api.getAppSignInCodes(appId).then(result => {
      if (!current) return;
      if (result.error || !result.data) { setFailed(result.error || 'Could not read the sign-in settings.'); return; }
      setState(result.data); setFailed('');
      setValues(startingValues(result.data));
    });
    return () => { current = false; };
  }, [appId, version]);

  if (failed) return <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{failed}</p>;
  if (!state) return <p role="status" className="text-xs text-slate-500 dark:text-slate-400">Loading…</p>;

  const provider = state.provider ?? '';
  // What is kept goes: with a plugin, its settings for this app; with none, every plugin's, and any from before.
  const clear = async (done: [string, string]) => {
    setSaving(true); setError('');
    const result = await api.clearAppSignInCodes(appId);
    setSaving(false);
    if (result.error || !result.data) { setError(result.error || 'Could not remove the settings.'); return; }
    setState(result.data); setValues(startingValues(result.data));
    toast.info(done[0], done[1]);
    if (!result.data.plugin && !result.data.keptWithoutPlugin) onForgotten?.();
  };
  if (!state.plugin) {
    return <div className="space-y-2">
      {provider ? <>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          This app signs people in with a code sent to their phone, through &ldquo;{provider}&rdquo;. A plugin on this site sends such codes, and no plugin here sends them for &ldquo;{provider}&rdquo;.
        </p>
        <p role="status" className="text-sm font-medium text-amber-700 dark:text-amber-300">
          Off: visitors are told sign-in messaging is not set up yet. Ask the site&apos;s administrator to install a plugin that sends them (Admin → Platform → Plugins).
        </p>
      </> : <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">This app no longer signs people in with a code sent to their phone.</p>}
      {state.keptWithoutPlugin && <>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">Details you gave for sending this app&apos;s codes are still kept on this site, though nothing uses them now.</p>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
        <Button size="sm" variant="ghost" onClick={() => void clear(['The kept details are forgotten', 'Nothing of them is kept on this site.'])} isLoading={saving} disabled={disabled}>Forget the kept details</Button>
      </>}
    </div>;
  }

  const plugin = state.plugin;
  const set = (key: string, value: Value) => setValues(now => ({ ...now, [key]: value }));
  const incomplete = state.fields.some(field => missing(field, values[field.key], state.kept[field.key] === true));

  const save = async () => {
    setSaving(true); setError('');
    const sent: Record<string, Value> = {};
    for (const field of state.fields) {
      const value = values[field.key];
      if (field.type === 'secret') {
        // Left empty, the one kept stays.
        if (String(value ?? '').trim()) sent[field.key] = String(value).trim();
      } else if (field.type === 'text') {
        sent[field.key] = String(value ?? '').trim();
      } else if (value !== undefined) {
        sent[field.key] = value;
      }
    }
    const result = await api.saveAppSignInCodes(appId, sent);
    setSaving(false);
    if (result.error || !result.data) { setError(result.error || 'Could not save.'); return; }
    setState(result.data); setValues(startingValues(result.data));
    toast.success('Sign-in codes are on', `Visitors get their code from ${plugin.name}.`);
  };
  const remove = () => clear(['Sign-in codes are off', 'Visitors are told sign-in messaging is not set up.']);

  const on = state.configured && plugin.enabled;
  const field = (item: AppSettingField) => {
    const id = `signin-${appId}-${item.key}`;
    const value = values[item.key];
    const help = item.help ? <p className={HINT}>{item.help}</p> : null;
    if (item.type === 'boolean') {
      return <div key={item.key}>
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input id={id} type="checkbox" className="mt-0.5" checked={value === true} onChange={event => set(item.key, event.target.checked)} disabled={disabled || saving} />
          <span>{item.label}</span>
        </label>
        {help}
      </div>;
    }
    let control;
    if (item.type === 'choice') {
      control = <select id={id} value={String(value ?? '')} onChange={event => set(item.key, event.target.value)} disabled={disabled || saving}
        className="block min-h-10 max-w-full rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white max-sm:min-h-11">
        {(item.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>;
    } else if (item.type === 'integer') {
      control = <Input id={id} type="number" min={item.min} max={item.max} value={String(value ?? '')} onChange={event => set(item.key, Math.round(Number(event.target.value)))} disabled={disabled || saving} />;
    } else if (item.type === 'secret') {
      const kept = state.kept[item.key] === true;
      control = <Input id={id} type="password" value={String(value ?? '')} onChange={event => set(item.key, event.target.value)} autoComplete="new-password" spellCheck={false}
        maxLength={item.maxLength} placeholder={kept ? 'Kept. Enter a new one to replace it.' : (item.placeholder || 'Not set')} disabled={disabled || saving} />;
    } else {
      control = <Input id={id} value={String(value ?? '')} onChange={event => set(item.key, event.target.value)} autoComplete="off" spellCheck={false}
        maxLength={item.maxLength} placeholder={item.placeholder} disabled={disabled || saving} />;
    }
    return <div key={item.key}>
      <label htmlFor={id} className={LABEL}>
        {item.label}{item.optional ? <span className="font-normal text-slate-400"> (optional)</span> : null}
        {item.type === 'secret' && state.kept[item.key] ? <span className="ml-2 font-normal text-emerald-700 dark:text-emerald-300">Kept</span> : null}
      </label>
      {control}
      {item.type === 'secret' && <p className={HINT}>{sentTo(item.sendTo ?? [])}</p>}
      {help}
    </div>;
  };

  return <div className="space-y-3">
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
      {state.asked ? 'This app signs people in with a code sent to their phone. ' : 'This version of the app does not ask for sign-in codes; these settings are used only by one that does. '}
      On this site its codes are sent by the plugin {plugin.name} ({plugin.label}). Enter your own details for it: the app itself never sees them, and the app&apos;s own limits on how often a code can be asked for apply before any is sent.
    </p>
    {!plugin.enabled && <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">The site&apos;s administrator has turned this plugin off. Until it is on again, no codes are sent.</p>}
    <p className={on ? 'text-sm font-medium text-emerald-700 dark:text-emerald-300' : 'text-sm font-medium text-amber-700 dark:text-amber-300'} role="status">
      {on ? 'On: codes are sent.' : 'Off: visitors are told sign-in messaging is not set up yet.'}
    </p>
    {state.fields.map(field)}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => void save()} isLoading={saving} disabled={disabled || incomplete}>Save</Button>
      {state.configured && <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={disabled || saving}>Turn off</Button>}
    </div>
  </div>;
}
