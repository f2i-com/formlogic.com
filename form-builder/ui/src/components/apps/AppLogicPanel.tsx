// Deploy panel: author sandboxed QuickJS app-logic in-product (spec §54).
//
// Owners add/edit/enable/delete scripts bound to a hook, set permissions, and "Test run" each one
// against the real QuickJS host with a sample ctx before saving. Persists via the runtime store's
// saveCustomLogic (demo-aware). The backend re-sanitizes + re-validates on save and on submit.
import { useMemo, useState } from 'react';
import { Braces, Plus, Trash2, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { runHook, type AppLogicHookOutcome } from '../../client-runtime/logic/appLogicHost';
import type { AppLogicEffectHandlers } from '../../client-runtime/logic/appLogicEffects';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import type { CustomAppLogicBundle, CustomAppLogicHookName, CustomAppLogicScript } from '../../types/customAppLogic';

const HOOKS: CustomAppLogicHookName[] = [
  'onAppStart', 'onScreenEnter', 'onScreenLeave', 'onButtonClick', 'onBeforeSubmit',
  'onAfterSubmit', 'onConnectorEvent', 'onSyncConflict', 'mapConnectorDataToForm', 'calculateDashboardState',
];

const STARTER: Record<string, string> = {
  onBeforeSubmit: "function run(ctx) {\n  if (Number(ctx.answers.fuel_percent || 0) < 15) {\n    return { reject: true, message: 'Fuel is too low to start this shift.' };\n  }\n  return { ok: true };\n}",
  onConnectorEvent: "function run(ctx) {\n  var e = ctx.event;\n  if (!e) return {};\n  // Phone abilities: e.result is the device data (see the 'device' connector).\n  if (e.command === 'gps.read') return { ui: { setValues: { latitude: e.result.lat, longitude: e.result.lng } } };\n  var v = e.vehicleStatus;\n  if (v) return { ui: { setValues: { fleet_number: v.fleetNumber, fuel_percent: v.fuelPercent } } };\n  return {};\n}",
  onScreenEnter: "function run(ctx) {\n  // Ask a connector for data on screen open. Use 'device' for phone abilities\n  // (gps.read, battery.read, network.read, info.read, …) or your own connector.\n  return { effects: [{ type: 'connector.request', connectorId: 'device', command: 'gps.read' }] };\n}",
};

// A representative ctx so authors can Test-run without a live form/connector.
const SAMPLE_CTX = {
  answers: { fuel_percent: 8, active_fault_codes: '', vehicle_id: 'TRUCK-044' },
  values: {},
  params: {},
  meta: { nativeAvailable: false, offline: false, userRole: 'Owner', now: '2026-07-05T00:00:00Z' },
  // A device gps.read result so Test-run exercises phone-ability scripts; vehicleStatus
  // kept for the vehicle examples. Scripts read ctx.event.result.
  event: {
    connectorId: 'device',
    command: 'gps.read',
    result: { lat: -27.4698, lng: 153.0251, accuracy: 12 },
    vehicleStatus: { vehicleId: 'TRUCK-044', fleetNumber: 'F044', fuelPercent: 8, faultCodes: ['P0123'] },
  },
};

function newScript(): CustomAppLogicScript {
  return { id: `script_${Math.random().toString(36).slice(2, 8)}`, hook: 'onBeforeSubmit', runtime: 'quickjs', source: STARTER.onBeforeSubmit, enabled: true };
}

/** Human-readable summary of a host run — leads with the outcome + denied permissions, then full JSON. */
function formatOutcome(o: AppLogicHookOutcome, applied: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(o.rejected ? `❌ REJECTED: ${o.message ?? ''}` : `✓ ran ${o.ran} script${o.ran === 1 ? '' : 's'}`);
  if (Object.keys(applied).length) lines.push('setValues → ' + JSON.stringify(applied));
  if (o.warnings.length) lines.push('⚠ warnings: ' + o.warnings.join('; '));
  if (o.deniedPermissions.length) lines.push('⛔ DENIED (missing permission): ' + o.deniedPermissions.join(', '));
  if (o.errors.length) lines.push('errors: ' + o.errors.join('; '));
  return lines.join('\n') + '\n\n' + JSON.stringify(o, null, 2);
}

export function AppLogicPanel({ appId, initialLogic }: { appId: string; initialLogic?: CustomAppLogicBundle }) {
  const [open, setOpen] = useState(false);
  const [scripts, setScripts] = useState<CustomAppLogicScript[]>(() => initialLogic?.scripts ?? []);
  const [appPerms, setAppPerms] = useState(() => (initialLogic?.permissions ?? []).join(', '));
  const [strict, setStrict] = useState(() => initialLogic?.strictPermissions ?? true);
  const [saving, setSaving] = useState(false);
  const [testOut, setTestOut] = useState<Record<number, string>>({});

  const update = (i: number, patch: Partial<CustomAppLogicScript>) =>
    setScripts((list) => list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const bundle = useMemo<CustomAppLogicBundle>(() => ({
    version: 1,
    runtime: 'quickjs',
    strictPermissions: strict,
    permissions: appPerms.split(',').map((p) => p.trim()).filter(Boolean) as CustomAppLogicBundle['permissions'],
    scripts,
  }), [scripts, appPerms, strict]);

  const test = async (i: number) => {
    const s = scripts[i];
    setTestOut((o) => ({ ...o, [i]: 'Running…' }));
    try {
      // Preview through the REAL trusted host (runHook), not raw runAppLogic — so the output reflects
      // permission checks + effect application (what the runtime actually does), including any effect
      // DENIED for a missing grant. Runs every script bound to this hook so connector→onConnectorEvent
      // chains resolve; the mock connector handler feeds the sample event result.
      const applied: Record<string, unknown> = {};
      const handlers: AppLogicEffectHandlers = {
        setValues: (v) => Object.assign(applied, v),
        toast: () => {},
        connectorRequest: async () => SAMPLE_CTX.event.result,
      };
      const outcome = await runHook({
        bundle,
        hook: s.hook,
        input: { answers: SAMPLE_CTX.answers, values: {}, params: {}, meta: SAMPLE_CTX.meta, event: SAMPLE_CTX.event },
        handlers,
      });
      setTestOut((o) => ({ ...o, [i]: formatOutcome(outcome, applied) }));
    } catch (e) {
      setTestOut((o) => ({ ...o, [i]: 'Error: ' + (e instanceof Error ? e.message : String(e)) }));
    }
  };

  const save = async () => {
    setSaving(true);
    const r = await api.updateApp(appId, { customLogic: bundle });
    setSaving(false);
    if (r.error) {
      toast.error('Failed to save app logic', typeof r.error === 'string' ? r.error : undefined);
    } else {
      toast.success('App logic saved', `${scripts.length} script${scripts.length === 1 ? '' : 's'} active.`);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 text-left">
        <Braces className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        <h3 className="flex-1 font-medium text-gray-900 dark:text-white tracking-tight">App logic (QuickJS)</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">{scripts.length} script{scripts.length === 1 ? '' : 's'}</span>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Sandboxed scripts that run in the app runtime to prefill fields, warn, or block a submit. They can only
            return <em>effects</em>; the server stays authoritative. Every effect needs a matching permission.
          </p>

          {/* App-level grants */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto] gap-3 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">App-wide permissions</label>
              <input
                value={appPerms}
                onChange={(e) => setAppPerms(e.target.value)}
                placeholder="ui.setValues, ui.toast, connector.device.gps.read, connector.device.*"
                className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 pb-2.5">
              <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} className="rounded" />
              Strict permissions
            </label>
          </div>

          {/* Scripts */}
          {scripts.map((s, i) => (
            <div key={s.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={s.hook}
                  onChange={(e) => update(i, { hook: e.target.value as CustomAppLogicHookName })}
                  className="px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500"
                >
                  {HOOKS.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-slate-400">
                  <input type="checkbox" checked={s.enabled !== false} onChange={(e) => update(i, { enabled: e.target.checked })} className="rounded" />
                  Enabled
                </label>
                <div className="flex-1" />
                <Button variant="outline" size="sm" onClick={() => test(i)} leftIcon={<Play className="h-3.5 w-3.5" />}>Test run</Button>
                <Button variant="ghost" size="sm" onClick={() => setScripts((l) => l.filter((_, idx) => idx !== i))} aria-label="Delete script">
                  <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
              <textarea
                value={s.source}
                onChange={(e) => update(i, { source: e.target.value })}
                spellCheck={false}
                rows={8}
                className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-600 rounded-lg bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-white text-xs font-mono leading-relaxed focus:ring-2 focus:ring-primary-500 resize-y"
              />
              <input
                value={(s.permissions ?? []).join(', ')}
                onChange={(e) => update(i, { permissions: e.target.value.split(',').map((p) => p.trim()).filter(Boolean) as CustomAppLogicScript['permissions'] })}
                placeholder="script-level permissions (optional, added to app-wide)"
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 text-xs font-mono focus:ring-2 focus:ring-primary-500"
              />
              {testOut[i] !== undefined && (
                <pre className="bg-gray-900 text-green-300 rounded-lg p-3 text-xs overflow-x-auto max-h-48 whitespace-pre">{testOut[i]}</pre>
              )}
            </div>
          ))}

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => setScripts((l) => [...l, newScript()])} leftIcon={<Plus className="h-4 w-4" />}>
              Add script
            </Button>
            <Button size="sm" onClick={save} isLoading={saving} disabled={saving}>Save app logic</Button>
          </div>
          <p className="text-xs text-gray-400 dark:text-slate-500">
            Test run executes this hook through the real host with a sample ctx (low fuel + a device/vehicle
            event), showing the applied values, warnings, and any effects <strong>denied</strong> for a missing
            permission — then the full outcome JSON.
          </p>
        </div>
      )}
    </div>
  );
}
