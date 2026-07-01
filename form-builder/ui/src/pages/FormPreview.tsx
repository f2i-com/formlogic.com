import { useState, useMemo, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Monitor, Smartphone, ExternalLink, ChevronUp, ChevronDown, Share2, ClipboardCheck } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Button } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { FieldResponse } from './FormResponse';
import { CustomScreenRuntime } from '../components/custom-screen/CustomScreenRuntime';
import { useFormStore } from '../stores/formStore';
import { useUIStore } from '../stores/uiStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { NigoDashboard } from '../components/builder/NigoDashboard';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import type { FormField } from '../types/form';

// Main Preview Component
export default function FormPreview() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const { getForm, loadFullForm } = useFormStore();
  const { previewDevice, setPreviewDevice, previewMode, setPreviewMode } = useUIStore();

  const reduceMotion = useReducedMotion();
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [showNigo, setShowNigo] = useState(false);
  const [calculatedValues, setCalculatedValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  const handleCalculated = useCallback((fId: string, val: unknown) => {
    setCalculatedValues(prev => {
      if (prev[fId] === val) return prev;
      return { ...prev, [fId]: val };
    });
  }, []);

  // Load full form data (with fields) from API when entering preview
  useEffect(() => {
    if (formId) loadFullForm(formId).finally(() => setLoaded(true));
  }, [formId, loadFullForm]);

  // Reset per-form preview state when switching forms. This is a single route
  // component reused across /preview/:formId, so without this, answers/step/
  // calculated values from the previous form leak into the next form (fields
  // sharing a slug id render pre-filled with the wrong value).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- per-form reset: must clear answers/step/calculated state synchronously when the formId route param changes
    setAnswers({});
    setCalculatedValues({});
    setCurrentStep(0);
    setLoaded(false);
  }, [formId]);

  const form = formId ? getForm(formId) : undefined;

  // Merge user answers with computed calculated field values
  const allFormData = useMemo(
    () => ({ ...answers, ...calculatedValues }),
    [answers, calculatedValues]
  );

  // Use conditional logic to determine field visibility
  const { isFieldVisible, isFieldRequired, isEvaluating } = useConditionalLogic(
    form?.fields ?? [],
    allFormData
  );

  // Get visible fields based on conditional logic
  const visibleFields = useMemo(() => {
    if (!form) return [];
    return form.fields.filter((f) => {
      // Hide the thank_you (post-submit) screen + hidden fields; welcome_screen IS a leading
      // step in both runtimes, so show it here too for true WYSIWYG.
      if (['thank_you', 'hidden'].includes(f.type)) return false;
      // Check conditional logic
      return isFieldVisible(f.id);
    });
  }, [form, isFieldVisible]);

  // Build sets for NigoDashboard
  const visibleFieldIds = useMemo(() => new Set(visibleFields.map((f) => f.id)), [visibleFields]);
  const requiredFieldIds = useMemo(() => {
    const s = new Set<string>();
    visibleFields.forEach((f) => {
      if (f.required || isFieldRequired(f.id)) s.add(f.id);
    });
    return s;
  }, [visibleFields, isFieldRequired]);

  // Clamp currentStep when visible fields shrink (e.g. conditional logic hides fields)
  useEffect(() => {
    if (visibleFields.length > 0 && currentStep >= visibleFields.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp persisted step back into state when conditional logic shrinks the visible-field list
      setCurrentStep(visibleFields.length - 1);
    }
  }, [visibleFields.length, currentStep]);

  if (!form && !loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" role="status" aria-label="Loading form" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950">
        <p className="text-gray-500 dark:text-slate-400">Form not found</p>
      </div>
    );
  }

  // A custom screen replaces the default form in preview too (owner context → live data).
  if (form.customScreen?.enabled && (form.customScreen.html || form.customScreen.js || form.customScreen.ts || form.customScreen.files?.length)) {
    return (
      <div className="h-screen w-full bg-white dark:bg-slate-950">
        <CustomScreenRuntime
          screen={form.customScreen}
          formId={form.id}
          formTitle={form.title}
          fields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
          className="w-full h-full border-0"
        />
      </div>
    );
  }

  // Ensure currentStep is within bounds when fields change
  const safeCurrentStep = Math.min(currentStep, Math.max(0, visibleFields.length - 1));
  const currentField = visibleFields[safeCurrentStep];
  const progress = visibleFields.length > 0 ? ((safeCurrentStep + 1) / visibleFields.length) * 100 : 0;
  const isLastStep = safeCurrentStep === visibleFields.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      // Preview is a design preview — it does NOT save a response. Be explicit so
      // it isn't mistaken for a real submission that should appear in the data list.
      toast.info('Preview only', "This is a preview — responses aren't saved. Publish your form and open its share link to collect real responses.");
    } else {
      setCurrentStep((s) => Math.min(s + 1, visibleFields.length - 1));
    }
  };

  const handlePrev = () => {
    setCurrentStep((s) => Math.max(s - 1, 0));
  };

  // Get dynamic required status for a field
  const getFieldRequired = (field: FormField) => {
    return field.required || isFieldRequired(field.id);
  };

  const handleAnswerChange = (fieldId: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [fieldId]: value }));
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex flex-col transition-colors duration-300">
      {/* Header */}
      <header className="h-14 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between px-4 flex-shrink-0 transition-colors duration-300">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/builder/${form.id}`)}>
            <ArrowLeft className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Exit Preview</span>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {/* Device toggle - hidden on mobile since it's responsive anyway */}
          <div className="hidden md:flex items-center bg-gray-100 dark:bg-slate-800 rounded-lg p-1 transition-colors duration-300">
            <button
              onClick={() => setPreviewDevice('desktop')}
              aria-label="Desktop preview"
              className={cn(
                'p-2 rounded-md transition-all duration-200 cursor-pointer',
                previewDevice === 'desktop'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              <Monitor className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPreviewDevice('mobile')}
              aria-label="Mobile preview"
              className={cn(
                'p-2 rounded-md transition-all duration-200 cursor-pointer',
                previewDevice === 'mobile'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              <Smartphone className="h-4 w-4" />
            </button>
          </div>

          {/* Mode toggle - simplified on mobile */}
          <div className="flex items-center bg-gray-100 dark:bg-slate-800 rounded-lg p-1 transition-colors duration-300">
            <button
              onClick={() => setPreviewMode('focused')}
              className={cn(
                'px-2 sm:px-3 py-1.5 text-xs sm:text-sm rounded-md transition-all duration-200 cursor-pointer',
                previewMode === 'focused'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              Focused
            </button>
            <button
              onClick={() => setPreviewMode('classic')}
              className={cn(
                'px-2 sm:px-3 py-1.5 text-xs sm:text-sm rounded-md transition-all duration-200 cursor-pointer',
                previewMode === 'classic'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              Classic
            </button>
          </div>

          {form.settings?.showNigoDashboard && (
            <Button
              variant={showNigo ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setShowNigo((v) => !v)}
              title="NIGO Dashboard"
            >
              <ClipboardCheck className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">NIGO</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowEmbedModal(true)}
            title="Share & Embed"
          >
            <Share2 className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Share</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/form/${form.id}`, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Open</span>
          </Button>
        </div>
      </header>

      {/* Embed Modal */}
      <EmbedModal
        isOpen={showEmbedModal}
        onClose={() => setShowEmbedModal(false)}
        formId={form.id}
        formTitle={form.title}
      />

      {/* Preview Area */}
      <div className="flex-1 flex items-center justify-center p-4 sm:p-8 relative overflow-hidden">
        <div
          className={cn(
            'bg-white rounded-2xl shadow-2xl overflow-hidden transition-all duration-300 bg-cover bg-center',
            previewDevice === 'mobile' ? 'w-full max-w-[375px] h-[667px] max-h-[calc(100vh-8rem)]' : 'w-full max-w-4xl h-[600px] max-h-[calc(100vh-8rem)]'
          )}
          style={{
            backgroundColor: form.theme.backgroundColor,
            backgroundImage: form.theme.backgroundImage ? `url(${form.theme.backgroundImage})` : undefined,
            color: form.theme.textColor,
            fontFamily: form.theme.fontFamily,
          }}
        >
          {visibleFields.length === 0 ? (
            <div className="h-full flex items-center justify-center opacity-50">
              <p>Add some fields to preview your form</p>
            </div>
          ) : previewMode === 'focused' ? (
            /* Focused Mode */
            <div className="h-full flex flex-col">
              {/* Progress */}
              <div className="p-4">
                <ProgressBar value={progress} size="sm" barColor={form.theme.primaryColor} />
                <p className="text-sm opacity-50 mt-2 text-right">
                  {safeCurrentStep + 1} of {visibleFields.length}
                  {isEvaluating && <span className="ml-2 animate-pulse">...</span>}
                </p>
              </div>

              {/* Content */}
              <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentField.id}
                    initial={{ opacity: 0, y: reduceMotion ? 0 : 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduceMotion ? 0 : -20 }}
                    transition={{ duration: reduceMotion ? 0 : 0.3 }}
                    className="w-full max-w-lg"
                  >
                    <FieldResponse
                      field={currentField}
                      value={answers[currentField.id]}
                      onChange={(val) => handleAnswerChange(currentField.id, val)}
                      isRequired={getFieldRequired(currentField)}
                      primaryColor={form.theme.primaryColor}
                      textColor={form.theme.textColor}
                      allAnswers={allFormData}
                      allFieldIds={form.fields.map(f => f.id)}
                      onCalculated={handleCalculated}
                      formId={formId}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Navigation */}
              <div className="p-4 flex items-center justify-between border-t border-current/10">
                <button
                  onClick={handlePrev}
                  disabled={safeCurrentStep === 0}
                  aria-label="Previous question"
                  className="p-2 opacity-40 hover:opacity-70 disabled:opacity-20 transition-opacity cursor-pointer disabled:cursor-not-allowed"
                >
                  <ChevronUp className="h-6 w-6" />
                </button>
                <Button onClick={handleNext} style={{ backgroundColor: form.theme.primaryColor }}>
                  {isLastStep ? 'Submit' : 'OK'} ✓
                </Button>
                <button
                  onClick={handleNext}
                  disabled={isLastStep}
                  aria-label="Next question"
                  className="p-2 opacity-40 hover:opacity-70 disabled:opacity-20 transition-opacity cursor-pointer disabled:cursor-not-allowed"
                >
                  <ChevronDown className="h-6 w-6" />
                </button>
              </div>
            </div>
          ) : (
            /* Classic Mode */
            <div className="h-full overflow-y-auto p-8">
              <div className="max-w-lg mx-auto space-y-8">
                <div className="text-center mb-8">
                  {form.icon && <DynamicIcon name={form.icon} className="h-8 w-8 mx-auto mb-2" />}
                  <h1 className="text-3xl font-bold tracking-tight">{form.title}</h1>
                  {form.description && (
                    <p className="opacity-70 mt-2">{form.description}</p>
                  )}
                </div>

                {visibleFields.map((field) => (
                  <div key={field.id} className="pb-6 border-b border-current/10 last:border-0">
                    <FieldResponse
                      field={field}
                      value={answers[field.id]}
                      onChange={(val) => handleAnswerChange(field.id, val)}
                      isRequired={getFieldRequired(field)}
                      primaryColor={form.theme.primaryColor}
                      textColor={form.theme.textColor}
                      allAnswers={allFormData}
                      allFieldIds={form.fields.map(f => f.id)}
                      onCalculated={handleCalculated}
                      formId={formId}
                    />
                  </div>
                ))}

                <div className="pt-4">
                  <Button
                    className="w-full"
                    size="lg"
                    onClick={() => toast.info('Preview only', "This is a preview — responses aren't saved. Publish your form and open its share link to collect real responses.")}
                    style={{ backgroundColor: form.theme.primaryColor }}
                  >
                    {form.settings.submitButtonText || 'Submit'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* NIGO Dashboard Sidebar */}
        {showNigo && form.settings?.showNigoDashboard && (
          <div className="absolute top-4 right-4 w-72 z-20">
            <NigoDashboard
              fields={form.fields}
              formData={answers}
              visibleFields={visibleFieldIds}
              requiredFields={requiredFieldIds}
              onFieldClick={(fieldId) => {
                const idx = visibleFields.findIndex((f) => f.id === fieldId);
                if (idx >= 0) {
                  setCurrentStep(idx);
                  // In classic mode, scroll the field into view
                  const el = document.getElementById(`field-${fieldId}`);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
