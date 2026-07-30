// Builder-side Flows dock.
//
// This is the form-authoring surface for form.submitted bindings. It shares the same binding
// rows with /flows Triggers, but keeps the builder layout model intact: a right dock when the
// measured width allows it, and the shared mobile bottom sheet under pressure.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import { demoApplyFlowOverlay, demoApplyFormBindingOverlay, demoCreateFlow, demoCreateFormBinding, demoDeleteFormBinding, demoUpdateFormBinding, isDemoLocalId } from '../../lib/demoLocal';
import { cn } from '../../lib/utils';
import type { FormAppContext } from '../../types/app';
import type { FormField } from '../../types/form';
import type { FlowBinding, FlowDefinition, FlowRunLog } from '../../types/flows';
import { statusChipStyle } from '../flows/runHistoryChip';
import { bindingToPayload } from '../flows/bindings/bindingPayload';
import { FORM_SUBMITTED_EVENT } from './formFlowBindingsSerialize';
import { FormFlowBindingEditor } from './FormFlowBindingEditor';
import { buildFormSubmissionFlowSeed, realAnswerFields } from './formFlowSeed';

type ScopeKind = 'workspace' | 'app';

interface FlowSection {
  key: string;
  kind: ScopeKind;
  appId?: string;
  label: string;
  note?: string;
  flows: FlowDefinition[];
  bindings: FlowBinding[];
}

interface EditingTarget {
  sectionKey: string;
  binding: FlowBinding | null;
}

interface DeleteTarget {
  sectionKey: string;
  binding: FlowBinding;
}

function filterSubmitBindings(bindings: FlowBinding[], formId: string, requireFormId = false): FlowBinding[] {
  return bindings.filter((binding) => {
    if (binding.event !== FORM_SUBMITTED_EVENT) return false;
    return requireFormId ? binding.formId === formId : !binding.formId || binding.formId === formId;
  });
}

function flowName(section: FlowSection, binding: FlowBinding): string {
  return section.flows.find((flow) => flow.id === binding.flowDefinitionId || flow.slug === binding.flow)?.name ?? binding.flow;
}

function currentSections(workspaceFlows: FlowDefinition[], workspaceBindings: FlowBinding[], appSections: FlowSection[]): FlowSection[] {
  return [
    {
      key: 'workspace',
      kind: 'workspace',
      label: 'Workspace flows',
      note: 'Runs from your workspace, independent of any app.',
      flows: workspaceFlows,
      bindings: workspaceBindings,
    },
    ...appSections,
  ];
}

function sectionByKey(sections: FlowSection[], key: string): FlowSection | undefined {
  return sections.find((section) => section.key === key);
}

function runChip(run: FlowRunLog | null | undefined) {
  if (!run) {
    return (
      <span className="inline-flex items-center rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5 text-[11px] font-medium text-gray-400 dark:text-slate-500">
        No runs
      </span>
    );
  }
  const chip = statusChipStyle(run);
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', chip.cls)}>
      {chip.label}
    </span>
  );
}

function payloadWithFlowId(section: FlowSection, payload: Record<string, unknown>, binding: FlowBinding | null): Record<string, unknown> {
  const slug = typeof payload.flow === 'string' ? payload.flow : binding?.flow;
  const flowDefinitionId = section.flows.find((flow) => flow.slug === slug)?.id ?? binding?.flowDefinitionId ?? slug;
  return typeof flowDefinitionId === 'string' ? { ...payload, flowDefinitionId } : payload;
}

export function FormFlowsPanel({
  formId,
  formTitle,
  fields,
  onClose,
  onCountChange,
  variant = 'dock',
}: {
  formId: string;
  formTitle: string;
  fields: FormField[];
  onClose: () => void;
  onCountChange?: (count: number) => void;
  variant?: 'dock' | 'sheet';
}) {
  const navigate = useNavigate();
  const [workspaceFlows, setWorkspaceFlows] = useState<FlowDefinition[]>([]);
  const [workspaceBindings, setWorkspaceBindings] = useState<FlowBinding[]>([]);
  const [appSections, setAppSections] = useState<FlowSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRuns, setLastRuns] = useState<Record<string, FlowRunLog | null>>({});
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [createScopeKey, setCreateScopeKey] = useState('workspace');
  const [creating, setCreating] = useState(false);
  const [createdFlowId, setCreatedFlowId] = useState<string | null>(null);
  const demoMode = api.isDemoMode();

  const answerFields = useMemo(() => realAnswerFields(fields), [fields]);
  const sections = useMemo(
    () => currentSections(workspaceFlows, workspaceBindings, appSections),
    [appSections, workspaceBindings, workspaceFlows],
  );
  const totalBindings = sections.reduce((sum, section) => sum + section.bindings.length, 0);
  const createScope = sectionByKey(sections, createScopeKey) ?? sections[0];
  const hasApps = appSections.length > 0;

  const load = useCallback(async () => {
    const [workspaceFlowsRes, workspaceBindingsRes, contextsRes] = await Promise.all([
      api.listWorkspaceFlows(),
      api.listFormFlowBindings(formId),
      api.getFormAppContexts(formId),
    ]);

    const nextWorkspaceFlows = demoMode
      ? await demoApplyFlowOverlay(null, workspaceFlowsRes.data?.flows ?? [])
      : workspaceFlowsRes.data?.flows ?? [];
    const serverWorkspaceBindings = workspaceBindingsRes.data
      ? filterSubmitBindings(workspaceBindingsRes.data.bindings, formId)
      : [];
    const nextWorkspaceBindings = demoMode
      ? await demoApplyFormBindingOverlay(formId, serverWorkspaceBindings)
      : serverWorkspaceBindings;
    const contexts = contextsRes.data?.contexts ?? [];
    const nextAppSections = await Promise.all(contexts.map(async (context: FormAppContext) => {
      const [flowsRes, bindingsRes] = await Promise.all([
        api.listFlows(context.appId),
        api.listFlowBindings(context.appId),
      ]);
      const appFlows = demoMode
        ? await demoApplyFlowOverlay(context.appId, flowsRes.data?.flows ?? [])
        : flowsRes.data?.flows ?? [];
      return {
        key: `app:${context.appId}`,
        kind: 'app' as const,
        appId: context.appId,
        label: context.appName,
        note: demoMode && !isDemoLocalId(context.appId)
          ? 'App-scoped bindings are read-only in the demo.'
          : context.isPublished ? 'Attached app flow.' : 'Attached app flow in a draft app.',
        flows: appFlows,
        bindings: bindingsRes.data ? filterSubmitBindings(bindingsRes.data.bindings, formId, true) : [],
      };
    }));

    const allBindings = [...nextWorkspaceBindings, ...nextAppSections.flatMap((section) => section.bindings)];
    const runEntries = await Promise.all(allBindings.map(async (binding) => {
      const res = await api.listMyFlowRuns({ flowId: binding.flowDefinitionId, limit: 1 });
      return [binding.id, res.data?.runs[0] ?? null] as const;
    }));
    const nextCount = allBindings.length;

    if (!demoMode && (workspaceFlowsRes.error || workspaceBindingsRes.error || contextsRes.error)) {
      toast.error('Failed to load flow bindings');
    }
    setWorkspaceFlows(nextWorkspaceFlows);
    setWorkspaceBindings(nextWorkspaceBindings);
    setAppSections(nextAppSections);
    setLastRuns(Object.fromEntries(runEntries));
    setLoading(false);
    onCountChange?.(nextCount);
    setCreateScopeKey((current) => {
      const keys = ['workspace', ...nextAppSections.map((section) => section.key)];
      if (demoMode) return 'workspace';
      if (current === 'workspace' && nextAppSections.length === 1) return nextAppSections[0].key;
      if (keys.includes(current)) return current;
      return nextAppSections.length === 1 ? nextAppSections[0].key : 'workspace';
    });
  }, [demoMode, formId, onCountChange]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      await load();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [load]);

  const refresh = useCallback(() => { void load(); }, [load]);

  const saveBinding = useCallback(async (target: EditingTarget, binding: FlowBinding | null, payload: Record<string, unknown>) => {
    const section = sectionByKey(sections, target.sectionKey);
    if (!section) return { ok: false, error: 'Flow scope was not found.' };
    if (demoMode && section.kind === 'app' && !isDemoLocalId(section.appId)) {
      return { ok: false, error: 'App-scoped bindings are read-only in the demo.' };
    }
    if (demoMode && section.kind === 'workspace') {
      const demoPayload = payloadWithFlowId(section, payload, binding);
      if (binding) await demoUpdateFormBinding(formId, binding.id, demoPayload);
      else await demoCreateFormBinding(formId, demoPayload);
      refresh();
      return { ok: true };
    }
    const res = section.kind === 'workspace'
      ? binding
        ? await api.updateFormFlowBinding(formId, binding.id, payload)
        : await api.createFormFlowBinding(formId, payload)
      : binding
        ? await api.updateFlowBinding(section.appId as string, binding.id, { ...payload, formId })
        : await api.createFlowBinding(section.appId as string, { ...payload, formId });
    if (res.error || !res.data) {
      return { ok: false, error: typeof res.error === 'string' ? res.error : undefined };
    }
    refresh();
    return { ok: true };
  }, [demoMode, formId, refresh, sections]);

  const toggleBinding = useCallback(async (section: FlowSection, binding: FlowBinding, enabled: boolean) => {
    const payload = { ...bindingToPayload(binding), enabled };
    if (demoMode && section.kind === 'app' && !isDemoLocalId(section.appId)) {
      toast.info('Demo read-only', 'App-scoped bindings are read-only in the demo.');
      return;
    }
    if (demoMode && section.kind === 'workspace') {
      await demoUpdateFormBinding(formId, binding.id, payloadWithFlowId(section, payload, binding));
      refresh();
      return;
    }
    const res = section.kind === 'workspace'
      ? await api.updateFormFlowBinding(formId, binding.id, payload)
      : await api.updateFlowBinding(section.appId as string, binding.id, { ...payload, formId });
    if (res.error || !res.data) {
      toast.error('Failed to update binding', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    refresh();
  }, [demoMode, formId, refresh]);

  const deleteBinding = useCallback(async () => {
    if (!deleteTarget) return;
    const section = sectionByKey(sections, deleteTarget.sectionKey);
    if (!section) return;
    if (demoMode && section.kind === 'app' && !isDemoLocalId(section.appId)) {
      toast.info('Demo read-only', 'App-scoped bindings are read-only in the demo.');
      setDeleteTarget(null);
      return;
    }
    if (demoMode && section.kind === 'workspace') {
      await demoDeleteFormBinding(formId, deleteTarget.binding.id);
      toast.success('Binding removed');
      setDeleteTarget(null);
      refresh();
      return;
    }
    const res = section.kind === 'workspace'
      ? await api.deleteFormFlowBinding(formId, deleteTarget.binding.id)
      : await api.deleteFlowBinding(section.appId as string, deleteTarget.binding.id);
    if (res.error) {
      toast.error('Failed to delete binding', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    toast.success('Binding removed');
    setDeleteTarget(null);
    refresh();
  }, [deleteTarget, demoMode, formId, refresh, sections]);

  const createFlowForForm = useCallback(async () => {
    if (!createScope) return;
    if (demoMode && createScope.kind === 'app' && !isDemoLocalId(createScope.appId)) {
      toast.info('Demo read-only', 'App-scoped bindings are read-only in the demo.');
      return;
    }
    setCreating(true);
    const seed = buildFormSubmissionFlowSeed({
      formTitle,
      fields,
      existingSlugs: createScope.flows.map((flow) => flow.slug),
    });
    const flowBody = {
      name: seed.name,
      slug: seed.slug,
      description: seed.description,
      flowJson: seed.flowJson,
      enabled: true,
      nodeCapabilities: seed.nodeCapabilities,
    };
    const flow = demoMode && createScope.kind === 'workspace'
      ? await demoCreateFlow({ ...flowBody, appId: null })
      : createScope.kind === 'workspace'
        ? (await api.createWorkspaceFlow(flowBody)).data?.flow
        : (await api.createFlow(createScope.appId as string, flowBody)).data?.flow;
    if (!flow) {
      setCreating(false);
      toast.error('Failed to create flow');
      return;
    }
    const bindingPayload = {
      event: FORM_SUBMITTED_EVENT,
      flow: flow.slug,
      mode: 'async',
      inputMap: seed.inputMap,
      enabled: true,
    };
    const bindingRes = demoMode && createScope.kind === 'workspace'
      ? { error: null, data: { binding: await demoCreateFormBinding(formId, { ...bindingPayload, flowDefinitionId: flow.id }) } }
      : createScope.kind === 'workspace'
        ? await api.createFormFlowBinding(formId, bindingPayload)
        : await api.createFlowBinding(createScope.appId as string, { ...bindingPayload, formId });
    setCreating(false);
    if (bindingRes.error || !bindingRes.data) {
      toast.error('Flow created, but binding failed', typeof bindingRes.error === 'string' ? bindingRes.error : undefined);
      setCreatedFlowId(flow.id);
      refresh();
      return;
    }
    toast.success('Flow created', 'This form now triggers the new flow on submit.');
    setCreatedFlowId(flow.id);
    refresh();
  }, [createScope, demoMode, fields, formId, formTitle, refresh]);

  return (
    <aside
      className={cn(
        'bg-white dark:bg-slate-900 flex flex-col flex-shrink-0',
        variant === 'dock'
          ? 'w-full md:w-96 border-l border-gray-200 dark:border-slate-800 md:animate-scale-in md:origin-right motion-safe:transition-[width] motion-safe:duration-200'
          : 'h-full w-full',
      )}
    >
      {variant === 'dock' && (
        <div className="flex items-center justify-between gap-2 p-4 border-b border-gray-200 dark:border-slate-800 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-gray-900 dark:text-white">Flows</h2>
            <p className="text-sm text-gray-500 dark:text-slate-500 truncate">{totalBindings} trigger{totalBindings === 1 ? '' : 's'}</p>
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center min-h-8 min-w-8 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            aria-label="Close flows panel"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className={cn('flex-1 overflow-y-auto p-4 space-y-4', variant === 'sheet' && 'pb-[calc(1rem+env(safe-area-inset-bottom))]')}>
        {demoMode && (
          <p className="rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200">
            Demo: your flows stay in this browser.
          </p>
        )}
        <div className="rounded-xl border border-primary-200/70 dark:border-primary-500/25 bg-primary-50/70 dark:bg-primary-500/10 p-3 space-y-3">
          <div className="flex items-start gap-2">
            <Zap className="h-4 w-4 mt-0.5 text-primary-600 dark:text-primary-300" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Create a submit flow</h3>
              <p className="text-xs text-gray-600 dark:text-slate-300">
                Seed a Trigger, summary step, Output, and input map from this form's real fields.
              </p>
            </div>
          </div>
          {hasApps && !demoMode && (
            appSections.length === 1 ? (
              <p className="text-xs text-primary-700 dark:text-primary-200">
                This form belongs to {appSections[0].label}; new flows default to that app.
              </p>
            ) : (
              <select
                aria-label="Flow scope"
                value={createScopeKey}
                onChange={(e) => setCreateScopeKey(e.target.value)}
                className="w-full rounded-lg border border-primary-200 bg-white px-3 py-2 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-primary-500/30 dark:bg-slate-900 dark:text-white"
              >
                <option value="workspace">Workspace</option>
                {appSections.map((section) => <option key={section.key} value={section.key}>{section.label}</option>)}
              </select>
            )
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={createFlowForForm} disabled={creating || loading || answerFields.length === 0}>
              <Plus className="h-3.5 w-3.5" /> {creating ? 'Creating...' : 'Create flow for this form'}
            </Button>
            {createdFlowId && (
              <Button variant="outline" size="sm" onClick={() => navigate(`/flows?flow=${encodeURIComponent(createdFlowId)}`)}>
                <ExternalLink className="h-3.5 w-3.5" /> Open in Automations
              </Button>
            )}
          </div>
          {answerFields.length === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">Add at least one answer field before seeding a submit flow.</p>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">Loading flows...</p>
        ) : (
          sections.map((section) => {
            const readOnly = demoMode && section.kind === 'app' && !isDemoLocalId(section.appId);
            return (
            <section key={section.key} className="space-y-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">{section.label}</h3>
                {section.note && <p className="text-xs text-gray-400 dark:text-slate-500">{section.note}</p>}
              </div>

              {section.flows.length === 0 && section.bindings.length === 0 && (
                <p className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 px-3 py-4 text-center text-xs text-gray-500 dark:text-slate-400">
                  No flows in this scope yet.
                </p>
              )}

              {section.bindings.map((binding) => {
                const name = flowName(section, binding);
                const editTarget: EditingTarget = { sectionKey: section.key, binding };
                return (
                  <div key={binding.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-800/40 p-3 space-y-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex rounded-full border border-gray-200 dark:border-slate-700 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:text-slate-300">
                            {binding.mode}
                          </span>
                          {runChip(lastRuns[binding.id])}
                        </div>
                      </div>
                      <Switch
                        checked={binding.enabled}
                        onChange={(enabled) => { void toggleBinding(section, binding, enabled); }}
                        size="sm"
                        disabled={readOnly}
                        ariaLabel={`Enable the ${name} flow binding`}
                      />
                    </div>

                    {!readOnly && editing?.sectionKey === section.key && editing.binding?.id === binding.id ? (
                      <FormFlowBindingEditor
                        fields={answerFields}
                        flows={section.flows}
                        binding={binding}
                        onSave={(current, payload) => saveBinding(editTarget, current, payload)}
                        onDone={() => setEditing(null)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/flows?flow=${encodeURIComponent(binding.flowDefinitionId)}`)}
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Open in Automations
                        </Button>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(editTarget)}
                            disabled={readOnly}
                            aria-label={`Edit binding for ${name}`}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-primary-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget({ sectionKey: section.key, binding })}
                            disabled={readOnly}
                            aria-label={`Delete binding for ${name}`}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {editing?.sectionKey === section.key && editing.binding === null ? (
                <FormFlowBindingEditor
                  fields={answerFields}
                  flows={section.flows}
                  binding={null}
                  onSave={(current, payload) => saveBinding({ sectionKey: section.key, binding: null }, current, payload)}
                  onDone={() => setEditing(null)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                section.flows.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setEditing({ sectionKey: section.key, binding: null })} disabled={readOnly}>
                    <Plus className="h-3.5 w-3.5" /> Add trigger
                  </Button>
                )
              )}
            </section>
            );
          })
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Remove this flow binding?"
        message="This form will no longer trigger the flow when a record is submitted."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => { void deleteBinding(); }}
        onClose={() => setDeleteTarget(null)}
      />
    </aside>
  );
}
