import { useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  LayoutPanelTop,
  Map,
  Play,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { cn } from '../../lib/utils';
import { returnToState } from '../../hooks/useReturnTo';
import { STUDIO_STEPS, type StudioStepId } from './studioSteps';
import type { App, AppForm, AppRole } from '../../types/app';
import type { Form } from '../../types/form';
import type { FlowDefinition } from '../../types/flows';

interface CommandItem {
  id: string;
  group: 'Actions' | 'Studio steps' | 'Data types' | 'Automations' | 'Roles';
  label: string;
  detail: string;
  keywords: string;
  icon: LucideIcon;
  action: () => void;
}

const STEP_ICONS: Record<StudioStepId, LucideIcon> = {
  plan: Map,
  data: Database,
  screens: LayoutPanelTop,
  automations: GitBranch,
  access: ShieldCheck,
  publish: Rocket,
};

const GROUP_ORDER: CommandItem['group'][] = ['Actions', 'Studio steps', 'Data types', 'Automations', 'Roles'];

/**
 * Current-app command palette. It keeps fast navigation local to the Studio:
 * steps, preview/publish actions and the app's real forms, flows and roles.
 */
export function StudioCommandPalette({
  app,
  appForms,
  formsById,
  flows,
  roles,
  activeStep,
  aiAvailable,
  onClose,
  onStepChange,
  onPreview,
  onPublish,
  onAskAi,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  flows: FlowDefinition[];
  roles: AppRole[];
  activeStep: StudioStepId;
  aiAvailable: boolean;
  onClose: () => void;
  onStepChange: (step: StudioStepId) => void;
  onPreview: () => void;
  onPublish: () => void;
  onAskAi: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const studioReturn = returnToState(`/apps/${app.id}/studio/${activeStep}`, 'App Studio');

  const items = useMemo<CommandItem[]>(() => {
    const actions: CommandItem[] = [
      {
        id: 'preview',
        group: 'Actions',
        label: 'Preview app',
        detail: 'Open the current draft as its owner',
        keywords: 'use app test play runtime cmd p',
        icon: Play,
        action: onPreview,
      },
      {
        id: 'publish',
        group: 'Actions',
        label: 'Review pending release',
        detail: 'Check readiness and review the next release',
        keywords: 'release live changes cmd shift p',
        icon: Rocket,
        action: onPublish,
      },
      {
        id: 'manage',
        group: 'Actions',
        label: 'Manage app',
        detail: 'Identity, services and lifecycle settings',
        keywords: 'settings configure archive delete',
        icon: Settings,
        action: () => navigate(`/apps/${app.id}/settings?tab=manage`, { state: studioReturn }),
      },
    ];
    if (aiAvailable) {
      actions.splice(2, 0, {
        id: 'ask-ai',
        group: 'Actions',
        label: 'Ask AI about this app',
        detail: 'Open the app-aware copilot',
        keywords: 'assistant help build chat',
        icon: Sparkles,
        action: onAskAi,
      });
    }

    const steps: CommandItem[] = STUDIO_STEPS.map((step, index) => ({
      id: `step-${step.id}`,
      group: 'Studio steps',
      label: step.label,
      detail: `${index + 1} of ${STUDIO_STEPS.length} · ${step.description}`,
      keywords: `${step.shortLabel} ${step.description} step ${index + 1}`,
      icon: STEP_ICONS[step.id],
      action: () => onStepChange(step.id),
    }));

    const dataTypes: CommandItem[] = appForms.map((attachment) => {
      const form = formsById[attachment.formId];
      const label = attachment.displayName || form?.title || 'Untitled';
      return {
        id: `form-${attachment.formId}`,
        group: 'Data types',
        label,
        detail: `${form?.fields.length ?? 0} fields · open in the form builder`,
        keywords: `${label} form fields data builder`,
        icon: FileText,
        action: () => navigate(`/builder/${attachment.formId}`, { state: studioReturn }),
      };
    });

    const automationItems: CommandItem[] = flows.map((flow) => ({
      id: `flow-${flow.id}`,
      group: 'Automations',
      label: flow.name,
      detail: `${flow.enabled ? 'Active' : 'Paused'} · open on the flow canvas`,
      keywords: `${flow.name} ${flow.slug} flow automation ${flow.enabled ? 'active enabled' : 'paused disabled'}`,
      icon: Workflow,
      action: () => navigate(`/flows?flow=${flow.id}`, { state: studioReturn }),
    }));

    const roleItems: CommandItem[] = roles.map((role) => ({
      id: `role-${role.id}`,
      group: 'Roles',
      label: role.name,
      detail: role.description || 'Review this role in Users & roles',
      keywords: `${role.name} permissions access users member`,
      icon: role.isSystem ? ShieldCheck : Bot,
      action: () => onStepChange('access'),
    }));

    return [...actions, ...steps, ...dataTypes, ...automationItems, ...roleItems];
  }, [
    aiAvailable,
    app.id,
    appForms,
    flows,
    formsById,
    navigate,
    onAskAi,
    onPreview,
    onPublish,
    onStepChange,
    roles,
    studioReturn,
  ]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = terms.length === 0
      ? items
      : items.filter((item) => {
          const haystack = `${item.label} ${item.detail} ${item.group} ${item.keywords}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });
    return matches.slice(0, 24);
  }, [items, query]);

  const run = (item: CommandItem) => {
    onClose();
    item.action();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && filtered[activeIndex]) {
      event.preventDefault();
      run(filtered[activeIndex]);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Search App Studio"
      description={`Jump anywhere in ${app.name}`}
      size="xl"
      showCloseButton={false}
    >
      <div className="p-3 sm:p-4">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Search steps, forms, flows, roles and actions…"
          aria-label="Search App Studio commands"
          leftIcon={<Search className="h-4 w-4" />}
          autoFocus
        />

        <div className="scrollbar-thin mt-3 max-h-[52dvh] overflow-y-auto" role="listbox" aria-label="App Studio commands">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center dark:border-white/10">
              <p className="text-sm font-semibold text-gray-700 dark:text-slate-200">No matches</p>
              <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Try a step name, form, automation or role.</p>
            </div>
          ) : (
            GROUP_ORDER.map((group) => {
              const groupItems = filtered.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <section key={group} className="mb-3 last:mb-0">
                  <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400 dark:text-slate-500">
                    {group}
                  </p>
                  <div className="space-y-1">
                    {groupItems.map((item) => {
                      const itemIndex = filtered.indexOf(item);
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={itemIndex === activeIndex}
                          onMouseEnter={() => setActiveIndex(itemIndex)}
                          onClick={() => run(item)}
                          className={cn(
                            'flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                            itemIndex === activeIndex
                              ? 'bg-primary-50 text-primary-800 ring-1 ring-inset ring-primary-200 dark:bg-primary-500/10 dark:text-primary-200 dark:ring-primary-500/20'
                              : 'text-gray-700 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-white/[0.04]'
                          )}
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-primary-600 shadow-sm ring-1 ring-gray-200 dark:bg-slate-800 dark:text-primary-300 dark:ring-white/10">
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-bold">{item.label}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-gray-400 dark:text-slate-500">{item.detail}</span>
                          </span>
                          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-gray-300 dark:text-slate-600" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-1 pt-3 text-[10px] text-gray-400 dark:border-white/[0.06] dark:text-slate-500">
          <span>↑↓ choose · Enter open · Esc close</span>
          <span>Shortcuts: Ctrl+P preview · Ctrl+Shift+P publish · Alt+1–6 steps</span>
        </div>
      </div>
    </Modal>
  );
}
