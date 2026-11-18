import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  Copy,
  Database,
  ExternalLink,
  GitBranch,
  LayoutPanelTop,
  Map,
  PencilRuler,
  Rocket,
  Settings,
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
import { copyToClipboard, formatRelativeTime } from '../../../lib/utils';
import { returnToState } from '../../../hooks/useReturnTo';
import { trackStudioSave } from '../studioSaveState';
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
  formsKnown = true,
  nativeTableCount = 0,
  formsById,
  roles,
  flows,
  blueprint,
  memberCount,
  memberCountKnown = true,
  aiAvailable = false,
  onReloadApp,
}: {
  app: App;
  appForms: AppForm[];
  formsKnown?: boolean;
  nativeTableCount?: number;
  formsById: Record<string, Form>;
  roles: AppRole[];
  flows: FlowDefinition[];
  blueprint: Blueprint | null;
  memberCount: number;
  /** False when the member fetch failed — the tile says "not loaded", never "0". */
  memberCountKnown?: boolean;
  aiAvailable?: boolean;
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
  // Set by Escape: the blur that follows saves nothing, and the draft it would read is still
  // the typed text, because clearing the draft takes effect only after the key event.
  const editCancelled = useRef(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [creatingDiagram, setCreatingDiagram] = useState(false);

  const published = app.status === 'published';
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
  const canStartForm = formsKnown && !appForms.length && !nativeTableCount;
  const summary = [`${appForms.length} ${appForms.length === 1 ? 'form' : 'forms'}`];
  if (nativeTableCount) summary.push(`${nativeTableCount} database ${nativeTableCount === 1 ? 'table' : 'tables'}`);
  if (relationCount) summary.push(`${relationCount} ${relationCount === 1 ? 'relationship' : 'relationships'}`);

  /** Save one identity key. Only the edited key is sent, so this can never revert
   *  a field another surface owns (the server writes present keys wholesale). */
  const saveField = async (key: 'name' | 'description', value: string, label: string) => {
    const ok = await trackStudioSave(label, () => updateApp(app.id, { [key]: value }), (saved) => !!saved);
    if (ok) await onReloadApp();
    return ok;
  };

  /** Whether Escape ended this edit: true once, for the blur Escape itself caused. */
  const takeCancelled = () => {
    const cancelled = editCancelled.current;
    editCancelled.current = false;
    return cancelled;
  };

  const commitName = async () => {
    const next = (nameDraft ?? '').trim();
    setNameDraft(null);
    if (takeCancelled() || !next || next === app.name) return;
    if (next.length < 2) {
      toast.error('Name too short', 'An app name needs at least two characters.');
      return;
    }
    await saveField('name', next, 'App name');
  };

  const commitDescription = async () => {
    const typed = descDraft;
    setDescDraft(null);
    // Unlike a name, a description may be cleared, so a box nobody typed in can't read as empty.
    if (takeCancelled() || typed === null) return;
    const next = typed.trim();
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
        `Help me plan the "${app.name}" app: suggest the forms, relationships, screens and automations it needs.`
    );
    setChatMinimized(false);
    setChatOpen(true);
  };

  return (
    <div className="space-y-4 @2xl/studio:space-y-5">
      {/* ── Identity: the studio's focal point, and the only editable copy of it ── */}
      <section className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="flex items-start gap-3 p-4 @2xl/studio:gap-5 @2xl/studio:p-6">
          <AppTile app={app} size="lg" className="size-10 @2xl/studio:size-14" />

          <div className="min-w-0 flex-1">
            <label htmlFor="studio-app-name" className="sr-only">App name</label>
            <input
              id="studio-app-name"
              value={nameDraft ?? app.name}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                if (e.key === 'Escape') { editCancelled.current = true; e.currentTarget.blur(); }
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
              onKeyDown={(e) => { if (e.key === 'Escape') { editCancelled.current = true; e.currentTarget.blur(); } }}
              rows={2}
              placeholder="Add a description for members."
              className="scrollbar-thin -mx-2 mt-1 w-[calc(100%+1rem)] min-w-0 resize-y rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm leading-5 text-gray-600 outline-none transition hover:border-gray-200 focus:border-primary-400 focus:bg-white focus:ring-2 focus:ring-primary-500/15 dark:text-slate-300 dark:hover:border-white/10 dark:focus:border-primary-500/50 dark:focus:bg-slate-950/60"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
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

      <section aria-labelledby="studio-app-contents" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/50 @2xl/studio:p-5">
        <h3 id="studio-app-contents" className="mb-3 text-sm font-semibold text-slate-900 dark:text-white">App contents</h3>
        <ul className="grid gap-2 @lg/studio:grid-cols-2 @4xl/studio:grid-cols-3">
          <SummaryLink icon={Database} label="Forms" detail={!formsKnown ? 'Forms not loaded' : canStartForm ? 'Add your first form' : summary.join(' · ')}
            to={`/apps/${app.id}/studio/data${canStartForm ? '?new=form' : ''}`} />
          <SummaryLink icon={LayoutPanelTop} label="Screens" detail={formsKnown ? `${appForms.length + 1} ${appForms.length === 0 ? 'screen' : 'screens'}` : 'Edit app screens'}
            to={`/apps/${app.id}/studio/screens`} />
          <SummaryLink icon={GitBranch} label="Automations" detail={flows.length
            ? `${flows.length} ${flows.length === 1 ? 'automation' : 'automations'} · ${activeFlows} running` : 'Add an automation'}
            to={`/apps/${app.id}/studio/automations`} />
          <SummaryLink icon={Users} label="Members" detail={`${memberCountKnown ? (memberCount <= 1 ? 'Only you' : `${memberCount} members`) : 'Members not loaded'} · ${roles.length} ${roles.length === 1 ? 'role' : 'roles'}`}
            to={`/apps/${app.id}/studio/access`} />
          <SummaryLink icon={Rocket} label="Publishing" detail={published ? (app.publishedVersion ? `Live · version ${app.publishedVersion}` : 'Live') : 'Review your draft'}
            to={`/apps/${app.id}/studio/publish`} />
        </ul>
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
                <span className="font-semibold">Apply changes</span> on the canvas to bring new forms,
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
              Describe the outcome and the copilot proposes forms, screens and flows. Every change is
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
              Connect an AI provider and the copilot can propose this app's forms, screens and flows
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

function SummaryLink({ icon: Icon, label, detail, to }: { icon: typeof Database; label: string; detail: string; to: string }) {
  return <li>
    <Link to={to} className="group flex h-full min-h-16 items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 hover:border-primary-400 hover:bg-primary-50/50 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:hover:bg-primary-500/10">
      <Icon className="size-4 shrink-0 text-primary-600 dark:text-primary-300" aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-900 dark:text-white">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-400">{detail}</span>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-slate-400 group-hover:text-primary-600" aria-hidden="true" />
    </Link>
  </li>;
}
