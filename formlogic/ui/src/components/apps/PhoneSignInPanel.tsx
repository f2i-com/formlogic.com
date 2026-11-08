// Phone sign-in codes for a SoftN app that sends them through Twilio Verify (its manifest names
// `config.app.verificationProvider: "twilio-verify"`, as Coffee.Dating does). The owner gives their
// own Twilio details: FormLogic sends the codes and checks them, and the app's code never sees them.
// The token is kept on the server and never shown again (NativePhoneVerification).
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { api, type NativeVerification } from '../../lib/api';
import { toast } from '../../stores/toastStore';

export function PhoneSignInPanel({ appId, version, disabled = false }: { appId: string; version: number; disabled?: boolean }) {
  const [state, setState] = useState<NativeVerification | null>(null);
  const [failed, setFailed] = useState('');
  const [accountSid, setAccountSid] = useState('');
  const [serviceSid, setServiceSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    void api.getNativeVerification(appId).then(result => {
      if (!current) return;
      if (result.error || !result.data) { setFailed(result.error || 'Could not read the sign-in settings.'); return; }
      setState(result.data); setFailed('');
      setAccountSid(result.data.accountSid ?? ''); setServiceSid(result.data.serviceSid ?? '');
    });
    return () => { current = false; };
  }, [appId, version]);

  if (failed) return <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{failed}</p>;
  if (!state) return <p role="status" className="text-xs text-slate-500 dark:text-slate-400">Loading…</p>;

  const save = async () => {
    setSaving(true); setError('');
    const result = await api.saveNativeVerification(appId, { accountSid: accountSid.trim(), serviceSid: serviceSid.trim(), authToken: authToken.trim() });
    setSaving(false);
    if (result.error || !result.data) { setError(result.error || 'Could not save.'); return; }
    setState(result.data); setAuthToken('');
    toast.success('Sign-in codes are on', 'Visitors get their code by text, from your Twilio Verify service.');
  };
  const remove = async () => {
    setSaving(true); setError('');
    const result = await api.clearNativeVerification(appId);
    setSaving(false);
    if (result.error || !result.data) { setError(result.error || 'Could not remove the details.'); return; }
    setState(result.data); setAccountSid(''); setServiceSid(''); setAuthToken('');
    toast.info('Sign-in codes are off', 'Visitors are told sign-in messaging is not set up.');
  };

  return <div className="space-y-3">
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
      {state.asked ? 'This app signs people in with a code sent to their phone, through Twilio Verify. ' : 'This version of the app does not ask for Twilio Verify codes; these details are used only by one that does. '}
      Enter your own Twilio details: you pay Twilio for the texts, and the app itself never sees them. The app&apos;s own limits on how often a code can be asked for apply before any text is sent.
    </p>
    <p className={state.configured ? 'text-sm font-medium text-emerald-700 dark:text-emerald-300' : 'text-sm font-medium text-amber-700 dark:text-amber-300'} role="status">
      {state.configured ? 'On: codes are sent by text.' : 'Off: visitors are told sign-in messaging is not set up yet.'}
    </p>
    <div>
      <label htmlFor={`verify-account-${appId}`} className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">Account SID</label>
      <Input id={`verify-account-${appId}`} value={accountSid} onChange={event => setAccountSid(event.target.value)} placeholder="AC…" autoComplete="off" spellCheck={false} disabled={disabled || saving} />
    </div>
    <div>
      <label htmlFor={`verify-service-${appId}`} className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">Verify service SID</label>
      <Input id={`verify-service-${appId}`} value={serviceSid} onChange={event => setServiceSid(event.target.value)} placeholder="VA…" autoComplete="off" spellCheck={false} disabled={disabled || saving} />
    </div>
    <div>
      <label htmlFor={`verify-token-${appId}`} className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">Auth token</label>
      <Input id={`verify-token-${appId}`} type="password" value={authToken} onChange={event => setAuthToken(event.target.value)} autoComplete="new-password" spellCheck={false}
        placeholder={state.configured ? 'Kept. Enter a new one to replace it.' : 'From the Twilio console'} disabled={disabled || saving} />
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => void save()} isLoading={saving} disabled={disabled || !accountSid.trim() || !serviceSid.trim() || (!state.configured && !authToken.trim())}>Save</Button>
      {state.configured && <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={disabled || saving}>Turn off</Button>}
    </div>
  </div>;
}
