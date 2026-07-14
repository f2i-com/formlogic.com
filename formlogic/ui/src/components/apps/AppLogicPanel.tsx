// Deploy panel: author sandboxed QuickJS app-logic in-product (spec §54).
//
// Owners add scripts through a guided modal (pick a hook with a plain-language description,
// then start blank or from that hook's starter snippet), edit them in Monaco-backed cards
// (hook badge, optional description, enable toggle, permission quick-add chips), and
// "Test run" each one against the real QuickJS host with a sample ctx before saving.
// Persists via api.updateApp; the backend re-sanitizes + re-validates on save and on submit.
import { useId, useMemo, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { runHook, type AppLogicHookOutcome } from '../../client-runtime/logic/appLogicHost';
import type { AppLogicEffectHandlers } from '../../client-runtime/logic/appLogicEffects';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Switch } from '../ui/Switch';
import { CodeEditor } from '../ui/CodeEditor';
import { EmptyState } from '../ui/EmptyState';
import type { CustomAppLogicBundle, CustomAppLogicHookName, CustomAppLogicPermission, CustomAppLogicScript } from '../../types/customAppLogic';

// The four hooks most apps reach for first; the rest sit behind "More hooks" in the add modal.
const PRIMARY_HOOKS: CustomAppLogicHookName[] = ['onScreenEnter', 'onBeforeSubmit', 'onConnectorEvent', 'onAfterSubmit'];
const MORE_HOOKS: CustomAppLogicHookName[] = ['onAppStart', 'onScreenLeave', 'onButtonClick', 'onSyncConflict', 'mapConnectorDataToForm', 'calculateDashboardState'];
const ALL_HOOKS: CustomAppLogicHookName[] = [...PRIMARY_HOOKS, ...MORE_HOOKS];

const HOOK_INFO: Record<CustomAppLogicHookName, string> = {
  onScreenEnter: 'Prefill fields from a connector when a form screen opens.',
  onBeforeSubmit: 'Validate answers and block a submission with a message.',
  onConnectorEvent: 'Map device/vehicle data into form fields as it arrives.',
  onAfterSubmit: 'Show a toast or navigate after a successful save.',
  onAppStart: 'Run once when the app launches.',
  onScreenLeave: 'Run when the user leaves a screen.',
  onButtonClick: 'Handle a custom button press on a screen.',
  onSyncConflict: 'Decide what happens when offline changes clash.',
  mapConnectorDataToForm: 'Transform a raw connector payload into field values.',
  calculateDashboardState: 'Compute values for the app dashboard to read.',
};

// "Start with a starter" source per hook — small, working, and safe to run under Test.
const STARTER: Record<CustomAppLogicHookName, string> = {
  onBeforeSubmit: "function run(ctx) {\n  if (Number(ctx.answers.fuel_percent || 0) < 15) {\n    return { reject: true, message: 'Fuel is too low to start this shift.' };\n  }\n  return { ok: true };\n}",
  onConnectorEvent: "function run(ctx) {\n  var e = ctx.event;\n  if (!e) return {};\n  // Phone abilities: e.result is the device data (see the 'device' connector).\n  if (e.command === 'gps.read') return { ui: { setValues: { latitude: e.result.lat, longitude: e.result.lng } } };\n  var v = e.vehicleStatus;\n  if (v) return { ui: { setValues: { fleet_number: v.fleetNumber, fuel_percent: v.fuelPercent } } };\n  return {};\n}",
  onScreenEnter: "function run(ctx) {\n  // Ask a connector for data on screen open. Use 'device' for phone abilities\n  // (gps.read, battery.read, network.read, info.read, …) or your own connector.\n  return { effects: [{ type: 'connector.request', connectorId: 'device', command: 'gps.read' }] };\n}",
  onAfterSubmit: "function run(ctx) {\n  return { ui: { toast: { message: 'Submission saved.', level: 'success' } } };\n}",
  onAppStart: "function run(ctx) {\n  return { ui: { toast: { message: 'Welcome back.', level: 'info' } } };\n}",
  onScreenLeave: "function run(ctx) {\n  // Remember the last screen for the next visit.\n  return { effects: [{ type: 'storage.set', key: 'last_screen', value: ctx.meta.screenId || '' }] };\n}",
  onButtonClick: "function run(ctx) {\n  return { ui: { navigate: { screenId: 'dashboard' } } };\n}",
  onSyncConflict: "function run(ctx) {\n  // ctx.event carries the clashing copies; return {} to accept the default resolution.\n  return {};\n}",
  mapConnectorDataToForm: "function run(ctx) {\n  var v = (ctx.event && ctx.event.vehicleStatus) || {};\n  return { ui: { setValues: { fleet_number: v.fleetNumber, fuel_percent: v.fuelPercent } } };\n}",
  calculateDashboardState: "function run(ctx) {\n  return { value: { lastChecked: ctx.meta.now } };\n}",
};

const BLANK_SOURCE = 'function run(ctx) {\n  \n}';

// Quick-add grants for the per-script permissions input.
const COMMON_GRANTS = ['ui.setValues', 'ui.toast', 'connector.device.*', 'connector.vehicle.*'];

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

const parsePerms = (text: string) =>
  text.split(',').map((p) => p.trim()).filter(Boolean) as CustomAppLogicPermission[];

/** Guided add-script modal: pick the hook (with descriptions), then blank vs starter. */
function AddScriptModal({ isOpen, onClose, onAdd }: {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (hook: CustomAppLogicHookName, source: string) => void;
}) {
  // The shared Modal renders children ONLY while open, so the inner form below mounts fresh on
  // every open — its useState initializers ARE the reset (no reset-on-open effect needed).
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add a script" description="Pick when it runs, then choose how to start." size="lg">
      <AddScriptForm onClose={onClose} onAdd={onAdd} />
    </Modal>
  );
}

function AddScriptForm({ onClose, onAdd }: {
  onClose: () => void;
  onAdd: (hook: CustomAppLogicHookName, source: string) => void;
}) {
  const [hook, setHook] = useState<CustomAppLogicHookName | null>(null);
  const [start, setStart] = useState<'blank' | 'starter'>('blank');
  const [showMore, setShowMore] = useState(false);

  const hookOption = (h: CustomAppLogicHookName) => {
    const selected = hook === h;
    return (
      <button
        key={h}
        type="button"
        aria-pressed={selected}
        onClick={() => setHook(h)}
        className={`w-full text-left rounded-xl border px-3.5 py-2.5 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
          selected
            ? 'border-primary-400 dark:border-primary-500/60 bg-primary-50/70 dark:bg-primary-500/10'
            : 'border-gray-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-500/40 hover:bg-gray-50 dark:hover:bg-slate-800/50'
        }`}
      >
        <span className="block font-mono text-sm font-medium text-gray-900 dark:text-white">{h}</span>
        <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">{HOOK_INFO[h]}</span>
      </button>
    );
  };

  const startOption = (key: 'blank' | 'starter', label: string, desc: string) => {
    const selected = start === key;
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => setStart(key)}
        className={`text-left rounded-xl border px-3.5 py-2.5 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
          selected
            ? 'border-primary-400 dark:border-primary-500/60 bg-primary-50/70 dark:bg-primary-500/10'
            : 'border-gray-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-500/40 hover:bg-gray-50 dark:hover:bg-slate-800/50'
        }`}
      >
        <span className="block text-sm font-medium text-gray-900 dark:text-white">{label}</span>
        <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">{desc}</span>
      </button>
    );
  };

  return (
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">When should it run?</p>
          <div className="space-y-2">{PRIMARY_HOOKS.map(hookOption)}</div>
          <button
            type="button"
            onClick={() => setShowMore((m) => !m)}
            aria-expanded={showMore}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
          >
            {showMore ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            More hooks ({MORE_HOOKS.length})
          </button>
          {showMore && <div className="mt-2 space-y-2">{MORE_HOOKS.map(hookOption)}</div>}
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Start with</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {startOption('blank', 'Blank', 'An empty run(ctx) function to write yourself.')}
            {startOption('starter', 'Starter example', hook ? `A small working snippet for ${hook}.` : 'A small working snippet for the chosen hook.')}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={!hook}
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => { if (hook) onAdd(hook, start === 'starter' ? STARTER[hook] : BLANK_SOURCE); }}
          >
            Add script
          </Button>
        </div>
      </div>
  );
}

export function AppLogicPanel({ appId, initialLogic }: { appId: string; initialLogic?: CustomAppLogicBundle }) {
  const [open, setOpen] = useState(false);
  const [scripts, setScripts] = useState<CustomAppLogicScript[]>(() => initialLogic?.scripts ?? []);
  const [appPerms, setAppPerms] = useState(() => (initialLogic?.permissions ?? []).join(', '));
  const [strict, setStrict] = useState(() => initialLogic?.strictPermissions ?? true);
  const [saving, setSaving] = useState(false);
  const [testOut, setTestOut] = useState<Record<string, string>>({});
  // Raw text per script id so a trailing comma survives while typing (the parsed
  // permissions array is kept in sync on every keystroke).
  const [permText, setPermText] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CustomAppLogicScript | null>(null);
  // How many scripts the last save (or initial load) persisted — drives the
  // "all scripts removed, save to apply" affordance in the empty state.
  const [lastSavedCount, setLastSavedCount] = useState(() => initialLogic?.scripts?.length ?? 0);
  const appPermsId = useId();

  const update = (id: string, patch: Partial<CustomAppLogicScript>) =>
    setScripts((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const bundle = useMemo<CustomAppLogicBundle>(() => ({
    version: 1,
    runtime: 'quickjs',
    strictPermissions: strict,
    permissions: parsePerms(appPerms),
    scripts,
  }), [scripts, appPerms, strict]);

  const addScript = (hook: CustomAppLogicHookName, source: string) => {
    setScripts((l) => [...l, {
      id: `script_${Math.random().toString(36).slice(2, 8)}`,
      hook,
      runtime: 'quickjs',
      source,
      enabled: true,
    }]);
    setAddOpen(false);
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setScripts((l) => l.filter((s) => s.id !== id));
    setTestOut((o) => { const rest = { ...o }; delete rest[id]; return rest; });
    setPermText((t) => { const rest = { ...t }; delete rest[id]; return rest; });
    setPendingDelete(null);
  };

  const toggleGrant = (s: CustomAppLogicScript, grant: string) => {
    const cur = s.permissions ?? [];
    const next = cur.includes(grant as CustomAppLogicPermission)
      ? cur.filter((p) => p !== grant)
      : [...cur, grant as CustomAppLogicPermission];
    update(s.id, { permissions: next });
    setPermText((t) => ({ ...t, [s.id]: next.join(', ') }));
  };

  const test = async (s: CustomAppLogicScript) => {
    setTestOut((o) => ({ ...o, [s.id]: 'Running…' }));
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
      setTestOut((o) => ({ ...o, [s.id]: formatOutcome(outcome, applied) }));
    } catch (e) {
      setTestOut((o) => ({ ...o, [s.id]: 'Error: ' + (e instanceof Error ? e.message : String(e)) }));
    }
  };

  const save = async () => {
    setSaving(true);
    const r = await api.updateApp(appId, { customLogic: bundle });
    setSaving(false);
    if (r.error) {
      toast.error('Failed to save app logic', typeof r.error === 'string' ? r.error : undefined);
    } else {
      setLastSavedCount(scripts.length);
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

          {scripts.length === 0 ? (
            <>
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-slate-700">
                <EmptyState
                  icon={Braces}
                  title="No app logic yet"
                  description="Hooks run small sandboxed scripts at key moments — prefill fields when a screen opens, validate before a submit, or map device data into fields."
                  action={
                    <Button size="sm" onClick={() => setAddOpen(true)} leftIcon={<Plus className="h-4 w-4" />}>
                      Add script
                    </Button>
                  }
                />
              </div>
              {lastSavedCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-gray-500 dark:text-slate-400">All scripts removed — save to apply the change.</p>
                  <Button size="sm" onClick={save} isLoading={saving} disabled={saving}>Save app logic</Button>
                </div>
              )}
            </>
          ) : (
            <>
              {/* App-level grants */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto] gap-x-4 gap-y-3 items-start">
                <div>
                  <label htmlFor={appPermsId} className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">App-wide permissions</label>
                  <input
                    id={appPermsId}
                    value={appPerms}
                    onChange={(e) => setAppPerms(e.target.value)}
                    placeholder="ui.setValues, ui.toast, connector.device.gps.read, connector.device.*"
                    className="w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm font-mono focus:ring-2 focus:ring-primary-500"
                  />
                  <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Comma-separated grants every script receives; add script-only grants on the cards below.</p>
                </div>
                <div className="sm:pt-9">
                  <Switch checked={strict} onChange={setStrict} label="Strict permissions" size="sm" />
                </div>
              </div>

              {/* Script cards */}
              {scripts.map((s) => (
                <div key={s.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 overflow-hidden">
                  {/* Header: hook badge + description + enabled + actions */}
                  <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-gray-50/70 dark:bg-slate-800/40 border-b border-gray-200/80 dark:border-slate-700/60">
                    <select
                      value={s.hook}
                      onChange={(e) => update(s.id, { hook: e.target.value as CustomAppLogicHookName })}
                      aria-label="Hook"
                      className="px-2.5 py-1.5 rounded-lg border border-primary-200/70 dark:border-primary-500/25 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300 text-xs font-mono font-medium focus:ring-2 focus:ring-primary-500 focus:outline-none cursor-pointer"
                    >
                      {ALL_HOOKS.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <input
                      value={s.description ?? ''}
                      onChange={(e) => update(s.id, { description: e.target.value || undefined })}
                      placeholder="What does this script do? (optional)"
                      aria-label="Script description"
                      className="flex-1 min-w-[8rem] px-2.5 py-1.5 text-sm rounded-lg border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
                    />
                    <Switch checked={s.enabled !== false} onChange={(v) => update(s.id, { enabled: v })} label="Enabled" size="sm" />
                    <Button variant="outline" size="sm" onClick={() => test(s)} leftIcon={<Play className="h-3.5 w-3.5" />}>Test run</Button>
                    <Button variant="ghost" size="sm" onClick={() => setPendingDelete(s)} aria-label="Delete script">
                      <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                    </Button>
                  </div>

                  <div className={`p-4 space-y-3 ${s.enabled === false ? 'opacity-60' : ''}`}>
                    <p className="text-xs text-gray-400 dark:text-slate-500">{HOOK_INFO[s.hook]}</p>

                    {/* Code editor (lazy Monaco, javascript) */}
                    <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                      <CodeEditor value={s.source} onChange={(v) => update(s.id, { source: v })} language="javascript" sdk="app" height={220} />
                    </div>

                    {/* Script-level permissions */}
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                        <span className="text-xs font-medium text-gray-500 dark:text-slate-400 mr-1">Permissions</span>
                        {COMMON_GRANTS.map((g) => {
                          const on = (s.permissions ?? []).includes(g as CustomAppLogicPermission);
                          return (
                            <button
                              key={g}
                              type="button"
                              aria-pressed={on}
                              title={on ? `Remove ${g}` : `Grant ${g}`}
                              onClick={() => toggleGrant(s, g)}
                              className={`px-2 py-0.5 rounded-full border text-[11px] font-mono transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                                on
                                  ? 'border-primary-300 dark:border-primary-500/40 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                                  : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-primary-300 dark:hover:border-primary-500/40 hover:text-primary-600 dark:hover:text-primary-400'
                              }`}
                            >
                              {g}
                            </button>
                          );
                        })}
                      </div>
                      <input
                        value={permText[s.id] ?? (s.permissions ?? []).join(', ')}
                        onChange={(e) => {
                          setPermText((t) => ({ ...t, [s.id]: e.target.value }));
                          update(s.id, { permissions: parsePerms(e.target.value) });
                        }}
                        placeholder="e.g. ui.setValues, connector.device.*"
                        aria-label="Script permissions"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 text-xs font-mono focus:ring-2 focus:ring-primary-500"
                      />
                      <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                        Grants for this script only, added on top of the app-wide list. Effects without a matching grant are denied.
                      </p>
                    </div>

                    {testOut[s.id] !== undefined && (
                      <pre className="bg-gray-900 text-green-300 rounded-lg p-3 text-xs overflow-x-auto max-h-48 whitespace-pre">{testOut[s.id]}</pre>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)} leftIcon={<Plus className="h-4 w-4" />}>
                  Add script
                </Button>
                <Button size="sm" onClick={save} isLoading={saving} disabled={saving}>Save app logic</Button>
              </div>
              <p className="text-xs text-gray-400 dark:text-slate-500">
                Test run executes this hook through the real host with a sample ctx (low fuel + a device/vehicle
                event), showing the applied values, warnings, and any effects <strong>denied</strong> for a missing
                permission — then the full outcome JSON.
              </p>
            </>
          )}
        </div>
      )}

      <AddScriptModal isOpen={addOpen} onClose={() => setAddOpen(false)} onAdd={addScript} />
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete script"
        message={pendingDelete ? `Delete this ${pendingDelete.hook} script? The change applies when you save.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
