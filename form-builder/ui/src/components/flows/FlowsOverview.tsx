// FormLogic Flows workspace - overview panel shown before a flow is selected.
//
// The empty editor state is productive: it explains what flows do, surfaces Desktop readiness,
// shows recent owner-wide runs, and lets authors start from the same templates as NewFlowDialog.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, FileText, Laptop, Loader2, MessageSquare, PhoneIncoming, Plus, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react';
import { listProviders } from '../../client-runtime/flows/aiProviders';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { formatRelativeTime } from './relativeTime';
import { statusChipStyle } from './runHistoryChip';
import { flowStarterTemplatesForConnectors, type FlowStarterTemplate } from './starterTemplates';
import {
  describeFlowsLastSeen,
  type FlowsDesktopPresence,
} from './useFlowsDesktopPresence';
import type { FlowDefinition, FlowRunLog } from '../../types/flows';

const TEMPLATE_ICON: Record<string, LucideIcon> = {
  blank: FileText,
  'caller-lookup': PhoneIncoming,
  'call-summary': ClipboardList,
  'sms-auto-draft': MessageSquare,
};

interface FlowsOverviewProps {
  flows: FlowDefinition[];
  desktopPresence: FlowsDesktopPresence;
  onNewFlow: (template?: FlowStarterTemplate) => void;
  onOpenRunFlow: (flowId: string) => void;
  onOpenAiServices: () => void;
  availableConnectorIds?: readonly string[];
}

function RunStatusChip({ run }: { run: FlowRunLog }) {
  const { cls, label } = statusChipStyle(run);
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>;
}

export function FlowsOverview({ flows, desktopPresence, onNewFlow, onOpenRunFlow, onOpenAiServices, availableConnectorIds = [] }: FlowsOverviewProps) {
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const userId = useAuthStore((state) => state.user?.id);
  const [providerCount, setProviderCount] = useState(() => listProviders(userId).length);
  const flowById = useMemo(() => new Map(flows.map((flow) => [flow.id, flow])), [flows]);
  const flowBySlug = useMemo(() => {
    const map = new Map<string, FlowDefinition>();
    for (const flow of flows) if (!map.has(flow.slug)) map.set(flow.slug, flow);
    return map;
  }, [flows]);
  const visibleTemplates = useMemo(() => flowStarterTemplatesForConnectors(availableConnectorIds), [availableConnectorIds]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setRunsError(null);
    const res = await api.listMyFlowRuns({ limit: 10 });
    setLoadingRuns(false);
    if (res.error || !res.data) {
      setRunsError(typeof res.error === 'string' ? res.error : 'Could not load recent runs');
      setRuns([]);
      return;
    }
    setRuns(res.data.runs);
  }, []);

  useEffect(() => {
    // Leading await: the load (and its setStates) runs after the effect body returns
    // (react-hooks/set-state-in-effect convention).
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await loadRuns();
    })();
    return () => { cancelled = true; };
  }, [loadRuns]);

  useEffect(() => {
    const refresh = () => setProviderCount(listProviders(userId).length);
    refresh();
    window.addEventListener('formlogic:ai-services-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('formlogic:ai-services-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [userId]);

  const resolveFlow = (run: FlowRunLog): FlowDefinition | null => {
    if (run.flowDefinitionId) {
      const byId = flowById.get(run.flowDefinitionId);
      if (byId) return byId;
    }
    return run.flow ? flowBySlug.get(run.flow) ?? null : null;
  };

  return (
    <div className="h-full min-h-0 overflow-auto p-4 sm:p-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Flows</h2>
            <div className="mt-2 h-0.5 w-32 rounded-full bg-gradient-to-r from-primary-500 via-primary-400 to-transparent dark:from-primary-300 dark:via-primary-400 dark:to-transparent" />
            <p className="mt-1 max-w-xl text-sm text-gray-600 dark:text-slate-400">
              Flows run your busywork: when a call comes in, a form is submitted, or on demand — they look up records, draft replies, and speak on the line.
            </p>
          </div>
          <Button size="sm" onClick={() => onNewFlow()} leftIcon={<Plus className="h-4 w-4" />}>
            New flow
          </Button>
        </section>

        <DesktopStatusCard presence={desktopPresence} />
        <AiServicesStatusCard providerCount={providerCount} presence={desktopPresence} onOpen={onOpenAiServices} />

        <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Recent runs</h3>
              <p className="text-xs text-gray-500 dark:text-slate-400">Latest owner-wide flow activity.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={loadRuns} isLoading={loadingRuns} disabled={loadingRuns} leftIcon={<RefreshCw className="h-3.5 w-3.5" />}>
              Refresh
            </Button>
          </div>
          {runs === null || loadingRuns ? (
            <p className="flex items-center gap-2 py-4 text-xs text-gray-400 dark:text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading recent runs...
            </p>
          ) : runsError ? (
            <p className="py-4 text-xs text-red-600 dark:text-red-400">{runsError}</p>
          ) : runs.length === 0 ? (
            <p className="py-4 text-xs text-gray-400 dark:text-slate-500">No flow runs yet. Test runs and event-triggered runs will appear here.</p>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {runs.map((run) => {
                const flow = resolveFlow(run);
                const when = run.startedAt ?? run.createdAt;
                return (
                  <button
                    key={run.runId}
                    type="button"
                    disabled={!flow}
                    onClick={() => { if (flow) onOpenRunFlow(flow.id); }}
                    className={cn(
                      'grid w-full grid-cols-[1fr,auto] gap-2 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:grid-cols-[minmax(0,1fr),auto,auto]',
                      flow ? 'hover:bg-gray-50 dark:hover:bg-slate-800/50' : 'cursor-default',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-800 dark:text-slate-200">
                        {flow?.name ?? run.flow ?? run.flowDefinitionId ?? 'Unknown flow'}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-gray-500 dark:text-slate-400">{run.triggerEvent}</span>
                    </span>
                    <span className="self-center"><RunStatusChip run={run} /></span>
                    <span className="col-span-2 text-xs text-gray-400 dark:text-slate-500 sm:col-span-1 sm:self-center" title={when ?? undefined}>
                      {formatRelativeTime(when)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Start from a template</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400">Open the New flow dialog with a starter preselected.</p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {visibleTemplates.map((template) => {
              const Icon = TEMPLATE_ICON[template.id] ?? FileText;
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => onNewFlow(template)}
                  className="group flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800/50"
                >
                  <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-gray-100 text-gray-500 group-hover:text-gray-700 dark:bg-slate-800 dark:text-slate-300 dark:group-hover:text-white">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-gray-900 dark:text-white">{template.name}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">{template.summary}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function AiServicesStatusCard({
  providerCount,
  presence,
  onOpen,
}: {
  providerCount: number;
  presence: FlowsDesktopPresence;
  onOpen: () => void;
}) {
  const speechLabel =
    presence.kind === 'local'
      ? 'Default Desktop speech ready'
      : presence.kind === 'remote'
        ? 'Linked Desktop speech online'
        : 'Desktop speech offline';
  const speechCopy =
    presence.kind === 'local'
      ? 'Speech nodes use the Desktop aokie-voice service by default when no API service or endpoint is selected.'
      : presence.kind === 'remote'
        ? 'The linked Desktop is online; browser service enumeration is only available for local pairing.'
        : 'Link FormLogic Desktop to use the default speech service, or choose a browser-stored API service on AI nodes.';

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">AI services</h3>
            <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {providerCount} API {providerCount === 1 ? 'service' : 'services'}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-gray-700 dark:text-slate-200">{speechLabel}</p>
          <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">{speechCopy}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={onOpen}>
            Open
          </Button>
        </div>
      </div>
    </section>
  );
}

function DesktopStatusCard({ presence }: { presence: FlowsDesktopPresence }) {
  const navigate = useNavigate();
  const label =
    presence.kind === 'local'
      ? 'Desktop connected'
      : presence.kind === 'remote'
        ? `Desktop online - ${presence.label}`
        : 'Desktop offline';
  const lastSeen = presence.kind === 'remote' ? describeFlowsLastSeen(presence.lastSeenMs) : null;
  const online = presence.kind !== 'none';

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-10 w-10 flex-none items-center justify-center rounded-lg',
            online
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-slate-400',
          )}
        >
          <Laptop className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h3>
            <span className={cn('h-2 w-2 rounded-full', online ? 'bg-emerald-500' : 'bg-gray-400 dark:bg-slate-500')} />
          </div>
          {presence.kind === 'local' && (
            <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
              This browser is paired to FormLogic Desktop on this machine.
            </p>
          )}
          {presence.kind === 'remote' && (
            <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
              A linked Desktop is online{lastSeen ? ` - last seen ${lastSeen}` : ''}.
            </p>
          )}
          {presence.kind === 'none' && (
            <>
              <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
                Desktop-powered nodes (browser, image, speech, Aokie phone) won't run until FormLogic Desktop is running and linked.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => navigate('/settings#linked-desktops')}
              >
                Set up in Settings
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
