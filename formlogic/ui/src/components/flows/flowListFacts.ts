// What the list of flows says about a flow besides its name: what starts it, and how its last
// run went. Kept apart from the table so the words are tested without drawing it.
import { flowEventLabel } from './flowEventCatalog';
import type { FlowBinding, FlowDefinition, FlowRunLog } from '../../types/flows';

/** Rows a page of the list holds. Each row on screen asks for its flow's triggers once. */
export const FLOWS_PER_PAGE = 12;

export interface TriggerSummary {
  /** What the cell says: "Form submitted · Support Ticket", "Form submitted + 2 more", "No trigger". */
  text: string;
  /** Every trigger on a line of its own, for the cell's hover. Empty when there is none. */
  detail: string;
  /** None of the triggers is on: the flow has triggers and still starts by itself on nothing. */
  allOff: boolean;
}

function triggerLine(binding: FlowBinding, formTitle: (formId: string) => string | undefined): string {
  const form = binding.formId ? formTitle(binding.formId) : undefined;
  return form ? `${flowEventLabel(binding.event)} · ${form}` : flowEventLabel(binding.event);
}

/** One line for the "Starts on" column, from the flow's triggers. Triggers that are on come first. */
export function triggerSummary(bindings: readonly FlowBinding[], formTitle: (formId: string) => string | undefined): TriggerSummary {
  if (bindings.length === 0) return { text: 'No trigger', detail: '', allOff: false };
  const ordered = [...bindings.filter((binding) => binding.enabled), ...bindings.filter((binding) => !binding.enabled)];
  const allOff = !ordered[0].enabled;
  const first = triggerLine(ordered[0], formTitle);
  const text = `${first}${ordered.length > 1 ? ` + ${ordered.length - 1} more` : ''}${allOff ? ' (off)' : ''}`;
  const detail = ordered.map((binding) => `${triggerLine(binding, formTitle)}${binding.enabled ? '' : ' (off)'}`).join('\n');
  return { text, detail, allOff };
}

/**
 * The newest run of each flow among the runs given (newest first, as the server sends them).
 * A run names its flow by id; an older row only by slug, which the first flow of that slug takes.
 */
export function lastRunByFlow(runs: readonly FlowRunLog[], flows: readonly FlowDefinition[]): Map<string, FlowRunLog> {
  const ids = new Set(flows.map((flow) => flow.id));
  const bySlug = new Map<string, string>();
  for (const flow of flows) if (!bySlug.has(flow.slug)) bySlug.set(flow.slug, flow.id);
  const last = new Map<string, FlowRunLog>();
  for (const run of runs) {
    const flowId = run.flowDefinitionId && ids.has(run.flowDefinitionId) ? run.flowDefinitionId : run.flow ? bySlug.get(run.flow) : undefined;
    if (flowId && !last.has(flowId)) last.set(flowId, run);
  }
  return last;
}

/** Which rows a page of the list shows: `size` flows from the `page`th page (1-based, held in range). */
export function pageOf<T>(rows: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  const shown = rows.slice(start, start + size);
  return { rows: shown, page: current, pages, from: shown.length ? start + 1 : 0, to: start + shown.length };
}
