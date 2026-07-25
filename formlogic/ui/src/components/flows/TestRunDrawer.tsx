// FormLogic Flows workspace — Test Run drawer.
//
// Executes the selected flow's graph through the REAL v0 browser executor
// (client-runtime/flows/flowExecutor) with the owner-scoped workspace deps (QuickJS sandbox +
// the FormLogic API + connector client). The author supplies a JSON `inputs` object. The run reads
// like a debug log: a live per-node timeline (each node's status, duration and a compact output /
// error) built from the executor's onNodeStatus observer, plus the final status + result. App-scoped
// flows additionally offer a headless server run that writes a row into run history.
//
// "Run on" (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7): the primary run button honors the
// flow's executionLocation — 'auto' keeps the browser executor untouched, 'desktop' rides the
// E2E desktop relay with live queue/progress, 'cloud' calls the synchronous cloud runner
// (credit-metered; typed refusals — credits exhausted / unsupported nodes — surface inline).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Cloud, Laptop, Loader2, MinusCircle, PlayCircle, ServerCog, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { PanelHeader } from './PanelHeader';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import { executeFlow, type FlowRunOutcome } from '../../client-runtime/flows/flowExecutor';
import { resolveExecutableGraph } from '../../client-runtime/flows/compiledGraph';
import { buildWorkspaceExecutorDeps } from '../../client-runtime/flows/flowDispatcher';
import { runFlowOnDesktop, type DesktopFlowRunState } from '../../client-runtime/desktop/desktopFlowRun';
import { getNodeSpec } from './editor/nodeCatalog';
import { flowExecutionLocation, type CloudRunFeedback, type FlowRunExecutedLocation } from './editor/executionLocation';
import {
  EMPTY_RUN_LOG,
  formatDuration,
  nodeDurationMs,
  previewOutput,
  reduceRunLog,
  type NodeRunPhase,
  type RunLog,
} from './runStatus';
import type { FlowDefinition, FlowRunError, WorkflowGraph } from '../../types/flows';

/** Seed the Inputs box from the Trigger node's declared inputs ({ name, example? }) so the box
 *  mirrors exactly what the flow expects. Falls back to an empty object when none are declared. */
function initialInputsJson(graph: WorkflowGraph | undefined): string {
  const trigger = (graph?.nodes ?? []).find((n) => n.type === 'input');
  const rows = (trigger?.data as { inputs?: unknown } | undefined)?.inputs;
  const seed: Record<string, unknown> = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string') {
        const name = (r as { name: string }).name.trim();
        if (name !== '') seed[name] = typeof (r as { example?: unknown }).example === 'string' ? (r as { example: string }).example : '';
      }
    }
  }
  return Object.keys(seed).length === 0 ? '{\n  \n}' : JSON.stringify(seed, null, 2);
}

const INPUT_CLS =
  'w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 font-mono text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500';

function statusTone(status: string): string {
  if (status === 'done') return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25';
  if (status === 'running' || status === 'queued') return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25';
  return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25';
}

/** A tiny per-node status glyph for the timeline (running spins, done checks, error crosses).
 *  Running speaks in the primary token so the drawer and the canvas run-beam agree on what
 *  "live" looks like — one execution language across the whole editor. */
function PhaseGlyph({ phase }: { phase: NodeRunPhase }) {
  if (phase === 'running') return <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-primary-500" />;
  if (phase === 'done') return <Check className="h-3.5 w-3.5 flex-none text-emerald-500" />;
  // Skipped is neither success nor failure: the node never ran because an input could not arrive.
  if (phase === 'skipped') return <MinusCircle className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-500" />;
  return <X className="h-3.5 w-3.5 flex-none text-red-500" />;
}

export function TestRunDrawer({ flow, onClose, onServerRun, onRunStart, onNodeStatus, onCloudRunFeedback, hideClose = false }: {
  flow: FlowDefinition;
  onClose: () => void;
  /** Called after a successful server test-run (app flows) so the caller can refresh history. */
  onServerRun?: () => void;
  /** Fired when a browser/server run begins so the caller can clear the canvas run pills. */
  onRunStart?: () => void;
  /** Forwarded executor onNodeStatus events so the caller can light up the canvas node pills. */
  onNodeStatus?: (nodeId: string, status: NodeRunPhase, info?: { output?: unknown; error?: string }) => void;
  /** Cloud-run refusals/successes, forwarded so the editor's "Run on" chrome can react (plan §5.7). */
  onCloudRunFeedback?: (flowId: string, feedback: CloudRunFeedback) => void;
  /** The mobile slide-over supplies its own close — suppress the header's to avoid two X buttons. */
  hideClose?: boolean;
}) {
  const navigate = useNavigate();
  const [inputText, setInputText] = useState(() => initialInputsJson(flow.flowJson));
  const [running, setRunning] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [outcome, setOutcome] = useState<FlowRunOutcome | null>(null);
  const [runLog, setRunLog] = useState<RunLog>(EMPTY_RUN_LOG);
  // "Run on" state (plan §5.7): where the last run executed, the desktop relay's live
  // queue/run state, and a cloud run's typed refusal (credits / unsupported nodes).
  const location = flowExecutionLocation(flow);
  const [runLocation, setRunLocation] = useState<FlowRunExecutedLocation | null>(null);
  const [desktopState, setDesktopState] = useState<DesktopFlowRunState | null>(null);
  const [cloudError, setCloudError] = useState<{ kind: 'credits' | 'unsupported' | 'other'; message: string; nodes?: string[] } | null>(null);

  // Friendly label per node id for the timeline (falls back to the raw type / id).
  const nodeLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of flow.flowJson?.nodes ?? []) m.set(n.id, getNodeSpec(n.type)?.label ?? n.type);
    return (id: string) => m.get(id) ?? id;
  }, [flow.flowJson]);

  const parseInputs = (): Record<string, unknown> | null => {
    const t = inputText.trim();
    if (t === '') return {};
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        toast.error('Inputs must be a JSON object');
        return null;
      }
      return v as Record<string, unknown>;
    } catch {
      toast.error('Inputs is not valid JSON');
      return null;
    }
  };

  const resetRunState = () => {
    setOutcome(null);
    setRunLog(EMPTY_RUN_LOG);
    setRunLocation(null);
    setDesktopState(null);
    setCloudError(null);
  };

  const runBrowser = async () => {
    const inputs = parseInputs();
    if (inputs === null) return;
    setRunning(true);
    resetRunState();
    onRunStart?.();
    try {
      // RUN-301: a graph with contributed nodes executes the server-compiled canonical IR —
      // Test Runs use the exact same lowering contract as cloud runs (plan §9.3).
      const resolved = await resolveExecutableGraph(flow.id, flow.flowJson ?? { nodes: [], edges: [] });
      const result = !resolved.ok
        ? { status: 'error' as const, error: resolved.error, nodesExecuted: 0 }
        : await executeFlow(resolved.graph, {
        inputs,
        deps: buildWorkspaceExecutorDeps(),
        // No explicit deadline: the executor's adaptive default applies (30s for plain
        // flows, 3 min for flows with AI/service nodes — a browser LLM call can be slow).
        capabilities: flow.nodeCapabilities,
        flowSlug: flow.slug,
        // flow_call ancestry seed. The workspace deps carry no child invoker yet, so
        // flow_call in a Test Run refuses typed — the seed is still correct for when
        // the workspace invoker lands.
        callStack: [flow.id],
        onNodeStatus: (id, status, info) => {
          setRunLog((l) => reduceRunLog(l, id, status, info));
          onNodeStatus?.(id, status, info);
        },
      });
      setRunLocation('browser');
      setOutcome(result);
    } catch (err) {
      setOutcome({ status: 'error', error: { code: 'node_failed', message: err instanceof Error ? err.message : String(err) }, nodesExecuted: 0 });
    } finally {
      setRunning(false);
    }
  };

  /** Cloud run (plan §5.7): synchronous server-side runner, credit-metered. */
  const runCloud = async () => {
    const inputs = parseInputs();
    if (inputs === null) return;
    setRunning(true);
    resetRunState();
    onRunStart?.();
    // The shared demo is server-read-only; run in the browser instead (same honesty note
    // as the server-run path).
    if (api.isDemoMode()) {
      setRunning(false);
      toast.info('Demo mode', 'Runs execute in your browser and are not saved to the server.');
      await runBrowser();
      return;
    }
    const res = await api.runFlowCloud(flow.id, inputs);
    setRunning(false);
    if (res.error || !res.data) {
      if (res.code === 'flow_credits_exceeded') {
        setCloudError({ kind: 'credits', message: res.error ?? 'Out of cloud run credits' });
        return;
      }
      if (res.code === 'cloud_unsupported_node') {
        const nodes = res.details?.nodes ?? [];
        setCloudError({ kind: 'unsupported', message: res.error ?? 'This flow has nodes the cloud runner cannot execute', nodes });
        onCloudRunFeedback?.(flow.id, { kind: 'unsupported', nodes });
        return;
      }
      if (res.status === 404 || res.code === 'not_found' || res.code === 'route_not_found') {
        // The server predates the cloud runner: Cloud can't work here at all — the
        // editor's dropdown disables the option with this reason.
        onCloudRunFeedback?.(flow.id, { kind: 'unavailable', reason: 'this FormLogic server has no cloud runner' });
        setCloudError({ kind: 'other', message: 'Cloud runs are not available on this FormLogic server yet.' });
        return;
      }
      setOutcome({
        status: 'error',
        error: { code: (res.code ?? 'runner_unavailable') as FlowRunError['code'], message: res.error ?? 'Cloud run failed' },
        nodesExecuted: 0,
      });
      return;
    }
    const data = res.data;
    onCloudRunFeedback?.(flow.id, { kind: 'ok' });
    setRunLocation('cloud');
    setOutcome({
      status: data.status === 'done' ? 'done' : data.status === 'timeout' ? 'timeout' : data.status === 'cancelled' ? 'cancelled' : 'error',
      result: data.result,
      error: data.error
        ? {
            code: (data.error.code ?? 'node_failed') as FlowRunError['code'],
            message: data.error.message ?? 'Cloud run failed',
            ...(data.error.nodeId ? { nodeId: data.error.nodeId } : {}),
          }
        : undefined,
      nodesExecuted: data.nodesExecuted ?? 0,
    });
  };

  /** Desktop run (plan §5.7): E2E-sealed relay run with live queue position + node progress. */
  const runDesktop = async () => {
    const inputs = parseInputs();
    if (inputs === null) return;
    setRunning(true);
    resetRunState();
    onRunStart?.();
    if (api.isDemoMode()) {
      setRunning(false);
      toast.info('Demo mode', 'Runs execute in your browser and are not saved to the server.');
      await runBrowser();
      return;
    }
    let executed = 0;
    const res = await runFlowOnDesktop(flow.id, {
      inputs,
      onState: (s) => setDesktopState(s),
      onProgress: (p) => {
        if (p.status === 'done' || p.status === 'error') executed += 1;
        if (!p.nodeId) return;
        // The Desktop progress stream has no skipped phase of its own yet (RUN-303 carries the
        // readiness rule to the Rust runner); until then it only reports running/done/error.
        const phase: NodeRunPhase = p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : 'running';
        const info = p.status === 'error' ? { error: p.message ?? 'Failed' } : undefined;
        setRunLog((l) => reduceRunLog(l, p.nodeId as string, phase, info));
        onNodeStatus?.(p.nodeId, phase, info);
      },
    });
    setRunning(false);
    if (!res.ok) {
      if (res.error.code === 'uncertain') {
        // Honest non-outcome: the state line already says the desktop may still finish.
        return;
      }
      setOutcome({
        status: 'error',
        error: { code: res.error.code as FlowRunError['code'], message: res.error.message },
        nodesExecuted: 0,
      });
      return;
    }
    setRunLocation('desktop');
    setOutcome({ status: 'done', result: res.data.result, nodesExecuted: executed });
  };

  const runServer = async () => {
    if (!flow.appId) return;
    setServerRunning(true);
    resetRunState();
    onRunStart?.();
    // The shared demo is server-read-only; a logged server run isn't possible, so run in the
    // browser instead (same executor) — no server error, and the result still shows here.
    if (api.isDemoMode()) {
      setServerRunning(false);
      toast.info('Demo mode', 'Runs execute in your browser and are not saved to the server.');
      await runBrowser();
      return;
    }
    const r = await api.testRunFlow(flow.appId, flow.id);
    setServerRunning(false);
    if (r.error || !r.data) {
      toast.error('Server test run failed', typeof r.error === 'string' ? r.error : undefined);
      return;
    }
    const run = r.data.run;
    setOutcome({
      status: run.status === 'done' ? 'done' : run.status === 'timeout' ? 'timeout' : run.status === 'cancelled' ? 'cancelled' : 'error',
      result: run.result ?? undefined,
      error: run.error ?? undefined,
      nodesExecuted: 0,
    });
    toast.success('Server run recorded', 'It now appears in run history.');
    onServerRun?.();
  };

  const hasTimeline = runLog.order.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full max-w-md flex-col border-l border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900">
      <PanelHeader
        icon={PlayCircle}
        title="Test run"
        subtitle={flow.slug}
        actions={hideClose ? undefined : (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close test run">
            <X className="h-4 w-4" />
          </Button>
        )}
      />

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300" htmlFor="flow-test-inputs">
            Inputs (JSON) — available as <span className="font-mono">$inputs</span> / <span className="font-mono">inputs</span>
          </label>
          <textarea
            id="flow-test-inputs"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            rows={6}
            spellCheck={false}
            className={INPUT_CLS + ' resize-y'}
            placeholder='{ "from": "+61400000000" }'
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {location === 'auto' && (
            <Button size="sm" onClick={runBrowser} isLoading={running} disabled={running} leftIcon={<PlayCircle className="h-4 w-4" />}>
              Run in browser
            </Button>
          )}
          {location === 'desktop' && (
            <Button size="sm" onClick={runDesktop} isLoading={running} disabled={running} leftIcon={<Laptop className="h-4 w-4" />}>
              Run on Desktop
            </Button>
          )}
          {location === 'cloud' && (
            <Button size="sm" onClick={runCloud} isLoading={running} disabled={running} leftIcon={<Cloud className="h-4 w-4" />}>
              Run on FormLogic Cloud
            </Button>
          )}
          {location !== 'auto' && (
            <Button variant="outline" size="sm" onClick={runBrowser} disabled={running || serverRunning} leftIcon={<PlayCircle className="h-4 w-4" />}>
              Run in browser
            </Button>
          )}
          {flow.appId && (
            <Button variant="outline" size="sm" onClick={runServer} isLoading={serverRunning} disabled={serverRunning} leftIcon={<ServerCog className="h-4 w-4" />}>
              Run on server &amp; log
            </Button>
          )}
        </div>
        <p className="text-[11px] text-gray-400 dark:text-slate-500">
          {location === 'desktop'
            ? 'Desktop runs travel end-to-end encrypted to your FormLogic Desktop and are unmetered; queue position and node progress appear live below.'
            : location === 'cloud'
              ? 'Cloud runs execute on FormLogic Cloud and use plan credits.'
              : 'Browser runs use the real QuickJS sandbox and your session\'s permissions, exactly like a live run, but are not written to history.'}
          {flow.appId ? ' A server run executes headless and is recorded below.' : ''}
        </p>

        {/* Desktop relay state (plan §5.7): queue position → running → done/failed/uncertain. */}
        {desktopState && desktopState.state !== 'done' && (
          <p role="status" className="text-xs text-gray-500 dark:text-slate-400">
            {desktopState.state === 'queued'
              ? desktopState.position >= 1
                ? `Queued #${desktopState.position} on your Desktop…`
                : 'Queued on your Desktop — up next…'
              : desktopState.state === 'running'
                ? 'Running on your Desktop…'
                : desktopState.state === 'failed'
                  ? `Desktop run failed: ${desktopState.message ?? desktopState.code}`
                  : `Outcome uncertain — ${desktopState.message ?? 'the desktop may still complete the run.'}`}
          </p>
        )}

        {/* Cloud typed refusals (plan §5.7/§5.8): credits exhausted (upgrade copy) and
            unsupported nodes (named inline; the Cloud selection stays saveable). */}
        {cloudError && (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200"
          >
            {cloudError.kind === 'credits' ? (
              <p>
                Out of Cloud run credits for this month.{' '}
                <button
                  type="button"
                  onClick={() => navigate('/billing')}
                  className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
                >
                  Upgrade your plan
                </button>
                , or switch Run on to Auto or Desktop — those are unmetered.
              </p>
            ) : cloudError.kind === 'unsupported' ? (
              <p>
                FormLogic Cloud can't run this flow yet — unsupported node{cloudError.nodes && cloudError.nodes.length === 1 ? '' : 's'}
                {cloudError.nodes && cloudError.nodes.length > 0 ? (
                  <>: <span className="font-medium">{cloudError.nodes.join(', ')}</span></>
                ) : null}
                . Switch to Auto or Desktop to run it now, or change those nodes.
              </p>
            ) : (
              <p>{cloudError.message}</p>
            )}
          </div>
        )}

        {/* Per-node run timeline (browser runs) — reads like a debug log. */}
        {hasTimeline && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
              Run timeline
            </p>
            <ol className="space-y-1.5">
              {runLog.order.map((id) => {
                const s = runLog.map[id];
                if (!s) return null;
                const ms = nodeDurationMs(s);
                return (
                  <li
                    key={id}
                    className="rounded-lg border border-gray-200/70 dark:border-slate-700/60 bg-gray-50/60 dark:bg-slate-800/40 px-2.5 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <PhaseGlyph phase={s.status} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800 dark:text-slate-200">
                        {nodeLabel(id)}
                      </span>
                      <span className="truncate font-mono text-[10px] text-gray-400 dark:text-slate-500">{id}</span>
                      {ms !== null && (
                        <span className="flex-none font-mono text-[10px] text-gray-400 dark:text-slate-500">{formatDuration(ms)}</span>
                      )}
                    </div>
                    {s.status === 'error' ? (
                      <p className="mt-1 break-words pl-5 text-[11px] text-red-600 dark:text-red-400">{s.error || 'Failed'}</p>
                    ) : s.status === 'done' ? (
                      <p className="mt-1 break-words pl-5 font-mono text-[10px] text-gray-500 dark:text-slate-400">{previewOutput(s.output)}</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {outcome && (
          <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(outcome.status)}`}>
                {outcome.status !== 'done' && <AlertTriangle className="h-3 w-3" />}
                {outcome.status}
              </span>
              {runLocation && (
                <span
                  data-testid="run-location-badge"
                  className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-300"
                >
                  {runLocation === 'cloud'
                    ? 'Ran on FormLogic Cloud'
                    : runLocation === 'desktop'
                      ? 'Ran on your Desktop'
                      : 'Ran in this browser'}
                </span>
              )}
              <span className="text-[11px] text-gray-400 dark:text-slate-500">{outcome.nodesExecuted} node{outcome.nodesExecuted === 1 ? '' : 's'} executed</span>
            </div>
            {outcome.error && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {outcome.error.code}: {outcome.error.message}{outcome.error.nodeId ? ` (node '${outcome.error.nodeId}')` : ''}
              </p>
            )}
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Result</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 dark:bg-slate-800/60 p-2.5 font-mono text-[11px] text-gray-700 dark:text-slate-300">
                {JSON.stringify(outcome.result ?? null, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
