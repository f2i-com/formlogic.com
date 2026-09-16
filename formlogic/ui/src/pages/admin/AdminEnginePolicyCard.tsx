// Admin → Platform: "App engine" card (GET/PUT /api/admin/engine-policy).
//
// Decides which client engine embedded apps run on: the site default, and the engines owners may
// pick between. The SERVER enforces it on every runtime request; this card only edits it, and the
// same rules are applied there, so a refusal here is the same refusal an API caller would get.
// Two rules are structural rather than stylistic: the default must be a ZIPP engine, and
// ZIPP (JavaScript and Python) can never be removed, because it is the fallback every other
// choice falls back TO.
import { useCallback, useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api, type ClientEngineId, type EnginePolicy } from '../../lib/api';
import { ENGINE_DESCRIPTIONS, ENGINE_LABELS, REQUIRED_ENGINE, ZIPP_ENGINES } from '../../lib/clientEngines';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';

/** Enough of the policy to drive the card: anything less is a malformed answer, not a policy. */
function isEnginePolicy(value: unknown): value is EnginePolicy {
  const p = value as EnginePolicy | undefined;
  return !!p && typeof p === 'object' && typeof p.default === 'string' && Array.isArray(p.allowed);
}

export function AdminEnginePolicyCard() {
  const [policy, setPolicy] = useState<EnginePolicy | null>(null);
  const [installed, setInstalled] = useState<ClientEngineId[]>([]);
  const [engines, setEngines] = useState<ClientEngineId[]>([]);
  const [draft, setDraft] = useState<{ default: ClientEngineId; allowed: ClientEngineId[]; hostJsRequireWorker: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const apply = useCallback((next: EnginePolicy) => {
    setPolicy(next);
    // Coerced, not trusted: the draft is what a save sends back, and the server refuses a
    // non-boolean outright, so an answer missing the flag must not turn into a 400 on save.
    setDraft({ default: next.default, allowed: [...next.allowed], hostJsRequireWorker: next.hostJsRequireWorker === true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.adminGetEnginePolicy().then((r) => {
      if (cancelled) return;
      // A 2xx whose body is not the shape this asked for is a failure, not a policy. Reading
      // through it would throw inside the promise, so setLoadError below would never run and the
      // card would sit on its spinner for ever saying nothing — the one failure mode a card that
      // governs which engine runs author code must not have.
      if (isEnginePolicy(r.data?.policy)) {
        apply(r.data.policy);
        setInstalled(Array.isArray(r.data.installed) ? r.data.installed : []);
        setEngines(Array.isArray(r.data.engines) ? r.data.engines : []);
        setLoadError(null);
      } else {
        setLoadError(r.error || 'Could not load the app engine policy');
      }
    });
    return () => { cancelled = true; };
  }, [apply, reloadTick]);

  const retry = () => { setPolicy(null); setDraft(null); setLoadError(null); setReloadTick((t) => t + 1); };

  const toggleAllowed = (engine: ClientEngineId, on: boolean) => {
    setDraft((current) => {
      if (!current || engine === REQUIRED_ENGINE) return current;
      const allowed = on ? [...current.allowed, engine] : current.allowed.filter((e) => e !== engine);
      // Dropping the current default would make the policy unsavable; move it back to the fallback.
      const fallback = allowed.includes(current.default) ? current.default : REQUIRED_ENGINE;
      return { ...current, allowed: engines.filter((e) => allowed.includes(e)), default: fallback };
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const r = await api.adminPutEnginePolicy(draft);
    setSaving(false);
    if (r.error || !r.data) {
      toast.error('Could not save the app engine policy', r.error || undefined);
      return;
    }
    apply(r.data.policy);
    setInstalled(r.data.installed);
    toast.success('App engine policy saved', `Revision ${r.data.policy.revision}. Apps pick it up on their next load.`);
  };

  const dirty = !!policy && !!draft && (
    policy.default !== draft.default
    || policy.hostJsRequireWorker !== draft.hostJsRequireWorker
    || policy.allowed.join(',') !== draft.allowed.join(',')
  );

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Cpu className="h-4 w-4" /> App engine
            {policy && <Badge variant="default">revision {policy.revision}</Badge>}
          </h3>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Which engine embedded apps run on. Owners choose per app from what you allow here; the server
            decides the engine on every load, so changes apply the next time an app opens.
          </p>
        </div>

        {policy === null && !loadError && <AdminSpinner label="Loading the app engine policy" />}
        {loadError && <AdminError message={loadError} onRetry={retry} />}

        {draft && policy && (
          <>
            <div>
              <label htmlFor="engine-default" className="block text-sm font-medium text-gray-700 dark:text-slate-300">Site default</label>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 mb-2">
                What an app runs on when its owner has not chosen. Only a ZIPP engine can be the default, so every
                other choice always has somewhere to fall back to.
              </p>
              <select
                id="engine-default"
                value={draft.default}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, default: e.target.value as ClientEngineId })}
                className="max-w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100"
              >
                {engines.filter((e) => (ZIPP_ENGINES as readonly string[]).includes(e) && draft.allowed.includes(e)).map((e) => (
                  <option key={e} value={e}>{ENGINE_LABELS[e]}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Engines owners may choose</p>
              {engines.map((engine) => {
                const locked = engine === REQUIRED_ENGINE;
                return (
                  <div key={engine} className="flex flex-wrap items-start gap-3 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {ENGINE_LABELS[engine]}
                        {locked && <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">always available</span>}
                        {!installed.includes(engine) && <Badge variant="warning" className="ml-2">not in the installed runtime</Badge>}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-slate-400">{ENGINE_DESCRIPTIONS[engine]}</p>
                    </div>
                    <Switch
                      size="sm"
                      checked={draft.allowed.includes(engine)}
                      disabled={saving || locked}
                      onChange={(on) => toggleAllowed(engine, on)}
                      ariaLabel={`Allow ${ENGINE_LABELS[engine]}`}
                    />
                  </div>
                );
              })}
            </div>

            {draft.allowed.includes('host-js') && (
              <p role="note" className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                Host JavaScript removes the virtual machine from around an app&apos;s code. It still runs in the
                sandboxed frame with no access to FormLogic&apos;s cookies, storage or API, but a runaway app can
                freeze the viewer&apos;s tab. Only accounts you verify for code trust can use it, and you verify
                those one at a time in <strong>Users</strong>.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void save()} disabled={!dirty || saving} isLoading={saving}>Save</Button>
              {dirty ? <Badge variant="warning">unsaved</Badge> : null}
              <span className="text-xs text-gray-500 dark:text-slate-400">
                Installed runtime serves: {installed.map((e) => ENGINE_LABELS[e]).join(', ')}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
