import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Database, GitFork, LayoutPanelTop, Map, PencilRuler, Share2, Sparkles } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { formatRelativeTime } from '../../../lib/utils';
import type { App, AppForm, AppRole } from '../../../types/app';
import type { Form } from '../../../types/form';
import type { Blueprint } from '../../../types/blueprints';

/**
 * Studio step 1 — Plan (optional): the app's linked diagram plus AI planning.
 * The diagram is the real Blueprints surface (materialise / apply-changes live
 * on the canvas); "Plan with AI" seeds the site chat, which can sketch and
 * build through its tool set.
 */
export function PlanStep({
  app,
  blueprint,
  appForms,
  formsById,
  roles,
  onSkip,
}: {
  app: App;
  blueprint: Blueprint | null;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  roles: AppRole[];
  onSkip: () => void;
}) {
  const navigate = useNavigate();
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);

  const relationCount = useMemo(() => {
    let count = 0;
    for (const af of appForms) {
      const form = formsById[af.formId];
      if (!form) continue;
      count += form.fields.filter((f) => f.type === 'linked_record').length;
    }
    return count;
  }, [appForms, formsById]);

  const startDiagram = async () => {
    if (creating) return;
    setCreating(true);
    const res = await api.createBlueprint({ name: `${app.name} plan`, appId: app.id });
    setCreating(false);
    const id = res.data?.blueprint?.id;
    if (!id) {
      toast.error('Could not start a diagram', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    navigate(`/diagrams/${id}`);
  };

  const askAi = () => {
    const text = prompt.trim() || `Help me plan the "${app.name}" app: suggest the data types, relationships, screens and automations it needs.`;
    setChatSeed(text);
    setChatMinimized(false);
    setChatOpen(true);
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,.7fr)]">
      {/* Diagram card */}
      <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-200/80 dark:border-white/[0.06] p-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">App blueprint</h3>
              <Badge size="sm">Optional</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500 dark:text-slate-400">
              Sketch the people, data and process on a diagram. FormLogic materialises an approved
              plan into connected forms, flows and roles — and keeps the diagram linked to this app.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onSkip}>
            Skip planning
          </Button>
        </div>

        {blueprint ? (
          <div className="p-5">
            <div className="flex items-start gap-3 rounded-xl border border-primary-200/70 dark:border-primary-500/20 bg-primary-50/60 dark:bg-primary-500/[0.07] p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-primary-foreground">
                <Map className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{blueprint.name}</p>
                  <Badge variant="success" size="sm">Linked to this app</Badge>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                  Revision {blueprint.semanticRevision} · updated {formatRelativeTime(blueprint.updatedAt)}
                </p>
                <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-slate-400">
                  Edit the diagram and use <span className="font-semibold">Apply changes</span> on the canvas to
                  bring new data types, relationships, flows and roles into this app.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => navigate(`/diagrams/${blueprint.id}`)} leftIcon={<PencilRuler className="h-4 w-4" />}>
                Open diagram
              </Button>
              <Button variant="secondary" onClick={() => navigate('/diagrams/all')}>
                All diagrams
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400">
              <Map className="h-6 w-6" />
            </span>
            <p className="mt-4 text-sm font-semibold text-gray-900 dark:text-white">No diagram linked yet</p>
            <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
              Start a canvas for this app — place forms, actors and relationships, then materialise
              them into real building blocks.
            </p>
            <Button className="mt-4" onClick={startDiagram} isLoading={creating} leftIcon={<PencilRuler className="h-4 w-4" />}>
              Sketch a diagram
            </Button>
          </div>
        )}
      </section>

      <div className="space-y-5">
        {/* Plan with AI */}
        <section className="rounded-xl border border-primary-200/80 dark:border-primary-500/20 bg-gradient-to-br from-primary-50 to-white dark:from-primary-500/[0.09] dark:to-slate-900/60 p-5 shadow-sm">
          <div className="flex items-center gap-2 text-primary-700 dark:text-primary-300">
            <Sparkles className="h-4.5 w-4.5" />
            <h3 className="text-sm font-semibold">Plan with AI</h3>
          </div>
          <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-slate-400">
            Describe the outcome and the AI copilot proposes data types, screens and flows — every
            change is previewed before it is applied, and can be undone.
          </p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            aria-label="Describe the app"
            placeholder={`e.g. Customers submit requests, staff assign a technician, and customers get updates until the job is invoiced.`}
            className="mt-4 w-full resize-none rounded-xl border border-primary-200 dark:border-white/10 bg-white dark:bg-slate-950/60 p-3 text-sm leading-6 text-gray-700 dark:text-slate-200 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-500/15"
          />
          <Button className="mt-3 w-full" onClick={askAi} leftIcon={<Sparkles className="h-4 w-4" />}>
            Ask the AI to plan this
          </Button>
        </section>

        {/* What this app already has */}
        <section className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Already in place</h3>
            {appForms.length > 0 && (
              <Badge variant="success" size="sm">
                <Check className="h-3 w-3 mr-1 inline" /> Ready
              </Badge>
            )}
          </div>
          <div className="mt-4 space-y-2.5">
            <MappingLine icon={Database} label={`${appForms.length} data ${appForms.length === 1 ? 'type' : 'types'}`} detail="Forms attached to this app" done={appForms.length > 0} />
            <MappingLine icon={GitFork} label={`${relationCount} ${relationCount === 1 ? 'relationship' : 'relationships'}`} detail="Linked-record fields" done={relationCount > 0} />
            <MappingLine icon={LayoutPanelTop} label="Generated screens" detail="Home, lists and record views" done={appForms.length > 0} />
            <MappingLine icon={Share2} label={`${roles.length} ${roles.length === 1 ? 'role' : 'roles'}`} detail={roles.map((r) => r.name).slice(0, 3).join(', ') || 'Created with the app'} done={roles.length > 0} />
          </div>
          <Button variant="secondary" className="mt-4 w-full" onClick={onSkip}>
            Continue to Data & forms <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </section>
      </div>
    </div>
  );
}

function MappingLine({ icon: Icon, label, detail, done }: { icon: typeof Database; label: string; detail: string; done: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-gray-50 dark:bg-white/[0.035] px-3 py-2.5">
      <Icon className="h-4 w-4 text-primary-600 dark:text-primary-400" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-gray-800 dark:text-slate-200">{label}</p>
        <p className="mt-0.5 text-[11px] text-gray-400 dark:text-slate-500 truncate">{detail}</p>
      </div>
      {done && <Check className="h-3.5 w-3.5 text-emerald-500" />}
    </div>
  );
}
