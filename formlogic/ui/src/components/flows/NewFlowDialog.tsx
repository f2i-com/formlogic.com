// FormLogic Flows workspace - "New flow" dialog.
//
// Picks a starter template, creation scope (Workspace or an installed app), and name. Templates
// that rely on an Aokie connector can auto-target the only installed app that grants Aokie.
import { useMemo, useState } from 'react';
import { Check, ClipboardList, FileText, MessageSquare, PhoneIncoming, Plug, Workflow, type LucideIcon } from 'lucide-react';
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
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; slug: string; description: string; template: FlowStarterTemplate; appId: string | null }) => void;
  creating: boolean;
  apps?: AppListItem[];
  initialTemplate?: FlowStarterTemplate | null;
}) {
  const availableConnectorIds = useMemo(() => connectorIdsForApps(apps), [apps]);
  const visibleTemplates = useMemo(() => flowStarterTemplatesForConnectors(availableConnectorIds), [availableConnectorIds]);
  const initial = visibleTemplates.find((candidate) => candidate.id === initialTemplate?.id) ?? visibleTemplates[0] ?? FLOW_STARTER_TEMPLATES[0];
  const [templateId, setTemplateId] = useState<string>(initial.id);
  const [name, setName] = useState<string>(initial.name);
  const [scopeAppId, setScopeAppId] = useState<string | null>(() => recommendedScope(initial, apps));
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
      setScopeAppId(recommendedScope(nextTemplate, apps));
    }
  }

  const pickTemplate = (t: FlowStarterTemplate) => {
    setTemplateId(t.id);
    if (!nameEdited) setName(t.name);
    if (!scopeEdited) setScopeAppId(recommendedScope(t, apps));
  };

  const submit = () => {
    if (creating) return;
    onCreate({ ...buildFlowCreateInput(template.id, name), appId: scopeAppId });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New flow"
      description="Start from a blank canvas or a ready-made template."
      size="lg"
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="space-y-5 p-4 sm:p-6"
      >
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-slate-300" htmlFor="new-flow-name">
            Flow name
          </label>
          <input
            id="new-flow-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
            placeholder={template.name}
            autoComplete="off"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        </div>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-gray-600 dark:text-slate-300">Create in</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <ScopeButton
              active={scopeAppId === null}
              label="Workspace"
              description="Runs when one of your forms is submitted, or on demand. Can be reused by any app."
              icon={Workflow}
              onClick={() => { setScopeAppId(null); setScopeEdited(true); }}
            />
            {apps.map((app) => {
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
            You can&apos;t move an automation between these later — pick the app if you want its events.
          </p>
          {autoScopeAppId && !scopeEdited && scopeAppId === autoScopeAppId && (
            <p className="mt-2 text-[11px] text-primary-600 dark:text-primary-300">
              Aokie template detected - the only app with Aokie connector access is selected.
            </p>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-gray-600 dark:text-slate-300">Start from</legend>
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
                      <span className={cn('block truncate text-sm font-semibold', active ? 'text-primary-800 dark:text-primary-200' : 'text-gray-900 dark:text-white')}>
                        {t.name}
                      </span>
                      {active && <Check className="h-3.5 w-3.5 flex-none text-primary-600 dark:text-primary-400" />}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">{t.summary}</span>
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

        <div className="flex justify-end gap-2 border-t border-gray-200/70 pt-4 dark:border-slate-800">
          <Button type="button" variant="ghost" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button type="submit" isLoading={creating} disabled={creating}>Create flow</Button>
        </div>
      </form>
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
        <span className={cn('block truncate text-sm font-semibold', active ? 'text-primary-800 dark:text-primary-200' : 'text-gray-900 dark:text-white')}>
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">{description}</span>
      </span>
      {active && <Check className="mt-1 h-3.5 w-3.5 flex-none text-primary-600 dark:text-primary-400" />}
    </button>
  );
}
