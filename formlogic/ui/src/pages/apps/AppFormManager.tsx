import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useReturnTo } from '../../hooks/useReturnTo';
import { Plus, X, Pencil, Link2, ArrowLeftIcon, ChevronUp, ChevronDown, Check, Search, Tag, Share2, Layers } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { PageBody, PAGE_GUTTER } from '../../components/layout/PageBody';
import { Panel } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Input';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { useResourcePaths } from '../../components/admin/AdminActingContext';
import { api } from '../../lib/api';
import type { AppFormRelations } from '../../lib/api';
import type { App, AppForm, DashboardWidget, AppReportItem } from '../../types/app';
import { isReportDocument } from '../../types/app';

/** What each visibility state means for members, said in the row rather than a tooltip. */
const NAV_STATE_HELP: Record<'shown' | 'unlisted' | 'data-only' | 'off', string> = {
  shown: 'In the app menu — members can open it from anywhere.',
  unlisted: 'Not in the menu, but still openable by link and from other screens.',
  'data-only': 'No screens at all. It keeps storing records, which custom screens can still read.',
  off: 'Removed from the app entirely — not even the SDK can reach it. Records are kept.',
};

interface RelationBadge {
  type: 'outgoing' | 'incoming';
  formName: string;
  fieldLabel: string;
  allowMultiple: boolean;
}

export function AppFormManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const paths = useResourcePaths();
  // Origin-relative Back: opened from the App Studio this returns to its step.
  const backTo = useReturnTo(paths.appSub(`${appId}`, 'settings?tab=manage'));
  const { addFormToApp, removeFormFromApp, updateAppForm, reorderAppForms, apps } = useAppStore();
  const { forms: allForms, refreshForms } = useFormStore();
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyFormId, setBusyFormId] = useState<string | null>(null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');
  const [availableSearch, setAvailableSearch] = useState('');
  const [relationBadges, setRelationBadges] = useState<Record<string, RelationBadge[]>>({});
  const [removeConfirm, setRemoveConfirm] = useState<{ formId: string; formName: string; affectedFields: Array<{ formName: string; fieldLabel: string }>; sharedWith: string[]; dashboardRefCount: number } | null>(null);
  // Cache the app's linked_record relations (one round trip) so we can check for
  // references when a form is removed (incomingLinks = fields elsewhere targeting it).
  const relationsRef = useRef<Record<string, AppFormRelations>>({});
  // Cache the app's home dashboard widgets + saved reports (one round trip) so a form removal
  // can warn when a widget/report still points at the form being removed — the backend already
  // sanitizes dead references on the next dashboard save, but the user should know BEFORE removing.
  const dashboardDataRef = useRef<{ widgets: DashboardWidget[]; reports: AppReportItem[] }>({ widgets: [], reports: [] });
  // Guards against out-of-order loadForms resolving (e.g. rapid appId changes)
  const loadTokenRef = useRef(0);

  const loadForms = async () => {
    if (!appId) return;
    const token = ++loadTokenRef.current;
    setLoading(true);
    // Use the API directly so a fetch FAILURE is distinguishable from "no forms"
    // (the store helper returns [] either way), letting us show error + retry.
    // Relations come from ONE owner-scoped call (replaces the old per-form getForm
    // fan-out); if it fails the badges/warnings just degrade to empty. The app record
    // (customScreen + reports) powers the dashboard-reference warning on remove; if it
    // fails that warning just degrades to empty (never blocks the page).
    const [result, relResult, appResult] = await Promise.all([
      api.getAppForms(appId),
      api.getAppFormRelations(appId),
      api.getApp(appId),
    ]);
    if (loadTokenRef.current !== token) return;
    if (result.error) {
      setLoadError(typeof result.error === 'string' ? result.error : 'Could not load the app’s forms.');
      setLoading(false);
      return;
    }
    setLoadError(null);
    const forms = (result.data?.forms ?? []) as AppForm[];
    setAppForms(forms);

    // Build relation badges from the relations payload. Prefer the app's display names
    // (nameMap) over the server-resolved form titles, matching the old behaviour.
    const nameMap: Record<string, string> = {};
    forms.forEach((f) => { nameMap[f.formId] = f.displayName; });

    const badges: Record<string, RelationBadge[]> = {};
    const relationsCache: Record<string, AppFormRelations> = {};
    for (const rel of relResult.data?.forms ?? []) {
      relationsCache[rel.formId] = rel;
      for (const link of rel.outgoingLinks ?? []) {
        // Outgoing badge on the source form ("<field> → <target form>").
        if (!badges[rel.formId]) badges[rel.formId] = [];
        badges[rel.formId].push({
          type: 'outgoing',
          formName: nameMap[link.targetFormId] || link.targetFormName || allForms.find((af2) => af2.id === link.targetFormId)?.title || 'Removed form',
          fieldLabel: link.fieldLabel,
          allowMultiple: !!link.allowMultiple,
        });
      }
      for (const link of rel.incomingLinks ?? []) {
        // Incoming badge ("<source form> links here via <field>") — the link's target*
        // fields name the OTHER form (the one whose linked_record field points here).
        if (!badges[rel.formId]) badges[rel.formId] = [];
        badges[rel.formId].push({
          type: 'incoming',
          formName: nameMap[link.targetFormId] || link.targetFormName || 'Removed form',
          fieldLabel: link.fieldLabel,
          allowMultiple: !!link.allowMultiple,
        });
      }
    }

    setRelationBadges(badges);
    relationsRef.current = relationsCache;

    const appRecord = appResult.data?.app as App | undefined;
    dashboardDataRef.current = {
      widgets: appRecord?.customScreen?.kind === 'dashboard' ? (appRecord.customScreen.dashboard?.widgets ?? []) : [],
      reports: appRecord?.reports ?? [],
    };

    setLoading(false);
  };

  // Settings → Manage → "Companion app" deep-links here with #companion; scroll to it
  // rather than dropping the user at the top of a page titled "Manage forms".
  useEffect(() => {
    if (window.location.hash === '#companion') {
      const id = window.setTimeout(() => document.getElementById('companion')?.scrollIntoView({ block: 'start' }), 250);
      return () => window.clearTimeout(id);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await refreshForms();
      await loadForms();
    };
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // Forms installed by a pack are excluded from the picker (they're managed through their
  // pack). Forms that belong to OTHER apps ARE offered — attaching one SHARES the form and
  // its existing responses between the apps (both apps read and write the same data), which
  // is how you run e.g. a client app and an admin app over the same backend.
  const [packFormIds, setPackFormIds] = useState<Set<string>>(new Set());
  // formId → names of OTHER apps that already include it (drives the "in <app>" /
  // "Shared" badges and the remove-confirm copy).
  const [formAppUsage, setFormAppUsage] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [usage, packsRes] = await Promise.all([
        useAppStore.getState().fetchFormAppUsage(appId),
        api.getInstalledPacks(),
      ]);
      if (cancelled) return;
      const ids = new Set<string>();
      (packsRes.data?.installations ?? []).forEach((inst) => (inst.formIds ?? []).forEach((id) => ids.add(id)));
      setPackFormIds(ids);
      setFormAppUsage(usage);
    })();
    return () => { cancelled = true; };
  }, [appId]);

  // Other apps a form is attached to. Prefers the server's (optional) `sharedWith` on the
  // listForms rows; falls back to the client-computed usage map when it's absent.
  const getSharedApps = (af: AppForm): string[] => {
    const raw = (af as AppForm & { sharedWith?: unknown }).sharedWith;
    if (Array.isArray(raw)) {
      const names = raw
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object') {
            const o = entry as Record<string, unknown>;
            return String(o.name ?? o.appName ?? o.title ?? '');
          }
          return '';
        })
        .filter(Boolean);
      if (names.length > 0) return names;
      return []; // Server says "not shared" — trust it over the fallback.
    }
    return formAppUsage[af.formId] ?? [];
  };

  const includedFormIds = appForms.map((f) => f.formId);
  const attachable = allForms.filter((f) => !includedFormIds.includes(f.id) && !packFormIds.has(f.id));
  // The list is every form in the workspace, so it is long for anyone with a few
  // apps — attaching one was a scroll hunt with no way to narrow it.
  const availableQuery = availableSearch.trim().toLowerCase();
  const availableForms = availableQuery
    ? attachable.filter((f) => f.title.toLowerCase().includes(availableQuery))
    : attachable;

  const handleAdd = async (formId: string) => {
    if (!appId) return;
    setBusyFormId(formId);
    // The store toasts on failure (e.g. the duplicate-attach guard when the form was
    // already added in another tab); reloading either way converges both lists to
    // server truth — an already-attached form simply shows up under "Included".
    await addFormToApp(appId, formId);
    await loadForms();
    setBusyFormId(null);
  };

  const handleRemoveRequest = (formId: string) => {
    // Check if any other forms have linked_record fields targeting this form —
    // exactly this form's incomingLinks from the app relations payload.
    const nameMap: Record<string, string> = {};
    appForms.forEach((f) => { nameMap[f.formId] = f.displayName; });
    const formName = nameMap[formId] || formId;

    const affectedFields: Array<{ formName: string; fieldLabel: string }> = (relationsRef.current[formId]?.incomingLinks ?? [])
      .filter((link) => link.targetFormId !== formId)
      .map((link) => ({
        formName: nameMap[link.targetFormId] || link.targetFormName || 'Unknown form',
        fieldLabel: link.fieldLabel,
      }));

    // Also warn when the app's home dashboard or saved reports still query this form — the
    // backend safely sanitizes those dead references on the NEXT dashboard/report save, but the
    // user should know before removing that widgets will silently go blank until then.
    const { widgets, reports } = dashboardDataRef.current;
    const reportFormIds = new Map<string, string>();
    for (const item of reports) { if (!isReportDocument(item)) reportFormIds.set(item.id, item.spec.formId); }
    const widgetRefCount = widgets.filter((w) =>
      (w.kind === 'report' && w.spec?.formId === formId) || (w.kind === 'list' && w.list?.formId === formId)
    ).length;
    const reportRefCount = reports.filter((item) => (
      isReportDocument(item)
        ? item.blocks.some((b) => b.kind === 'report' && reportFormIds.get(b.reportId) === formId)
        : item.spec.formId === formId
    )).length;
    const dashboardRefCount = widgetRefCount + reportRefCount;

    // Always confirm — removing a form from an app is a meaningful action even
    // when nothing links to it (it stops collecting in the app + can lose relations).
    const af = appForms.find((f) => f.formId === formId);
    setRemoveConfirm({ formId, formName, affectedFields, sharedWith: af ? getSharedApps(af) : [], dashboardRefCount });
  };

  const handleRemoveConfirmed = async (formId: string) => {
    if (!appId) return;
    setRemoveConfirm(null);
    setBusyFormId(formId);
    await removeFormFromApp(appId, formId);
    await loadForms();
    setBusyFormId(null);
  };

  // Four nav states per app form. 'shown' = normal menu entry; 'unlisted' = no
  // menu entry but still openable (URL / screens); 'data-only' = no UI at all,
  // records stay readable/writable from other forms' custom screens via the
  // SDK; 'off' = legacy is_visible=false, excluded from the app runtime
  // entirely (not even the SDK sees it).
  type FormNavState = 'shown' | 'unlisted' | 'data-only' | 'off';
  const formNavState = (af: AppForm): FormNavState => {
    if (!af.isVisible) return 'off';
    if ((af.settings as { hidden?: boolean } | undefined)?.hidden === true) return 'data-only';
    if ((af.settings as { menuHidden?: boolean } | undefined)?.menuHidden === true) return 'unlisted';
    return 'shown';
  };
  const applyNavState = async (af: AppForm, state: FormNavState) => {
    if (!appId) return;
    setBusyFormId(af.formId);
    // settings is stored WHOLE (server replaces the JSON object) — spread the
    // existing object so packFormId and future keys survive the toggle.
    const settings = { ...(af.settings || {}) } as Record<string, unknown>;
    delete settings.hidden;
    delete settings.menuHidden;
    if (state === 'data-only') settings.hidden = true;
    if (state === 'unlisted') settings.menuHidden = true;
    await updateAppForm(appId, af.formId, { isVisible: state !== 'off', settings });
    await loadForms();
    setBusyFormId(null);
  };

  // Reorder the runtime nav order (sort_order). Optimistic, rolls back on failure.
  const handleMove = async (index: number, dir: -1 | 1) => {
    if (!appId) return;
    const target = index + dir;
    if (target < 0 || target >= appForms.length) return;
    const previous = [...appForms];
    const reordered = [...appForms];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setAppForms(reordered);
    // The store resolves (never throws) and returns false on failure, so check
    // the result and reload to the true server order on failure.
    const ok = await reorderAppForms(appId, reordered.map((f) => f.formId));
    if (!ok) {
      await loadForms();
      return;
    }
    toast.undo('Navigation order updated', () => {
      void (async () => {
        setAppForms(previous);
        const restored = await reorderAppForms(appId, previous.map((form) => form.formId));
        if (!restored) await loadForms();
      })();
    });
  };

  // Companion app: a second app (e.g. an admin console) over these same forms + data.
  const sourceAppName = apps.find((a) => a.id === appId)?.name;
  const [companionName, setCompanionName] = useState('');
  const [companionBusy, setCompanionBusy] = useState(false);
  // What to copy across: dashboard + saved reports default ON (they stay valid — the forms are
  // identical), app-level custom logic defaults OFF (custom code is opt-in per app).
  const [companionCopyDashboard, setCompanionCopyDashboard] = useState(true);
  const [companionCopyReports, setCompanionCopyReports] = useState(true);
  const [companionCopyLogic, setCompanionCopyLogic] = useState(false);
  // Prefill "<App> Admin" once the app name is known, but never clobber user input.
  const companionTouchedRef = useRef(false);
  useEffect(() => {
    if (!companionTouchedRef.current && sourceAppName) {
      setCompanionName(`${sourceAppName} Admin`);
    }
  }, [sourceAppName]);

  const handleCreateCompanion = async () => {
    if (!appId || companionBusy) return;
    setCompanionBusy(true);
    const name = companionName.trim();
    const result = await api.createCompanionApp(appId, {
      name: name || undefined,
      copyDashboard: companionCopyDashboard,
      copyReports: companionCopyReports,
      copyLogic: companionCopyLogic,
      // Companions default to appKind 'admin' server-side — pair that with the matching role preset.
      rolePreset: 'admin-console',
    });
    const newApp = result.data?.app as { id?: string; name?: string } | undefined;
    if (result.error || !newApp?.id) {
      toast.error('Could not create companion app', typeof result.error === 'string' ? result.error : 'Please try again.');
      setCompanionBusy(false);
      return;
    }
    toast.success('Companion app created', `"${newApp.name ?? name}" shares this app's forms and data — members and roles are its own.`);
    // Refresh the apps slice so the new app exists in the store before we land on its manage page.
    await useAppStore.getState().fetchApps();
    navigate(paths.appSub(newApp.id, 'settings?tab=manage'));
  };

  const startRename = (af: AppForm) => {
    setEditingNameId(af.formId);
    setEditNameValue(af.displayName);
  };

  const saveRename = async (formId: string) => {
    if (!appId) return;
    const name = editNameValue.trim();
    setEditingNameId(null);
    if (!name) return;
    await updateAppForm(appId, formId, { displayName: name });
    await loadForms();
  };

  const back = { onClick: () => navigate(backTo.path, { state: backTo.state }), label: backTo.label ? `Back to ${backTo.label}` : 'Back to app settings' };

  // The page's frame from the first paint: the header and Back, then what is known so far.
  if (loading) {
    return (
      <div className="min-h-screen">
        <Header title="Manage forms" back={back} />
        <div className={cn('flex items-center gap-3 py-8 text-sm text-gray-500 dark:text-slate-400', PAGE_GUTTER)}>
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading forms" />
          Loading the app’s forms…
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen">
        <Header title="Manage forms" back={back} />
        <div role="alert" className={cn('py-8', PAGE_GUTTER)}>
          <p className="text-sm text-gray-600 dark:text-slate-300">{loadError}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => loadForms()}>Try again</Button>
        </div>
      </div>
    );
  }

  // ── What one included form's row, or its card on a phone, is made of ──────────────────────
  // `finger` draws a control at a touch target's size, for the card.
  const iconButton = (finger: boolean) => cn(
    'inline-flex flex-none cursor-pointer items-center justify-center text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-default disabled:opacity-30 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-200',
    finger ? 'h-11 w-11 rounded-lg' : 'h-8 w-8 rounded-md',
  );
  /** Its place in the app's menu: one step up, one step down. */
  const moveButtons = (af: AppForm, index: number, finger: boolean) => (
    <span className="inline-flex flex-none items-center">
      <button type="button" onClick={() => handleMove(index, -1)} disabled={index === 0} aria-label={`Move ${af.displayName} up`} title="Move up" className={iconButton(finger)}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => handleMove(index, 1)} disabled={index === appForms.length - 1} aria-label={`Move ${af.displayName} down`} title="Move down" className={iconButton(finger)}>
        <ChevronDown className="h-4 w-4" />
      </button>
    </span>
  );
  /** Its name in this app, or the field that renames it. */
  const formName = (af: AppForm, finger: boolean) => editingNameId === af.formId ? (
    <input
      autoFocus
      value={editNameValue}
      onChange={(e) => setEditNameValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') saveRename(af.formId); if (e.key === 'Escape') setEditingNameId(null); }}
      onBlur={() => saveRename(af.formId)}
      aria-label="Display name"
      className={cn('min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-white', finger ? 'min-h-11 text-base' : 'text-sm')}
    />
  ) : (
    <span className={cn('min-w-0 flex-1 truncate font-semibold text-gray-900 dark:text-white', finger && 'text-[15px]')}>{af.displayName}</span>
  );
  /** Whether members see it: in the menu, by link only, as data only, or not at all. */
  const visibility = (af: AppForm, describedBy: string, finger: boolean) => (
    <select
      value={formNavState(af)}
      onChange={(e) => applyNavState(af, e.target.value as FormNavState)}
      disabled={busyFormId === af.formId}
      aria-label={`Visibility for ${af.displayName}`}
      aria-describedby={describedBy}
      className={cn(
        'w-full min-w-0 cursor-pointer rounded-lg border border-gray-200 bg-white px-1.5 transition-colors disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900',
        finger ? 'min-h-11 text-base' : 'h-8 text-xs',
        formNavState(af) === 'shown' ? 'text-green-600' : formNavState(af) === 'off' ? 'text-gray-500 dark:text-slate-400' : 'text-amber-600 dark:text-amber-400'
      )}
    >
      <option value="shown">Shown</option>
      <option value="unlisted">Unlisted</option>
      <option value="data-only">Data-only</option>
      <option value="off">Off</option>
    </select>
  );
  /** Rename (or keep the new name), edit the form, take it out of the app. */
  const rowActions = (af: AppForm, finger: boolean) => (
    <span className="inline-flex flex-none items-center">
      {editingNameId === af.formId ? (
        <button type="button" onMouseDown={(e) => { e.preventDefault(); saveRename(af.formId); }} aria-label="Save name" title="Save name" className={cn(iconButton(finger), 'text-green-600 dark:text-green-500')}>
          <Check className="h-4 w-4" />
        </button>
      ) : (
        <button type="button" onClick={() => startRename(af)} aria-label={`Rename ${af.displayName}`} title="Rename display label" className={iconButton(finger)}>
          <Tag className="h-4 w-4" />
        </button>
      )}
      <button type="button" onClick={() => navigate(paths.builder(af.formId, appId))} aria-label={`Edit ${af.displayName}`} title="Edit form" className={iconButton(finger)}>
        <Pencil className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => handleRemoveRequest(af.formId)} disabled={busyFormId === af.formId} aria-label={`Remove ${af.displayName}`} title="Remove from the app" className={cn(iconButton(finger), 'hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-500/10 dark:hover:text-red-400')}>
        {busyFormId === af.formId ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" /> : <X className="h-4 w-4" />}
      </button>
    </span>
  );
  /** The apps it is shared with, and the linked-record fields to and from it. */
  const formLinks = (af: AppForm) => {
    const sharedApps = getSharedApps(af);
    if (sharedApps.length === 0 && !relationBadges[af.formId]?.length) return null;
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {sharedApps.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-600 dark:bg-violet-500/10 dark:text-violet-400"
            title={`This form and its responses are shared with ${sharedApps.join(', ')} — the apps read and write the same data.`}
          >
            <Share2 className="h-3 w-3" />
            <span className="font-medium">Shared</span>
            <span className="opacity-60">· also in {sharedApps.length <= 2 ? sharedApps.join(' & ') : `${sharedApps.length} other apps`}</span>
          </span>
        )}
        {relationBadges[af.formId]?.map((badge, i) => (
          <span
            key={i}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
              badge.type === 'outgoing'
                ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
                : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400'
            )}
            title={badge.type === 'outgoing'
              ? `"${badge.fieldLabel}" links to ${badge.formName}`
              : `${badge.formName} links here via "${badge.fieldLabel}"`
            }
          >
            {badge.type === 'outgoing' ? <Link2 className="h-3 w-3" /> : <ArrowLeftIcon className="h-3 w-3" />}
            <span className="font-medium">{badge.fieldLabel}</span>
            <span className="opacity-60">{badge.type === 'outgoing' ? '→' : '←'} {badge.formName}</span>
            <span className="opacity-50">{badge.allowMultiple ? '1:N' : '1:1'}</span>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen">
      <Header title="Manage forms" back={back} />
      {/* Left-aligned and as wide as the page: the app's forms as one table, and beside it (under
          it on a narrower screen) the forms that can be added and the companion app. */}
      <PageBody className="@container/page">
        <p className="text-sm text-gray-500 dark:text-slate-400">
          The forms in <span className="font-medium text-gray-900 dark:text-white">{sourceAppName ?? 'this app'}</span>: their order in the app’s menu, what members see of each, and the forms you can add.
        </p>
        <div className="mt-4 grid items-start gap-4 @5xl/page:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        {/* Included forms */}
        <section aria-labelledby="included-forms" className="@container/list min-w-0">
          <h2 id="included-forms" className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Included forms ({appForms.length})</h2>
          {appForms.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-slate-700 dark:text-slate-400">No forms included yet</p>
          ) : (
            <>
              {/* A phone: a card per form. Nothing scrolls sideways, and every control is a finger wide. */}
              <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm @2xl/list:hidden dark:border-slate-700 dark:bg-slate-900/60">
                {appForms.map((af, index) => (
                  <li key={af.formId} className="border-b border-gray-100 px-3 py-2 last:border-b-0 dark:border-slate-800">
                    <div className="flex min-w-0 items-center gap-1">
                      {formName(af, true)}
                      {moveButtons(af, index, true)}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <div className="min-w-0 flex-1">{visibility(af, `nav-state-card-${af.formId}`, true)}</div>
                      {rowActions(af, true)}
                    </div>
                    {/* What the chosen visibility actually does, in the row. It used to
                        live only in a `title` tooltip, which never appears on touch and
                        is the one place the four states are explained at all. */}
                    <p id={`nav-state-card-${af.formId}`} className="mt-1.5 text-xs leading-5 text-gray-500 dark:text-slate-400">
                      {NAV_STATE_HELP[formNavState(af)]}
                    </p>
                    {formLinks(af)}
                  </li>
                ))}
              </ul>

              {/* With room for it: the table, a form a row. The four visibilities are explained
                  once, under the rows, where each row used to repeat its own sentence; a screen
                  reader still hears the chosen one's with the choice. */}
              <div className="hidden overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm @2xl/list:block dark:border-slate-700 dark:bg-slate-900/60">
                <table className="w-full table-fixed border-collapse text-left text-[13px] leading-5">
                  <caption className="sr-only">Forms included in this app, in the order of its menu</caption>
                  <thead className="border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th scope="col" className="h-8 w-[76px] py-0 pl-3 pr-1 font-semibold uppercase tracking-wider">Order</th>
                      <th scope="col" className="px-2 font-semibold uppercase tracking-wider">Form</th>
                      <th scope="col" className="w-[116px] px-2 font-semibold uppercase tracking-wider">Visibility</th>
                      <th scope="col" className="w-[112px] px-2 pr-3"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {appForms.map((af, index) => (
                      <tr key={af.formId} className="border-b border-gray-100 align-top last:border-b-0 hover:bg-gray-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
                        <td className="py-1 pl-2 pr-1">{moveButtons(af, index, false)}</td>
                        <th scope="row" className="px-2 py-1.5 font-normal">
                          <div className="flex min-h-7 min-w-0 items-center">{formName(af, false)}</div>
                          {formLinks(af)}
                        </th>
                        <td className="px-2 py-1">
                          {visibility(af, `nav-state-${af.formId}`, false)}
                          <span id={`nav-state-${af.formId}`} className="sr-only">{NAV_STATE_HELP[formNavState(af)]}</span>
                        </td>
                        <td className="py-1 pl-2 pr-2 text-right">{rowActions(af, false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <dl className="grid gap-x-6 gap-y-1 border-t border-gray-200 px-3 py-2 text-xs leading-5 text-gray-500 @4xl/list:grid-cols-2 dark:border-slate-700 dark:text-slate-400">
                  {(['shown', 'unlisted', 'data-only', 'off'] as const).map((state) => (
                    <div key={state} className="flex gap-1.5">
                      <dt className="flex-none font-semibold text-gray-700 dark:text-slate-300">{{ shown: 'Shown', unlisted: 'Unlisted', 'data-only': 'Data-only', off: 'Off' }[state]}</dt>
                      <dd>{NAV_STATE_HELP[state]}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}
        </section>

        <div className="grid min-w-0 items-start gap-4 @3xl/page:grid-cols-2 @5xl/page:grid-cols-1">
        {/* Available forms */}
        <Panel title="Available forms" icon={<Plus className="h-4 w-4" />} description="Your forms not yet in this app. Adding a form that another app already uses shares it — both apps read and write the same data.">
          {attachable.length > 5 && (
            <Input
              value={availableSearch}
              onChange={(e) => setAvailableSearch(e.target.value)}
              placeholder={`Search ${attachable.length} forms…`}
              aria-label="Search available forms"
              leftIcon={<Search className="h-4 w-4" />}
              className="mb-3"
            />
          )}
          {availableForms.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-slate-400">
              {attachable.length === 0
                ? (allForms.length === 0 ? 'No forms created yet. Create forms first.' : 'No forms to add — all your forms are already in this app or managed by a pack.')
                : `No forms match "${availableSearch.trim()}".`}
            </p>
          ) : (
            <div className="-mx-2 divide-y divide-gray-100 dark:divide-slate-800">
              {availableForms.map((form) => {
                const usedBy = formAppUsage[form.id] ?? [];
                return (
                <div key={form.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-gray-50 dark:hover:bg-white/[0.04]">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{form.title}</span>
                    <Badge variant={form.status === 'published' ? 'success' : 'default'} size="sm" className="capitalize">{form.status}</Badge>
                    {usedBy.length > 0 && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                        title={`Already used by ${usedBy.join(', ')}. Adding it here shares the form and its existing responses — both apps read and write the same data.`}
                      >
                        <Share2 className="h-3 w-3" />
                        {usedBy.length === 1 ? `in ${usedBy[0]}` : `in ${usedBy.length} other apps`}
                      </span>
                    )}
                  </div>
                  <button type="button" onClick={() => handleAdd(form.id)} disabled={busyFormId === form.id} aria-label={`Add ${form.title}`} title="Add to this app" className="inline-flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-lg text-primary-600 transition-colors hover:bg-primary-50 disabled:opacity-50 max-sm:h-11 max-sm:w-11 dark:text-primary-400 dark:hover:bg-primary-500/10">
                    {busyFormId === form.id ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" /> : <Plus className="h-4 w-4" />}
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </Panel>

      {/* Companion app — id anchors the Settings → Manage tile, which used to land
          on this page's top with the card far below the fold. */}
      <Panel id="companion" title="Create a companion app" icon={<Layers className="h-4 w-4" />}>
        <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
          A second app — e.g. an admin console — over these same forms and data. Members and roles stay separate; pick what to bring across below.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-2">
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={companionCopyDashboard}
              onChange={(e) => setCompanionCopyDashboard(e.target.checked)}
              disabled={companionBusy}
              className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500/30"
            />
            Copy dashboard
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={companionCopyReports}
              onChange={(e) => setCompanionCopyReports(e.target.checked)}
              disabled={companionBusy}
              className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500/30"
            />
            Copy saved reports
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={companionCopyLogic}
              onChange={(e) => setCompanionCopyLogic(e.target.checked)}
              disabled={companionBusy}
              className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500/30"
            />
            Copy app logic (custom code)
          </label>
        </div>
        <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
          Each app runs its own app-level custom logic and screens; form-level logic travels with the shared forms.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={companionName}
            onChange={(e) => { companionTouchedRef.current = true; setCompanionName(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCompanion(); }}
            placeholder={sourceAppName ? `${sourceAppName} Admin` : 'Companion app name'}
            aria-label="Companion app name"
            disabled={companionBusy}
            className="min-w-0 flex-1 basis-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 max-sm:min-h-11 max-sm:text-base dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
          <Button size="sm" onClick={handleCreateCompanion} isLoading={companionBusy} leftIcon={<Layers className="h-4 w-4" />} className="flex-shrink-0">
            Create companion app
          </Button>
        </div>
      </Panel>
        </div>
        </div>
      </PageBody>

      {/* Referential integrity warning dialog */}
      <ConfirmDialog
        isOpen={!!removeConfirm}
        onClose={() => setRemoveConfirm(null)}
        onConfirm={() => removeConfirm && handleRemoveConfirmed(removeConfirm.formId)}
        title={removeConfirm && (removeConfirm.affectedFields.length > 0 || removeConfirm.dashboardRefCount > 0) ? 'This form is in use' : 'Remove form from app?'}
        message={removeConfirm
          ? (removeConfirm.affectedFields.length > 0 || removeConfirm.dashboardRefCount > 0
              ? [
                  removeConfirm.affectedFields.length > 0
                    ? `Removing "${removeConfirm.formName}" will break linked record fields in the following forms:\n\n${removeConfirm.affectedFields.map((af) => `- ${af.formName}: "${af.fieldLabel}"`).join('\n')}`
                    : `Removing "${removeConfirm.formName}" from this app:`,
                  removeConfirm.dashboardRefCount > 0
                    ? `${removeConfirm.dashboardRefCount} dashboard widget${removeConfirm.dashboardRefCount === 1 ? '' : 's'} or report${removeConfirm.dashboardRefCount === 1 ? '' : 's'} still query this form and will go blank until you edit or remove ${removeConfirm.dashboardRefCount === 1 ? 'it' : 'them'}.`
                    : '',
                  removeConfirm.sharedWith.length > 0 ? `The form and its data stay in ${removeConfirm.sharedWith.join(', ')} — nothing is deleted.` : '',
                  'Are you sure you want to remove this form?',
                ].filter(Boolean).join('\n\n')
              : (removeConfirm.sharedWith.length > 0
                  ? `Remove "${removeConfirm.formName}" from this app? It will stop appearing here, but the form and all of its responses stay in ${removeConfirm.sharedWith.join(', ')} — nothing is deleted.`
                  : `Remove "${removeConfirm.formName}" from this app? It will stop appearing in the app. The form and its responses are kept.`))
          : ''}
        confirmLabel={removeConfirm && (removeConfirm.affectedFields.length > 0 || removeConfirm.dashboardRefCount > 0) ? 'Remove anyway' : 'Remove'}
        variant="danger"
      />
    </div>
  );
}
