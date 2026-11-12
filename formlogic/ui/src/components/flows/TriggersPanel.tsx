// FormLogic Flows workspace - trigger bindings for the selected flow.
//
// This right rail is a flow-centric view over the same binding rows edited in the app Deploy
// panel and form binding routes. It keeps route choice outside BindingEditor: app-scoped flows
// save via /api/apps/{id}/flow-bindings; workspace flows save only form.submitted triggers via
// /api/forms/{formId}/flow-bindings.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, FileText, Loader2, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { demoCreateFormBinding, demoDeleteFormBinding, demoUpdateFormBinding, isDemoLocalId } from '../../lib/demoLocal';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadFailure } from '../ui/LoadFailure';
import { Switch } from '../ui/Switch';
import { PanelHeader } from './PanelHeader';
import { BindingEditor, type BindingDraft } from './bindings/BindingEditor';
import { bindingToPayload } from './bindings/bindingPayload';
import { flowEventLabel } from './flowEventCatalog';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from './editor/nodeCatalog';
import type { FlowFormOption } from './editor/NodeProperties';
import type { FlowBinding, FlowDefinition } from '../../types/flows';
import { triggerRunSummary } from './bindings/triggerVocabulary';

interface TriggersPanelProps {
  flow: FlowDefinition;
  bindings: FlowBinding[];
  loading?: boolean;
  /** Set when the triggers READ failed — never render "No triggers yet" in that case. */
  loadError?: string | null;
  forms: FlowFormOption[];
  context?: FlowEditorContext;
  /** The selected flow's sibling flows (same app) — source options for flow.* outcome triggers (§9.1). */
  appFlows?: FlowDefinition[];
  onRefresh: () => Promise<void>;
}

const CHANGE_HINT = 'A connected Desktop picks up a changed trigger within about a minute.';

// (conditionSummary retired — triggerRunSummary in bindings/triggerVocabulary composes the
// mode and the condition into one sentence, shared with the editor's "When it runs" copy.)

function formLabel(binding: FlowBinding, forms: FlowFormOption[]): string | null {
  if (!binding.formId) return null;
  return forms.find((form) => form.id === binding.formId)?.title ?? binding.formId;
}

export function TriggersPanel({
  flow,
  bindings,
  loading = false,
  loadError = null,
  forms,
  context = EMPTY_FLOW_EDITOR_CONTEXT,
  appFlows,
  onRefresh,
}: TriggersPanelProps) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FlowBinding | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const isWorkspaceFlow = flow.appId === null;
  const appReadOnly = api.isDemoMode() && !isWorkspaceFlow && !isDemoLocalId(flow.appId);
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
      if (api.isDemoMode()) {
        const demoBody = { ...body, flowDefinitionId: flow.id };
        const saved = binding
          ? await demoUpdateFormBinding(formId, binding.id, demoBody)
          : await demoCreateFormBinding(formId, demoBody);
        await onRefresh();
        setSavedHint(true);
        return saved ?? (binding ? { ...binding, ...demoBody, formId, flowDefinitionId: flow.id } : null);
      }
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
    if (appReadOnly) {
      toast.info('Demo read-only', 'App-scoped triggers are read-only in the demo.');
      return null;
    }
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
    if (appReadOnly) {
      toast.info('Demo read-only', 'App-scoped triggers are read-only in the demo.');
      return;
    }
    const payload = { ...bindingToPayload(binding), enabled };
    if (api.isDemoMode() && !flow.appId && binding.formId) {
      await demoUpdateFormBinding(binding.formId, binding.id, { ...payload, flowDefinitionId: flow.id });
      await onRefresh();
      setSavedHint(true);
      return;
    }
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
    if (appReadOnly) {
      toast.info('Demo read-only', 'App-scoped triggers are read-only in the demo.');
      return;
    }
    if (api.isDemoMode() && !flow.appId && binding.formId) {
      await demoDeleteFormBinding(binding.formId, binding.id);
      if (editingId === binding.id) setEditingId(null);
      await onRefresh();
      setSavedHint(true);
      return;
    }
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
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <PanelHeader
        icon={Zap}
        title="Triggers"
        actions={(
          <Button variant="outline" size="sm" disabled={appReadOnly} onClick={() => { setAdding(true); setEditingId(null); }} leftIcon={<Plus className="h-3.5 w-3.5" />}>
            Add trigger
          </Button>
        )}
      />

      {/* pb-24: the last trigger scrolls clear of the chat button fixed at the window's corner. */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3 pb-24">
        {/* A fact about workspace flows, not a warning: one muted line, no amber box. */}
        {isWorkspaceFlow && (
          <p className="mb-3 text-xs leading-5 text-gray-500 dark:text-slate-400">
            A workspace flow's triggers are form submissions. To start a flow on an app's own events (a call, an SMS, a changed record), create the flow in that app.
          </p>
        )}
        {appReadOnly && (
          <p className="mb-3 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200">
            Demo app-scoped triggers are read-only. Workspace form triggers save in this browser.
          </p>
        )}
        {savedHint && (
          <p className="mb-3 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200">
            {CHANGE_HINT}
          </p>
        )}

        {loading ? (
          <p className="flex items-center gap-2 px-1 py-3 text-xs text-gray-500 dark:text-slate-400">
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
                    <p className={cn('truncate text-sm font-medium', binding.enabled ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400')}>{flowEventLabel(binding.event)}{!binding.enabled && ' (off)'}</p>
                    <p className="truncate font-mono text-[11px] text-gray-500 dark:text-slate-400">{binding.event}</p>
                    {/* One sentence about behaviour, from the SAME copy the editor's
                        "When it runs" select uses, so the row and the editor cannot
                        disagree. This used to read "async - No condition": the raw enum
                        plus a double negative, and a paused trigger looked identical to
                        a live one. */}
                    <p
                      className="mt-1 truncate text-xs text-gray-500 dark:text-slate-400"
                      title={binding.condition?.expr || undefined}
                    >
                      {triggerRunSummary(binding.mode, binding.condition?.expr)}
                    </p>
                    {binding.formId && (
                      <button
                        type="button"
                        onClick={() => navigate(`/builder/${binding.formId}`)}
                        title="Open this form in the builder"
                        className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-primary-100 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-primary-500/20 dark:hover:text-primary-200"
                      >
                        <FileText className="h-3 w-3 flex-none" />
                        <span className="truncate">{formLabel(binding, forms) ?? 'Open form'}</span>
                        <ExternalLink className="h-2.5 w-2.5 flex-none opacity-60" />
                      </button>
                    )}
                  </div>
                  {/* The switch stands with the row's two buttons, without its word (the word was
                      what did not fit beside the name in a panel this narrow, and gave the switch
                      a row to itself): the name says "(off)" when it is off. */}
                  <div className="flex flex-none items-center gap-0.5">
                    <span className="mr-1 flex items-center max-sm:min-h-11" title={binding.enabled ? 'Enabled. Press to disable.' : 'Disabled. Press to enable.'}>
                      <Switch checked={binding.enabled} onChange={(enabled) => void toggleEnabled(binding, enabled)} ariaLabel="Enabled" size="sm" disabled={appReadOnly} />
                    </span>
                    <Button variant="ghost" size="sm" disabled={appReadOnly} onClick={() => { setEditingId((id) => (id === binding.id ? null : binding.id)); setAdding(false); }} aria-label="Edit trigger" title="Edit trigger" aria-expanded={editingId === binding.id} className="h-8 w-8 px-0 max-sm:h-11 max-sm:w-11">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={appReadOnly} onClick={() => setPendingDelete(binding)} aria-label="Delete trigger" title="Delete trigger" className="h-8 w-8 px-0 hover:text-red-600 dark:hover:text-red-400 max-sm:h-11 max-sm:w-11">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {!appReadOnly && editingId === binding.id && (
                  <div className="mt-3">
                    <BindingEditor
                      binding={binding}
                      flows={editorFlows}
                      sourceFlows={appFlows}
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
                sourceFlows={appFlows}
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

            {loadError && !adding && (
              <LoadFailure
                compact
                className="mt-1"
                title="We couldn't load this flow's triggers"
                message={loadError}
                onRetry={() => { void onRefresh(); }}
              />
            )}

            {!loadError && bindings.length === 0 && !adding && (
              <p className="px-1 py-3 text-xs leading-5 text-gray-500 dark:text-slate-400">
                {isWorkspaceFlow
                  ? 'No triggers yet. Add one so this flow starts by itself when a form is submitted.'
                  : 'No triggers yet. Add one so this flow starts by itself: on a call, an SMS, a form submission or a changed record.'}
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
