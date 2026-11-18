import { Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, ArrowUpRight, Atom, ClipboardList, CodeXml, FileCode2, FileUp, LayoutTemplate, Plug, Sparkles } from 'lucide-react';
import { InlineChatMount } from '../../components/chat/inlineChat';
import type { AiPreferences } from '../../client-runtime/flows/aiDefault';
import { lazyWithRetry } from '../../lib/lazyWithRetry';
import { useWorkspaceMcp } from '../../lib/workspaceMcp';
import { useUIStore } from '../../stores/uiStore';

const ConnectionDialog = lazyWithRetry(() => import('../../components/mcp/ConnectAiModal').then(module => ({ default: module.ConnectAiModal })));

const suggestions = [
  { label: 'Vanilla JS app', prefix: 'Build a Vanilla JS app', idea: ' to collect ideas and mark my favourites.', icon: CodeXml },
  { label: 'React app', prefix: 'Build a React app', idea: ' to track practice sessions and my weekly goal.', icon: Atom },
  { label: 'Vue app', prefix: 'Build a Vue app', idea: ' to log the books I’m reading and track pages read.', icon: FileCode2 },
  { label: 'Forms app', prefix: 'Build a forms app', idea: ' to collect requests and review responses with my team.', icon: ClipboardList },
];

export function CreateAppChat({ prefs }: { prefs?: AiPreferences }) {
  const mount = useContext(InlineChatMount);
  const chatOpen = useUIStore(s => s.chatOpen);
  const minimized = useUIStore(s => s.chatMinimized);
  const [startedHere, setStartedHere] = useState(false);
  const visible = startedHere && chatOpen && !minimized;
  const queued = useUIStore(s => !!s.chatLaunch);
  const [prompt, setPrompt] = useState('');
  const [connecting, setConnecting] = useState(false);
  const mcp = useWorkspaceMcp();
  const needsConnection = mcp?.status === 'expired' || mcp?.status === 'unavailable';
  const canAttach = prefs?.aiSource === 'site' ? prefs.siteAiActions !== false : prefs?.aiSource === 'custom' && !!prefs.customToolConnection;
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const wasVisible = useRef(visible);
  const attachTranscript = useCallback((node: HTMLDivElement | null) => {
    transcript.current = node;
    mount(node);
  }, [mount]);
  useEffect(() => {
    if (wasVisible.current !== visible) (visible ? transcript.current : input.current)?.focus({ preventScroll: true });
    wasVisible.current = visible;
  }, [visible]);
  const chatNote = needsConnection ? 'Your MCP connection is no longer active. Reconnect to use its tools again.'
    : mcp && prefs?.aiSource === 'desktop' ? 'Linked Desktop uses its own tools. To use this MCP connection, choose a tool-capable Site AI or custom provider.'
    : prefs?.aiSource === 'site' && prefs.siteAiActions === false ? 'This Site AI can help plan your app. Choose a starter to begin editing.'
    : prefs?.aiSource === 'site' && prefs.chatToolMode === 'confirm' && !mcp ? 'Site AI can plan and read in Ask first. Connect MCP to approve changes here.'
    : prefs?.aiSource === 'custom' && !prefs.customToolConnection ? 'To let a compatible custom provider create apps, enable workspace tools in AI settings.'
    : null;

  function send() {
    const text = prompt.trim();
    const ui = useUIStore.getState();
    if (!text || ui.chatLaunch) return;
    setStartedHere(true);
    ui.setChatLaunch({ text, newThread: true });
    ui.setChatOpen(true);
    ui.setChatMinimized(false);
    setPrompt('');
  }

  return <div className="mx-auto max-w-3xl px-4 pb-24 pt-6 sm:px-8 sm:pt-10">
    {!visible && <section aria-labelledby="create-chat-title" className="py-6 sm:pt-14">
      <Sparkles aria-hidden="true" className="mb-5 size-8 text-primary-600 dark:text-primary-300" />
      <h2 id="create-chat-title" className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl dark:text-white">What would you like to build?</h2>
      <p className="mt-2 text-sm text-slate-600 sm:text-base dark:text-slate-400">Describe who it’s for and what it should do.</p>
      {chatNote && <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{chatNote}{prefs?.aiSource === 'custom' && <> <Link to="/settings#ai" className="font-medium underline">AI settings</Link></>}</p>}
      <form onSubmit={event => { event.preventDefault(); send(); }} className="mt-6 rounded-2xl border border-slate-300 bg-white p-3 shadow-sm focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/20 sm:p-4 dark:border-slate-600 dark:bg-slate-900">
        <textarea ref={input} aria-label="Describe your app" placeholder="I’d like an app for…" rows={3} maxLength={8000} value={prompt} onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
          className="block min-h-20 w-full resize-y border-0 bg-transparent px-1 text-base text-slate-900 outline-none placeholder:text-slate-500 dark:text-white" />
        <div className="flex justify-end">
          <button type="submit" aria-label="Send message" title="Send message" disabled={!prompt.trim() || queued} className="grid size-11 place-items-center rounded-xl bg-primary-600 text-primary-foreground hover:bg-primary-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:bg-slate-100 disabled:text-slate-400 dark:disabled:bg-slate-800"><ArrowUp className="size-5" /></button>
        </div>
      </form>
      <div aria-label="Quick prompts" role="group" className="mt-3 flex flex-wrap gap-2">
        {suggestions.map(({ label, prefix, idea, icon: Icon }) => <button key={label} type="button" title={prefix + idea} onClick={() => {
          const previous = suggestions.find(item => prompt.startsWith(item.prefix));
          if (!prompt.trim() || (previous && prompt === previous.prefix + previous.idea)) setPrompt(prefix + idea);
          else if (previous) setPrompt(prefix + prompt.slice(previous.prefix.length));
          else setPrompt(prefix + '. ' + prompt);
          input.current?.focus();
        }}
          className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:border-primary-400 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <Icon className="size-4" aria-hidden="true" />{label}
        </button>)}
      </div>
      {chatOpen && <button type="button" onClick={() => { setStartedHere(true); useUIStore.getState().setChatMinimized(false); }} className="mt-4 text-sm font-medium text-primary-700 hover:underline dark:text-primary-300">Resume your conversation</button>}
    </section>}
    <div ref={attachTranscript} tabIndex={-1} hidden={!visible} className="rounded-2xl focus-visible:outline-2 focus-visible:outline-primary-500" />
    <nav aria-label="Other ways to create" className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-200 pt-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
      <Link className="inline-flex min-h-10 items-center gap-1.5 hover:underline" to="?type=web"><LayoutTemplate className="size-4" />Choose a starter</Link>
      <Link className="inline-flex min-h-10 items-center gap-1.5 hover:underline" to="?type=forms"><ClipboardList className="size-4" />Create a forms app</Link>
      <Link className="inline-flex min-h-10 items-center gap-1.5 hover:underline" to="?type=upload"><FileUp className="size-4" />Upload a ZIP</Link>
      {canAttach || mcp ? <button type="button" onClick={() => setConnecting(true)} className="inline-flex min-h-10 items-center gap-1.5 hover:underline sm:ml-auto">
        <Plug aria-hidden="true" className="size-4" />{needsConnection ? 'Reconnect MCP' : mcp ? `MCP · ${mcp.scopeLabel}` : 'Connect MCP'}
      </button> : <Link className="inline-flex min-h-10 items-center gap-1 hover:underline sm:ml-auto" to="/settings#mcp">MCP access<ArrowUpRight className="size-3.5" /></Link>}
    </nav>
    {connecting && <Suspense fallback={<p role="status" className="text-sm">Opening MCP connections…</p>}>
      <ConnectionDialog isOpen workspaceChat onClose={() => setConnecting(false)} />
    </Suspense>}
  </div>;
}
