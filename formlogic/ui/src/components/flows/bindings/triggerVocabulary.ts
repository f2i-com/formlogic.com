import type { FlowBindingMode, FlowOutputActionType } from '../../../types/flows';

/**
 * Plain-language names for the trigger machinery, in ONE place so the editor's controls
 * and the trigger row cannot describe the same setting differently.
 *
 * These surfaces used to print the raw enum: the Mode select offered "async / sync /
 * background / manual", where picking `manual` silently meant "this automation never
 * runs on its own" with nothing on screen saying so; and the action picker offered
 * `formlogic.submitResponse` and `call.speak` to people who have never seen a dotted
 * identifier.
 */

export interface ModeCopy {
  /** What the option is called. */
  label: string;
  /** What choosing it actually does — shown under the select. */
  consequence: string;
  /** Prefix for the trigger row's one-line summary, when the mode needs calling out. */
  rowPrefix?: string;
}

export const BINDING_MODE_COPY: Record<FlowBindingMode, ModeCopy> = {
  async: {
    label: 'Run straight away (recommended)',
    consequence: 'Runs as soon as the event happens, without holding anything up.',
  },
  sync: {
    label: 'Wait for the result',
    consequence: 'The event waits for this automation to finish before continuing. Slower, but the result is available immediately.',
  },
  background: {
    label: 'Run in the background',
    consequence: 'Queued and run shortly afterwards. Best for slow work like sending email.',
  },
  manual: {
    label: 'Paused — only run when I ask',
    consequence: 'This automation will NOT run when the event happens. Nothing is triggered until you run it yourself.',
    rowPrefix: 'Paused',
  },
};

export function bindingModeLabel(mode: FlowBindingMode): string {
  return BINDING_MODE_COPY[mode]?.label ?? mode;
}

export interface ActionCopy {
  label: string;
  description: string;
}

/** The things a trigger can do after its flow finishes. */
export const OUTPUT_ACTION_COPY: Record<FlowOutputActionType, ActionCopy> = {
  'formlogic.submitResponse': {
    label: 'Save a new record',
    description: 'Adds a record to one of your forms.',
  },
  'formlogic.updateResponse': {
    label: 'Update an existing record',
    description: 'Changes a record that already exists.',
  },
  'formlogic.toast': {
    label: 'Show a message in the app',
    description: 'A short on-screen note for whoever is using the app.',
  },
  'connector.request': {
    label: 'Call another service',
    description: 'Sends a request through one of this app’s connectors.',
  },
  'call.speak': {
    label: 'Say something on the call',
    description: 'Speaks a line to the caller. Needs the phone connector.',
  },
};

export function outputActionLabel(type: FlowOutputActionType): string {
  return OUTPUT_ACTION_COPY[type]?.label ?? type;
}

/**
 * The one-line summary shown on a trigger row: when it fires, and whether anything
 * narrows it. Rows used to read "async · No condition", which says nothing about
 * behaviour and printed the enum.
 */
export function triggerRunSummary(mode: FlowBindingMode, conditionExpr?: string | null): string {
  const prefix = BINDING_MODE_COPY[mode]?.rowPrefix;
  const when = conditionExpr?.trim()
    ? `Runs only when ${conditionExpr.trim()}`
    : 'Runs every time';
  return prefix ? `${prefix} — ${when.charAt(0).toLowerCase()}${when.slice(1)}` : when;
}
