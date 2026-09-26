import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { resolveDefaultLlm, resolveDefaultLlmTools, TOOLS_UNSUPPORTED } from '../../client-runtime/flows/aiDefault';
import { EDITOR_AI_LIMITS, EDITOR_AI_TOOLS_VERSION, validateEditorAiToolRequest } from '../../client-runtime/flows/aiToolCalls';
import { EDITOR_BRIDGE_PROTOCOL } from '../../lib/softn/protocol';
import { ArrowLeft, Check, Copy, Loader2, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { EDITOR_AGENT_RUNS_VERSION, readAgentStatus, type EditorAgentStatus, type EditorBrief } from './editorAgent';

export type AppEditorKind = 'builder' | 'studio';

/** Older hosted manifests omit the file inventory required by the visual editor. */
function editorBundle(bundle: Uint8Array): Uint8Array {
  const files = unzipSync(bundle);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const client = Object.keys(files).filter(path => !/^(server|backend|private)\//.test(path));
  const inventory = { ui: client.filter(path => path.endsWith('.ui')), logic: client.filter(path => path.endsWith('.logic')), assets: client.filter(path => path.startsWith('assets/')), xdb: client.filter(path => path.endsWith('.xdb')) };
  manifest.files = { ...manifest.files };
  for (const [group, paths] of Object.entries(inventory)) {
    manifest.files[group] = [...new Set([...(Array.isArray(manifest.files[group]) ? manifest.files[group] : []), ...paths])];
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files);
}

/** Editor changes return to the owner's draft. Publishing still uses version-checked hosting APIs. */
export function AppEditorDialog({ kind, name, bundle, onApply, onClose, brief, applyLabel = 'Review changes' }: {
  kind: AppEditorKind; name: string; bundle: Uint8Array;
  onApply: (bytes: Uint8Array) => Promise<void>; onClose: () => void;
  /** Studio only: what its agent should build or change as soon as the app opens. */
  brief?: EditorBrief;
  /** The label of the action that returns the editor's changes. */
  applyLabel?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const pending = useRef(new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());
  const lock = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aiPending, setAiPending] = useState(false);
  // Where Studio's agent is, from an editor that reports it (agentRuns); null from one that does not.
  const [agent, setAgent] = useState<EditorAgentStatus | null>(null);
  // A brief this editor cannot take (it is older than agentRuns): shown for the owner to paste in.
  const [briefToPaste, setBriefToPaste] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(false);
  const [copied, setCopied] = useState(false);
  const agentWorking = agent?.state === 'running';
  const [error, setError] = useState('');
  // Audit SN-04: a save the editor requested is acknowledged back over the
  // port only after the draft was actually taken (or with the failure reason),
  // so the editor never shows "saved" for a request this side dropped.
  const applyRef = useRef<(saveId?: string) => void>(() => {});
  function request(method: string, data: Record<string, unknown> = {}): Promise<unknown> {
    if (!port.current) return Promise.reject(new Error('The editor is not connected.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.current.delete(id); reject(new Error('The editor did not respond. Your project remains unchanged.')); }, 45000);
      pending.current.set(id, { resolve, reject, timer });
      port.current!.postMessage({ id, method, ...data });
    });
  }
  function acknowledgeSave(saveId: string | undefined, ok: boolean, error?: string) {
    if (!saveId || !port.current) return;
    try { port.current.postMessage({ kind: 'save-result', id: saveId, ok, ...(ok ? {} : { error }) }); } catch { /* the port is already gone; the editor's own timeout reports it */ }
  }
  async function apply(saveId?: string) {
    if (!ready || aiPending || agentWorking) { acknowledgeSave(saveId, false, !ready ? 'The editor is not connected to FormLogic yet.' : 'AI is still editing the draft; wait for it to finish.'); return; }
    if (lock.current) { acknowledgeSave(saveId, false, 'A previous save is still being applied.'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await request('export');
      if (!(result instanceof Uint8Array) || result.byteLength > 24 * 1024 * 1024) throw new Error('The editor returned an invalid project.');
      await onApply(result);
      acknowledgeSave(saveId, true);
      onClose();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not return your changes.';
      acknowledgeSave(saveId, false, message);
      setError(message);
    }
    finally { lock.current = false; setBusy(false); }
  }
  useLayoutEffect(() => { applyRef.current = (saveId?: string) => { void apply(saveId); }; });
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const queue = pending.current;
    let disposed = false;
    const aiRequests = new Map<string, AbortController>();
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== location.origin || event.data?.kind !== 'formlogic-editor-ready' || event.data?.protocol !== EDITOR_BRIDGE_PROTOCOL || port.current) return;
      // Native tool calls (`aiTools`) are an optional capability on top of the bridge:
      // offered back only to an editor that announced it, so an older editor sees
      // exactly the handshake and the text-only requests it always did.
      const aiTools = kind === 'studio' && Number.isInteger(event.data.aiTools) && event.data.aiTools >= EDITOR_AI_TOOLS_VERSION;
      // agentRuns, likewise: a brief and status reports only with a Studio that announced them.
      const agentRuns = kind === 'studio' && Number.isInteger(event.data.agentRuns) && event.data.agentRuns >= EDITOR_AGENT_RUNS_VERSION;
      const channel = new MessageChannel();
      port.current = channel.port1;
      channel.port1.onmessage = ({ data }) => {
        if (data?.kind === 'agent-status') { const status = agentRuns ? readAgentStatus(data) : null; if (status && !disposed) setAgent(status); return; }
        if (data?.kind === 'ai-cancel' && typeof data.id === 'string') { aiRequests.get(data.id)?.abort(); aiRequests.delete(data.id); setAiPending(false); return; }
        if (data?.kind === 'ai-request' && typeof data.id === 'string') {
          const reply = (ok: boolean, value: unknown, code?: string) => { if (!disposed) channel.port1.postMessage({ kind: 'ai-response', id: data.id, ok, ...(ok ? { value } : { error: value, ...(code ? { code } : {}) }) }); };
          const structured = data.aiTools !== undefined;
          let ask: (signal: AbortSignal) => Promise<void>;
          if (!structured) {
            // The text request every editor version sends: unchanged.
            if (kind !== 'studio' || aiRequests.size || !Array.isArray(data.messages) || data.messages.length > EDITOR_AI_LIMITS.maxMessages || !data.messages.every((m: { role?: unknown; content?: unknown }) => ['system', 'user', 'assistant'].includes(String(m?.role)) && typeof m?.content === 'string') || JSON.stringify(data.messages).length > 1000000) {
              reply(false, 'AI is busy or the request is too large.'); return;
            }
            ask = signal => resolveDefaultLlm({ messages: data.messages, signal, editor: true }).then(result => {
              if (signal.aborted) return;
              if (result.ok) reply(true, result.data.content); else reply(false, result.error.message);
            });
          } else {
            if (kind !== 'studio' || aiRequests.size) { reply(false, 'AI is busy or the request is too large.'); return; }
            if (!aiTools) { reply(false, 'FormLogic did not offer AI tool calls to this editor.', TOOLS_UNSUPPORTED); return; }
            const checked = validateEditorAiToolRequest(data);
            if (!checked.ok) { reply(false, checked.error); return; }
            ask = signal => resolveDefaultLlmTools({ ...checked.request, signal }).then(result => {
              if (signal.aborted) return;
              if (result.ok) {
                const { text, toolCalls, stopReason, usage } = result.data;
                reply(true, { text, toolCalls, stopReason, ...(usage ? { usage } : {}) });
              } else reply(false, result.error.message, result.error.code === TOOLS_UNSUPPORTED ? TOOLS_UNSUPPORTED : undefined);
            });
          }
          const controller = new AbortController(); aiRequests.set(data.id, controller); setAiPending(true);
          void ask(controller.signal).catch(error => reply(false, error instanceof Error ? error.message : 'Could not contact your AI provider.')).finally(() => { aiRequests.delete(data.id); if (!disposed) setAiPending(aiRequests.size > 0); });
          return;
        }
        if (data?.kind === 'save-requested') { applyRef.current(typeof data.id === 'string' ? data.id : undefined); return; }
        const waiting = queue.get(data?.id);
        if (!waiting) return;
        clearTimeout(waiting.timer); queue.delete(data.id);
        if (data.ok) waiting.resolve(data.value);
        else waiting.reject(new Error(typeof data.error === 'string' ? data.error : 'Editor operation failed.'));
      };
      channel.port1.start();
      frame.current!.contentWindow!.postMessage({ kind: 'formlogic-editor-connect', protocol: EDITOR_BRIDGE_PROTOCOL, ...(aiTools ? { aiTools: EDITOR_AI_TOOLS_VERSION } : {}), ...(agentRuns ? { agentRuns: EDITOR_AGENT_RUNS_VERSION } : {}) }, location.origin, [channel.port2]);
      const sendBrief = !!brief && agentRuns;
      if (brief && kind === 'studio' && !agentRuns) setBriefToPaste(brief.prompt);
      void Promise.resolve().then(() => request('open', { bytes: editorBundle(bundle), name, theme: document.documentElement.classList.contains("dark") ? "dark" : "light", saveLabel: applyLabel, ...(sendBrief ? { brief } : {}) })).then(() => { if (!disposed) setReady(true); }).catch(reason => { if (!disposed) setError(reason.message); });
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => { if (!port.current && !disposed) setError('The editor could not load. Check that the editor assets are installed on this server.'); }, 25000);
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      disposed = true; document.body.style.overflow = previous;
      window.removeEventListener('message', receive); window.removeEventListener('beforeunload', beforeUnload); clearTimeout(timer);
      for (const controller of aiRequests.values()) controller.abort(); aiRequests.clear();
      port.current?.close(); port.current = null;
      for (const waiting of queue.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Editor closed.')); } queue.clear();
    };
    // This dialog owns one immutable opening snapshot for its entire session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(<div role="dialog" aria-modal="true" aria-label={kind === 'builder' ? 'Visual Builder' : 'AI Studio'} className="fixed inset-0 z-[1000] flex h-dvh flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-white">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3 dark:border-slate-700 sm:px-5">
      <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" disabled={busy} onClick={() => { if (!ready || window.confirm(agentWorking ? 'The AI is still building your app. Leave now and the work it has done so far is lost.' : `Return without applying editor changes? Use “${applyLabel}” to keep your work.`)) onClose(); }} leftIcon={<ArrowLeft className="h-4 w-4" />}>Back</Button><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{kind === 'builder' ? 'Visual Builder' : 'AI Studio'} · {name}</h2><p className="text-xs text-slate-500 dark:text-slate-400">Edit and preview here, then choose “{applyLabel}”. The editor’s preview does not run your app’s backend; your app does.</p></div></div>
      <Button disabled={!ready || busy || aiPending || agentWorking} isLoading={busy} onClick={() => void apply()} leftIcon={<Check className="h-4 w-4" />}>{applyLabel}</Button>
    </header>
    {agent ? <AgentStatusBar status={agent} applyLabel={applyLabel} /> : aiPending && <p role="status" className="border-b border-slate-200 px-4 py-2 text-sm dark:border-slate-700">AI is editing your draft. Wait for it to finish, or choose Stop generating in Studio.</p>}
    {briefToPaste && <div role="note" className="flex flex-wrap items-center gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-950/40 dark:text-indigo-100">
      <span className="min-w-0 flex-1">This version of AI Studio does not start from a request yet: paste yours into its AI chat. <span className="text-indigo-700 dark:text-indigo-300">“{briefToPaste.length > 140 ? `${briefToPaste.slice(0, 140)}…` : briefToPaste}”</span></span>
      <Button size="sm" variant="secondary" leftIcon={<Copy className="h-4 w-4" />} onClick={() => {
        // No clipboard (a plain-http address) or a refusal: the whole request is shown to copy by hand.
        if (!navigator.clipboard) { setCopied(false); setShowRequest(true); return; }
        void navigator.clipboard.writeText(briefToPaste).then(() => setCopied(true), () => { setCopied(false); setShowRequest(true); });
      }}>{copied ? 'Copied' : 'Copy request'}</Button>
      {showRequest && <textarea readOnly aria-label="Your request" value={briefToPaste} rows={3} onFocus={event => event.currentTarget.select()} className="basis-full rounded-lg border border-indigo-200 bg-white p-2 text-sm text-slate-800 dark:border-indigo-500/30 dark:bg-slate-900 dark:text-slate-100" />}
      <Button size="sm" variant="ghost" onClick={() => setBriefToPaste(null)}>Dismiss</Button>
    </div>}
    {error && <p role="alert" className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
    <div className="relative min-h-0 flex-1">{!ready && !error && <p role="status" className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-slate-950">{brief && kind === 'studio' ? 'Opening AI Studio…' : 'Opening your app…'}</p>}{busy && <div className="absolute inset-0 z-10 bg-white/50 dark:bg-slate-950/50" />}
      <iframe ref={frame} title={kind === 'builder' ? 'App visual editor' : 'App AI editor'} src={`/app-editors/${kind}/index.html?formlogicEditor=1`} className="h-full w-full border-0" />
    </div>
  </div>, document.body);
}

/** What Studio's agent is doing, above the editor: working, waiting on the person, or done. */
function AgentStatusBar({ status, applyLabel }: { status: EditorAgentStatus; applyLabel: string }) {
  const tone = status.state === 'failed' || status.state === 'stopped' || status.state === 'paused'
    ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100'
    : status.state === 'finished' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-100'
    : 'border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-950/40 dark:text-indigo-100';
  const message = (() => {
    switch (status.state) {
      case 'running': return <>AI Studio is building your app{status.step ? <>: <span className="font-medium">{status.step}</span></> : '…'} Watch it in the preview; your changes are kept when you choose “{applyLabel}” once it is done.</>;
      case 'waiting': return <>AI Studio has a question for you in its chat.</>;
      case 'paused': return <>The AI paused{status.reason ? `: ${status.reason}` : '.'} Resume it in Studio&apos;s chat.</>;
      case 'stopped': return <>The AI stopped. What it wrote so far is in the editor; choose “{applyLabel}” to keep it.</>;
      case 'failed': return <>The AI could not finish{status.reason ? `: ${status.reason}` : '.'} What it wrote so far is in the editor.</>;
      case 'finished': return <>Done{status.summary ? `: ${status.summary}` : '.'} Choose “{applyLabel}” to keep it.</>;
      default: return null;
    }
  })();
  if (!message) return null;
  return <p role="status" aria-live="polite" className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${tone}`}>
    {status.state === 'running' ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> : <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
    <span className="min-w-0">{message}</span>
  </p>;
}
