import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { forwardReturnTo, useReturnTo } from '../../hooks/useReturnTo';
import { ArrowRight, Plus, Trash2, Link2, ExternalLink, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useResourcePaths } from '../../components/admin/AdminActingContext';
import { Header } from '../../components/layout/Header';
import { PageBody, PAGE_GUTTER } from '../../components/layout/PageBody';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RelationFormModal } from './RelationFormModal';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { deferEffect } from '../../lib/deferredEffect';
import { saveFormFields } from '../../lib/formFields';
import type { Form, FormField } from '../../types/form';
import type { AppForm } from '../../types/app';

interface Relation {
  sourceFormId: string;
  sourceFormName: string;
  targetFormId: string;
  targetFormName: string;
  field: FormField;
}

export function AppRelationsManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const paths = useResourcePaths();
  // Origin-relative Back: opened from the App Studio this returns to its section.
  const backTo = useReturnTo(paths.appSub(`${appId}`, 'settings?tab=manage'));
  const { fetchAppForms } = useAppStore();

  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  // Forms that could not be read: their relations are unknown, not absent.
  const [unreadableForms, setUnreadableForms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Relation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadRelations = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!appId) return;
    setLoading(true);

    const forms = await fetchAppForms(appId);
    if (isCancelled()) return;
    setAppForms(forms);

    // Build a name map from app forms
    const nameMap: Record<string, string> = {};
    forms.forEach((f) => { nameMap[f.formId] = f.displayName; });

    // Fetch full form data for each app form to find linked_record fields
    const results = await Promise.allSettled(
      forms.map((af) => api.getForm(af.formId))
    );
    if (isCancelled()) return;

    const rels: Relation[] = [];
    const unreadable: string[] = [];
    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled' || !result.value.data?.form) {
        unreadable.push(forms[idx].displayName);
        return;
      }
      const form = result.value.data!.form as Form;
      form.fields
        .filter((f) => f.type === 'linked_record' && f.properties.targetFormId)
        .forEach((field) => {
          rels.push({
            sourceFormId: forms[idx].formId,
            sourceFormName: nameMap[forms[idx].formId] || form.title,
            targetFormId: field.properties.targetFormId!,
            targetFormName: nameMap[field.properties.targetFormId!] || field.properties.targetFormId!,
            field,
          });
        });
    });

    setRelations(rels);
    setUnreadableForms(unreadable);
    setLoading(false);
  }, [appId, fetchAppForms]);

  useEffect(() => {
    let cancelled = false;
    const cancelStart = deferEffect(() => { void loadRelations(() => cancelled); });
    return () => { cancelled = true; cancelStart(); };
  }, [loadRelations]);

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);

    try {
      const res = await api.getForm(deleteTarget.sourceFormId);
      if (!res.data?.form) {
        throw new Error('Could not load the source form. It may have been deleted.');
      }
      const form = res.data.form as Form;
      const updatedFields = form.fields.filter((f) => f.id !== deleteTarget.field.id);
      // A refusal comes back as a value rather than a throw, so discarding it turned
      // every one (permission, validation, a private form demanding an encryptionSchema)
      // into a silent no-op: the dialog closed, the list reloaded, and the relation was
      // still there with no message at all.
      const upd = await saveFormFields(deleteTarget.sourceFormId, updatedFields, { fieldsRevision: form.fieldsRevision });
      if (!upd.ok) {
        setDeleteError(upd.error ?? 'Could not delete the relation.');
        setDeleting(false);
        return;
      }
      setDeleteTarget(null);
      await loadRelations();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete relation');
    }
    setDeleting(false);
  };

  const handleEdit = (rel: Relation) => {
    // Navigate to the form builder — the linked_record field can be fully configured there.
    // Carry the origin so the builder's Back returns here, not to the global Forms list.
    navigate(paths.builder(rel.sourceFormId, appId), {
      state: forwardReturnTo(`${location.pathname}${location.search}`, 'Relations', backTo),
    });
  };

  const handleAdd = () => {
    setModalOpen(true);
  };

  const handleModalSave = async () => {
    setModalOpen(false);
    await loadRelations();
  };

  const back = { onClick: () => navigate(backTo.path, { state: backTo.state }), label: backTo.label ? `Back to ${backTo.label}` : 'Back to app settings' };

  // The page's frame from the first paint: the header and Back, then what is known so far.
  if (loading) {
    return (
      <div className="min-h-screen">
        <Header title="Relations" back={back} />
        <div className={cn('flex items-center gap-3 py-8 text-sm text-gray-500 dark:text-slate-400', PAGE_GUTTER)}>
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading relations" />
          Loading relations…
        </div>
      </div>
    );
  }

  const kind = (rel: Relation) => rel.field.properties.allowMultiple ? '1 : N' : '1 : 1';
  const shows = (rel: Relation) => {
    const count = rel.field.properties.displayFieldIds?.length ?? 0;
    return count > 0 ? `${count} display field${count !== 1 ? 's' : ''} configured` : '';
  };
  /** What can be done with a relation; `finger` draws the two at a touch target's size. */
  const actions = (rel: Relation, finger: boolean) => {
    const button = cn(
      'inline-flex flex-none cursor-pointer items-center justify-center text-gray-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400',
      finger ? 'h-11 w-11 rounded-lg' : 'h-8 w-8 rounded-md',
    );
    return (
      <>
        <button type="button" onClick={() => handleEdit(rel)} aria-label={`Edit ${rel.field.label} in builder`} title="Open in Form Builder for full configuration"
          className={cn(button, 'hover:bg-gray-100 hover:text-primary-700 dark:hover:bg-white/5 dark:hover:text-primary-300')}>
          <ExternalLink className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setDeleteTarget(rel)} aria-label="Delete relation" title="Delete relation"
          className={cn(button, 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400')}>
          <Trash2 className="h-4 w-4" />
        </button>
      </>
    );
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Relations"
        back={back}
        actions={
          <>
            <Button size="sm" aria-label="Add relation" onClick={handleAdd} disabled={appForms.length < 2} title={appForms.length < 2 ? 'Add at least two forms to this app first' : undefined} leftIcon={<Plus className="h-4 w-4" />}>
              <span className="hidden @xl/header:inline">Add relation</span>
            </Button>
          </>
        }
      />

      {/* Left-aligned and as wide as the page: the relations as one table, a row each, with the
          forms it joins in columns of their own. On a phone the same rows are cards. */}
      <PageBody>
        <p className="mb-3 text-sm text-gray-500 dark:text-slate-400">A relation is a linked-record field: it lets a record in one form point at a record in another.</p>
        {deleteError && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
            <span>{deleteError}</span>
            <button onClick={() => setDeleteError(null)} className="ml-2 inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg text-red-400 hover:text-red-600 max-sm:h-11 max-sm:w-11 dark:hover:text-red-300" aria-label="Dismiss error">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {unreadableForms.length > 0 && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
            <span>Could not load {unreadableForms.join(', ')}, so any relations from {unreadableForms.length === 1 ? 'that form' : 'those forms'} are not shown here.</span>
            <Button variant="ghost" size="sm" onClick={() => void loadRelations()}>Try again</Button>
          </div>
        )}
        {relations.length === 0 && unreadableForms.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 p-5 dark:border-slate-700">
            <Link2 className="h-6 w-6 text-primary-600 dark:text-primary-400" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">No relations yet</h2>
            <p className="mb-4 mt-1 max-w-2xl text-sm text-gray-500 dark:text-slate-400">
              {appForms.length < 2
                ? 'A relation links records between two forms. Add at least two forms to this app first.'
                : 'Relations link records between forms. Create one to connect your data.'}
            </p>
            <Button size="sm" aria-label="Add relation" onClick={handleAdd} disabled={appForms.length < 2} leftIcon={<Plus className="h-4 w-4" />}>
              Add relation
            </Button>
          </div>
        ) : relations.length > 0 && (
          <div className="@container/list">
            {/* A phone: a card per relation. Nothing scrolls sideways, and every action is a finger wide. */}
            <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm @xl/list:hidden dark:border-slate-700 dark:bg-slate-900/60">
              {relations.map((rel) => (
                <li key={`${rel.sourceFormId}-${rel.field.id}`} className="flex items-center gap-2 border-b border-gray-100 py-1.5 pl-3 pr-1 last:border-b-0 dark:border-slate-800">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-[15px] font-semibold text-gray-900 dark:text-white">{rel.field.label}</span>
                      <span className="flex-none rounded bg-primary-50 px-1.5 py-0.5 text-[10px] font-semibold text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">{kind(rel)}</span>
                    </p>
                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
                      <span className="min-w-0 truncate">{rel.sourceFormName}</span>
                      <ArrowRight className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
                      <span className="min-w-0 truncate">{rel.targetFormName}</span>
                    </p>
                    {shows(rel) && <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{shows(rel)}</p>}
                  </div>
                  <span className="flex flex-none items-center">{actions(rel, true)}</span>
                </li>
              ))}
            </ul>

            {/* With room for it: the table. */}
            <div className="hidden overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm @xl/list:block dark:border-slate-700 dark:bg-slate-900/60">
              <table className="w-full table-fixed border-collapse text-left text-[13px] leading-5">
                <caption className="sr-only">Relations between this app’s forms</caption>
                <thead className="border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
                  <tr>
                    <th scope="col" className="h-8 py-0 pl-3 pr-2 font-semibold uppercase tracking-wider">Relation</th>
                    <th scope="col" className="w-[22%] px-2 font-semibold uppercase tracking-wider">From</th>
                    <th scope="col" className="w-[22%] px-2 font-semibold uppercase tracking-wider">To</th>
                    <th scope="col" className="w-16 px-2 font-semibold uppercase tracking-wider">Kind</th>
                    <th scope="col" className="hidden w-52 px-2 font-semibold uppercase tracking-wider @4xl/list:table-cell">Shows</th>
                    <th scope="col" className="w-[84px] px-2 pr-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {relations.map((rel) => (
                    <tr key={`${rel.sourceFormId}-${rel.field.id}`} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
                      <th scope="row" className="py-1 pl-3 pr-2 font-normal">
                        <div className="flex min-w-0 items-center gap-2">
                          <Link2 className="h-4 w-4 flex-none text-primary-600 dark:text-primary-400" aria-hidden="true" />
                          <span className="min-w-0 truncate font-semibold text-gray-900 dark:text-white">{rel.field.label}</span>
                        </div>
                      </th>
                      <td className="truncate px-2 text-gray-700 dark:text-slate-300">{rel.sourceFormName}</td>
                      <td className="px-2 text-gray-700 dark:text-slate-300">
                        <span className="flex min-w-0 items-center gap-1.5"><ArrowRight className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" /><span className="truncate">{rel.targetFormName}</span></span>
                      </td>
                      <td className="px-2 tabular-nums text-gray-700 dark:text-slate-300">{kind(rel)}</td>
                      <td className="hidden truncate px-2 text-gray-500 @4xl/list:table-cell dark:text-slate-400">{shows(rel)}</td>
                      <td className="py-0.5 pl-2 pr-2 text-right"><span className="inline-flex items-center justify-end gap-0.5">{actions(rel, false)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-gray-200 px-3 py-1.5 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">
                {relations.length.toLocaleString()} relation{relations.length === 1 ? '' : 's'} across {appForms.length.toLocaleString()} form{appForms.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>
        )}
      </PageBody>

      {/* Add modal (create-only — edit goes to builder) */}
      <RelationFormModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleModalSave}
        appForms={appForms}
        existing={null}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete relation"
        message={deleteTarget ? `Remove the "${deleteTarget.field.label}" linked-record field from "${deleteTarget.sourceFormName}"? This will also remove any existing linked data for this field.` : ''}
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleting}
      />
    </div>
  );
}
