import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { forwardReturnTo, useReturnTo } from '../../hooks/useReturnTo';
import { ArrowLeft, ArrowRight, Plus, Trash2, Link2, ExternalLink, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useResourcePaths } from '../../components/admin/AdminActingContext';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RelationFormModal } from './RelationFormModal';
import { api } from '../../lib/api';
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
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Relation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadRelations = useCallback(async () => {
    if (!appId) return;
    setLoading(true);

    const forms = await fetchAppForms(appId);
    setAppForms(forms);

    // Build a name map from app forms
    const nameMap: Record<string, string> = {};
    forms.forEach((f) => { nameMap[f.formId] = f.displayName; });

    // Fetch full form data for each app form to find linked_record fields
    const results = await Promise.allSettled(
      forms.map((af) => api.getForm(af.formId))
    );

    const rels: Relation[] = [];
    results.forEach((result, idx) => {
      if (result.status !== 'fulfilled' || !result.value.data?.form) return;
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
    setLoading(false);
  }, [appId, fetchAppForms]);

  useEffect(() => {
    loadRelations();
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
      await api.updateForm(deleteTarget.sourceFormId, { fields: updatedFields });
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

  if (loading) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 dark:border-primary-400" role="status" aria-label="Loading relations" /></div>;
  }

  return (
    <div className="min-h-screen">
      <Header
        title="Relations"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(backTo.path, { state: backTo.state })} leftIcon={<ArrowLeft className="h-4 w-4" />}>
              {backTo.label ? `Back to ${backTo.label}` : 'Back'}
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={appForms.length < 2} title={appForms.length < 2 ? 'Add at least two forms to this app first' : undefined} leftIcon={<Plus className="h-4 w-4" />}>
              Add relation
            </Button>
          </>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        <div className="max-w-5xl mx-auto">
          {deleteError && (
            <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-4 py-3 rounded-lg mb-4 border border-red-100 dark:border-red-500/20">
              <span>{deleteError}</span>
              <button onClick={() => setDeleteError(null)} className="ml-2 text-red-400 hover:text-red-600 dark:hover:text-red-300" aria-label="Dismiss error">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {relations.length === 0 ? (
            <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-12 text-center">
              <div className="mx-auto w-12 h-12 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-4">
                <Link2 className="h-6 w-6 text-primary-600 dark:text-primary-400" />
              </div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1 tracking-tight">No relations yet</h3>
              <p className="text-sm text-gray-500 dark:text-slate-400 mb-6 max-w-sm mx-auto">
                {appForms.length < 2
                  ? 'A relation links records between two forms. Add at least two forms to this app first.'
                  : 'Relations link records between forms. Create one to connect your data.'}
              </p>
              <Button size="sm" onClick={handleAdd} disabled={appForms.length < 2} leftIcon={<Plus className="h-4 w-4" />}>
                Add relation
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {relations.map((rel) => (
                <div
                  key={`${rel.sourceFormId}-${rel.field.id}`}
                  className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4 hover:border-gray-300 dark:hover:border-slate-600 transition-all duration-200"
                >
                  {/* Relation label */}
                  <div className="flex items-center gap-2 mb-3">
                    <Link2 className="h-4 w-4 text-primary-600 dark:text-primary-400 shrink-0" />
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{rel.field.label}</span>
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400">
                      {rel.field.properties.allowMultiple ? '1 : N' : '1 : 1'}
                    </span>
                  </div>

                  {/* Source -> Target */}
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-slate-800/50">
                    <span className="text-xs font-medium text-gray-500 dark:text-slate-400 truncate">{rel.sourceFormName}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-gray-400 dark:text-slate-500 shrink-0" />
                    <span className="text-xs font-medium text-gray-500 dark:text-slate-400 truncate">{rel.targetFormName}</span>
                  </div>

                  {/* Display fields badge */}
                  {(rel.field.properties.displayFieldIds?.length ?? 0) > 0 && (
                    <p className="text-xs text-gray-400 dark:text-slate-500 mb-3">
                      {rel.field.properties.displayFieldIds!.length} display field{rel.field.properties.displayFieldIds!.length !== 1 ? 's' : ''} configured
                    </p>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1 border-t border-gray-100 dark:border-slate-800 pt-3">
                    <button
                      onClick={() => handleEdit(rel)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors cursor-pointer"
                      title="Open in Form Builder for full configuration"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Edit in builder
                    </button>
                    <button
                      onClick={() => setDeleteTarget(rel)}
                      className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer ml-auto"
                      aria-label="Delete relation"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

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
