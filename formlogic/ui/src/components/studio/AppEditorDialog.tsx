import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { resolveDefaultLlm, resolveDefaultLlmTools, TOOLS_UNSUPPORTED } from '../../client-runtime/flows/aiDefault';
import { EDITOR_AI_TOOLS_VERSION, validateEditorAiToolRequest } from '../../client-runtime/flows/aiToolCalls';
import { EDITOR_BRIDGE_PROTOCOL } from '../../lib/softn/protocol';
import { ArrowLeft, Check } from 'lucide-react';
import { Button } from '../ui/Button';

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
export function AppEditorDialog({ kind, name, bundle, onApply, onClose }: {
  kind: AppEditorKind; name: string; bundle: Uint8Array;
  onApply: (bytes: Uint8Array) => Promise<void>; onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const pending = useRef(new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());
  const lock = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aiPending, setAiPending] = useState(false);
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
    if (!ready || aiPending) { acknowledgeSave(saveId, false, !ready ? 'The editor is not connected to FormLogic yet.' : 'AI is still editing the draft; wait for it to finish.'); return; }
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
      const channel = new MessageChannel();
      port.current = channel.port1;
      channel.port1.onmessage = ({ data }) => {
        if (data?.kind === 'ai-cancel' && typeof data.id === 'string') { aiRequests.get(data.id)?.abort(); aiRequests.delete(data.id); setAiPending(false); return; }
        if (data?.kind === 'ai-request' && typeof data.id === 'string') {
          const reply = (ok: boolean, value: unknown, code?: string) => { if (!disposed) channel.port1.postMessage({ kind: 'ai-response', id: data.id, ok, ...(ok ? { value } : { error: value, ...(code ? { code } : {}) }) }); };
          const structured = data.aiTools !== undefined;
          let ask: (signal: AbortSignal) => Promise<void>;
          if (!structured) {
            // The text request every editor version sends: unchanged.
            if (kind !== 'studio' || aiRequests.size || !Array.isArray(data.messages) || data.messages.length > 100 || !data.messages.every((m: { role?: unknown; content?: unknown }) => ['system', 'user', 'assistant'].includes(String(m?.role)) && typeof m?.content === 'string') || JSON.stringify(data.messages).length > 1000000) {
              reply(false, 'AI is busy or the request is too large.'); return;
            }
            ask = signal => resolveDefaultLlm({ messages: data.messages, signal }).then(result => {
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
      frame.current!.contentWindow!.postMessage({ kind: 'formlogic-editor-connect', protocol: EDITOR_BRIDGE_PROTOCOL, ...(aiTools ? { aiTools: EDITOR_AI_TOOLS_VERSION } : {}) }, location.origin, [channel.port2]);
      void Promise.resolve().then(() => request('open', { bytes: editorBundle(bundle), name, theme: document.documentElement.classList.contains("dark") ? "dark" : "light" })).then(() => { if (!disposed) setReady(true); }).catch(reason => { if (!disposed) setError(reason.message); });
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
      <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" disabled={busy} onClick={() => { if (!ready || window.confirm('Return without applying editor changes? Use “Review changes” to keep your work.')) onClose(); }} leftIcon={<ArrowLeft className="h-4 w-4" />}>Back</Button><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{kind === 'builder' ? 'Visual Builder' : 'AI Studio'} · {name}</h2><p className="text-xs text-slate-500 dark:text-slate-400">Edit and preview here. Review, publish, then test the backend in your app.</p></div></div>
      <Button disabled={!ready || busy || aiPending} isLoading={busy} onClick={() => void apply()} leftIcon={<Check className="h-4 w-4" />}>Review changes</Button>
    </header>
    {aiPending && <p role="status" className="border-b border-slate-200 px-4 py-2 text-sm dark:border-slate-700">AI is editing your draft. Wait for it to finish, or choose Stop generating in Studio.</p>}
    {error && <p role="alert" className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
    <div className="relative min-h-0 flex-1">{!ready && !error && <p role="status" className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-slate-950">Opening your app…</p>}{busy && <div className="absolute inset-0 z-10 bg-white/50 dark:bg-slate-950/50" />}
      <iframe ref={frame} title={kind === 'builder' ? 'App visual editor' : 'App AI editor'} src={`/app-editors/${kind}/index.html?formlogicEditor=1`} className="h-full w-full border-0" />
    </div>
  </div>, document.body);
}
