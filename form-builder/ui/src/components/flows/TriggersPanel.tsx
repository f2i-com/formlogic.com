// FormLogic Flows workspace - trigger bindings for the selected flow.
//
// This right rail is a flow-centric view over the same binding rows edited in the app Deploy
// panel and form binding routes. It keeps route choice outside BindingEditor: app-scoped flows
// save via /api/apps/{id}/flow-bindings; workspace flows save only form.submitted triggers via
// /api/forms/{formId}/flow-bindings.
import { useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Switch } from '../ui/Switch';
import { PanelHeader } from './PanelHeader';
import { BindingEditor, bindingToPayload, type BindingDraft } from './bindings/BindingEditor';
import { FLOW_EVENT_CATALOG } from './flowEventCatalog';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from './editor/nodeCatalog';
import type { FlowFormOption } from './editor/NodeProperties';
import type { FlowBinding, FlowDefinition } from '../../types/flows';

interface TriggersPanelProps {
  flow: FlowDefinition;
  bindings: FlowBinding[];
  loading?: boolean;
  forms: FlowFormOption[];
  context?: FlowEditorContext;
  onRefresh: () => Promise<void>;
}

const CHANGE_HINT = 'A connected Desktop picks up binding changes within about a minute.';

function eventLabel(event: string): string {
  const entry = FLOW_EVENT_CATALOG.find((candidate) => candidate.kind === 'event' && candidate.event === event);
  return entry?.label ?? event.split('.').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function conditionSummary(binding: FlowBinding): string {
  const expr = binding.condition?.expr?.trim();
  return expr ? `if ${expr}` : 'No condition';
}

function formLabel(binding: FlowBinding, forms: FlowFormOption[]): string | null {
  if (!binding.formId) return null;
  return forms.find((form) => form.id === binding.formId)?.title ?? binding.formId;
}

export function TriggersPanel({
  flow,
  bindings,
  loading = false,
  forms,
  context = EMPTY_FLOW_EDITOR_CONTEXT,
  onRefresh,
}: TriggersPanelProps) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FlowBinding | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const isWorkspaceFlow = flow.appId === null;
  const editorFlows = useMemo(() => [flow], [flow]);
  const editorContext = isWorkspaceFlow ? EMPTY_FLOW_EDITOR_CONTEXT : context;

  const saveBinding = async (binding: FlowBinding | null, payload: Record<string, unknown>, draft: BindingDraft): Promise<FlowBinding | null> => {
    const body: Record<string, unknown> = { ...payload, flow: flow.slug };
    if (isWorkspaceFlow) {
      const formId = binding?.formId ?? draft.formId;
      if (!formId) {
        toast.error('Pick a form for this trigger');
        return null;
      }
      body.event = 'form.submitted';
      const result = binding
        ? await api.updateFormFlowBinding(formId, binding.id, body)
        : await api.createFormFlowBinding(formId, body);
      if (result.error || !result.data) {
        toast.error('Failed to save trigger', typeof result.error === 'string' ? result.error : undefined);
        return null;
      }
      await onRefresh();
      setSavedHint(true);
      return result.data.binding;
    }

    if (!flow.appId) return null;
    const result = binding
      ? await api.updateFlowBinding(flow.appId, binding.id, body)
      : await api.createFlowBinding(flow.appId, body);
    if (result.error || !result.data) {
      toast.error('Failed to save trigger', typeof result.error === 'string' ? result.error : undefined);
      return null;
    }
    await onRefresh();
    setSavedHint(true);
    return result.data.binding;
  };

  const toggleEnabled = async (binding: FlowBinding, enabled: boolean) => {
    const payload = { ...bindingToPayload(binding), enabled };
    const result = flow.appId
      ? await api.updateFlowBinding(flow.appId, binding.id, payload)
      : binding.formId
        ? await api.updateFormFlowBinding(binding.formId, binding.id, payload)
        : { error: 'Missing form id', data: null };
    if (result.error || !result.data) {
      toast.error('Failed to update trigger', typeof result.error === 'string' ? result.error : undefined);
      return;
    }
    await onRefresh();
    setSavedHint(true);
  };

  const confirmDelete = async () => {
    const binding = pendingDelete;
    setPendingDelete(null);
    if (!binding) return;
    const result = flow.appId
      ? await api.deleteFlowBinding(flow.appId, binding.id)
      : binding.formId
        ? await api.deleteFormFlowBinding(binding.formId, binding.id)
        : { error: 'Missing form id' };
    if (result.error) {
      toast.error('Failed to delete trigger', typeof result.error === 'string' ? result.error : undefined);
      return;
    }
    if (editingId === binding.id) setEditingId(null);
    await onRefresh();
    setSavedHint(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={Zap}
        title="Triggers"
        actions={(
          <Button variant="outline" size="sm" onClick={() => { setAdding(true); setEditingId(null); }} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Add trigger
          </Button>
        )}
      />

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isWorkspaceFlow && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            Workspace flows can only use form.submitted triggers here; connector/event triggers need an app-scoped flow.
          </p>
        )}
        {savedHint && (
          <p className="mb-3 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200">
            {CHANGE_HINT}
          </p>
        )}

        {loading ? (
          <p className="flex items-center gap-2 px-1 py-3 text-xs text-gray-400 dark:text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading triggers...
          </p>
        ) : (
          <div className="space-y-3">
            {bindings.map((binding) => (
              <div key={binding.id} className="rounded-xl border border-gray-200/80 p-3 dark:border-slate-700/60">
                <div className="flex items-start gap-2.5">
                  <span className={cn(
                    'mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg',
                    binding.enabled
                      ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300'
                      : 'bg-gray-100 text-gray-400 dark:bg-slate-800 dark:text-slate-500',
                  )}>
                    <Zap className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{eventLabel(binding.event)}</p>
                    <p className="truncate font-mono text-[11px] text-gray-500 dark:text-slate-400">{binding.event}</p>
                    <p className="mt-1 truncate text-xs text-gray-500 dark:text-slate-400">
                      {binding.mode} - {conditionSummary(binding)}{formLabel(binding, forms) ? ` - ${formLabel(binding, forms)}` : ''}
                    </p>
                  </div>
                  <Switch checked={binding.enabled} onChange={(enabled) => void toggleEnabled(binding, enabled)} label="Enabled" size="sm" />
                  <Button variant="ghost" size="iconOnly" onClick={() => { setEditingId((id) => (id === binding.id ? null : binding.id)); setAdding(false); }} aria-label="Edit trigger">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="iconOnly" onClick={() => setPendingDelete(binding)} aria-label="Delete trigger">
                    <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                  </Button>
                </div>
                {editingId === binding.id && (
                  <div className="mt-3">
                    <BindingEditor
                      binding={binding}
                      flows={editorFlows}
                      connectors={editorContext.connectors}
                      forms={forms}
                      context={editorContext}
                      workspaceFormOnly={isWorkspaceFlow}
                      lockFlow
                      lockFormId={isWorkspaceFlow}
                      onSave={(payload, draft) => saveBinding(binding, payload, draft)}
                      onSaved={() => setEditingId(null)}
                      onDelete={() => setPendingDelete(binding)}
                    />
                  </div>
                )}
              </div>
            ))}

            {adding && (
              <BindingEditor
                binding={null}
                flows={editorFlows}
                connectors={editorContext.connectors}
                forms={forms}
                context={editorContext}
                workspaceFormOnly={isWorkspaceFlow}
                lockFlow
                onSave={(payload, draft) => saveBinding(null, payload, draft)}
                onSaved={() => setAdding(false)}
                onDelete={() => setAdding(false)}
              />
            )}

            {bindings.length === 0 && !adding && (
              <p className="px-1 py-3 text-xs text-gray-400 dark:text-slate-500">
                No triggers yet. Add one so this flow runs itself — on a call, an SMS, or a form submission.
              </p>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete trigger"
        message={pendingDelete ? `Delete the '${pendingDelete.event}' trigger? The flow itself is kept.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
