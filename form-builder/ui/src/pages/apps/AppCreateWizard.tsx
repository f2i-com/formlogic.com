import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Globe, FileText, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { cn } from '../../lib/utils';

const steps = ['App Details', 'Select Forms', 'Review'];

export function AppCreateWizard() {
  const navigate = useNavigate();
  const { createApp } = useAppStore();
  const { forms } = useFormStore();
  const [step, setStep] = useState(0);
  const [isCreating, setIsCreating] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedFormIds, setSelectedFormIds] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);

  const canNext = step === 0 ? name.trim().length > 0 : true;

  const validateName = () => {
    if (!name.trim()) {
      setNameError('App name is required');
      return false;
    }
    if (name.trim().length < 2) {
      setNameError('Name must be at least 2 characters');
      return false;
    }
    setNameError(null);
    return true;
  };

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const app = await createApp({ name, description: description || undefined });
      if (app) {
        let failedCount = 0;
        for (const formId of selectedFormIds) {
          const added = await useAppStore.getState().addFormToApp(app.id, formId);
          if (!added) failedCount++;
        }
        if (failedCount > 0) {
          toast.warning('Partial success', `App created but ${failedCount} form(s) could not be added.`);
        }
        navigate(`/apps/${app.id}/settings`);
        return; // Skip setIsCreating after navigate
      } else {
        toast.error('Creation failed', 'Could not create the app. Please try again.');
      }
    } catch {
      toast.error('Creation failed', 'An unexpected error occurred. Please try again.');
    }
    setIsCreating(false);
  };

  const toggleForm = (formId: string) => {
    setSelectedFormIds((prev) =>
      prev.includes(formId) ? prev.filter((id) => id !== formId) : [...prev, formId]
    );
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Create New App"
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate('/apps')} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            Back
          </Button>
        }
      />
      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
      <div className="max-w-2xl mx-auto">

      {/* Step indicator */}
      <div className="flex items-center mb-8">
        {steps.map((label, i) => (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            <div className="flex items-center gap-2">
              <div className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all',
                i < step ? 'bg-primary-600 text-primary-foreground shadow-sm' :
                i === step ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-400 ring-2 ring-primary-600' :
                'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-500'
              )}>
                {i < step ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span className={cn('text-sm hidden sm:inline', i === step ? 'text-gray-900 dark:text-white font-medium' : i < step ? 'text-gray-600 dark:text-slate-300' : 'text-gray-400 dark:text-slate-500')}>{label}</span>
            </div>
            {i < steps.length - 1 && <div className={cn('flex-1 h-px mx-3', i < step ? 'bg-primary-400' : 'bg-gray-200 dark:bg-slate-700')} />}
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-6">
        {step === 0 && (
          <div className="space-y-4">
            <Input
              label="App Name *"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }}
              onBlur={validateName}
              placeholder="My Application"
              error={nameError ?? undefined}
              autoFocus
            />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this app do?"
              rows={3}
            />
          </div>
        )}

        {step === 1 && (
          <div>
            <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Select forms to include in your app. You can add more later.</p>
            {forms.length === 0 ? (
              <div className="text-center py-8">
                <FileText className="h-8 w-8 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
                <p className="text-gray-400 dark:text-slate-500 mb-4">No forms available yet.</p>
                <Button size="sm" variant="outline" onClick={() => navigate('/builder')} leftIcon={<Plus className="h-4 w-4" />}>
                  Create a Form
                </Button>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {forms.map((form) => (
                  <label
                    key={form.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200',
                      selectedFormIds.includes(form.id)
                        ? 'border-primary-300 dark:border-primary-500/30 bg-primary-50 dark:bg-primary-500/10'
                        : 'border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedFormIds.includes(form.id)}
                      onChange={() => toggleForm(form.id)}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{form.title}</span>
                      {form.description && <p className="text-xs text-gray-500 dark:text-slate-400">{form.description}</p>}
                    </div>
                    <span className={cn('ml-auto text-xs px-2 py-0.5 rounded-full', form.status === 'published' ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400')}>
                      {form.status}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-slate-800 rounded-xl">
              <Globe className="h-10 w-10 text-primary-600 dark:text-primary-400" />
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white tracking-tight">{name}</h3>
                {description && <p className="text-sm text-gray-500 dark:text-slate-400">{description}</p>}
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Included Forms ({selectedFormIds.length})</h4>
              {selectedFormIds.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">No forms selected</p>
              ) : (
                <ul className="space-y-1">
                  {selectedFormIds.map((id) => {
                    const form = forms.find((f) => f.id === id);
                    return form ? (
                      <li key={id} className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary-500" />
                        {form.title}
                      </li>
                    ) : null;
                  })}
                </ul>
              )}
            </div>
            <p className="text-xs text-gray-400 dark:text-slate-500">Default roles (Owner, Admin, Member) will be created automatically.</p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-6">
        <Button
          variant="ghost"
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
          leftIcon={<ArrowLeft className="h-4 w-4" />}
        >
          Back
        </Button>

        {step < steps.length - 1 ? (
          <Button
            onClick={() => { if (step === 0 && !validateName()) return; setStep(step + 1); }}
            disabled={!canNext}
            rightIcon={<ArrowRight className="h-4 w-4" />}
          >
            Next
          </Button>
        ) : (
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? 'Creating...' : 'Create App'}
          </Button>
        )}
      </div>
    </div>
    </div>
    </div>
  );
}
