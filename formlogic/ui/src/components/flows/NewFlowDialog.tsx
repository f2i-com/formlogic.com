// FormLogic Flows workspace - "New flow" dialog.
//
// Picks a starter template, creation scope (Workspace or an installed app), and name. Templates
// that rely on an Aokie connector can auto-target the only installed app that grants Aokie.
import { useId, useMemo, useState } from 'react';
import { ArrowRight, Check, ClipboardList, FileText, MessageSquare, PhoneIncoming, Plug, Workflow, type LucideIcon } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { deriveFlowConnectors } from './flowConnectors';
import { FLOW_STARTER_TEMPLATES, buildFlowCreateInput, flowStarterTemplatesForConnectors, type FlowStarterTemplate } from './starterTemplates';
import type { AppListItem } from '../../types/app';

/** Icon per starter template (keeps lucide out of the data module). */
const TEMPLATE_ICON: Record<string, LucideIcon> = {
  blank: FileText,
  'caller-lookup': PhoneIncoming,
  'call-summary': ClipboardList,
  'sms-auto-draft': MessageSquare,
};

function connectorIdsForApps(apps: AppListItem[]): string[] {
  return [...new Set(apps.flatMap((app) => deriveFlowConnectors(app).map((connector) => connector.id)))].sort();
}

function recommendedScope(template: FlowStarterTemplate, apps: AppListItem[]): string | null {
  if (!template.requiresConnector) return null;
  const appsWithConnector = apps.filter((app) => deriveFlowConnectors(app).some((connector) => connector.id === template.requiresConnector));
  return appsWithConnector.length === 1 ? appsWithConnector[0].id : null;
}

export function NewFlowDialog({
  isOpen,
  onClose,
  onCreate,
  creating,
  apps = [],
  initialTemplate = null,
  fixedAppId,
  embedded = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; slug: string; description: string; template: FlowStarterTemplate; appId: string | null }) => void;
  creating: boolean;
  apps?: AppListItem[];
  initialTemplate?: FlowStarterTemplate | null;
  /** App Studio creates automations in the app the author is editing. */
  fixedAppId?: string;
  /** Reuse the creation form as the Automations workspace landing view. */
  embedded?: boolean;
}) {
  const formId = useId();
  const availableConnectorIds = useMemo(() => connectorIdsForApps(apps), [apps]);
  const visibleTemplates = useMemo(() => flowStarterTemplatesForConnectors(availableConnectorIds), [availableConnectorIds]);
  const initial = visibleTemplates.find((candidate) => candidate.id === initialTemplate?.id) ?? visibleTemplates[0] ?? FLOW_STARTER_TEMPLATES[0];
  const [templateId, setTemplateId] = useState<string>(initial.id);
  const [name, setName] = useState<string>(initial.name);
  const [scopeAppId, setScopeAppId] = useState<string | null>(() => fixedAppId ?? recommendedScope(initial, apps));
  // Once the author edits a field, template switches stop overwriting that field.
  const [nameEdited, setNameEdited] = useState(false);
  const [scopeEdited, setScopeEdited] = useState(false);

  const template = visibleTemplates.find((t) => t.id === templateId) ?? visibleTemplates[0] ?? FLOW_STARTER_TEMPLATES[0];
  const autoScopeAppId = useMemo(() => recommendedScope(template, apps), [template, apps]);

  // Reset ONLY on the closed→open transition, during render (React's "adjusting state when
  // props change" pattern — no effect, so no cascading render). `apps` can change identity
  // while the dialog is open (async load, demo overlay) and must never wipe a typed name.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  if (prevOpen !== isOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      const nextTemplate = visibleTemplates.find((candidate) => candidate.id === initialTemplate?.id) ?? visibleTemplates[0] ?? FLOW_STARTER_TEMPLATES[0];
      setTemplateId(nextTemplate.id);
      setName(nextTemplate.name);
      setNameEdited(false);
      setScopeEdited(false);
      setScopeAppId(fixedAppId ?? recommendedScope(nextTemplate, apps));
    }
  }

  const pickTemplate = (t: FlowStarterTemplate) => {
    setTemplateId(t.id);
    if (!nameEdited) setName(t.name);
    if (!scopeEdited) setScopeAppId(fixedAppId ?? recommendedScope(t, apps));
  };

  const selectedApp = apps.find((app) => app.id === scopeAppId);
  const connectorUnavailable = !!template.requiresConnector && (!selectedApp || !deriveFlowConnectors(selectedApp).some((connector) => connector.id === template.requiresConnector));
  const canCreate = name.trim().length > 0 && !connectorUnavailable && (!scopeAppId || !!selectedApp);
  const submit = () => {
    if (creating || !canCreate) return;
    onCreate({ ...buildFlowCreateInput(template.id, name), appId: scopeAppId });
  };

  const footer = (<div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500 dark:text-slate-400">Next: connect and test your steps in the editor.</p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={creating}>{embedded ? 'Existing flows' : 'Cancel'}</Button>
          <Button type="submit" form={formId} isLoading={creating} disabled={creating || !canCreate}>Create automation <ArrowRight className="ml-2 h-4 w-4" /></Button>
        </div>
      </div>);
  const content = (
      <form id={formId}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="space-y-7 p-5 sm:p-7"
      >
        <div>
          <label className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-slate-200" htmlFor="new-flow-name">
            <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-500 dark:bg-slate-800 dark:text-slate-400">1</span> Automation name
          </label>
          <input
            id="new-flow-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
            placeholder={template.name}
            autoComplete="off"
            required
            maxLength={100}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-3 text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        </div>

        <fieldset>
          <legend className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-slate-200"><span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-500 dark:bg-slate-800 dark:text-slate-400">2</span> Create in</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {!fixedAppId && <ScopeButton
              active={scopeAppId === null}
              label="Workspace"
              description="A reusable automation for your forms, or for running on demand."
              icon={Workflow}
              onClick={() => { setScopeAppId(null); setScopeEdited(true); }}
            />}
            {apps.filter(app => !fixedAppId || app.id === fixedAppId).map((app) => {
              const hasAokie = deriveFlowConnectors(app).some((connector) => connector.id === 'aokie');
              return (
                <ScopeButton
                  key={app.id}
                  active={scopeAppId === app.id}
                  label={app.name}
                  description={hasAokie ? "Can also run on this app's events, like an incoming phone call." : "Can also run on this app's own events."}
                  icon={Plug}
                  onClick={() => { setScopeAppId(app.id); setScopeEdited(true); }}
                />
              );
            })}
          </div>
          {/* Re-scoping is not a field flip — triggers live on different routes per scope —
              so this is a one-way choice. State it here rather than letting the owner
              discover it when the trigger they want is not offered. */}
          <p className="mt-2 text-[11px] text-gray-500 dark:text-slate-400">
            Choose an app to use its events and connectors. This location cannot be changed later.
          </p>
          {autoScopeAppId && !scopeEdited && scopeAppId === autoScopeAppId && (
            <p className="mt-2 text-[11px] text-primary-600 dark:text-primary-300">
              Aokie template detected - the only app with Aokie connector access is selected.
            </p>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-slate-200"><span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-500 dark:bg-slate-800 dark:text-slate-400">3</span> Choose a starting point</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {visibleTemplates.map((t) => {
              const active = t.id === template.id;
              const Icon = TEMPLATE_ICON[t.id] ?? FileText;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  aria-pressed={active}
                  className={cn(
                    'group relative flex items-start gap-3 rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    active
                      ? 'border-primary-400 bg-primary-50/70 ring-1 ring-primary-400/40 dark:border-primary-500/60 dark:bg-primary-500/10 dark:ring-primary-500/30'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800/50',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg transition-colors',
                      active
                        ? 'bg-primary-600 text-primary-foreground'
                        : 'bg-gray-100 text-gray-500 group-hover:text-gray-700 dark:bg-slate-700 dark:text-slate-300 dark:group-hover:text-white',
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cn('block break-words text-sm font-semibold', active ? 'text-primary-800 dark:text-primary-200' : 'text-gray-900 dark:text-white')}>
                        {t.name}
                      </span>
                      {active && <Check className="h-3.5 w-3.5 flex-none text-primary-600 dark:text-primary-400" />}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-gray-500 dark:text-slate-400">{t.summary}</span>
                    {t.appHint && (
                      <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-slate-700/70 dark:text-slate-400">
                        <Plug className="h-2.5 w-2.5" /> {t.appHint}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <p className="text-xs leading-relaxed text-gray-500 dark:text-slate-400">{template.description}</p>

        {connectorUnavailable && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">Choose an app with Aokie access for this template, or select a different starting point.</p>}
      </form>
  );
  if (embedded) return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-slate-700/60 dark:bg-slate-900">
      <div className="border-b border-gray-100 bg-gradient-to-br from-primary-50/60 to-white p-5 dark:border-slate-800 dark:from-primary-500/5 dark:to-slate-900 sm:p-7">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-300">Flow setup</p>
        <h2 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white sm:text-2xl">Create a new flow</h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-600 dark:text-slate-400">Set up your flow here, then build it visually. Nothing runs until you test it or connect a trigger.</p>
      </div>
      {content}
      <div className="border-t border-gray-100 bg-gray-50/70 p-5 dark:border-slate-800 dark:bg-slate-800/30 sm:p-6">{footer}</div>
    </section>
  );
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!creating) onClose(); }} title="Create an automation"
      description="Choose a starting point. Then add steps, test the result and connect a trigger." size="xl" footer={footer}>
      {content}
    </Modal>
  );
}

function ScopeButton({ active, label, description, icon: Icon, onClick }: {
  active: boolean;
  label: string;
  description: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'group flex items-start gap-3 rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        active
          ? 'border-primary-400 bg-primary-50/70 ring-1 ring-primary-400/40 dark:border-primary-500/60 dark:bg-primary-500/10 dark:ring-primary-500/30'
          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors',
          active
            ? 'bg-primary-600 text-primary-foreground'
            : 'bg-gray-100 text-gray-500 group-hover:text-gray-700 dark:bg-slate-700 dark:text-slate-300 dark:group-hover:text-white',
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block break-words text-sm font-semibold', active ? 'text-primary-800 dark:text-primary-200' : 'text-gray-900 dark:text-white')}>
          {label}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-gray-500 dark:text-slate-400">{description}</span>
      </span>
      {active && <Check className="mt-1 h-3.5 w-3.5 flex-none text-primary-600 dark:text-primary-400" />}
    </button>
  );
}
