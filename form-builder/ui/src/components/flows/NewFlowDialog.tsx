// FormLogic Flows workspace — "New flow" dialog.
//
// Picks a starter template (blank / caller lookup / call summary / sms auto-draft — ported from
// the Aokie Receptionist pack) and a name, then creates a WORKSPACE flow. The created flow's
// graph renders as a proper canvas in the editor. Keyboard-accessible (Modal traps focus + closes
// on Esc; the name field submits on Enter). Templates that only make sense with a connector app
// show a subtle "works with" hint.
import { useState } from 'react';
import { Check, ClipboardList, FileText, MessageSquare, PhoneIncoming, Plug, type LucideIcon } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { FLOW_STARTER_TEMPLATES, buildFlowCreateInput, type FlowStarterTemplate } from './starterTemplates';

/** Icon per starter template (keeps lucide out of the data module). */
const TEMPLATE_ICON: Record<string, LucideIcon> = {
  blank: FileText,
  'caller-lookup': PhoneIncoming,
  'call-summary': ClipboardList,
  'sms-auto-draft': MessageSquare,
};

export function NewFlowDialog({ isOpen, onClose, onCreate, creating }: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; slug: string; description: string; template: FlowStarterTemplate }) => void;
  creating: boolean;
}) {
  const [templateId, setTemplateId] = useState<string>('blank');
  const [name, setName] = useState<string>(FLOW_STARTER_TEMPLATES[0].name);
  // Once the author edits the name, template switches stop overwriting it.
  const [nameEdited, setNameEdited] = useState(false);

  const template = FLOW_STARTER_TEMPLATES.find((t) => t.id === templateId) ?? FLOW_STARTER_TEMPLATES[0];

  const pickTemplate = (t: FlowStarterTemplate) => {
    setTemplateId(t.id);
    if (!nameEdited) setName(t.name);
  };

  const submit = () => {
    if (creating) return;
    onCreate(buildFlowCreateInput(templateId, name));
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
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-gray-600 dark:text-slate-300">Start from</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {FLOW_STARTER_TEMPLATES.map((t) => {
              const active = t.id === templateId;
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

        <div className="flex justify-end gap-2 border-t border-gray-200/70 dark:border-slate-800 pt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={creating}>Cancel</Button>
          <Button type="submit" isLoading={creating} disabled={creating}>Create flow</Button>
        </div>
      </form>
    </Modal>
  );
}
