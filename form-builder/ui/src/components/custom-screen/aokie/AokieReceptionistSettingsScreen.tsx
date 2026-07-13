// Receptionist Settings console (SDK screen `aokie-receptionist-settings`).
//
// A friendly, mobile-first face over the singleton Receptionist Settings
// record: grouped cards (business & greeting / personality / voice & reply
// mode / advanced AI plumbing), a single Save action, and — the part that
// makes the settings TRUSTWORTHY — a "running now" readout of the config the
// Aokie plugin is actually using (settings.get, local or via the relay) plus
// a "Save & apply now" that pushes the exact same settings.set payload the
// Configure Receptionist flow sends on every incoming call. So the answer to
// "is the bot using my settings?" is always on screen, not a matter of faith.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquareText, Mic, RefreshCw, Save, Settings2, Sparkles } from 'lucide-react';
import { useConnector, useConnectorPermission, useResponses } from '../../../sdk';
import { toast } from '../../../stores/toastStore';
import { api } from '../../../lib/api';
import { useAppRuntimeStore } from '../../../stores/appRuntimeStore';
import { performRelayCommand } from './aokieRelay';
import { useAokiePresence } from './useAokiePresence';
import { DEFAULT_PERSONA } from '../../../data/packs/aokieReceptionistPack';

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';
const inputCls =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-800/60 dark:text-white dark:placeholder:text-slate-500';
const labelCls = 'mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300';
const hintCls = 'mt-1 text-[11px] leading-snug text-gray-400 dark:text-slate-500';

/** The pack's voice options (pocket-tts voices shipped with Aokie Voice). */
const VOICES = ['', 'alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];

interface Draft {
  business_name: string;
  instructions: string;
  greeting: string;
  model: string;
  llm_endpoint: string;
  stt_endpoint: string;
  tts_endpoint: string;
  voice: string;
  reply_mode: string;
  active: string;
}

const EMPTY_DRAFT: Draft = {
  business_name: '',
  instructions: '',
  greeting: '',
  model: '',
  llm_endpoint: '',
  stt_endpoint: '',
  tts_endpoint: '',
  voice: '',
  reply_mode: 'agent',
  active: 'yes',
};

function draftFromAnswers(a: Record<string, unknown>): Draft {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  return {
    business_name: s('business_name'),
    instructions: s('instructions'),
    greeting: s('greeting'),
    model: s('model'),
    llm_endpoint: s('llm_endpoint'),
    stt_endpoint: s('stt_endpoint'),
    tts_endpoint: s('tts_endpoint'),
    voice: s('voice'),
    reply_mode: s('reply_mode') || 'agent',
    active: s('active') || 'yes',
  };
}

/**
 * The settings.set payload for a draft — the SAME composition rule as the
 * pack's Configure Receptionist flow (FLOW_AGENT_CONFIG), so "apply now" and
 * the per-call flow can never disagree about what the bot should run.
 */
export function buildAgentPayload(d: Draft): Record<string, unknown> {
  let persona = d.instructions.trim() || DEFAULT_PERSONA;
  const business = d.business_name.trim();
  if (business) persona = `You are the phone receptionist for ${business}.\n` + persona;
  let greeting = d.greeting.trim();
  if (!greeting) {
    greeting = business
      ? `Thank you for calling ${business}! How can I help you today?`
      : 'Thanks for calling! How can I help you today?';
  }
  return {
    persona,
    greeting,
    ttsVoice: d.voice.trim(),
    aiModel: d.model.trim(),
    aiEndpoint: d.llm_endpoint.trim(),
    sttEndpoint: d.stt_endpoint.trim(),
    ttsEndpoint: d.tts_endpoint.trim(),
    aiReceptionist: d.reply_mode !== 'flow',
  };
}

interface RunningConfig {
  greeting?: string;
  persona?: string;
  voice?: string;
  model?: string;
  aiReceptionist?: boolean;
  configVersion?: number;
}

export function AokieReceptionistSettingsScreen({ params }: { params?: Record<string, unknown> }) {
  const formId = typeof params?.formId === 'string' ? params.formId : undefined;
  const connector = useConnector('aokie', formId ? { formId } : undefined);
  const { can } = useConnectorPermission('aokie', undefined, formId ? { formId } : undefined);
  const presence = useAokiePresence();
  const appSlug = useAppRuntimeStore((s) => s.appSlug);
  const createResponse = useAppRuntimeStore((s) => s.createResponse);
  const updateResponse = useAppRuntimeStore((s) => s.updateResponse);
  const canSubmit = useAppRuntimeStore((s) => s.canSubmit);
  const canEdit = useAppRuntimeStore((s) => s.canEdit);
  const records = useResponses(formId ?? '', { limit: 5 });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [running, setRunning] = useState<RunningConfig | null>(null);
  const [runningError, setRunningError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remoteMode = presence.kind === 'remote';

  // Route a plugin command locally (connector.request) or via the relay when
  // the receptionist runs on another machine — same pattern as Device Setup.
  const runCommand = useCallback(
    async (command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (remoteMode) {
        if (!appSlug) throw new Error('No app context for the remote command');
        const outcome = await performRelayCommand(api, appSlug, command, undefined, payload);
        if (outcome.status !== 'done') {
          const msg = typeof outcome.error?.message === 'string' ? outcome.error.message : outcome.status;
          throw new Error(`The desktop did not complete the command (${msg})`);
        }
        return (outcome.result && typeof outcome.result === 'object' ? outcome.result : {}) as Record<string, unknown>;
      }
      const res = await connector.request(command, payload);
      return (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
    },
    [remoteMode, appSlug, connector]
  );

  // Hydrate the draft from the newest record ONCE per load (never clobber
  // in-progress edits — Discard rehydrates explicitly).
  useEffect(() => {
    if (draft !== null || records.loading) return;
    const newest = records.rows[0];
    setDraft(newest ? draftFromAnswers(newest.answers) : { ...EMPTY_DRAFT });
    setRecordId(newest ? newest.id : null);
  }, [records.loading, records.rows, draft]);

  const saved = useMemo(() => {
    const newest = records.rows[0];
    return newest ? draftFromAnswers(newest.answers) : { ...EMPTY_DRAFT };
  }, [records.rows]);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const refreshRunning = useCallback(async () => {
    if (!can('settings.get')) return;
    setRunningError(null);
    try {
      const res = await runCommand('settings.get');
      const settings = (res.settings && typeof res.settings === 'object' ? res.settings : {}) as Record<string, unknown>;
      setRunning({
        greeting: typeof settings.greeting === 'string' ? settings.greeting : undefined,
        persona: typeof settings.persona === 'string' ? settings.persona : undefined,
        voice: typeof settings.ttsVoice === 'string' ? settings.ttsVoice : undefined,
        model: typeof settings.aiModel === 'string' ? settings.aiModel : undefined,
        aiReceptionist: settings.aiReceptionist === true,
        configVersion: typeof res.configVersion === 'number' ? res.configVersion : undefined,
      });
    } catch (err) {
      setRunning(null);
      setRunningError(err instanceof Error ? err.message : String(err));
    }
  }, [can, runCommand]);

  useEffect(() => {
    void refreshRunning();
  }, [refreshRunning]);

  const persistDraft = useCallback(async (): Promise<boolean> => {
    if (!formId || !draft) return false;
    const answers: Record<string, unknown> = { ...draft };
    try {
      if (recordId) {
        await updateResponse(formId, recordId, { answers });
      } else {
        const created = (await createResponse(formId, answers)) as { id?: string } | undefined;
        if (created && typeof created.id === 'string') setRecordId(created.id);
      }
      records.reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [formId, draft, recordId, updateResponse, createResponse, records]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    const ok = await persistDraft();
    setSaving(false);
    if (ok) {
      toast.success('Settings saved', 'Applied automatically at the next incoming call.');
    }
  }, [persistDraft]);

  const handleSaveAndApply = useCallback(async () => {
    if (!draft) return;
    setApplying(true);
    setError(null);
    try {
      const ok = await persistDraft();
      if (!ok) return;
      if (draft.active === 'no') {
        toast.info('Saved (marked inactive)', 'This record is inactive, so it was not pushed to the receptionist.');
        return;
      }
      await runCommand('settings.set', buildAgentPayload(draft));
      await refreshRunning();
      toast.success('Applied to the receptionist', 'The very next call uses this configuration.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [draft, persistDraft, runCommand, refreshRunning]);

  if (!formId) {
    return <p className="text-sm text-gray-400 dark:text-slate-500">This screen expects to be attached to the Receptionist Settings form.</p>;
  }
  if (draft === null) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-gray-400 dark:text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  const mayWrite = recordId ? canEdit(formId) : canSubmit(formId);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const preview = buildAgentPayload(draft);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* ── Running-now strip: the proof the bot uses these settings ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">What the receptionist is running now</h2>
          <button
            type="button"
            onClick={() => void refreshRunning()}
            title="Re-read the live configuration from the Aokie plugin"
            className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {running ? (
          <div className="space-y-1 text-sm">
            <p className="text-gray-900 dark:text-white">
              <span className="text-gray-400 dark:text-slate-500">Greeting: </span>“{running.greeting || '—'}”
            </p>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Voice {running.voice || 'default'} · model {running.model || 'auto'} ·{' '}
              {running.aiReceptionist ? 'built-in AI agent replies' : 'flow-driven replies'}
              {typeof running.configVersion === 'number' ? ` · config v${running.configVersion}` : ''}
            </p>
            {running.persona && (
              <p className="line-clamp-2 text-[11px] text-gray-400 dark:text-slate-500" title={running.persona}>
                {running.persona}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {runningError
              ? `Live configuration unavailable — ${runningError}`
              : can('settings.get')
                ? 'Reading the live configuration…'
                : 'Your role cannot read the live configuration.'}
          </p>
        )}
        <p className={hintCls}>
          The Configure Receptionist flow re-applies the saved settings on every incoming call, so saving is enough — “Save
          &amp; apply now” just updates the live line immediately instead of at the next ring.
        </p>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ── Business & greeting ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Business &amp; greeting</h2>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className={labelCls} htmlFor="rs-business">Business name</label>
            <input
              id="rs-business"
              type="text"
              value={draft.business_name}
              onChange={(e) => set({ business_name: e.target.value })}
              placeholder="e.g. Bright Smile Dental"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="rs-greeting">Greeting (spoken first)</label>
            <input
              id="rs-greeting"
              type="text"
              value={draft.greeting}
              onChange={(e) => set({ greeting: e.target.value })}
              placeholder={preview.greeting as string}
              className={inputCls}
            />
            <p className={hintCls}>Blank uses the friendly default shown above. Known callers are greeted by name automatically.</p>
          </div>
        </div>
      </div>

      {/* ── Personality ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">How should it talk &amp; behave?</h2>
        </div>
        <textarea
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={6}
          placeholder="e.g. Be warm and concise. Offer to book appointments Mon–Fri 9–5. If asked about prices, give the standard checkup price of $90 and offer to book."
          className={inputCls + ' resize-y'}
        />
        <p className={hintCls}>Blank uses Aokie's built-in receptionist persona. Plain English works — treat it like briefing a new hire.</p>
      </div>

      {/* ── Voice & replies ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Mic className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Voice &amp; replies</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="rs-voice">Voice</label>
            <select id="rs-voice" value={draft.voice} onChange={(e) => set({ voice: e.target.value })} className={inputCls + ' cursor-pointer'}>
              {VOICES.map((v) => (
                <option key={v || 'default'} value={v}>{v === '' ? 'Default' : v.charAt(0).toUpperCase() + v.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="rs-active">Active</label>
            <select id="rs-active" value={draft.active} onChange={(e) => set({ active: e.target.value })} className={inputCls + ' cursor-pointer'}>
              <option value="yes">Yes — use these settings</option>
              <option value="no">No — fall back to defaults</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rs-replymode">Who answers the caller</label>
            <select id="rs-replymode" value={draft.reply_mode} onChange={(e) => set({ reply_mode: e.target.value })} className={inputCls + ' cursor-pointer'}>
              <option value="agent">Built-in AI agent (recommended — fast, on-device)</option>
              <option value="flow">Custom flow (edit the Live Reply flow yourself)</option>
            </select>
            <p className={hintCls}>
              Unlike everything else here, reply mode only takes effect the next time Aokie reconnects — the plugin reads it
              once at startup, not per call.
            </p>
          </div>
        </div>
      </div>

      {/* ── Advanced (collapsed by default) ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-2 text-left"
        >
          {showAdvanced ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Advanced — AI model &amp; endpoints</h2>
          <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500">blank = auto-detect</span>
        </button>
        {showAdvanced && (
          <div className="mt-3 grid grid-cols-1 gap-3">
            <div>
              <label className={labelCls} htmlFor="rs-model">LLM model</label>
              <input id="rs-model" type="text" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="e.g. llama3.1:8b (blank = auto)" className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-llm">LLM endpoint</label>
              <input id="rs-llm" type="text" value={draft.llm_endpoint} onChange={(e) => set({ llm_endpoint: e.target.value })} placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions" className={inputCls + ' font-mono text-xs'} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-stt">Speech-to-text endpoint</label>
              <input id="rs-stt" type="text" value={draft.stt_endpoint} onChange={(e) => set({ stt_endpoint: e.target.value })} placeholder="e.g. http://127.0.0.1:17920/v1/audio/transcriptions" className={inputCls + ' font-mono text-xs'} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-tts">Text-to-speech endpoint</label>
              <input id="rs-tts" type="text" value={draft.tts_endpoint} onChange={(e) => set({ tts_endpoint: e.target.value })} placeholder="e.g. http://127.0.0.1:17920/v1/audio/speech" className={inputCls + ' font-mono text-xs'} />
            </div>
          </div>
        )}
      </div>

      {/* ── Save bar (sticky on mobile so it's always reachable) ── */}
      <div className="sticky bottom-2 z-10">
        <div className={`${card} flex flex-wrap items-center gap-2 p-3 shadow-lg`}>
          {dirty ? (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Unsaved changes</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {dirty && (
              <button
                type="button"
                onClick={() => { setDraft(saved); }}
                className="cursor-pointer rounded-xl px-3 py-2 text-xs font-medium text-gray-500 hover:bg-gray-50 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!mayWrite || saving || applying || !dirty}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </button>
            {can('settings.set') && (
              <button
                type="button"
                onClick={() => void handleSaveAndApply()}
                disabled={!mayWrite || saving || applying}
                title="Save, then push this configuration to the live receptionist immediately"
                className="app-btn-primary inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
              >
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Save &amp; apply now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
