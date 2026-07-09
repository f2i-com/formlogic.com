// Serialize an existing FlowBinding row back into the write payload the binding routes accept.
// Lives outside BindingEditor.tsx so that file only exports components (react-refresh needs
// component-only modules for fast refresh); shared by the Triggers panel's toggle/save paths.
import type { FlowBinding } from '../../../types/flows';

export function bindingToPayload(binding: FlowBinding): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    event: binding.event,
    flow: binding.flow,
    mode: binding.mode,
    condition: binding.condition,
    inputMap: binding.inputMap,
    outputActions: binding.outputActions,
    timeoutMs: binding.timeoutMs,
    retryPolicy: binding.retryPolicy,
    fallbackPolicy: binding.fallbackPolicy,
    enabled: binding.enabled,
    sortOrder: binding.sortOrder,
  };
  if (binding.formId) payload.formId = binding.formId;
  if (binding.connectorId) payload.connectorId = binding.connectorId;
  return payload;
}
