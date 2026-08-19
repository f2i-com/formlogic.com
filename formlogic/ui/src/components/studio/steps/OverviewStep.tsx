import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  Copy,
  Database,
  ExternalLink,
  GitBranch,
  LayoutPanelTop,
  Map,
  PencilRuler,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button } from '../../ui/Button';
import { AppTile } from '../../apps/AppTile';
import { IconPicker } from '../../ui/IconPicker';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { useUIStore } from '../../../stores/uiStore';
import { cn, copyToClipboard, formatRelativeTime } from '../../../lib/utils';
import { returnToState } from '../../../hooks/useReturnTo';
import { isDemoLocalId } from '../../../lib/demoLocal';
import { trackStudioSave } from '../studioSaveState';
import { versionLabel, type StudioStepId } from '../studioSteps';
import type { App, AppForm, AppRole } from '../../../types/app';
import type { Form } from '../../../types/form';
import type { FlowDefinition } from '../../../types/flows';
import type { Blueprint } from '../../../types/blueprints';

/**
 * Overview: the App Studio's home. It answers the three questions an owner has on
 * arriving — what is this app, what is in it, and is it live — and it is the only
 * place in the studio that can edit the app's own identity.
 *
 * It replaces the old Plan section in the first slot. Plan was a diagram tool that
 * sat permanently first in the nav, was empty for most apps, and described itself
 * as optional; its two tools live on here as cards. Meanwhile the studio could not
 * rename its own app, change its icon or see itself as a whole — those needed the
 * separate "manage" pages this section makes unnecessary.
 */
export function OverviewStep({
  app,
  appForms,
  formsById,
  roles,
  flows,
  blueprint,
  memberCount,
  memberCountKnown = true,
  aiAvailable = false,
  onStepChange,
  onReloadApp,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  roles: AppRole[];
  flows: FlowDefinition[];
  blueprint: Blueprint | null;
  memberCount: number;
  /** False when the member fetch failed — the tile says "not loaded", never "0". */
  memberCountKnown?: boolean;
  aiAvailable?: boolean;
  onStepChange: (step: StudioStepId) => void;
  onReloadApp: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const updateApp = useAppStore((s) => s.updateApp);
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const studioReturn = returnToState(`/apps/${app.id}/studio/plan`, 'App Studio');

  // `null` = not editing, so the field always shows the server's current value and
  // an edit landing from another surface can never be clobbered by a stale draft.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [creatingDiagram, setCreatingDiagram] = useState(false);

  const browserOnly = isDemoLocalId(app.id);
  const published = app.status === 'published';
  const live = versionLabel(app);
  const appUrl = `${window.location.origin}/app/${app.slug}`;

  const relationCount = useMemo(() => {
    let count = 0;
    for (const af of appForms) {
      const form = formsById[af.formId];
      if (form) count += form.fields.filter((f) => f.type === 'linked_record').length;
    }
    return count;
  }, [appForms, formsById]);

  const activeFlows = flows.filter((f) => f.enabled).length;

  /** Save one identity key. Only the edited key is sent, so this can never revert
   *  a field another surface owns (the server writes present keys wholesale). */
  const saveField = async (key: 'name' | 'description', value: string, label: string) => {
    const ok = await trackStudioSave(label, () => updateApp(app.id, { [key]: value }), (saved) => !!saved);
    if (ok) await onReloadApp();
    return ok;
  };

  const commitName = async () => {
    const next = (nameDraft ?? '').trim();
    setNameDraft(null);
    if (!next || next === app.name) return;
    if (next.length < 2) {
      toast.error('Name too short', 'An app name needs at least two characters.');
      return;
    }
    await saveField('name', next, 'App name');
  };

  const commitDescription = async () => {
    const next = (descDraft ?? '').trim();
    setDescDraft(null);
    if (next === (app.description ?? '').trim()) return;
    await saveField('description', next, 'App description');
  };

  const setIcon = async (icon: string | null) => {
    const current = useAppStore.getState().getApp(app.id)?.settings ?? app.settings;
    const ok = await trackStudioSave(
      'App icon',
      () => updateApp(app.id, { settings: { ...current, icon: icon ?? undefined } }),
      (saved) => !!saved
    );
    if (ok) await onReloadApp();
  };

  const copyLink = async () => {
    if (await copyToClipboard(appUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Copy failed', 'Select the link and copy it manually.');
    }
  };

  const startDiagram = async () => {
    if (creatingDiagram) return;
    setCreatingDiagram(true);
    const res = await api.createBlueprint({ name: `${app.name} plan`, appId: app.id });
    setCreatingDiagram(false);
    const id = res.data?.blueprint?.id;
    if (!id) {
      toast.error('Could not start a diagram', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    navigate(`/diagrams/${id}`, { state: studioReturn });
  };

  const askAi = () => {
    setChatSeed(
      prompt.trim() ||
        `Help me plan the "${app.name}" app: suggest the data types, relationships, screens and automations it needs.`
    );
    setChatMinimized(false);
    setChatOpen(true);
  };

  return (
    <div className="space-y-4 @2xl/studio:space-y-5">
      {/* ── Identity: the studio's focal point, and the only editable copy of it ── */}
      <section className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="flex flex-col gap-4 p-4 @2xl/studio:flex-row @2xl/studio:items-start @2xl/studio:gap-5 @2xl/studio:p-6">
          <div className="flex items-start gap-3 @2xl/studio:gap-4">
            <AppTile app={app} size="lg" />
            <div className="min-w-0 flex-1 @2xl/studio:hidden">
              <StatusPill published={published} live={live} browserOnly={browserOnly} />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <label htmlFor="studio-app-name" className="sr-only">App name</label>
            <input
              id="studio-app-name"
              value={nameDraft ?? app.name}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                if (e.key === 'Escape') { setNameDraft(null); e.currentTarget.blur(); }
              }}
              // Reads as a heading until you touch it; the border appears on hover
              // and focus so it is discoverably editable without looking like a form.
              className="-mx-2 w-[calc(100%+1rem)] min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold tracking-tight text-gray-900 outline-none transition hover:border-gray-200 focus:border-primary-400 focus:bg-white focus:ring-2 focus:ring-primary-500/15 dark:text-white dark:hover:border-white/10 dark:focus:border-primary-500/50 dark:focus:bg-slate-950/60 @2xl/studio:text-2xl"
            />
            <label htmlFor="studio-app-description" className="sr-only">What this app is for</label>
            <textarea
              id="studio-app-description"
              value={descDraft ?? app.description ?? ''}
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={() => void commitDescription()}
              onKeyDown={(e) => { if (e.key === 'Escape') { setDescDraft(null); e.currentTarget.blur(); } }}
              rows={2}
              placeholder="Say what this app is for — members see it, and the AI uses it when planning."
              className="scrollbar-thin -mx-2 mt-1 w-[calc(100%+1rem)] min-w-0 resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm leading-6 text-gray-600 outline-none transition hover:border-gray-200 focus:border-primary-400 focus:bg-white focus:ring-2 focus:ring-primary-500/15 max-sm:min-h-[5.5rem] dark:text-slate-300 dark:hover:border-white/10 dark:focus:border-primary-500/50 dark:focus:bg-slate-950/60"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="hidden @2xl/studio:inline-flex">
                <StatusPill published={published} live={live} browserOnly={browserOnly} />
              </span>
              <IconPicker value={app.settings?.icon} onChange={(icon) => void setIcon(icon)} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(`/apps/${app.id}/settings`, { state: studioReturn })}
                leftIcon={<Settings className="h-4 w-4" />}
              >
                App settings
              </Button>
            </div>
          </div>
        </div>

        {/* Address bar: where the app lives, one tap from copying or opening it. */}
        <div className="flex flex-col gap-2 border-t border-gray-200/80 bg-gray-50/70 p-3 dark:border-white/[0.06] dark:bg-white/[0.02] @xl/studio:flex-row @xl/studio:items-center @xl/studio:gap-3 @2xl/studio:px-6">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-500 dark:text-slate-400" title={appUrl}>
            {appUrl}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void copyLink()} leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/app/${app.slug}`, { state: studioReturn })}
              leftIcon={<ExternalLink className="h-4 w-4" />}
            >
              Open app
            </Button>
          </div>
        </div>
      </section>

      {/* ── What is in the app: every tile is a way into the section that owns it ── */}
      <section>
        <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">In this app</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 @xl/studio:grid-cols-3 @3xl/studio:grid-cols-5 @2xl/studio:gap-3">
          <StatTile
            icon={Database}
            value={String(appForms.length)}
            label={appForms.length === 1 ? 'data type' : 'data types'}
            detail={relationCount > 0 ? `${relationCount} ${relationCount === 1 ? 'relationship' : 'relationships'}` : 'The forms behind the app'}
            onClick={() => onStepChange('data')}
          />
          <StatTile
            icon={LayoutPanelTop}
            value={String(appForms.length + 1)}
            label="screens"
            detail="Home and one per data type"
            onClick={() => onStepChange('screens')}
          />
          <StatTile
            icon={GitBranch}
            value={String(flows.length)}
            label={flows.length === 1 ? 'automation' : 'automations'}
            detail={flows.length === 0 ? 'Nothing runs automatically yet' : `${activeFlows} running`}
            onClick={() => onStepChange('automations')}
          />
          <StatTile
            icon={ShieldCheck}
            value={String(roles.length)}
            label={roles.length === 1 ? 'role' : 'roles'}
            detail={roles.map((r) => r.name).slice(0, 2).join(', ') || 'Who can do what'}
            onClick={() => onStepChange('access')}
          />
          <StatTile
            icon={Users}
            value={memberCountKnown ? String(memberCount) : '—'}
            label={memberCount === 1 && memberCountKnown ? 'member' : 'members'}
            detail={memberCountKnown ? (memberCount <= 1 ? 'Only you so far' : 'People with access') : 'Not loaded'}
            onClick={() => onStepChange('access')}
          />
        </div>
      </section>

      {/* ── Planning tools: still here, no longer occupying the first nav slot ── */}
      <section className="grid gap-4 @3xl/studio:grid-cols-2 @2xl/studio:gap-5">
        <div className="flex flex-col rounded-2xl border border-gray-200/80 bg-white p-4 shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50 @2xl/studio:p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
              <Map className="h-4 w-4" />
            </span>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Diagram</h3>
          </div>
          {blueprint ? (
            <>
              <p className="mt-2 min-w-0 flex-1 text-xs leading-5 text-gray-500 dark:text-slate-400">
                <span className="font-semibold text-gray-700 dark:text-slate-200">{blueprint.name}</span> is linked to this
                app — revision {blueprint.semanticRevision}, updated {formatRelativeTime(blueprint.updatedAt)}. Use{' '}
                <span className="font-semibold">Apply changes</span> on the canvas to bring new data types,
                relationships, flows and roles into the app.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => navigate(`/diagrams/${blueprint.id}`, { state: studioReturn })} leftIcon={<PencilRuler className="h-4 w-4" />}>
                  Open diagram
                </Button>
                <Button variant="ghost" size="sm" onClick={() => navigate('/diagrams/all')}>All diagrams</Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 min-w-0 flex-1 text-xs leading-5 text-gray-500 dark:text-slate-400">
                Sketch the people, data and process on a canvas, then materialise it into real forms, flows
                and roles. Optional — you can build the app directly instead.
              </p>
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={() => void startDiagram()} isLoading={creatingDiagram} leftIcon={<PencilRuler className="h-4 w-4" />}>
                  Sketch a diagram
                </Button>
              </div>
            </>
          )}
        </div>

        {aiAvailable ? (
          <div className="flex flex-col rounded-2xl border border-primary-200/80 bg-gradient-to-br from-primary-50 to-white p-4 shadow-sm dark:border-primary-500/20 dark:from-primary-500/[0.09] dark:to-slate-900/60 @2xl/studio:p-5">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-primary-600 shadow-sm dark:bg-slate-900 dark:text-primary-400">
                <Sparkles className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Plan with AI</h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-slate-400">
              Describe the outcome and the copilot proposes data types, screens and flows. Every change is
              previewed before it is applied, and can be undone.
            </p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); askAi(); }
              }}
              rows={3}
              aria-label="Describe the app"
              placeholder="e.g. Customers submit requests, staff assign a technician, and customers get updates until the job is invoiced."
              className="scrollbar-thin mt-3 w-full flex-1 resize-none rounded-xl border border-primary-200 bg-white p-3 text-sm leading-6 text-gray-700 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-500/15 dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-200"
            />
            <Button className="mt-3 w-full" onClick={askAi} leftIcon={<Sparkles className="h-4 w-4" />}>
              Ask the AI to plan this
            </Button>
          </div>
        ) : (
          <div className="flex flex-col justify-center rounded-2xl border border-dashed border-gray-300 p-4 dark:border-white/15 @2xl/studio:p-5">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-400 dark:bg-white/[0.05] dark:text-slate-500">
                <Sparkles className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Plan with AI</h3>
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-slate-400">
              Connect an AI provider and the copilot can propose this app's data types, screens and flows
              from a plain description.
            </p>
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => navigate('/connect-ai')}>Connect an AI</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Live/Draft state in one pill — the studio's most important fact, at every width. */
function StatusPill({ published, live, browserOnly }: { published: boolean; live: string | null; browserOnly: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
          published
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200'
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', published ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden="true" />
        {published ? `Live${live ? ` · ${live}` : ''}` : 'Draft — only you can see it'}
      </span>
      {browserOnly && (
        <span className="inline-flex items-center rounded-full bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">
          Saved in this browser
        </span>
      )}
    </span>
  );
}

/** One fact about the app that doubles as the way into the section that owns it. */
function StatTile({
  icon: Icon,
  value,
  label,
  detail,
  onClick,
}: {
  icon: typeof Database;
  value: string;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-20 cursor-pointer flex-col justify-between rounded-xl border border-gray-200/80 bg-white p-3 text-left shadow-sm transition hover:border-primary-300 hover:shadow-md dark:border-white/[0.06] dark:bg-slate-900/50 dark:hover:border-primary-500/30"
    >
      <Icon className="h-4 w-4 text-gray-400 transition group-hover:text-primary-500 dark:text-slate-500" aria-hidden="true" />
      <span className="mt-2 block min-w-0">
        <span className="block text-lg font-semibold leading-tight text-gray-900 dark:text-white">
          {value} <span className="text-xs font-medium text-gray-500 dark:text-slate-400">{label}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-gray-500 dark:text-slate-400" title={detail}>{detail}</span>
      </span>
    </button>
  );
}
