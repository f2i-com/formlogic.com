import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  ChevronRight,
  CircleSlash,
  Code2,
  ExternalLink,
  EyeOff,
  FileText,
  GitBranch,
  GitCompareArrows,
  Home,
  LayoutDashboard,
  List,
  Loader2,
  LockKeyhole,
  Monitor,
  PencilRuler,
  Plus,
  Settings2,
  Smartphone,
  Sparkles,
  Table2,
  Tablet,
  WandSparkles,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { Switch } from '../../ui/Switch';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { useUIStore } from '../../../stores/uiStore';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { readableForegroundColor } from '../../../lib/color';
import { returnToState } from '../../../hooks/useReturnTo';
import { interleaveMenu, menuForms, menuLinks, roleCanSeeForm } from '../../app-runtime/appMenu';
import { DynamicIcon } from '../../ui/DynamicIcon';
import { trackStudioSave } from '../studioSaveState';
import { statusLabel } from '../../../lib/appStatus';
import { AppLookPanel } from './AppLookPanel';
import type { UnpublishedChanges } from '../studioSteps';
import type { App, AppForm, AppRole, AppRuntimeForm, PermissionAction } from '../../../types/app';
import type { CustomScreen, Form } from '../../../types/form';

type ScreenSelection = { kind: 'home' } | { kind: 'form'; formId: string };

/**
 * The four states an attached form can be in, in the app's own words. The same four
 * states were previously spelled differently in two places — "Shown/Unlisted/
 * Data-only/Off" on the Forms manager page and a single "Show in app navigation"
 * switch here — and two of them could only be reached from the other page.
 */
type NavStateId = 'listed' | 'unlisted' | 'data-only' | 'off';

const NAV_STATES: Array<{ id: NavStateId; label: string; detail: string; icon: typeof Home }> = [
  { id: 'listed', label: 'In the app menu', detail: 'Members can open it from anywhere', icon: List },
  { id: 'unlisted', label: 'Unlisted', detail: 'Reachable from other screens and by link, but not in the menu', icon: EyeOff },
  { id: 'data-only', label: 'Data only', detail: 'Stores records but renders no screens', icon: Table2 },
  { id: 'off', label: 'Not in this app', detail: 'Withdrawn from the app entirely — records are kept', icon: CircleSlash },
];
type HomeKind = 'sdk' | 'code' | 'dashboard' | 'default';
type PreviewNavItem = { key: string; label: string; icon: string | null; active: boolean };

/**
 * Which screen the runtime actually serves for a custom-screen slot — mirrors
 * AppHomeScreen / AppFormView. `enabled` matters: a saved-but-switched-off screen
 * is not what members get, and calling it "Custom" hid exactly that.
 */
function resolveHomeKind(cs: CustomScreen | null | undefined): HomeKind {
  if (!cs) return 'default';
  if (cs.enabled && cs.kind === 'sdk' && cs.sdkScreen?.screenId) return 'sdk';
  if (cs.enabled && cs.kind !== 'dashboard' && (cs.html || cs.js || cs.ts || cs.files?.length)) return 'code';
  // AppDashboardHome falls back to the built-in pulse when a dashboard has no widgets,
  // and it renders a `kind: 'dashboard'` screen regardless of `enabled`.
  if (cs.kind === 'dashboard' && (cs.dashboard?.widgets?.length ?? 0) > 0) return 'dashboard';
  return 'default';
}

/**
 * A FORM's section screen has different rules from the home: AppFormView requires
 * `enabled` for every kind, including dashboards. Sharing one resolver labelled a
 * disabled pack dashboard "Widget dashboard" while the runtime served the plain form.
 */
function resolveFormScreenKind(cs: CustomScreen | null | undefined): HomeKind {
  if (!cs?.enabled) return 'default';
  if (cs.kind === 'sdk' && cs.sdkScreen?.screenId) return 'sdk';
  if (cs.kind === 'dashboard') return cs.dashboard ? 'dashboard' : 'default';
  if (cs.html || cs.js || cs.ts || cs.files?.length) return 'code';
  return 'default';
}

const SCREEN_KIND_LABEL: Record<HomeKind, string> = {
  sdk: 'Built-in screen',
  code: 'Custom code screen',
  dashboard: 'Widget dashboard',
  default: 'Generated',
};

/**
 * Screens: the app home plus the generated per-form screens, with a preview that
 * reads the SAME navigation and permission rules as the runtime, and the real
 * visibility / landing controls beside it.
 */
export function ScreensStep({
  app,
  appForms,
  formsById,
  roles,
  changes,
  onReloadApp,
  onReloadForms,
  onOpenPublish,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  roles: AppRole[];
  changes: UnpublishedChanges;
  onReloadApp: () => Promise<void>;
  onReloadForms: () => Promise<void>;
  onOpenPublish: () => void;
}) {
  const navigate = useNavigate();
  // The builder / screen studios return here when opened from this section.
  const studioReturn = returnToState(`/apps/${app.id}/studio/screens`, 'App Studio');
  const updateApp = useAppStore((s) => s.updateApp);
  const [selection, setSelection] = useState<ScreenSelection>({ kind: 'home' });
  // A phone user's first sight of their app should not be a 520px desktop mock
  // inside a horizontal scroller. Lazy initialiser, so an explicit later choice
  // wins and no effect re-derives it. (uiStore defaults isMobile:false, so jsdom
  // keeps the desktop default.)
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>(
    () => (useUIStore.getState().isMobile ? 'mobile' : 'desktop')
  );
  const [previewData, setPreviewData] = useState<'sample' | 'real'>('sample');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [fetchedPerms, setFetchedPerms] = useState<{
    roleId: string;
    perms: Array<{ formId: string | null; permission: PermissionAction }> | null;
    error: string | null;
  } | null>(null);
  const [recordState, setRecordState] = useState<{
    formId: string;
    records: Array<{ id: string; answers: Record<string, unknown>; submittedAt: string }>;
    error: string | null;
  } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedRole = roles.find((r) => r.id === roleId) ?? roles.find((r) => r.name === 'Owner') ?? roles[0] ?? null;
  const ownerLike = !selectedRole || selectedRole.name === 'Owner';
  const selectedRoleId = selectedRole?.id ?? null;
  const hideNav = (app.settings as { hideNav?: boolean } | undefined)?.hideNav === true;

  useEffect(() => {
    if (!selectedRoleId || ownerLike) return;
    let cancelled = false;
    api.getAppRolePermissions(app.id, selectedRoleId).then(
      (res) => {
        if (cancelled) return;
        // A dropped request is NOT "this role can see nothing" — encoding it that way
        // sent owners off to rewrite a permission matrix that was already correct.
        setFetchedPerms({
          roleId: selectedRoleId,
          perms: res.error ? null : ((res.data?.permissions ?? []) as Array<{ formId: string | null; permission: PermissionAction }>)
            .map((p) => ({ formId: p.formId, permission: p.permission })),
          error: res.error ? (typeof res.error === 'string' ? res.error : 'Could not read this role.') : null,
        });
      },
      () => {
        if (!cancelled) setFetchedPerms({ roleId: selectedRoleId, perms: null, error: 'Could not read this role.' });
      }
    );
    return () => { cancelled = true; };
  }, [app.id, selectedRoleId, ownerLike]);

  // Applicable only when the fetch matches the current role (derived — never reset in an effect).
  const currentPerms = !ownerLike && fetchedPerms?.roleId === selectedRoleId ? fetchedPerms : null;
  const rolePerms = currentPerms?.perms ?? null;
  const permsError = currentPerms?.error ?? null;
  /** True when the previewed role's real permissions are known and applicable. */
  const roleFiltered = !ownerLike && rolePerms !== null;

  const canSee = useMemo(
    () => (formId: string) => !roleFiltered || roleCanSeeForm(rolePerms!, formId),
    [roleFiltered, rolePerms]
  );

  /**
   * The runtime's form list, reproduced: attachments the server would withhold
   * (`isVisible: false`) or the role cannot reach never reach the menu at all.
   */
  const runtimeForms = useMemo<AppRuntimeForm[]>(
    () =>
      appForms
        .filter((af) => af.isVisible !== false && canSee(af.formId))
        .map((af) => {
          const settings = (af.settings ?? {}) as { hidden?: boolean; menuHidden?: boolean };
          return {
            formId: af.formId,
            displayName: af.displayName || formsById[af.formId]?.title || 'Untitled',
            hidden: settings.hidden === true,
            menuHidden: settings.menuHidden === true,
            fields: [],
            settings: {},
          } as AppRuntimeForm;
        }),
    [appForms, formsById, canSee]
  );

  const showReports = (app.reports?.length ?? 0) > 0 || ownerLike;

  /**
   * Menu entries composed with the SHELL's own helpers, so the preview can't drift.
   * `formsOnly` is kept separate from the interleaved menu: custom nav links belong in
   * the sidebar, but counting them as data types (or offering "New company handbook"
   * as a quick action) invents content the app does not have.
   */
  const previewNav = useMemo<{ menu: PreviewNavItem[]; formsOnly: PreviewNavItem[]; data: PreviewNavItem[] }>(() => {
    const visibleForms = menuForms(runtimeForms);
    const navigableIds = new Set(runtimeForms.filter((f) => f.hidden !== true).map((f) => f.formId));
    const links = menuLinks(app.navConfig, navigableIds);
    const formsOnly: PreviewNavItem[] = visibleForms.map((f) => ({
      key: f.formId,
      label: f.displayName,
      icon: null,
      active: selection.kind === 'form' && selection.formId === f.formId,
    }));
    const menu = interleaveMenu(
      formsOnly,
      links.map((l) => ({ key: `link:${l.key}`, label: l.label, icon: l.icon, active: false, position: l.position }))
    ).map((e) => e as PreviewNavItem);
    return {
      menu,
      formsOnly,
      data: [
        { key: 'records', label: 'Records', icon: null, active: false },
        ...(showReports ? [{ key: 'reports', label: 'Reports', icon: null, active: false }] : []),
      ],
    };
  }, [runtimeForms, app.navConfig, selection, showReports]);

  const totalRecords = useMemo(
    () => appForms.reduce((sum, af) => sum + (formsById[af.formId]?.responseCount ?? 0), 0),
    [appForms, formsById]
  );

  // Menu items the previewed role can SEE but cannot use. Only reported when the
  // role's permissions were actually read — a failed fetch must not raise an alarm.
  const inaccessibleNavNames = useMemo(() => {
    if (!roleFiltered) return [];
    return appForms
      .filter((af) => {
        const settings = (af.settings ?? {}) as { hidden?: boolean; menuHidden?: boolean };
        if (settings.hidden === true || settings.menuHidden === true || af.isVisible === false) return false;
        return !roleCanSeeForm(rolePerms!, af.formId);
      })
      .map((af) => af.displayName || formsById[af.formId]?.title || 'Untitled');
  }, [appForms, roleFiltered, rolePerms, formsById]);

  const selectedForm = selection.kind === 'form' ? formsById[selection.formId] ?? null : null;
  const selectedAttachment = selection.kind === 'form' ? appForms.find((af) => af.formId === selection.formId) ?? null : null;
  const selectedFormId = selection.kind === 'form' ? selection.formId : null;
  const selectedRoleCanView = selection.kind !== 'form' || canSee(selection.formId);

  useEffect(() => {
    if (previewData !== 'real' || !selectedFormId) return;
    let cancelled = false;
    api.getResponses(selectedFormId, { limit: 3 }).then(
      (res) => {
        if (cancelled) return;
        setRecordState({
          formId: selectedFormId,
          records: (res.data?.responses ?? []).map((record) => ({
            id: record.id,
            answers: record.answers,
            submittedAt: record.submittedAt,
          })),
          error: res.error ? (typeof res.error === 'string' ? res.error : 'Could not load records.') : null,
        });
      },
      () => {
        if (!cancelled) setRecordState({ formId: selectedFormId, records: [], error: 'Could not load records.' });
      }
    );
    return () => { cancelled = true; };
  }, [previewData, selectedFormId]);

  const previewRecordsLoading = previewData === 'real'
    && !!selectedFormId
    && recordState?.formId !== selectedFormId;
  const previewRecords = recordState?.formId === selectedFormId ? recordState.records : [];
  const previewRecordsError = recordState?.formId === selectedFormId ? recordState.error : null;

  const homeKind = useMemo(() => resolveHomeKind(app.customScreen), [app.customScreen]);
  const selectedScreenKind = selection.kind === 'form'
    ? resolveFormScreenKind(formsById[selection.formId]?.customScreen)
    : homeKind;
  const activeScreenKind = selection.kind === 'home' ? homeKind : selectedScreenKind;

  /**
   * Landing screen. Undo re-reads the CURRENT settings and swaps only landingPage:
   * replaying a whole settings snapshot reverted whatever else had been saved in the
   * meantime (sign-up settings, a theme change, a chat tool's write).
   */
  const setLanding = async (landingPage: string) => {
    const previous = (app.settings as { landingPage?: string } | undefined)?.landingPage ?? 'dashboard';
    const write = async (value: string) => {
      const current = useAppStore.getState().getApp(app.id)?.settings ?? app.settings;
      const saved = await updateApp(app.id, { settings: { ...current, landingPage: value } });
      if (saved) await onReloadApp();
      return saved;
    };
    setBusy(true);
    const ok = await trackStudioSave('Landing screen', () => write(landingPage), (saved) => !!saved);
    setBusy(false);
    if (ok && previous !== landingPage) {
      toast.undo('Landing screen updated', () => {
        void trackStudioSave('Landing screen', () => write(previous), (saved) => !!saved);
      });
    }
  };

  /**
   * Write one of the four attachment states. Off (`isVisible: false`) is a genuinely
   * different thing from hidden-from-the-menu — it withdraws the form from the app —
   * so it is an explicit choice here rather than a switch position you could reach by
   * accident, and it is the only one that changes `isVisible`.
   */
  const setNavState = async (af: AppForm, next: NavStateId) => {
    if (attachmentState(af) === next) return;
    setBusy(true);
    const settings = { ...(af.settings ?? {}) } as Record<string, unknown>;
    delete settings.menuHidden;
    delete settings.hidden;
    if (next === 'unlisted') settings.menuHidden = true;
    if (next === 'data-only') settings.hidden = true;
    const name = af.displayName || formsById[af.formId]?.title || 'Screen';
    const previous = attachmentState(af);
    const res = await trackStudioSave(
      `${name} placement`,
      async () => {
        const result = await api.updateAppForm(app.id, af.formId, {
          settings,
          isVisible: next !== 'off',
        });
        if (!result.error) await onReloadForms();
        return result;
      },
      (result) => !result.error
    );
    setBusy(false);
    if (res.error) {
      toast.error('Could not update where this appears', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    toast.undo(`${name}: ${NAV_STATES.find((n) => n.id === next)?.label ?? next}`, () => {
      void setNavState({ ...af }, previous);
    });
  };

  const customiseScreen = () => {
    if (selection.kind === 'form') {
      navigate(`/forms/${selection.formId}/screen/edit`, { state: studioReturn });
      return;
    }
    if (homeKind === 'dashboard') {
      // Widget dashboards are edited in the live app (owner "Edit dashboard").
      window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer');
    } else {
      navigate(`/apps/${app.id}/home/edit`, { state: studioReturn });
    }
  };

  const attachmentState = (af: AppForm | null) => {
    const settings = (af?.settings ?? {}) as { hidden?: boolean; menuHidden?: boolean };
    if (af?.isVisible === false) return 'off' as const;
    if (settings.hidden === true) return 'data-only' as const;
    if (settings.menuHidden === true) return 'unlisted' as const;
    return 'listed' as const;
  };

  return (
    <div className="grid gap-4 @3xl/studio:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] @5xl/studio:grid-cols-[minmax(0,19.5rem)_minmax(0,1fr)]">
      {/* Screens + their settings share one rail, so the controls for the selected
          screen are never a preview-height below the fold at laptop widths. In the
          middle band they sit side by side rather than as one tall stacked column.
          Below @3xl the column goes LAST: stacked, the rail put the screen list, the
          settings card and the appearance panel all above the preview, so the point
          of the section sat about two screens down. (PublishStep uses the same
          order-first/order-none idiom.) */}
      <div className="order-last grid gap-4 @xl/studio:grid-cols-2 @3xl/studio:order-none @3xl/studio:grid-cols-1 @3xl/studio:content-start">
        <section className="overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
          <div className="border-b border-gray-200/80 p-4 dark:border-white/[0.06]">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">App screens</h3>
          </div>
          <div className="scrollbar-thin flex snap-x gap-1.5 overflow-x-auto p-2.5 @xl/studio:block @xl/studio:max-h-[340px] @xl/studio:space-y-1 @xl/studio:overflow-x-visible @xl/studio:overflow-y-auto">
            <ScreenItem
              icon={Home}
              label="App home"
              status={SCREEN_KIND_LABEL[homeKind]}
              custom={homeKind !== 'default'}
              selected={selection.kind === 'home'}
              onClick={() => setSelection({ kind: 'home' })}
            />
            {appForms.map((af) => {
              const state = attachmentState(af);
              const kind = resolveFormScreenKind(formsById[af.formId]?.customScreen);
              return (
                <ScreenItem
                  key={af.formId}
                  icon={state === 'data-only' || state === 'off' ? Table2 : FileText}
                  label={af.displayName || formsById[af.formId]?.title || 'Untitled'}
                  status={
                    state === 'off' ? 'Excluded from the app'
                      : state === 'data-only' ? 'Data only — no screens'
                        : SCREEN_KIND_LABEL[kind]
                  }
                  custom={state === 'listed' && kind !== 'default'}
                  selected={selection.kind === 'form' && selection.formId === af.formId}
                  onClick={() => setSelection({ kind: 'form', formId: af.formId })}
                />
              );
            })}
            {appForms.length === 0 && (
              <p className="px-3 py-4 text-xs text-gray-500 dark:text-slate-400">
                Screens are generated from your data types — add one in Data & forms first.
              </p>
            )}
            <button
              type="button"
              onClick={() => navigate(`/apps/${app.id}/studio/data`)}
              className="flex min-h-11 w-auto shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-dashed border-gray-300 px-3 text-xs font-semibold text-gray-600 hover:border-primary-400 hover:text-primary-700 @xl/studio:w-full @xl/studio:px-0 dark:border-white/15 dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
            >
              <Plus className="h-3.5 w-3.5" /> Add a data type
            </button>
          </div>
        </section>

        {/* Screen settings */}
        <section className="h-fit overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
          <div className="flex items-center justify-between border-b border-gray-200/80 p-4 dark:border-white/[0.06]">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {selection.kind === 'home' ? 'Home settings' : 'Screen settings'}
            </h3>
            <Settings2 className="h-4 w-4 text-gray-500 dark:text-slate-400" aria-hidden="true" />
          </div>
          <div className="space-y-4 p-4">
            {selection.kind === 'home' ? (
              <>
                <div className="rounded-xl border border-gray-200 p-3 dark:border-white/10">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Members see</p>
                  <div className="mt-2 space-y-1.5">
                    <ScreenTypeRow icon={Sparkles} label="Built-in screen" selected={homeKind === 'sdk'} />
                    <ScreenTypeRow icon={Code2} label="Custom code" selected={homeKind === 'code'} />
                    <ScreenTypeRow icon={LayoutDashboard} label="Widget dashboard" selected={homeKind === 'dashboard'} />
                    <ScreenTypeRow icon={List} label="Default dashboard" selected={homeKind === 'default'} />
                  </div>
                  {app.customScreen && homeKind === 'default' && (
                    <p className="mt-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                      A custom screen is saved but switched off, so members get the default dashboard.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="studio-landing" className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                    Members land on
                  </label>
                  <select
                    id="studio-landing"
                    value={app.settings?.landingPage ?? 'dashboard'}
                    onChange={(e) => void setLanding(e.target.value)}
                    disabled={busy}
                    className="mt-1.5 h-10 w-full min-w-0 cursor-pointer rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 outline-none max-sm:h-11 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
                  >
                    <option value="dashboard">App home</option>
                    {appForms.map((af) => {
                      // Data-only forms render no screen: the runtime bounces members
                      // straight back to the dashboard, so they are not landing targets.
                      const dataOnly = attachmentState(af) === 'data-only' || attachmentState(af) === 'off';
                      return (
                        <option key={af.formId} value={af.formId} disabled={dataOnly}>
                          {af.displayName || formsById[af.formId]?.title || 'Untitled'}
                          {dataOnly ? ' — data only, cannot be a landing screen' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <Button className="w-full" onClick={customiseScreen} leftIcon={<WandSparkles className="h-4 w-4" />}>
                  {homeKind === 'dashboard' ? 'Edit dashboard in the app' : 'Customise home screen'}
                </Button>
                {homeKind !== 'code' && (
                  <Button variant="secondary" className="w-full" onClick={() => navigate(`/apps/${app.id}/home/edit`, { state: studioReturn })} leftIcon={<Code2 className="h-4 w-4" />}>
                    Open home studio
                  </Button>
                )}
              </>
            ) : selectedAttachment && selectedForm ? (
              <>
                {/* One control for all FOUR states this attachment can be in. It used
                    to be a two-state switch plus two paragraphs telling the owner to
                    go to the Forms manager — for settings that are one field each. */}
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                    Where this appears
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {NAV_STATES.map((state) => {
                      const current = attachmentState(selectedAttachment);
                      return (
                        <button
                          key={state.id}
                          type="button"
                          disabled={busy || current === state.id}
                          onClick={() => void setNavState(selectedAttachment, state.id)}
                          aria-current={current === state.id ? 'true' : undefined}
                          className={cn(
                            'flex min-h-11 w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition',
                            current === state.id
                              ? 'border-primary-300 bg-primary-50 dark:border-primary-500/30 dark:bg-primary-500/[0.09]'
                              : 'cursor-pointer border-gray-200 hover:border-primary-300 hover:bg-gray-50 dark:border-white/10 dark:hover:border-primary-500/30 dark:hover:bg-white/[0.03]'
                          )}
                        >
                          <state.icon className={cn(
                            'mt-0.5 h-4 w-4 shrink-0',
                            current === state.id ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-500'
                          )} />
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold text-gray-800 dark:text-slate-200">{state.label}</span>
                            <span className="mt-0.5 block text-[11px] leading-4 text-gray-500 dark:text-slate-400">{state.detail}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {hideNav && (
                    <p className="mt-2 rounded-xl bg-gray-50 p-2.5 text-[11px] leading-4 text-gray-600 dark:bg-white/[0.04] dark:text-slate-300">
                      This app runs full-screen, so menu placement has no effect — members reach
                      records from the floating Records button. Turn the menu back on under
                      Look &amp; feel.
                    </p>
                  )}
                </div>
                {attachmentState(selectedAttachment) !== 'off' && attachmentState(selectedAttachment) !== 'data-only' && (
                  <Switch
                    label="Landing screen"
                    description="Members land here when they open the app"
                    checked={app.settings?.landingPage === selectedAttachment.formId}
                    onChange={(v) => void setLanding(v ? selectedAttachment.formId : 'dashboard')}
                    disabled={busy}
                  />
                )}
                <div className="rounded-xl border border-gray-200 p-3 dark:border-white/10">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Generated views</p>
                  <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-slate-300">
                    <li className="flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-primary-500" /> Submit form</li>
                    <li className="flex items-center gap-2"><Table2 className="h-3.5 w-3.5 text-primary-500" /> Records list &amp; detail</li>
                    <li className="flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5 text-primary-500" /> Analytics</li>
                  </ul>
                </div>
                <Button className="w-full" onClick={customiseScreen} leftIcon={<WandSparkles className="h-4 w-4" />}>
                  Customise this screen
                </Button>
                <Button variant="secondary" className="w-full" onClick={() => navigate(`/builder/${selectedForm.id}`, { state: studioReturn })} leftIcon={<PencilRuler className="h-4 w-4" />}>
                  Open form builder
                </Button>
              </>
            ) : (
              <p className="text-xs text-gray-500 dark:text-slate-400">Select a screen to configure it.</p>
            )}
          </div>
        </section>

        {/* The app's look lives beside the preview that draws it, not on a settings
            tab whose only preview was a white card with a sample button. */}
        <AppLookPanel app={app} onReloadApp={onReloadApp} />
      </div>

      {/* Preview — first on a phone, where it is the whole point of the section. */}
      <section className="order-first overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm @3xl/studio:order-none dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="space-y-3 border-b border-gray-200/80 p-3 dark:border-white/[0.06]">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-gray-800 dark:text-slate-200">
                {selection.kind === 'home' ? 'App home' : selectedAttachment?.displayName || selectedForm?.title || 'Screen'}
              </span>
              <Badge variant={activeScreenKind !== 'default' ? 'primary' : 'default'} size="sm">
                {SCREEN_KIND_LABEL[activeScreenKind]}
              </Badge>
            </span>
            {changes.everPublished && changes.count > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setCompareOpen(true)} leftIcon={<GitCompareArrows className="h-3.5 w-3.5" />}>
                Compare with live
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={selectedRole?.id ?? ''}
              onChange={(e) => setRoleId(e.target.value)}
              aria-label="Preview as role"
              className="h-9 min-w-0 max-w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-semibold text-gray-700 outline-none max-sm:h-11 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>Preview as {role.name}</option>
              ))}
            </select>
            <select
              value={previewData}
              onChange={(e) => setPreviewData(e.target.value as 'sample' | 'real')}
              aria-label="Preview data"
              className="h-9 min-w-0 max-w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-2.5 text-xs font-semibold text-gray-700 outline-none max-sm:h-11 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="sample">Sample content</option>
              <option value="real">Real records (your view)</option>
            </select>
            <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 max-sm:gap-1 max-sm:p-1 dark:border-white/10 dark:bg-white/[0.04]">
              <DeviceButton active={device === 'desktop'} label="Desktop preview" icon={Monitor} onClick={() => setDevice('desktop')} />
              <DeviceButton active={device === 'tablet'} label="Tablet preview" icon={Tablet} onClick={() => setDevice('tablet')} />
              <DeviceButton active={device === 'mobile'} label="Mobile preview" icon={Smartphone} onClick={() => setDevice('mobile')} />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer')}
              leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
              title={changes.count > 0 || app.status !== 'published' ? 'Open the current draft in a new tab' : 'Open the app in a new tab'}
            >
              {changes.count > 0 || app.status !== 'published' ? 'Open draft' : 'Open app'}
            </Button>
          </div>
        </div>
        {changes.everPublished && changes.count > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200/70 bg-amber-50/75 px-4 py-2.5 text-[11px] text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200">
            <span>
              <strong>{changes.count} {changes.count === 1 ? 'change' : 'changes'} since the last release.</strong> Saved edits are already live for members — publishing records them as a version.
            </span>
            <button type="button" onClick={() => setCompareOpen(true)} className="cursor-pointer font-bold hover:underline">
              See what differs
            </button>
          </div>
        )}
        {!changes.everPublished && app.status !== 'published' && (
          <div className="border-b border-primary-200/70 bg-primary-50/70 px-4 py-2.5 text-[11px] text-primary-800 dark:border-primary-500/20 dark:bg-primary-500/[0.07] dark:text-primary-200">
            <strong>Draft preview.</strong> Only you can use this version until the first publish.
          </div>
        )}
        {permsError && (
          <div className="flex items-center gap-2 border-b border-amber-200/70 bg-amber-50/75 px-4 py-2.5 text-[11px] text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Couldn't read {selectedRole?.name ?? 'this role'}'s permissions, so this preview shows the owner's view.
            </span>
          </div>
        )}
        <div className="scrollbar-thin flex min-h-[480px] items-center justify-center overflow-x-auto bg-gray-50/80 p-4 dark:bg-slate-950/40 sm:p-6">
          <AppPreview
            app={app}
            device={device}
            roleName={selectedRole?.name ?? 'Owner'}
            hideNav={hideNav}
            nav={previewNav}
            homeActive={selection.kind === 'home'}
            totalRecords={totalRecords}
            selection={selection}
            selectedForm={selectedForm}
            screenKind={activeScreenKind}
            previewData={previewData}
            records={previewRecords}
            recordsLoading={previewRecordsLoading}
            recordsError={previewRecordsError}
            canViewSelected={selectedRoleCanView}
            onUseSample={() => setPreviewData('sample')}
            onOpenScreen={customiseScreen}
          />
        </div>
        {/* Cross-check: menu entries the previewed role holds no permission on. */}
        {inaccessibleNavNames.length > 0 && selectedRole && !hideNav && (
          <div className="border-t border-amber-200/70 bg-amber-50/70 px-4 py-2.5 text-[11px] leading-4 text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.07] dark:text-amber-200">
            <span className="font-bold">{selectedRole.name} can't open {inaccessibleNavNames.length === 1 ? 'a menu item' : `${inaccessibleNavNames.length} menu items`}:</span>{' '}
            {inaccessibleNavNames.join(', ')} {inaccessibleNavNames.length === 1 ? 'is' : 'are'} in the menu but this role has no
            permission on {inaccessibleNavNames.length === 1 ? 'it' : 'them'}, so {inaccessibleNavNames.length === 1 ? 'it stays' : 'they stay'} hidden
            for these members — grant access in Users &amp; roles, or hide {inaccessibleNavNames.length === 1 ? 'it' : 'them'} here.
          </div>
        )}
        <p className="border-t border-gray-200/70 px-4 py-2 text-[10px] text-gray-500 dark:border-white/[0.06] dark:text-slate-400">
          Preview uses this draft's navigation, theme and role permissions. Records are read with your
          own access, so a role that only sees its own submissions will see fewer than shown here.
        </p>
      </section>

      <Modal
        isOpen={compareOpen}
        onClose={() => setCompareOpen(false)}
        title="Compare draft with live"
        description={`Saved edits are already live. Publishing records them as ${statusLabel(app) === 'Live' ? 'the next version' : `version ${(app.publishedVersion ?? 0) + 1}`}.`}
        size="lg"
      >
        <div className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-400/20 dark:bg-emerald-400/[0.06]">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-white">
                  <Monitor className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-[10px] font-bold uppercase tracking-wider">Published</span>
                  <span className="block text-sm font-semibold">{statusLabel(app)}</span>
                </span>
              </div>
              <p className="mt-3 text-xs leading-5 text-emerald-800/80 dark:text-emerald-200/80">
                This is what members keep using while you review the draft. No saved Studio change replaces it until Publish.
              </p>
            </section>
            <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-400/20 dark:bg-amber-400/[0.06]">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-white">
                  <PencilRuler className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-[10px] font-bold uppercase tracking-wider">Draft</span>
                  <span className="block text-sm font-semibold">
                    {changes.count} unpublished {changes.count === 1 ? 'change' : 'changes'}
                  </span>
                </span>
              </div>
              <p className="mt-3 text-xs leading-5 text-amber-800/80 dark:text-amber-200/80">
                The preview on this section renders these saved changes as the app owner, before they reach members.
              </p>
            </section>
          </div>

          <section className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/10">
            <div className="border-b border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Draft resources that differ</p>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
              {changes.changed.map((item) => (
                <div key={`${item.kind}-${item.id}`} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
                    {item.kind === 'form' ? <FileText className="h-3.5 w-3.5" /> : item.kind === 'flow' ? <GitBranch className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-700 dark:text-slate-200">{item.label}</span>
                  <Badge size="sm">{item.kind === 'app' ? 'App setup' : item.kind === 'flow' ? 'Automation' : 'Form'}</Badge>
                </div>
              ))}
            </div>
          </section>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setCompareOpen(false)}>Keep testing</Button>
            <Button
              onClick={() => {
                setCompareOpen(false);
                onOpenPublish();
              }}
              leftIcon={<GitCompareArrows className="h-4 w-4" />}
            >
              Review this release
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ScreenItem({
  icon: Icon,
  label,
  status,
  custom,
  selected,
  onClick,
}: {
  icon: typeof Home;
  label: string;
  status: string;
  custom: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        // Below @xl the list is a horizontal chip strip: shrink-0 so chips keep their
        // width, snap-start so a flick lands on a whole item.
        'flex min-h-11 w-auto max-w-[11rem] shrink-0 snap-start cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition @xl/studio:w-full @xl/studio:max-w-none @xl/studio:shrink',
        selected
          ? 'bg-primary-50 text-primary-800 dark:bg-primary-500/[0.09] dark:text-white'
          : 'text-gray-700 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-white/[0.035]'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className={cn('mt-0.5 block truncate text-[10px]', custom ? 'text-primary-600 dark:text-primary-300' : 'text-gray-500 dark:text-slate-400')}>
          {status}
        </span>
      </span>
      {selected && <ChevronRight className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" />}
    </button>
  );
}

function ScreenTypeRow({ icon: Icon, label, selected }: { icon: typeof LayoutDashboard; label: string; selected: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-semibold',
        selected
          ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300'
          : 'text-gray-500 dark:text-slate-400'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="flex-1">{label}</span>
      {selected && <span className="text-[9px] font-bold uppercase">Active</span>}
    </div>
  );
}

function DeviceButton({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: typeof Monitor; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition max-sm:h-11 max-sm:w-11',
        active ? 'bg-white text-primary-600 shadow-sm dark:bg-slate-800 dark:text-primary-400' : 'text-gray-500 dark:text-slate-400'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function previewAnswer(value: unknown): string {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.map(String).join(', ') || '—';
  if (typeof value === 'object') return 'Attached value';
  return String(value);
}

function previewRecordTitle(form: Form, answers: Record<string, unknown>): string {
  for (const field of form.fields) {
    const value = previewAnswer(answers[field.id]);
    if (value !== '—' && value !== 'Attached value') return value;
  }
  return 'Untitled record';
}

/** Faithful mini-render of the runtime shell from REAL app data (nav, theme, counts). */
function AppPreview({
  app,
  device,
  roleName,
  hideNav,
  nav,
  homeActive,
  totalRecords,
  selection,
  selectedForm,
  screenKind,
  previewData,
  records,
  recordsLoading,
  recordsError,
  canViewSelected,
  onUseSample,
  onOpenScreen,
}: {
  app: App;
  device: 'desktop' | 'tablet' | 'mobile';
  roleName: string;
  hideNav: boolean;
  nav: { menu: PreviewNavItem[]; formsOnly: PreviewNavItem[]; data: PreviewNavItem[] };
  homeActive: boolean;
  totalRecords: number;
  selection: ScreenSelection;
  selectedForm: Form | null;
  screenKind: HomeKind;
  previewData: 'sample' | 'real';
  records: Array<{ id: string; answers: Record<string, unknown>; submittedAt: string }>;
  recordsLoading: boolean;
  recordsError: string | null;
  canViewSelected: boolean;
  onUseSample: () => void;
  onOpenScreen: () => void;
}) {
  const accent = app.theme?.primaryColor || '#6366f1';
  const onAccent = readableForegroundColor(accent);
  const initial = (app.name?.trim().charAt(0) || '?').toUpperCase();
  const appIcon = (app.settings as { icon?: string } | undefined)?.icon ?? null;
  const groups = [
    { label: 'Overview', items: [{ key: '__home', label: 'Dashboard', icon: null, active: homeActive }] },
    ...(nav.menu.length > 0 ? [{ label: 'Forms', items: nav.menu }] : []),
    { label: 'Data', items: nav.data },
  ];
  // Mobile bottom bar mirrors the shell: Dashboard / Records / Reports own the fixed
  // slots and forms live under More — they are never tabs of their own.
  const bottomItems = [
    { key: '__home', label: 'Dashboard', active: homeActive },
    ...nav.data.map((d) => ({ key: d.key, label: d.label, active: false })),
    ...(nav.menu.length > 0 ? [{ key: '__more', label: 'More', active: selection.kind === 'form' }] : []),
  ];

  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden rounded-[18px] border border-gray-300 bg-white shadow-2xl shadow-gray-950/15 transition-all duration-300 dark:border-white/15 dark:bg-slate-950',
        // A minimum width per device so the mock stays readable in a narrow column;
        // the stage scrolls rather than shrinking the whole render to a smudge.
        device === 'desktop'
          ? 'w-full min-w-[520px] max-w-[760px]'
          : device === 'tablet'
            ? 'w-full min-w-[420px] max-w-[560px]'
            : 'w-[300px]'
      )}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-gray-200 bg-gray-50 px-3 dark:border-white/[0.08] dark:bg-slate-900">
        <span className="h-2 w-2 rounded-full bg-rose-400" />
        <span className="h-2 w-2 rounded-full bg-amber-400" />
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="mx-auto h-4 w-32 rounded bg-gray-200 dark:bg-white/[0.08]" />
      </div>
      <div className="flex min-h-[380px]">
        {/* A chromeless app renders no sidebar at all — drawing one made every
            navigation control on this section advice about a menu that never ships. */}
        {device !== 'mobile' && !hideNav && (
          <div className={cn(
            'shrink-0 overflow-y-auto border-r border-gray-200 bg-white p-2.5 dark:border-white/[0.08] dark:bg-slate-900',
            device === 'desktop' ? 'w-40' : 'w-32'
          )}>
            <div className="mb-3 flex items-center gap-2">
              <span
                className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg text-[10px] font-bold"
                style={{ backgroundColor: accent, color: onAccent }}
              >
                {app.logoUrl
                  ? <img src={app.logoUrl} alt="" className="h-full w-full object-cover" />
                  : <DynamicIcon name={appIcon} className="h-3.5 w-3.5" fallback={<span>{initial}</span>} />}
              </span>
              <span className="truncate text-[10px] font-bold text-gray-900 dark:text-white">{app.name}</span>
            </div>
            {groups.map((group) => (
              <div key={group.label} className="mb-2">
                <p className="px-1.5 pb-1 text-[8px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">{group.label}</p>
                {group.items.map((item) => (
                  <div
                    key={item.key}
                    className={cn(
                      'mb-0.5 flex items-center gap-1.5 truncate rounded-lg px-1.5 py-1 text-[9px]',
                      item.active
                        ? 'bg-primary-50 font-bold text-primary-700 dark:bg-primary-500/15 dark:text-primary-200'
                        : 'text-gray-600 dark:text-slate-400'
                    )}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
                    <span className="truncate">{item.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1 bg-gray-50/80 p-4 dark:bg-slate-900/60">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                Preview as {roleName} · {previewData === 'real' ? 'Real records' : 'Sample content'}
              </p>
              <h4 className="mt-1 truncate text-sm font-bold text-gray-900 dark:text-white">
                {selection.kind === 'home' ? app.name : selectedForm?.title ?? 'Screen'}
              </h4>
            </div>
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold"
              style={{ backgroundColor: accent, color: onAccent }}
            >
              {roleName.slice(0, 2).toUpperCase()}
            </span>
          </div>

          {/* A custom or SDK screen is real code — drawing the generic mock in its place
              means reviewing a screen that does not exist. Say so and offer to open it. */}
          {screenKind === 'code' || screenKind === 'sdk' ? (
            <div className="mt-4 flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 p-4 text-center dark:border-white/15">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
                {screenKind === 'sdk' ? <Sparkles className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
              </span>
              <p className="mt-2 text-[11px] font-bold text-gray-800 dark:text-slate-200">
                {screenKind === 'sdk' ? 'Built-in screen' : 'Custom code screen'}
              </p>
              <p className="mt-1 max-w-52 text-[10px] leading-4 text-gray-500 dark:text-slate-400">
                This screen runs real code, so it is not drawn here. Open it to see and edit it.
              </p>
              <button type="button" onClick={onOpenScreen} className="mt-2 cursor-pointer text-[10px] font-bold text-primary-600 hover:underline dark:text-primary-300">
                Open the screen
              </button>
            </div>
          ) : selection.kind === 'home' ? (
            <>
              <div className={cn('mt-4 grid gap-2', device === 'desktop' ? 'grid-cols-3' : 'grid-cols-2')}>
                <PreviewMetric label={previewData === 'real' ? 'Records' : 'Sample records'} value={String(previewData === 'real' ? totalRecords : 12)} />
                <PreviewMetric label="Data types" value={String(nav.formsOnly.length)} />
                {device === 'desktop' && <PreviewMetric label="Screens" value={String(nav.formsOnly.length + 1)} />}
              </div>
              <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-950/70">
                <span className="mb-2 block text-[10px] font-bold text-gray-800 dark:text-slate-200">Quick actions</span>
                {nav.formsOnly.slice(0, 3).map((item) => (
                  <div key={item.key} className="flex items-center gap-2 border-t border-gray-100 py-2 first:border-0 dark:border-white/[0.06]">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
                    <span className="min-w-0 flex-1 truncate text-[9px] text-gray-600 dark:text-slate-300">
                      New {item.label.toLowerCase()}
                    </span>
                    <ChevronRight className="h-2.5 w-2.5 text-gray-400" />
                  </div>
                ))}
                {nav.formsOnly.length === 0 && (
                  <p className="py-2 text-[9px] text-gray-500 dark:text-slate-400">No screens visible to this role.</p>
                )}
              </div>
            </>
          ) : selectedForm && !canViewSelected ? (
            <div className="mt-4 flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-amber-200 bg-amber-50/60 p-4 text-center dark:border-amber-400/20 dark:bg-amber-400/[0.06]">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-200">
                <LockKeyhole className="h-4 w-4" />
              </span>
              <p className="mt-2 text-[10px] font-bold text-amber-900 dark:text-amber-100">No access for {roleName}</p>
              <p className="mt-1 max-w-48 text-[9px] leading-4 text-amber-700 dark:text-amber-300">
                This role holds no permission on {selectedForm.title}, so the app never shows it.
              </p>
            </div>
          ) : selectedForm && previewData === 'real' ? (
            <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-950/70">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-bold text-gray-800 dark:text-slate-200">Recent {selectedForm.title} records</p>
                <span className="text-[9px] font-semibold text-gray-500 dark:text-slate-400">{records.length} shown</span>
              </div>
              {recordsLoading ? (
                <div className="flex min-h-36 items-center justify-center" role="status">
                  <Loader2 className="h-5 w-5 animate-spin text-primary-500" aria-hidden="true" />
                  <span className="sr-only">Loading records</span>
                </div>
              ) : recordsError ? (
                <div className="flex min-h-36 flex-col items-center justify-center text-center">
                  <p className="text-[10px] font-semibold text-rose-600 dark:text-rose-300">Couldn't load records.</p>
                  <button type="button" onClick={onUseSample} className="mt-2 cursor-pointer text-[10px] font-bold text-primary-600 hover:underline dark:text-primary-300">
                    Use sample content
                  </button>
                </div>
              ) : records.length === 0 ? (
                <div className="flex min-h-36 flex-col items-center justify-center text-center">
                  <p className="text-[10px] font-semibold text-gray-600 dark:text-slate-300">No records yet.</p>
                  <button type="button" onClick={onUseSample} className="mt-2 cursor-pointer text-[10px] font-bold text-primary-600 hover:underline dark:text-primary-300">
                    Preview with sample content
                  </button>
                </div>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {records.map((record) => (
                    <div key={record.id} className="rounded-lg border border-gray-100 bg-gray-50/70 px-2.5 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[10px] font-bold text-gray-800 dark:text-slate-200">
                          {previewRecordTitle(selectedForm, record.answers)}
                        </span>
                        <span className="shrink-0 text-[9px] text-gray-500 dark:text-slate-400">{formatRelativeTime(record.submittedAt)}</span>
                      </div>
                      <p className="mt-1 truncate text-[9px] text-gray-500 dark:text-slate-400">
                        {selectedForm.fields.slice(0, 2).map((field) => `${field.label}: ${previewAnswer(record.answers[field.id])}`).join(' · ')}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : selectedForm ? (
            <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-950/70">
              <p className="text-[10px] font-bold text-gray-800 dark:text-slate-200">{selectedForm.title}</p>
              <div className="mt-2 space-y-2">
                {selectedForm.fields.slice(0, 4).map((field) => (
                  <div key={field.id}>
                    <p className="text-[9px] font-semibold text-gray-500 dark:text-slate-400">
                      {field.label}{field.required ? ' *' : ''}
                    </p>
                    <div className="mt-0.5 h-5 rounded-md border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-slate-900" />
                  </div>
                ))}
                {selectedForm.fields.length === 0 && (
                  <p className="text-[9px] text-gray-500 dark:text-slate-400">No fields yet — add some in Data &amp; forms.</p>
                )}
              </div>
              <div className="mt-3 flex h-6 w-20 items-center justify-center rounded-md text-[9px] font-bold" style={{ backgroundColor: accent, color: onAccent }}>
                Submit
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {device === 'mobile' && !hideNav && (
        <div
          className="grid border-t border-gray-200 bg-white px-2 py-1.5 dark:border-white/[0.08] dark:bg-slate-950"
          style={{ gridTemplateColumns: `repeat(${bottomItems.length}, minmax(0, 1fr))` }}
        >
          {bottomItems.map((item) => (
            <div key={item.key} className="flex flex-col items-center gap-0.5 py-0.5">
              <span
                className={cn('h-1.5 w-1.5 rounded-full', item.active ? '' : 'bg-gray-300 dark:bg-slate-600')}
                style={item.active ? { backgroundColor: accent } : undefined}
              />
              <span className={cn('max-w-full truncate text-[8px] font-semibold', item.active ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400')}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      )}
      {hideNav && (
        <p className="border-t border-gray-200 bg-gray-50 px-3 py-1.5 text-[9px] text-gray-600 dark:border-white/[0.08] dark:bg-slate-900 dark:text-slate-300">
          This app runs chromeless — no sidebar or menu, just a floating Records button.
        </p>
      )}
    </div>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2.5 dark:border-white/[0.08] dark:bg-slate-950/70">
      <p className="text-[9px] font-semibold text-gray-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-sm font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}
