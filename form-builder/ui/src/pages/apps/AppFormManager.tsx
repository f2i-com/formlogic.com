import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, X, Eye, EyeOff, Pencil, Link2, ArrowLeftIcon, ChevronUp, ChevronDown, Check, Tag, Share2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import type { AppForm } from '../../types/app';
import type { Form, FormField } from '../../types/form';

interface RelationBadge {
  type: 'outgoing' | 'incoming';
  formName: string;
  fieldLabel: string;
  allowMultiple: boolean;
}

export function AppFormManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { addFormToApp, removeFormFromApp, updateAppForm, reorderAppForms } = useAppStore();
  const { forms: allForms, refreshForms } = useFormStore();
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyFormId, setBusyFormId] = useState<string | null>(null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');
  const [relationBadges, setRelationBadges] = useState<Record<string, RelationBadge[]>>({});
  const [removeConfirm, setRemoveConfirm] = useState<{ formId: string; formName: string; affectedFields: Array<{ formName: string; fieldLabel: string }>; sharedWith: string[] } | null>(null);
  // Cache loaded form definitions so we can check for linked_record references
  const loadedFormsRef = useRef<Record<string, Form>>({});
  // Guards against out-of-order loadForms resolving (e.g. rapid appId changes)
  const loadTokenRef = useRef(0);

  const loadForms = async () => {
    if (!appId) return;
    const token = ++loadTokenRef.current;
    setLoading(true);
    // Use the API directly so a fetch FAILURE is distinguishable from "no forms"
    // (the store helper returns [] either way), letting us show error + retry.
    const result = await api.getAppForms(appId);
    if (loadTokenRef.current !== token) return;
    if (result.error) {
      setLoadError(typeof result.error === 'string' ? result.error : 'Could not load the app’s forms.');
      setLoading(false);
      return;
    }
    setLoadError(null);
    const forms = (result.data?.forms ?? []) as AppForm[];
    setAppForms(forms);

    // Build relation badges from linked_record fields
    const nameMap: Record<string, string> = {};
    forms.forEach((f) => { nameMap[f.formId] = f.displayName; });

    const results = await Promise.allSettled(forms.map((af) => api.getForm(af.formId)));
    const badges: Record<string, RelationBadge[]> = {};

    // Cache loaded form definitions for referential integrity checks
    const formDefsCache: Record<string, Form> = {};
    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled' || !result.value.data?.form) return;
      const form = result.value.data!.form as Form;
      const formId = forms[idx].formId;
      formDefsCache[formId] = form;

      form.fields
        .filter((f: FormField) => f.type === 'linked_record' && f.properties.targetFormId)
        .forEach((field: FormField) => {
          const targetId = field.properties.targetFormId!;
          const multi = !!field.properties.allowMultiple;
          // Outgoing badge on source form
          if (!badges[formId]) badges[formId] = [];
          badges[formId].push({
            type: 'outgoing',
            formName: nameMap[targetId] || allForms.find((af2) => af2.id === targetId)?.title || 'Removed form',
            fieldLabel: field.label,
            allowMultiple: multi,
          });
          // Incoming badge only when the target form is actually in this app
          if (nameMap[targetId]) {
            if (!badges[targetId]) badges[targetId] = [];
            badges[targetId].push({
              type: 'incoming',
              formName: nameMap[formId] || form.title,
              fieldLabel: field.label,
              allowMultiple: multi,
            });
          }
        });
    });

    if (loadTokenRef.current !== token) return;
    setRelationBadges(badges);
    loadedFormsRef.current = formDefsCache;
    setLoading(false);
  };

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
  const availableForms = allForms.filter((f) => !includedFormIds.includes(f.id) && !packFormIds.has(f.id));

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
    // Check if any other forms have linked_record fields targeting this form
    const nameMap: Record<string, string> = {};
    appForms.forEach((f) => { nameMap[f.formId] = f.displayName; });
    const formName = nameMap[formId] || formId;

    const affectedFields: Array<{ formName: string; fieldLabel: string }> = [];
    for (const [otherFormId, formDef] of Object.entries(loadedFormsRef.current)) {
      if (otherFormId === formId) continue;
      for (const field of formDef.fields) {
        if (field.type === 'linked_record' && field.properties.targetFormId === formId) {
          affectedFields.push({
            formName: nameMap[otherFormId] || formDef.title,
            fieldLabel: field.label,
          });
        }
      }
    }

    // Always confirm — removing a form from an app is a meaningful action even
    // when nothing links to it (it stops collecting in the app + can lose relations).
    const af = appForms.find((f) => f.formId === formId);
    setRemoveConfirm({ formId, formName, affectedFields, sharedWith: af ? getSharedApps(af) : [] });
  };

  const handleRemoveConfirmed = async (formId: string) => {
    if (!appId) return;
    setRemoveConfirm(null);
    setBusyFormId(formId);
    await removeFormFromApp(appId, formId);
    await loadForms();
    setBusyFormId(null);
  };

  const handleToggleVisibility = async (formId: string, currentlyVisible: boolean) => {
    if (!appId) return;
    setBusyFormId(formId);
    await updateAppForm(appId, formId, { isVisible: !currentlyVisible });
    await loadForms();
    setBusyFormId(null);
  };

  // Reorder the runtime nav order (sort_order). Optimistic, rolls back on failure.
  const handleMove = async (index: number, dir: -1 | 1) => {
    if (!appId) return;
    const target = index + dir;
    if (target < 0 || target >= appForms.length) return;
    const reordered = [...appForms];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setAppForms(reordered);
    // The store resolves (never throws) and returns false on failure, so check
    // the result and reload to the true server order on failure.
    const ok = await reorderAppForms(appId, reordered.map((f) => f.formId));
    if (!ok) await loadForms();
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

  if (loading) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading forms" /></div>;
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-4">
        <p className="text-sm text-gray-600 dark:text-slate-300">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => loadForms()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header
        title="Manage forms"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${appId}/settings?tab=manage`)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto">

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Available forms */}
        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4">
          <h3 className="font-medium text-gray-900 dark:text-white mb-3 tracking-tight">Available forms</h3>
          <p className="text-xs text-gray-400 dark:text-slate-500 -mt-2 mb-3">Your forms not yet in this app. Adding a form that another app already uses shares it — both apps read and write the same data.</p>
          {availableForms.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-400 py-4 text-center">
              {allForms.length === 0 ? 'No forms created yet. Create forms first.' : 'No forms to add — all your forms are already in this app or managed by a pack.'}
            </p>
          ) : (
            <div className="space-y-2">
              {availableForms.map((form) => {
                const usedBy = formAppUsage[form.id] ?? [];
                return (
                <div key={form.id} className="flex items-center justify-between gap-2 p-3 rounded-xl border border-gray-200/80 dark:border-slate-700/60 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 flex-1">
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
                  <button onClick={() => handleAdd(form.id)} disabled={busyFormId === form.id} aria-label={`Add ${form.title}`} className="flex-shrink-0 p-1.5 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 text-primary-600 dark:text-primary-400 disabled:opacity-50 transition-colors cursor-pointer">
                    {busyFormId === form.id ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" /> : <Plus className="h-4 w-4" />}
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Included forms */}
        <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4">
          <h3 className="font-medium text-gray-900 dark:text-white mb-3 tracking-tight">Included forms ({appForms.length})</h3>
          {appForms.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-400 py-4 text-center">No forms included yet</p>
          ) : (
            <div className="space-y-2">
              {appForms.map((af, index) => {
                const sharedApps = getSharedApps(af);
                return (
                <div key={af.formId} className="p-3 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-gray-50 dark:bg-slate-800/50">
                  <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="flex flex-col -my-1 flex-shrink-0">
                    <button onClick={() => handleMove(index, -1)} disabled={index === 0} aria-label="Move up" className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-30 disabled:cursor-default cursor-pointer">
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => handleMove(index, 1)} disabled={index === appForms.length - 1} aria-label="Move down" className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-30 disabled:cursor-default cursor-pointer">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {editingNameId === af.formId ? (
                    <input
                      autoFocus
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveRename(af.formId); if (e.key === 'Escape') setEditingNameId(null); }}
                      onBlur={() => saveRename(af.formId)}
                      aria-label="Display name"
                      className="flex-1 min-w-0 text-sm px-2 py-1 rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:outline-none"
                    />
                  ) : (
                    <span className="text-sm font-medium text-gray-900 dark:text-white flex-1 min-w-0 truncate">{af.displayName}</span>
                  )}
                  </div>
                  {/* Action cluster — wraps to its own line on narrow screens (flex-wrap
                      on the row) so the name isn't squeezed and targets stay tappable. */}
                  <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto">
                  {editingNameId === af.formId ? (
                    <button onMouseDown={(e) => { e.preventDefault(); saveRename(af.formId); }} aria-label="Save name" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-green-600 transition-colors cursor-pointer">
                      <Check className="h-4 w-4" />
                    </button>
                  ) : (
                    <button onClick={() => startRename(af)} aria-label={`Rename ${af.displayName}`} title="Rename display label" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors cursor-pointer">
                      <Tag className="h-4 w-4" />
                    </button>
                  )}
                  <button onClick={() => navigate(`/builder/${af.formId}?appId=${appId}`)} aria-label={`Edit ${af.displayName}`} title="Edit form" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors cursor-pointer">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleToggleVisibility(af.formId, af.isVisible)} disabled={busyFormId === af.formId} aria-label={af.isVisible ? 'Hide form' : 'Show form'} className={cn('p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors cursor-pointer', af.isVisible ? 'text-green-600' : 'text-gray-400')}>
                    {af.isVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                  <button onClick={() => handleRemoveRequest(af.formId)} disabled={busyFormId === af.formId} aria-label={`Remove ${af.displayName}`} className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 transition-colors cursor-pointer">
                    {busyFormId === af.formId ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" /> : <X className="h-4 w-4" />}
                  </button>
                  </div>
                  </div>
                  {/* Shared-data + relation badges */}
                  {(sharedApps.length > 0 || relationBadges[af.formId]?.length > 0) && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {sharedApps.length > 0 && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
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
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
                            badge.type === 'outgoing'
                              ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                              : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
                          )}
                          title={badge.type === 'outgoing'
                            ? `"${badge.fieldLabel}" links to ${badge.formName}`
                            : `${badge.formName} links here via "${badge.fieldLabel}"`
                          }
                        >
                          {badge.type === 'outgoing' ? <Link2 className="h-3 w-3" /> : <ArrowLeftIcon className="h-3 w-3" />}
                          <span className="font-medium">{badge.fieldLabel}</span>
                          <span className="opacity-60">{badge.type === 'outgoing' ? '\u2192' : '\u2190'} {badge.formName}</span>
                          <span className="opacity-50">{badge.allowMultiple ? '1:N' : '1:1'}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
    </div>

      {/* Referential integrity warning dialog */}
      <ConfirmDialog
        isOpen={!!removeConfirm}
        onClose={() => setRemoveConfirm(null)}
        onConfirm={() => removeConfirm && handleRemoveConfirmed(removeConfirm.formId)}
        title={removeConfirm && removeConfirm.affectedFields.length > 0 ? 'Linked record dependencies' : 'Remove form from app?'}
        message={removeConfirm
          ? (removeConfirm.affectedFields.length > 0
              ? `Removing "${removeConfirm.formName}" will break linked record fields in the following forms:\n\n${removeConfirm.affectedFields.map((af) => `- ${af.formName}: "${af.fieldLabel}"`).join('\n')}\n\n${removeConfirm.sharedWith.length > 0 ? `The form and its data stay in ${removeConfirm.sharedWith.join(', ')} — nothing is deleted.\n\n` : ''}Are you sure you want to remove this form?`
              : (removeConfirm.sharedWith.length > 0
                  ? `Remove "${removeConfirm.formName}" from this app? It will stop appearing here, but the form and all of its responses stay in ${removeConfirm.sharedWith.join(', ')} — nothing is deleted.`
                  : `Remove "${removeConfirm.formName}" from this app? It will stop appearing in the app. The form and its responses are kept.`))
          : ''}
        confirmLabel={removeConfirm && removeConfirm.affectedFields.length > 0 ? 'Remove anyway' : 'Remove'}
        variant="danger"
      />
    </div>
  );
}
