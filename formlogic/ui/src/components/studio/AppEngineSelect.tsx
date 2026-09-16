import { useState } from 'react';
import { api, type AppEngine, type ClientEngineId, type OwnerEnginePolicy } from '../../lib/api';
import { ENGINE_DESCRIPTIONS, ENGINE_LABELS, engineLabel, engineReason } from '../../lib/clientEngines';
import { useAuthStore } from '../../stores/authStore';

/**
 * The owner's engine choice for one app (hosted deployment, native project and dashboard home all
 * share it — one column keyed on the app).
 *
 * The select offers only what the site policy allows. Host JavaScript stays disabled until an
 * administrator has verified this account for code trust, because the server refuses it anyway —
 * this only saves the owner a round trip. What the app actually runs on comes back from the
 * server, with its reason, so a choice the installed runtime cannot serve yet is visible rather
 * than silent. An admin acting as the owner cannot change it: the endpoint is owner-only.
 */
export function AppEngineSelect({
  appId,
  engine,
  policy,
  disabled,
  onChanged,
}: {
  appId: string;
  engine: AppEngine | undefined;
  policy: OwnerEnginePolicy | undefined;
  disabled?: boolean;
  onChanged: (engine: AppEngine, policy: OwnerEnginePolicy) => void;
}) {
  const verified = useAuthStore((state) => !!state.user?.isCodeTrustVerified);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!engine || !policy) return null;

  const choose = async (value: string) => {
    setSaving(true);
    setError('');
    const next = value === '' ? null : (value as ClientEngineId);
    const result = await api.putAppEngine(appId, next);
    setSaving(false);
    if (result.error || !result.data) {
      setError(result.error || 'The engine could not be changed.');
      return;
    }
    onChanged(result.data.engine, result.data.policy);
  };

  const reason = engineReason(engine.reason, engine.id);
  const control = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-800 dark:text-slate-200">
        App engine
        <select
          aria-label="App engine"
          className={`${control} mt-2`}
          disabled={disabled || saving}
          value={engine.stored ?? ''}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="">Site default ({engineLabel(policy.default)})</option>
          {policy.allowed.map((id) => (
            <option key={id} value={id} disabled={id === 'host-js' && !verified}>
              {ENGINE_LABELS[id]}
              {id === 'host-js' && !verified ? ' — needs an administrator to verify this account' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
        {ENGINE_DESCRIPTIONS[engine.stored ?? policy.default]}
      </p>
      <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">
        This app runs on <strong>{engineLabel(engine.id)}</strong>.{reason ? ` ${reason}` : ''}
      </p>
      <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
        Automations and app logic written in Python always run on the full ZIPP engine, whatever this is set to.
      </p>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    </div>
  );
}
