// The bridge's `agentRuns` capability on FormLogic's side: kept out of AppEditorDialog.tsx so
// that file only exports a component (react-refresh rule).

/**
 * The bridge's `agentRuns` capability, as FormLogic speaks it (SoftN's HOSTED_AGENT_RUNS_VERSION):
 * Studio may be opened with a request for its agent, and reports how the agent is doing.
 */
export const EDITOR_AGENT_RUNS_VERSION = 1;
/** A request for Studio's agent to carry out once the app is open: build a new app, or change this one. */
export interface EditorBrief { prompt: string; kind: 'build' | 'edit' }
export type EditorAgentState = 'idle' | 'running' | 'waiting' | 'paused' | 'stopped' | 'finished' | 'failed';
export interface EditorAgentStatus { state: EditorAgentState; step?: string; summary?: string; reason?: string }
const AGENT_STATES: readonly EditorAgentState[] = ['idle', 'running', 'waiting', 'paused', 'stopped', 'finished', 'failed'];
const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
/** An `agent-status` message as the editor sent it, or null when it is not one. */
export function readAgentStatus(data: unknown): EditorAgentStatus | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.kind !== 'agent-status' || !AGENT_STATES.includes(message.state as EditorAgentState)) return null;
  return { state: message.state as EditorAgentState, step: text(message.step, 200), summary: text(message.summary, 2000), reason: text(message.reason, 1000) };
}
