import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3,
  ChevronRight,
  Code2,
  ExternalLink,
  FileText,
  Home,
  LayoutDashboard,
  List,
  Monitor,
  PencilRuler,
  Plus,
  Settings2,
  Smartphone,
  Table2,
  WandSparkles,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { cn } from '../../../lib/utils';
import { returnToState } from '../../../hooks/useReturnTo';
import { trackStudioSave } from '../studioSaveState';
import type { App, AppForm, AppRole, PermissionAction } from '../../../types/app';
import type { Form } from '../../../types/form';

type ScreenSelection = { kind: 'home' } | { kind: 'form'; formId: string };

const VIEW_PERMISSIONS: PermissionAction[] = ['submit_responses', 'view_own_responses', 'view_all_responses'];

/**
 * Studio step 3 — Screens: the app home plus generated per-form screens, with a
 * live-data preview (device + role aware) and real navigation/visibility
 * controls. Deep customisation opens the home studio / screen studio / builder.
 */
export function ScreensStep({
  app,
  appForms,
  formsById,
  roles,
  onReloadApp,
  onReloadForms,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  roles: AppRole[];
  onReloadApp: () => Promise<void>;
  onReloadForms: () => Promise<void>;
}) {
  const navigate = useNavigate();
  // The builder / screen studios return here when opened from this step.
  const studioReturn = returnToState(`/apps/${app.id}/studio/screens`, 'App Studio');
  const updateAppForm = useAppStore((s) => s.updateAppForm);
  const updateApp = useAppStore((s) => s.updateApp);
  const [selection, setSelection] = useState<ScreenSelection>({ kind: 'home' });
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [fetchedPerms, setFetchedPerms] = useState<{ roleId: string; perms: Array<{ formId: string | null; permission: PermissionAction }> } | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedRole = roles.find((r) => r.id === roleId) ?? roles.find((r) => r.name === 'Owner') ?? roles[0] ?? null;
  const ownerLike = !selectedRole || selectedRole.name === 'Owner';
  const selectedRoleId = selectedRole?.id ?? null;

  useEffect(() => {
    if (!selectedRoleId || ownerLike) return;
    let cancelled = false;
    api.getAppRolePermissions(app.id, selectedRoleId).then((res) => {
      if (cancelled) return;
      setFetchedPerms({
        roleId: selectedRoleId,
        perms: ((res.data?.permissions ?? []) as Array<{ formId: string | null; permission: PermissionAction }>).map((p) => ({
          formId: p.formId,
          permission: p.permission,
        })),
      });
    });
    return () => { cancelled = true; };
  }, [app.id, selectedRoleId, ownerLike]);

  // Applicable only when the fetch matches the current role (derived — never reset in an effect).
  const rolePerms = !ownerLike && fetchedPerms?.roleId === selectedRoleId ? fetchedPerms.perms : null;

  const homeKind: 'dashboard' | 'code' | 'default' = useMemo(() => {
    const kind = (app.customScreen as { kind?: string } | undefined)?.kind;
    if (kind === 'dashboard') return 'dashboard';
    if (kind) return 'code';
    return 'default';
  }, [app.customScreen]);

  /** Nav visibility exactly as the runtime derives it (hidden/menuHidden), then role-filtered. */
  const navForms = useMemo(() => {
    return appForms.filter((af) => {
      const settings = (af.settings ?? {}) as { hidden?: boolean; menuHidden?: boolean };
      if (settings.hidden === true || settings.menuHidden === true || af.isVisible === false) return false;
      if (ownerLike || rolePerms === null) return true;
      return rolePerms.some(
        (p) => (p.formId === af.formId || p.formId === null) && VIEW_PERMISSIONS.includes(p.permission)
      );
    });
  }, [appForms, ownerLike, rolePerms]);

  const totalRecords = useMemo(
    () => appForms.reduce((sum, af) => sum + (formsById[af.formId]?.responseCount ?? 0), 0),
    [appForms, formsById]
  );

  // Permission cross-check (recommendation #3): menu items the previewed role
  // can SEE but cannot actually use — visible nav entries whose forms the role
  // holds no view/submit permission on. Makes the matrix tangible right where
  // the navigation is designed.
  const inaccessibleNavNames = useMemo(() => {
    if (ownerLike || rolePerms === null) return [];
    return appForms
      .filter((af) => {
        const settings = (af.settings ?? {}) as { hidden?: boolean; menuHidden?: boolean };
        if (settings.hidden === true || settings.menuHidden === true || af.isVisible === false) return false;
        return !rolePerms.some(
          (p) => (p.formId === af.formId || p.formId === null) && VIEW_PERMISSIONS.includes(p.permission)
        );
      })
      .map((af) => af.displayName || formsById[af.formId]?.title || 'Untitled');
  }, [appForms, ownerLike, rolePerms, formsById]);

  const selectedForm = selection.kind === 'form' ? formsById[selection.formId] ?? null : null;
  const selectedAttachment = selection.kind === 'form' ? appForms.find((af) => af.formId === selection.formId) ?? null : null;

  const screenStatus = (formId?: string): 'Custom' | 'Generated' => {
    if (!formId) return app.customScreen && homeKind !== 'default' ? 'Custom' : 'Generated';
    const kind = (formsById[formId]?.customScreen as { kind?: string } | undefined)?.kind;
    return kind ? 'Custom' : 'Generated';
  };

  const setMenuVisible = async (af: AppForm, visible: boolean, opts: { silent?: boolean } = {}) => {
    setBusy(true);
    const settings = { ...(af.settings ?? {}) } as Record<string, unknown>;
    delete settings.menuHidden;
    delete settings.hidden;
    if (!visible) settings.menuHidden = true;
    const name = af.displayName || formsById[af.formId]?.title || 'Screen';
    await trackStudioSave(
      visible ? `${name} shown in the menu` : `${name} hidden from the menu`,
      updateAppForm(app.id, af.formId, { isVisible: true, settings })
    );
    await onReloadForms();
    setBusy(false);
    // Hiding a nav item is easy to fat-finger — offer a one-tap way back.
    if (!visible && !opts.silent) {
      toast.undo(`${name} hidden from the menu`, () => { void setMenuVisible(af, true, { silent: true }); });
    }
  };

  const setLanding = async (landingPage: string) => {
    const previous = (app.settings as { landingPage?: string } | undefined)?.landingPage ?? 'dashboard';
    setBusy(true);
    const ok = await trackStudioSave(
      'Landing screen updated',
      updateApp(app.id, { settings: { ...app.settings, landingPage } }),
      (saved) => !!saved
    );
    if (ok) {
      await onReloadApp();
      if (previous !== landingPage) {
        toast.undo('Landing screen updated', () => {
          void (async () => {
            await trackStudioSave('Landing screen restored', updateApp(app.id, { settings: { ...app.settings, landingPage: previous } }), (saved) => !!saved);
            await onReloadApp();
          })();
        });
      }
    }
    setBusy(false);
  };

  const customiseHome = () => {
    if (homeKind === 'dashboard') {
      // Widget dashboards are edited in the live app (owner "Edit dashboard").
      window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer');
    } else {
      navigate(`/apps/${app.id}/home/edit`, { state: studioReturn });
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_280px]">
      {/* Screen list */}
      <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm h-fit">
        <div className="flex items-center justify-between border-b border-gray-200/80 dark:border-white/[0.06] p-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">App screens</h3>
            <p className="mt-0.5 text-[10px] text-gray-400 dark:text-slate-500">Navigation and experiences</p>
          </div>
        </div>
        <div className="scrollbar-thin max-h-[600px] space-y-3 overflow-y-auto p-2.5">
          <div>
            <p className="px-2 py-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-gray-400 dark:text-slate-500">App home</p>
            <ScreenItem
              icon={Home}
              label={homeKind === 'dashboard' ? 'Widget dashboard' : homeKind === 'code' ? 'Custom home screen' : 'Default dashboard'}
              status={screenStatus()}
              selected={selection.kind === 'home'}
              onClick={() => setSelection({ kind: 'home' })}
            />
          </div>
          {appForms.map((af) => {
            const form = formsById[af.formId];
            const settings = (af.settings ?? {}) as { hidden?: boolean; menuHidden?: boolean };
            return (
              <div key={af.formId}>
                <p className="px-2 py-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-gray-400 dark:text-slate-500 truncate">
                  {af.displayName || form?.title || 'Untitled'}
                </p>
                <ScreenItem
                  icon={settings.hidden ? Table2 : FileText}
                  label={settings.hidden ? 'Data only (no screens)' : 'Form & record views'}
                  status={screenStatus(af.formId)}
                  muted={settings.hidden === true}
                  selected={selection.kind === 'form' && selection.formId === af.formId}
                  onClick={() => setSelection({ kind: 'form', formId: af.formId })}
                />
              </div>
            );
          })}
          {appForms.length === 0 && (
            <p className="px-3 py-4 text-xs text-gray-400 dark:text-slate-500">
              Screens are generated from your data types — add one in the Data step first.
            </p>
          )}
          <button
            type="button"
            onClick={() => navigate(`/apps/${app.id}/studio/data`)}
            className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 dark:border-white/15 text-xs font-semibold text-gray-500 dark:text-slate-400 hover:border-primary-400 hover:text-primary-700 dark:hover:border-primary-500/40 dark:hover:text-primary-300"
          >
            <Plus className="h-3.5 w-3.5" /> Add a data type
          </button>
        </div>
      </section>

      {/* Preview */}
      <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-200/80 dark:border-white/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold text-gray-800 dark:text-slate-200 truncate">
              {selection.kind === 'home' ? 'App home' : selectedAttachment?.displayName || selectedForm?.title || 'Screen'}
            </span>
            <Badge variant={screenStatus(selection.kind === 'form' ? selection.formId : undefined) === 'Custom' ? 'primary' : 'default'} size="sm">
              {screenStatus(selection.kind === 'form' ? selection.formId : undefined)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedRole?.id ?? ''}
              onChange={(e) => setRoleId(e.target.value)}
              aria-label="Preview as role"
              className="h-9 cursor-pointer rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-slate-900 px-2.5 text-xs font-semibold text-gray-600 dark:text-slate-300 outline-none"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>Preview as {role.name}</option>
              ))}
            </select>
            <div className="flex rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.04] p-0.5">
              <DeviceButton active={device === 'desktop'} label="Desktop preview" icon={Monitor} onClick={() => setDevice('desktop')} />
              <DeviceButton active={device === 'mobile'} label="Mobile preview" icon={Smartphone} onClick={() => setDevice('mobile')} />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(`/app/${app.slug}`, '_blank', 'noopener,noreferrer')}
              leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
              title="Open the real app in a new tab"
            >
              Open live
            </Button>
          </div>
        </div>
        <div className="flex min-h-[480px] items-center justify-center overflow-hidden bg-gray-50/80 dark:bg-slate-950/40 p-4 sm:p-6">
          <AppPreview
            app={app}
            device={device}
            roleName={selectedRole?.name ?? 'Owner'}
            navForms={navForms}
            formsById={formsById}
            totalRecords={totalRecords}
            selection={selection}
            selectedForm={selectedForm}
          />
        </div>
        {/* Cross-check: menu entries the previewed role holds no permission on. */}
        {inaccessibleNavNames.length > 0 && selectedRole && (
          <div className="border-t border-amber-200/70 dark:border-amber-400/20 bg-amber-50/70 dark:bg-amber-400/[0.07] px-4 py-2.5 text-[11px] leading-4 text-amber-800 dark:text-amber-200">
            <span className="font-bold">{selectedRole.name} can't open {inaccessibleNavNames.length === 1 ? 'a menu item' : `${inaccessibleNavNames.length} menu items`}:</span>{' '}
            {inaccessibleNavNames.join(', ')} {inaccessibleNavNames.length === 1 ? 'is' : 'are'} in the menu but this role has no
            permission on {inaccessibleNavNames.length === 1 ? 'it' : 'them'}, so {inaccessibleNavNames.length === 1 ? 'it stays' : 'they stay'} hidden
            for these members — grant access in Users &amp; roles, or hide {inaccessibleNavNames.length === 1 ? 'it' : 'them'} here.
          </div>
        )}
        <p className="border-t border-gray-200/70 dark:border-white/[0.06] px-4 py-2 text-[10px] text-gray-400 dark:text-slate-500">
          Live preview from this app's real navigation, theme and role permissions. Open the live app to interact with real records.
        </p>
      </section>

      {/* Screen settings */}
      <section className="h-fit overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200/80 dark:border-white/[0.06] p-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Screen settings</h3>
            <p className="mt-0.5 text-[10px] text-gray-400 dark:text-slate-500">Changes save immediately</p>
          </div>
          <Settings2 className="h-4 w-4 text-gray-400" />
        </div>
        <div className="space-y-4 p-4">
          {selection.kind === 'home' ? (
            <>
              <div className="rounded-xl border border-gray-200 dark:border-white/10 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">Home screen type</p>
                <div className="mt-2 space-y-1.5">
                  <ScreenTypeRow icon={LayoutDashboard} label="Widget dashboard" selected={homeKind === 'dashboard'} />
                  <ScreenTypeRow icon={Code2} label="Custom code" selected={homeKind === 'code'} />
                  <ScreenTypeRow icon={List} label="Default dashboard" selected={homeKind === 'default'} />
                </div>
              </div>
              <div>
                <label htmlFor="studio-landing" className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">
                  Members land on
                </label>
                <select
                  id="studio-landing"
                  value={app.settings?.landingPage ?? 'dashboard'}
                  onChange={(e) => void setLanding(e.target.value)}
                  disabled={busy}
                  className="mt-1.5 h-10 w-full cursor-pointer rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-slate-900 px-3 text-xs font-semibold text-gray-700 dark:text-slate-200 outline-none"
                >
                  <option value="dashboard">App home</option>
                  {appForms.map((af) => (
                    <option key={af.formId} value={af.formId}>{af.displayName || formsById[af.formId]?.title || 'Untitled'}</option>
                  ))}
                </select>
              </div>
              <Button className="w-full" onClick={customiseHome} leftIcon={<WandSparkles className="h-4 w-4" />}>
                {homeKind === 'dashboard' ? 'Edit dashboard in live app' : 'Customise home screen'}
              </Button>
              {homeKind !== 'code' && (
                <Button variant="secondary" className="w-full" onClick={() => navigate(`/apps/${app.id}/home/edit`, { state: studioReturn })} leftIcon={<Code2 className="h-4 w-4" />}>
                  Open home studio
                </Button>
              )}
            </>
          ) : selectedAttachment && selectedForm ? (
            <>
              <Switch
                label="Show in app navigation"
                description="Unlisted screens stay reachable from other screens"
                checked={
                  !((selectedAttachment.settings as { hidden?: boolean; menuHidden?: boolean } | undefined)?.hidden === true ||
                    (selectedAttachment.settings as { menuHidden?: boolean } | undefined)?.menuHidden === true ||
                    selectedAttachment.isVisible === false)
                }
                onChange={(v) => void setMenuVisible(selectedAttachment, v)}
                disabled={busy || (selectedAttachment.settings as { hidden?: boolean } | undefined)?.hidden === true}
              />
              {(selectedAttachment.settings as { hidden?: boolean } | undefined)?.hidden === true && (
                <p className="text-[11px] text-gray-400 dark:text-slate-500">
                  This is a data-only form — manage its visibility from the Forms manager.
                </p>
              )}
              <Switch
                label="Landing screen"
                description="Members land here when they open the app"
                checked={app.settings?.landingPage === selectedAttachment.formId}
                onChange={(v) => void setLanding(v ? selectedAttachment.formId : 'dashboard')}
                disabled={busy}
              />
              <div className="rounded-xl border border-gray-200 dark:border-white/10 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">Generated views</p>
                <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-slate-300">
                  <li className="flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-primary-500" /> Submit form</li>
                  <li className="flex items-center gap-2"><Table2 className="h-3.5 w-3.5 text-primary-500" /> Records list & detail</li>
                  <li className="flex items-center gap-2"><BarChart3 className="h-3.5 w-3.5 text-primary-500" /> Analytics</li>
                </ul>
              </div>
              <Button className="w-full" onClick={() => navigate(`/forms/${selectedForm.id}/screen/edit`, { state: studioReturn })} leftIcon={<WandSparkles className="h-4 w-4" />}>
                Customise this screen
              </Button>
              <Button variant="secondary" className="w-full" onClick={() => navigate(`/builder/${selectedForm.id}`, { state: studioReturn })} leftIcon={<PencilRuler className="h-4 w-4" />}>
                Open form builder
              </Button>
            </>
          ) : (
            <p className="text-xs text-gray-400 dark:text-slate-500">Select a screen to configure it.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function ScreenItem({
  icon: Icon,
  label,
  status,
  selected,
  muted,
  onClick,
}: {
  icon: typeof Home;
  label: string;
  status: 'Custom' | 'Generated';
  selected: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 text-left transition',
        selected
          ? 'bg-primary-50 dark:bg-primary-500/[0.09] text-primary-800 dark:text-white'
          : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-white/[0.035]'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', muted && 'opacity-50')} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-xs font-semibold', muted && 'opacity-60')}>{label}</span>
        <span className={cn('mt-0.5 block text-[9px]', status === 'Custom' ? 'text-primary-500 dark:text-primary-300' : 'text-gray-400 dark:text-slate-500')}>
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
          ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
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
        'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition',
        active ? 'bg-white dark:bg-slate-800 text-primary-600 dark:text-primary-400 shadow-sm' : 'text-gray-400 dark:text-slate-500'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/** Faithful mini-render of the runtime shell from REAL app data (nav, theme, counts). */
function AppPreview({
  app,
  device,
  roleName,
  navForms,
  formsById,
  totalRecords,
  selection,
  selectedForm,
}: {
  app: App;
  device: 'desktop' | 'mobile';
  roleName: string;
  navForms: AppForm[];
  formsById: Record<string, Form>;
  totalRecords: number;
  selection: ScreenSelection;
  selectedForm: Form | null;
}) {
  const accent = app.theme?.primaryColor || '#6366f1';
  const initial = (app.name?.trim().charAt(0) || '?').toUpperCase();
  const navItems = [
    { key: '__home', label: 'Dashboard', active: selection.kind === 'home' },
    ...navForms.map((af) => ({
      key: af.formId,
      label: af.displayName || formsById[af.formId]?.title || 'Untitled',
      active: selection.kind === 'form' && selection.formId === af.formId,
    })),
    { key: '__records', label: 'Records', active: false },
  ];

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[18px] border border-gray-300 dark:border-white/15 bg-white dark:bg-slate-950 shadow-2xl shadow-gray-950/15 transition-all duration-300',
        device === 'desktop' ? 'w-full max-w-[760px]' : 'w-[300px]'
      )}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-slate-900 px-3">
        <span className="h-2 w-2 rounded-full bg-rose-400" />
        <span className="h-2 w-2 rounded-full bg-amber-400" />
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="mx-auto h-4 w-32 rounded bg-gray-200 dark:bg-white/[0.08]" />
      </div>
      <div className="flex min-h-[380px]">
        {device === 'desktop' && (
          <div className="w-40 shrink-0 border-r border-gray-200 dark:border-white/[0.08] bg-gray-900 p-3 text-white">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg text-[9px] font-bold" style={{ backgroundColor: accent }}>
                {initial}
              </span>
              <span className="truncate text-[10px] font-bold">{app.name}</span>
            </div>
            {navItems.slice(0, 7).map((item) => (
              <div
                key={item.key}
                className={cn(
                  'mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[9px] truncate',
                  item.active ? 'bg-white/15 font-bold text-white' : 'text-slate-400'
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
                <span className="truncate">{item.label}</span>
              </div>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1 bg-gray-50/80 dark:bg-slate-900/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">
                Preview as {roleName}
              </p>
              <h4 className="mt-1 truncate text-sm font-bold text-gray-900 dark:text-white">
                {selection.kind === 'home' ? app.name : selectedForm?.title ?? 'Screen'}
              </h4>
            </div>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[8px] font-bold text-white" style={{ backgroundColor: accent }}>
              {roleName.slice(0, 2).toUpperCase()}
            </span>
          </div>

          {selection.kind === 'home' ? (
            <>
              <div className={cn('mt-4 grid gap-2', device === 'desktop' ? 'grid-cols-3' : 'grid-cols-2')}>
                <PreviewMetric label="Records" value={String(totalRecords)} />
                <PreviewMetric label="Data types" value={String(navForms.length)} />
                {device === 'desktop' && <PreviewMetric label="Screens" value={String(navForms.length + 1)} />}
              </div>
              <div className="mt-3 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-slate-950/70 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[9px] font-bold text-gray-800 dark:text-slate-200">Quick actions</span>
                </div>
                {navForms.slice(0, 3).map((af) => (
                  <div key={af.formId} className="flex items-center gap-2 border-t border-gray-100 dark:border-white/[0.06] py-2 first:border-0">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
                    <span className="min-w-0 flex-1 truncate text-[8px] text-gray-500 dark:text-slate-400">
                      New {(af.displayName || formsById[af.formId]?.title || 'record').toLowerCase()}
                    </span>
                    <ChevronRight className="h-2.5 w-2.5 text-gray-300" />
                  </div>
                ))}
                {navForms.length === 0 && (
                  <p className="py-2 text-[8px] text-gray-400">No screens visible to this role.</p>
                )}
              </div>
            </>
          ) : selectedForm ? (
            <div className="mt-4 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-slate-950/70 p-3">
              <p className="text-[9px] font-bold text-gray-800 dark:text-slate-200">{selectedForm.title}</p>
              <div className="mt-2 space-y-2">
                {selectedForm.fields.slice(0, 4).map((field) => (
                  <div key={field.id}>
                    <p className="text-[7px] font-semibold text-gray-400 dark:text-slate-500">
                      {field.label}{field.required ? ' *' : ''}
                    </p>
                    <div className="mt-0.5 h-5 rounded-md border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-slate-900" />
                  </div>
                ))}
                {selectedForm.fields.length === 0 && (
                  <p className="text-[8px] text-gray-400">No fields yet — add some in the Data step.</p>
                )}
              </div>
              <div className="mt-3 flex h-6 w-20 items-center justify-center rounded-md text-[8px] font-bold text-white" style={{ backgroundColor: accent }}>
                Submit
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {device === 'mobile' && (
        <div className="grid grid-cols-4 border-t border-gray-200 dark:border-white/[0.08] bg-white dark:bg-slate-950 px-2 py-1.5">
          {navItems.slice(0, 4).map((item) => (
            <div key={item.key} className="flex flex-col items-center gap-0.5 py-0.5">
              <span
                className={cn('h-1.5 w-1.5 rounded-full', item.active ? '' : 'bg-gray-300 dark:bg-slate-600')}
                style={item.active ? { backgroundColor: accent } : undefined}
              />
              <span className={cn('max-w-full truncate text-[6px] font-semibold', item.active ? 'text-gray-900 dark:text-white' : 'text-gray-400')}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-slate-950/70 p-2.5">
      <p className="text-[7px] font-semibold text-gray-400 dark:text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}
