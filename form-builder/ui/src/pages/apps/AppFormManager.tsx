import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, X, Eye, EyeOff, Pencil, Link2, ArrowLeftIcon } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
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
  const { fetchAppForms, addFormToApp, removeFormFromApp, updateAppForm } = useAppStore();
  const { forms: allForms, refreshForms } = useFormStore();
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyFormId, setBusyFormId] = useState<string | null>(null);
  const [relationBadges, setRelationBadges] = useState<Record<string, RelationBadge[]>>({});

  const loadForms = async () => {
    if (!appId) return;
    setLoading(true);
    const forms = await fetchAppForms(appId);
    setAppForms(forms);

    // Build relation badges from linked_record fields
    const nameMap: Record<string, string> = {};
    forms.forEach((f) => { nameMap[f.formId] = f.displayName; });

    const results = await Promise.all(forms.map((af) => api.getForm(af.formId)));
    const badges: Record<string, RelationBadge[]> = {};

    results.forEach((res, idx) => {
      if (!res.data?.form) return;
      const form = res.data.form as Form;
      const formId = forms[idx].formId;

      form.fields
        .filter((f: FormField) => f.type === 'linked_record' && f.properties.targetFormId)
        .forEach((field: FormField) => {
          const targetId = field.properties.targetFormId!;
          const multi = !!field.properties.allowMultiple;
          // Outgoing badge on source form
          if (!badges[formId]) badges[formId] = [];
          badges[formId].push({
            type: 'outgoing',
            formName: nameMap[targetId] || targetId,
            fieldLabel: field.label,
            allowMultiple: multi,
          });
          // Incoming badge on target form
          if (!badges[targetId]) badges[targetId] = [];
          badges[targetId].push({
            type: 'incoming',
            formName: nameMap[formId] || form.title,
            fieldLabel: field.label,
            allowMultiple: multi,
          });
        });
    });

    setRelationBadges(badges);
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

  const includedFormIds = appForms.map((f) => f.formId);
  const availableForms = allForms.filter((f) => !includedFormIds.includes(f.id));

  const handleAdd = async (formId: string) => {
    if (!appId) return;
    setBusyFormId(formId);
    await addFormToApp(appId, formId);
    await loadForms();
    setBusyFormId(null);
  };

  const handleRemove = async (formId: string) => {
    if (!appId) return;
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

  if (loading) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" /></div>;
  }

  return (
    <div className="min-h-screen">
      <Header
        title="Manage Forms"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${appId}/settings`)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto">

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Available forms */}
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-4">
          <h3 className="font-medium text-gray-900 dark:text-white mb-3">Available Forms</h3>
          {availableForms.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-500 py-4 text-center">
              {allForms.length === 0 ? 'No forms created yet. Create forms first.' : 'All forms are already included.'}
            </p>
          ) : (
            <div className="space-y-2">
              {availableForms.map((form) => (
                <div key={form.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800">
                  <div>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{form.title}</span>
                    <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">{form.status}</span>
                  </div>
                  <button onClick={() => handleAdd(form.id)} disabled={busyFormId === form.id} aria-label={`Add ${form.title}`} className="p-1.5 rounded-md hover:bg-primary-50 dark:hover:bg-primary-500/10 text-primary-600 dark:text-primary-400 disabled:opacity-50 transition-colors">
                    {busyFormId === form.id ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" /> : <Plus className="h-4 w-4" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Included forms */}
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 p-4">
          <h3 className="font-medium text-gray-900 dark:text-white mb-3">Included Forms ({appForms.length})</h3>
          {appForms.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-500 py-4 text-center">No forms included yet</p>
          ) : (
            <div className="space-y-2">
              {appForms.map((af) => (
                <div key={af.formId} className="p-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                  <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-white flex-1">{af.displayName}</span>
                  <button onClick={() => navigate(`/builder/${af.formId}?appId=${appId}`)} aria-label={`Edit ${af.displayName}`} className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleToggleVisibility(af.formId, af.isVisible)} disabled={busyFormId === af.formId} aria-label={af.isVisible ? 'Hide form' : 'Show form'} className={cn('p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors', af.isVisible ? 'text-green-600' : 'text-gray-400')}>
                    {af.isVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                  <button onClick={() => handleRemove(af.formId)} disabled={busyFormId === af.formId} aria-label={`Remove ${af.displayName}`} className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 transition-colors">
                    {busyFormId === af.formId ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" /> : <X className="h-4 w-4" />}
                  </button>
                  </div>
                  {/* Relation badges */}
                  {relationBadges[af.formId]?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {relationBadges[af.formId].map((badge, i) => (
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
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
    </div>
  );
}
