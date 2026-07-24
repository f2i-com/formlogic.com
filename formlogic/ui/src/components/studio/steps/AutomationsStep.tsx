import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  GitBranch,
  Play,
  Plus,
  Workflow,
  Zap,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { FLOW_EVENT_CATALOG } from '../../flows/flowEventCatalog';
import { getNodeSpec } from '../../flows/editor/nodeCatalog';
import { FLOW_STARTER_TEMPLATES } from '../../flows/starterTemplates';
import { returnToState } from '../../../hooks/useReturnTo';
import { trackStudioSave } from '../studioSaveState';
import type { App, AppForm } from '../../../types/app';
import type { Form } from '../../../types/form';
import type { FlowBinding, FlowDefinition } from '../../../types/flows';

function eventLabel(event: string): string {
  return FLOW_EVENT_CATALOG.find((e) => e.event === event)?.label ?? event;
}

function nodeLabel(type: string | undefined): string {
  if (!type) return 'Step';
  return getNodeSpec(type)?.label ?? type.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Studio step 4 — Automations: the app's flows in plain language. Simple view =
 * trigger + steps read from the real flow graph and bindings, with enable
 * toggles and one-click test runs; the advanced canvas is the full flow editor.
 */
export function AutomationsStep({
  app,
  flows,
  bindings,
  appForms,
  formsById,
  onReloadFlows,
}: {
  app: App;
  flows: FlowDefinition[];
  bindings: FlowBinding[];
  appForms: AppForm[];
  formsById: Record<string, Form>;
  onReloadFlows: () => Promise<void>;
}) {
  const navigate = useNavigate();
  // The flow editor's back link returns here when opened from this step.
  const studioReturn = returnToState(`/apps/${app.id}/studio/automations`, 'App Studio');
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const selected = flows.find((f) => f.id === selectedFlowId) ?? flows[0] ?? null;
  const selectedBindings = useMemo(
    () => (selected ? bindings.filter((b) => b.flowDefinitionId === selected.id || b.flow === selected.slug) : []),
    [bindings, selected]
  );

  const formName = (formId: string | null) => {
    if (!formId) return null;
    return appForms.find((af) => af.formId === formId)?.displayName || formsById[formId]?.title || null;
  };

  const toggleFlow = async (flow: FlowDefinition, enabled: boolean) => {
    const res = await trackStudioSave(
      enabled ? `${flow.name} enabled` : `${flow.name} paused`,
      api.updateFlow(app.id, flow.id, { enabled }),
      (r) => !r.error
    );
    if (res.error) {
      toast.error('Could not update the automation', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    toast.success(enabled ? 'Automation enabled' : 'Automation paused');
    await onReloadFlows();
  };

  const testFlow = async (flow: FlowDefinition) => {
    if (testingId) return;
    setTestingId(flow.id);
    try {
      const res = await api.testRunFlow(app.id, flow.id);
      if (res.error) {
        toast.error('Test run failed', typeof res.error === 'string' ? res.error : undefined);
      } else {
        toast.success('Test run finished', 'See run history in the Flows workspace for details.');
      }
    } finally {
      setTestingId(null);
    }
  };

  const newAutomation = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const blank = FLOW_STARTER_TEMPLATES[0];
      const taken = new Set(flows.map((f) => f.slug));
      let slug = 'new-automation';
      let n = 1;
      while (taken.has(slug)) {
        n += 1;
        slug = `new-automation-${n}`;
      }
      const res = await api.createFlow(app.id, {
        name: n > 1 ? `New automation ${n}` : 'New automation',
        slug,
        flowJson: blank.flowJson,
        enabled: false,
        nodeCapabilities: blank.nodeCapabilities,
      });
      const flow = res.data?.flow;
      if (!flow) {
        toast.error('Could not create the automation', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      // Build it on the full canvas — the studio list will show it on return.
      navigate(`/flows?flow=${flow.id}`, { state: studioReturn });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-3 shadow-sm sm:flex-row sm:items-center">
        <p className="px-1 text-xs text-gray-500 dark:text-slate-400">
          Automations are FormLogic Flows scoped to this app — triggered by form events, schedules or connectors.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/flows')} leftIcon={<Workflow className="h-4 w-4" />}>
            Flows workspace
          </Button>
          <Button size="sm" onClick={newAutomation} isLoading={creating} leftIcon={<Plus className="h-4 w-4" />}>
            New automation
          </Button>
        </div>
      </div>

      {flows.length === 0 ? (
        <section className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-white/15 px-6 py-16 text-center">
          <GitBranch className="h-8 w-8 text-gray-300 dark:text-slate-600" />
          <p className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">No automations yet</p>
          <p className="mt-1 max-w-md text-sm text-gray-500 dark:text-slate-400">
            Automate what happens when a form is submitted, a status changes, or on a schedule —
            notifications, record updates, AI steps and more.
          </p>
          <Button className="mt-4" onClick={newAutomation} isLoading={creating} leftIcon={<Plus className="h-4 w-4" />}>
            Create your first automation
          </Button>
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(300px,.85fr)_minmax(0,1.15fr)]">
          {/* Automation list */}
          <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm h-fit">
            <div className="border-b border-gray-200/80 dark:border-white/[0.06] p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Automations</h3>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">Plain-language rules behind this app.</p>
            </div>
            <div className="scrollbar-thin max-h-[560px] space-y-2 overflow-y-auto p-2.5">
              {flows.map((flow) => {
                const isSelected = selected?.id === flow.id;
                const flowBindings = bindings.filter((b) => b.flowDefinitionId === flow.id || b.flow === flow.slug);
                const stepCount = Math.max(0, (flow.flowJson?.nodes?.length ?? 0) - 1);
                return (
                  <div
                    key={flow.id}
                    className={cn(
                      'w-full rounded-xl border p-3 transition-all',
                      isSelected
                        ? 'border-primary-200 dark:border-primary-500/20 bg-primary-50/70 dark:bg-primary-500/[0.07]'
                        : 'border-transparent hover:border-gray-200 dark:hover:border-white/10 hover:bg-gray-50 dark:hover:bg-white/[0.03]'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedFlowId(flow.id)}
                        className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
                      >
                        <span
                          className={cn(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                            flow.enabled
                              ? 'bg-primary-100 dark:bg-primary-500/10 text-primary-600 dark:text-primary-300'
                              : 'bg-gray-100 dark:bg-white/[0.05] text-gray-400'
                          )}
                        >
                          <GitBranch className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-xs font-bold text-gray-900 dark:text-white">{flow.name}</span>
                            <Badge variant={flow.enabled ? 'success' : 'default'} size="sm">
                              {flow.enabled ? 'Active' : 'Paused'}
                            </Badge>
                          </span>
                          <span className="mt-1.5 block text-[10px] leading-4 text-gray-500 dark:text-slate-400 line-clamp-2">
                            {flowBindings.length > 0
                              ? flowBindings.map((b) => eventLabel(b.event)).join(' · ')
                              : 'No trigger yet — runs manually or from other flows'}
                          </span>
                          <span className="mt-1.5 block text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">
                            {stepCount} {stepCount === 1 ? 'step' : 'steps'} · updated {formatRelativeTime(flow.updatedAt)}
                          </span>
                        </span>
                      </button>
                      <Switch
                        ariaLabel={`Toggle ${flow.name}`}
                        checked={flow.enabled}
                        onChange={(v) => void toggleFlow(flow, v)}
                        size="sm"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Simple editor for the selected automation */}
          {selected && (
            <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
              <div className="flex flex-col gap-3 border-b border-gray-200/80 dark:border-white/[0.06] p-5 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">{selected.name}</h3>
                    <Badge variant={selected.enabled ? 'success' : 'default'} size="sm">
                      {selected.enabled ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  {selected.description && (
                    <p className="mt-1 text-sm text-gray-500 dark:text-slate-400 line-clamp-2">{selected.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void testFlow(selected)}
                    isLoading={testingId === selected.id}
                    leftIcon={<Play className="h-4 w-4" />}
                  >
                    Test
                  </Button>
                  <Button size="sm" onClick={() => navigate(`/flows?flow=${selected.id}`, { state: studioReturn })} leftIcon={<Workflow className="h-4 w-4" />}>
                    Advanced canvas
                  </Button>
                </div>
              </div>

              <div className="space-y-3 p-4 sm:p-6">
                {/* Triggers (bindings) */}
                {selectedBindings.length > 0 ? (
                  selectedBindings.map((binding, index) => (
                    <div key={binding.id}>
                      <RuleCard
                        index={index + 1}
                        icon={Zap}
                        eyebrow="When this happens"
                        title={[
                          eventLabel(binding.event),
                          formName(binding.formId) ? `on ${formName(binding.formId)}` : null,
                          binding.condition ? '(with a condition)' : null,
                        ].filter(Boolean).join(' ')}
                        tone="primary"
                        muted={!binding.enabled}
                      />
                      <div className="ml-6 h-4 w-px bg-gray-200 dark:bg-white/10" />
                    </div>
                  ))
                ) : (
                  <div>
                    <RuleCard index={1} icon={Zap} eyebrow="When this happens" title="No trigger configured — add one on the canvas" tone="amber" />
                    <div className="ml-6 h-4 w-px bg-gray-200 dark:bg-white/10" />
                  </div>
                )}

                {/* Steps from the real flow graph */}
                {(selected.flowJson?.nodes ?? [])
                  .filter((node) => node.type !== 'input')
                  .map((node, index, list) => (
                    <div key={node.id ?? index}>
                      <RuleCard
                        index={selectedBindings.length + index + 1}
                        icon={GitBranch}
                        eyebrow={node.type === 'output' ? 'Result' : `Then · Step ${index + 1}`}
                        title={nodeLabel(node.type)}
                        tone={node.type === 'output' ? 'emerald' : 'sky'}
                      />
                      {index < list.length - 1 && <div className="ml-6 h-4 w-px bg-gray-200 dark:bg-white/10" />}
                    </div>
                  ))}

                <button
                  type="button"
                  onClick={() => navigate(`/flows?flow=${selected.id}`, { state: studioReturn })}
                  className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 dark:border-white/15 text-xs font-bold text-gray-500 dark:text-slate-400 transition hover:border-primary-400 hover:bg-primary-50 hover:text-primary-700 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/[0.05] dark:hover:text-primary-300"
                >
                  <Plus className="h-4 w-4" /> Add steps or triggers on the canvas
                </button>
              </div>

              <div className="flex items-center justify-between border-t border-gray-200/80 dark:border-white/[0.06] bg-gray-50/70 dark:bg-white/[0.02] px-5 py-3 text-[10px] text-gray-400 dark:text-slate-500">
                <span>Runs {selected.executionLocation === 'desktop' ? 'on your Desktop' : selected.executionLocation === 'cloud' ? 'in FormLogic Cloud' : 'automatically (Cloud or Desktop)'}</span>
                <button
                  type="button"
                  onClick={() => navigate(`/flows?flow=${selected.id}`, { state: studioReturn })}
                  className="cursor-pointer font-bold text-primary-600 dark:text-primary-400"
                >
                  View run history <ChevronRight className="inline h-3 w-3" />
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function RuleCard({
  index,
  icon: Icon,
  eyebrow,
  title,
  tone,
  muted,
}: {
  index: number;
  icon: typeof Zap;
  eyebrow: string;
  title: string;
  tone: 'primary' | 'sky' | 'amber' | 'emerald';
  muted?: boolean;
}) {
  const tones = {
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-300 border-primary-200 dark:border-primary-500/20',
    sky: 'bg-sky-50 dark:bg-sky-400/10 text-sky-600 dark:text-sky-300 border-sky-200 dark:border-sky-400/20',
    amber: 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-300 border-amber-200 dark:border-amber-400/20',
    emerald: 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/20',
  };
  return (
    <div className={cn(
      'flex min-h-14 w-full items-center gap-3 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-slate-950/40 p-3 text-left',
      muted && 'opacity-60'
    )}>
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border', tones[tone])}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[9px] font-bold uppercase tracking-[0.12em] text-gray-400 dark:text-slate-500">{eyebrow}</span>
        <span className="mt-1 block text-xs font-bold text-gray-800 dark:text-slate-200">{title}</span>
      </span>
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 dark:bg-white/[0.06] text-[9px] font-bold text-gray-400">
        {index}
      </span>
    </div>
  );
}
