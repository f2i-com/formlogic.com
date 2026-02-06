import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, X, GripVertical, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/utils';
import type { AppForm } from '../../types/app';

export function AppFormManager() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { fetchAppForms, addFormToApp, removeFormFromApp, updateAppForm } = useAppStore();
  const { forms: allForms, refreshForms } = useFormStore();
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [loading, setLoading] = useState(true);

  const loadForms = async () => {
    if (!appId) return;
    setLoading(true);
    const forms = await fetchAppForms(appId);
    setAppForms(forms);
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
    await addFormToApp(appId, formId);
    await loadForms();
  };

  const handleRemove = async (formId: string) => {
    if (!appId) return;
    await removeFormFromApp(appId, formId);
    await loadForms();
  };

  const handleToggleVisibility = async (formId: string, currentlyVisible: boolean) => {
    if (!appId) return;
    await updateAppForm(appId, formId, { isVisible: !currentlyVisible });
    await loadForms();
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
                    <span className="ml-2 text-xs text-gray-400">{form.status}</span>
                  </div>
                  <button onClick={() => handleAdd(form.id)} className="p-1 rounded-md hover:bg-primary-50 dark:hover:bg-primary-500/10 text-primary-600 dark:text-primary-400">
                    <Plus className="h-4 w-4" />
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
                <div key={af.formId} className="flex items-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                  <GripVertical className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-900 dark:text-white flex-1">{af.displayName}</span>
                  <button onClick={() => handleToggleVisibility(af.formId, af.isVisible)} className={cn('p-1 rounded-md', af.isVisible ? 'text-green-600' : 'text-gray-400')}>
                    {af.isVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                  <button onClick={() => handleRemove(af.formId)} className="p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600">
                    <X className="h-4 w-4" />
                  </button>
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
