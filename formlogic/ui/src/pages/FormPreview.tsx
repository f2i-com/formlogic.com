import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Monitor, Smartphone, ExternalLink, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Share2, ClipboardCheck } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Button } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { FieldResponse } from './FormResponse';
import { FormSectionNav } from '../components/forms/FormSectionNav';
import { groupFieldsIntoSections } from '../lib/formDraft';
import { SiteChatWidget } from '../components/chat/SiteChatWidget';
import { useChatDockOffset } from '../components/chat/useChatDockOffset';
import { CustomScreenRuntime } from '../components/custom-screen/CustomScreenRuntime';
import { FormWidgetDashboard } from '../components/custom-screen/FormWidgetDashboard';
import { useFormStore } from '../stores/formStore';
import { useUIStore } from '../stores/uiStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { toast } from '../stores/toastStore';
import { useAdminActing, useResourcePaths } from '../components/admin/AdminActingContext';
import { useReturnTo } from '../hooks/useReturnTo';
import { api } from '../lib/api';
import { isDemoLocalId } from '../lib/demoLocal';
import { cn } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { NigoDashboard } from '../components/builder/NigoDashboard';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import type { FormField } from '../types/form';
import { publicUnfillableFieldLabels } from '../lib/publicForm';
import { formPageColors } from '../lib/formPageColors';
import { getFormThemeTokens } from '../lib/formThemeStyles';
import { readableForegroundColor } from '../lib/color';

// Main Preview Component
export default function FormPreview() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  // Platform-admin acting mode: previews show STRUCTURE only (dashboards/custom
  // screens render live record data, which is hidden from admins).
  const acting = useAdminActing();
  const paths = useResourcePaths();
  // Origin-relative exit: opened from the App Studio, "Exit Preview" returns to
  // the studio step instead of the builder.
  const backTo = useReturnTo(formId ? paths.builder(formId) : paths.formsHome());
  const [searchParams] = useSearchParams();
  // ?form=1 previews the fillable FORM even when the form has a custom screen/dashboard — the "Preview"
  // eye on a standalone form shows the form itself (the screen has its own /forms/:id/screen preview).
  const forceForm = searchParams.get('form') === '1';
  const { getForm, loadFullForm } = useFormStore();
  const { previewDevice, setPreviewDevice, previewMode, setPreviewMode } = useUIStore();
  // The site chat rides the preview too (full-screen route outside AppShell → own
  // mount): page context makes "this form" resolve here, and the demo's guided-build
  // follow-up chips stay usable while admiring the published result.
  const chatDockOffset = useChatDockOffset();

  const reduceMotion = useReducedMotion();
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [sectionViewMode, setSectionViewMode] = useState<'paged' | 'all'>('paged');
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [sectionModeInitFormId, setSectionModeInitFormId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [showNigo, setShowNigo] = useState(false);
  const [calculatedValues, setCalculatedValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  const scrollToPreviewSection = useCallback((idx: number) => {
    requestAnimationFrame(() => {
      const container = previewScrollRef.current;
      const el = document.getElementById(`preview-section-block-${idx}`);
      if (container && el) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const targetTop = Math.max(0, container.scrollTop + (elRect.top - containerRect.top) - 20);
        container.scrollTo({ top: targetTop, behavior: reduceMotion ? 'auto' : 'smooth' });
      } else if (container) {
        container.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    });
  }, [reduceMotion]);

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
    setActiveSectionIndex(0);
    setWelcomeDismissed(false);
    setSectionModeInitFormId(null);
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

  const groupedSections = useMemo(
    () => groupFieldsIntoSections(visibleFields, answers, (fieldId) => requiredFieldIds.has(fieldId)),
    [visibleFields, answers, requiredFieldIds],
  );

  // When opening a multi-section form in Preview, default to Classic mode so designers
  // immediately see the full section outline & paged sections (still toggleable to Focused).
  useEffect(() => {
    if (!form?.id || visibleFields.length === 0 || sectionModeInitFormId === form.id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot initial mode selection per form load
    setSectionModeInitFormId(form.id);
    if (groupedSections.hasExplicitSections && previewMode !== 'classic') {
      setPreviewMode('classic');
    }
  }, [form?.id, visibleFields.length, groupedSections.hasExplicitSections, sectionModeInitFormId, previewMode, setPreviewMode]);

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

  // Slim bar for the full-bleed screen/dashboard previews: without it there is no way
  // OUT of the preview (user report), and the chat vanished mid-guided-demo. The chat
  // widget mounts here too so the conversation follows the viewer onto the result.
  const previewBar = (
    <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900">
      {/* Named for a screen reader too: on a phone only the arrow shows. */}
      <Button variant="ghost" size="sm" onClick={() => navigate(backTo.path)} aria-label="Exit preview" title="Exit preview">
        <ArrowLeft className="h-4 w-4 sm:mr-2" />
        <span className="hidden sm:inline">Exit preview</span>
      </Button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700 dark:text-slate-300">{form.title}</span>
    </div>
  );

  // A section-screen widget dashboard replaces the default form in preview (owner → live data).
  // Private E2EE forms never render custom screens or dashboards.
  const isPrivateForm = form.encryption?.mode === 'private';
  if (!isPrivateForm && !forceForm && !acting && form.customScreen?.enabled && form.customScreen.kind === 'dashboard' && form.customScreen.dashboard) {
    return (
      <div className={cn('min-h-dvh w-full bg-gray-50 dark:bg-slate-950 flex flex-col', chatDockOffset && 'mr-96')}>
        <SiteChatWidget />
        {previewBar}
        {/* The dashboard starts at the left and takes the width of the window, as the
            product's other data views do, instead of a centred column. */}
        <div className="w-full p-4 md:p-6">
          <FormWidgetDashboard
            dashboard={form.customScreen.dashboard}
            formId={form.id}
            fields={form.fields}
            formTitle={form.title}
            publicMode={false}
            accent={form.theme.primaryColor}
          />
        </div>
      </div>
    );
  }

  // A custom screen replaces the default form in preview too (owner context → live data).
  if (!isPrivateForm && !forceForm && !acting && form.customScreen?.enabled && (form.customScreen.html || form.customScreen.js || form.customScreen.ts || form.customScreen.files?.length)) {
    return (
      <div className={cn('h-dvh w-full bg-white dark:bg-slate-950 flex flex-col', chatDockOffset && 'mr-96')}>
        <SiteChatWidget />
        {previewBar}
        <div className="min-h-0 flex-1">
          <CustomScreenRuntime
            screen={form.customScreen}
            formId={form.id}
            formTitle={form.title}
            fields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
            className="w-full h-full border-0"
          />
        </div>
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

  // The form is shown in its own colours, whatever the site's light or dark mode: its theme's, with
  // what the theme leaves out filled in to read against the rest, and a form with none in the
  // default light ones (formPageColors). The page around it keeps the site's mode; the form keeps
  // its own (fl-light turns the dark variant off within it, `dark` on), so a light form's labels
  // and answers are never drawn in dark mode's light text on its light page.
  const safeSectionIndex = Math.min(activeSectionIndex, Math.max(0, groupedSections.sections.length - 1));
  const activeSection = groupedSections.sections[safeSectionIndex];
  const focusedSection = groupedSections.hasExplicitSections && currentField
    ? groupedSections.sections.find(
        (sec) => sec.id === currentField.id || sec.fields.some((f) => f.id === currentField.id),
      )
    : undefined;

  const page = formPageColors(form.theme, false);
  const resolvedTheme = { ...form.theme, backgroundColor: page.backgroundColor, textColor: page.textColor };
  const themeTokens = getFormThemeTokens(resolvedTheme, page.dark);
  // The OK and Submit buttons in the form's accent with words that read on it, as the published
  // page draws them. Left to the button's own text colour they took the site's theme: dark mode's
  // navy on an indigo accent (3:1), and on a navy one hardly there at all.
  const accentButton = { backgroundColor: form.theme.primaryColor, color: readableForegroundColor(form.theme.primaryColor) };

  return (
    <div className={cn('min-h-[calc(100vh-var(--fl-demo-banner-h,0px))] bg-gray-50 dark:bg-slate-950 flex flex-col transition-colors duration-300', chatDockOffset && 'mr-96')}>
      <SiteChatWidget />
      {acting && form.customScreen?.enabled && (
        <div className="bg-amber-100 dark:bg-amber-500/15 text-amber-900 dark:text-amber-200 text-xs px-4 py-2 text-center">
          Dashboard &amp; custom-screen previews are disabled for platform admins — they display record data. Showing the form structure instead.
        </div>
      )}
      {/* Header */}
      <header className="h-14 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between px-4 flex-shrink-0 transition-colors duration-300">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(backTo.path)} aria-label="Exit preview" title="Exit preview">
            <ArrowLeft className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Exit preview</span>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {/* Device toggle - hidden on mobile since it's responsive anyway */}
          <div className="hidden md:flex items-center bg-gray-100 dark:bg-slate-800 rounded-lg p-1 transition-colors duration-300">
            <button
              type="button"
              onClick={() => setPreviewDevice('desktop')}
              aria-label="Desktop preview"
              aria-pressed={previewDevice === 'desktop'}
              title="Desktop preview"
              className={cn(
                'p-2 rounded-md transition-all duration-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                previewDevice === 'desktop'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              <Monitor className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPreviewDevice('mobile')}
              aria-label="Mobile preview"
              aria-pressed={previewDevice === 'mobile'}
              title="Mobile preview"
              className={cn(
                'p-2 rounded-md transition-all duration-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
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
          {/* Demo-local forms have no public /form/ page (they exist only in this
              browser) — hide the external Open instead of opening a dead link. */}
          {!(api.isDemoMode() && isDemoLocalId(form.id)) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/form/${form.id}`, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Open</span>
          </Button>
          )}
        </div>
      </header>

      {/* Embed Modal */}
      <EmbedModal
        isOpen={showEmbedModal}
        onClose={() => setShowEmbedModal(false)}
        formId={form.id}
        formTitle={form.title}
        formStatus={form.status}
        publicUnfillableFields={publicUnfillableFieldLabels(form.fields)}
      />

      {/* Preview Area */}
      <div className="flex-1 flex items-center justify-center p-3 sm:p-5 relative overflow-hidden">
        <div
          className={cn(
            'fl-themed-form relative rounded-2xl shadow-2xl overflow-hidden transition-all duration-300',
            page.dark ? 'dark' : 'fl-light',
            previewDevice === 'mobile'
              ? 'w-full max-w-[390px] h-[720px] max-h-[calc(100vh-7rem)]'
              : groupedSections.hasExplicitSections && previewMode === 'classic'
                ? 'w-full max-w-6xl h-[calc(100vh-7rem)] min-h-[580px]'
                : 'w-full max-w-5xl h-[calc(100vh-7rem)] min-h-[580px]'
          )}
          style={themeTokens.pageStyle}
        >
          {themeTokens.hasBackgroundImage && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-0"
              style={{
                backgroundColor: themeTokens.isPageDark ? 'rgba(15, 23, 42, 0.35)' : 'rgba(255, 255, 255, 0.35)',
              }}
            />
          )}
          {visibleFields.length === 0 ? (
            <div className="relative z-10 h-full flex items-center justify-center opacity-50">
              <p>Add some fields to preview your form</p>
            </div>
          ) : previewMode === 'focused' ? (
            /* Focused Mode */
            <div className="relative z-10 h-full flex flex-col">
              {/* Progress */}
              <div className="p-4">
                <ProgressBar value={progress} size="sm" barColor={form.theme.primaryColor} />
                <div className="mt-2 flex items-center justify-between gap-2">
                  {focusedSection ? (
                    <span
                      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
                      style={{
                        backgroundColor: `${form.theme.primaryColor}18`,
                        color: form.theme.primaryColor,
                      }}
                    >
                      Section {focusedSection.index + 1} of {groupedSections.sections.length} · {focusedSection.title}
                    </span>
                  ) : <span />}
                  <p className="text-sm opacity-50">
                    {safeCurrentStep + 1} of {visibleFields.length}
                    {isEvaluating && <span className="ml-2 animate-pulse">...</span>}
                  </p>
                </div>
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
                    className={cn('w-full max-w-2xl', themeTokens.sheetClass)}
                    style={themeTokens.sheetClass ? themeTokens.sheetStyle : undefined}
                  >
                    <FieldResponse
                      field={currentField}
                      value={answers[currentField.id]}
                      onChange={(val) => handleAnswerChange(currentField.id, val)}
                      isRequired={getFieldRequired(currentField)}
                      primaryColor={form.theme.primaryColor}
                      textColor={themeTokens.surfaceTextColor}
                      theme={resolvedTheme}
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
                <Button onClick={handleNext} style={accentButton} className={themeTokens.controlRadiusClass}>
                  {isLastStep ? 'Submit' : currentField?.type === 'section' ? 'Continue' : 'OK'} ✓
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
            /* Classic / Multi-Section Mode */
            <div ref={previewScrollRef} className={cn('relative z-10 h-full overflow-y-auto', previewDevice === 'mobile' ? 'p-4' : 'p-5 sm:p-8')}>
              <div className={cn('mx-auto w-full', groupedSections.hasExplicitSections && previewDevice === 'desktop' ? 'max-w-6xl' : 'max-w-3xl')}>
                {form.theme.logo && (
                  <div className="mb-4 flex justify-center">
                    <img src={form.theme.logo} alt="" className="max-h-12 max-w-[60%] object-contain" />
                  </div>
                )}

                {themeTokens.headerStyle === 'hero' ? (
                  <div
                    className={cn('mb-6 text-center shadow-sm', themeTokens.cardRadiusClass, themeTokens.headerPaddingClass)}
                    style={{ backgroundColor: form.theme.primaryColor, color: themeTokens.onPrimaryColor }}
                  >
                    {form.icon && <DynamicIcon name={form.icon} className="h-7 w-7 mx-auto mb-2 opacity-90" />}
                    <h1 className="text-2xl font-bold tracking-tight">{form.title}</h1>
                    {form.description && <p className="opacity-85 mt-1.5 text-sm">{form.description}</p>}
                  </div>
                ) : themeTokens.headerStyle === 'accent_bar' ? (
                  <div
                    className={cn('mb-6 overflow-hidden border shadow-2xs', themeTokens.cardRadiusClass)}
                    style={{
                      backgroundColor: themeTokens.surfaceBgColor,
                      borderColor: themeTokens.isSurfaceDark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.12)',
                      color: themeTokens.surfaceTextColor,
                    }}
                  >
                    <div className="h-2 w-full" style={{ backgroundColor: form.theme.primaryColor }} />
                    <div className={cn('text-center sm:text-left', themeTokens.headerPaddingClass)}>
                      {form.icon && <DynamicIcon name={form.icon} className="h-7 w-7 mx-auto sm:mx-0 mb-2" style={{ color: form.theme.primaryColor }} />}
                      <h1 className="text-2xl font-bold tracking-tight">{form.title}</h1>
                      {form.description && <p className="opacity-75 mt-1.5 text-sm">{form.description}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="text-center mb-8">
                    {form.icon && <DynamicIcon name={form.icon} className="h-8 w-8 mx-auto mb-2" />}
                    <h1 className="text-3xl font-bold tracking-tight">{form.title}</h1>
                    {form.description && (
                      <p className="opacity-70 mt-2">{form.description}</p>
                    )}
                  </div>
                )}

                {groupedSections.hasExplicitSections && groupedSections.welcomeField && !welcomeDismissed ? (
                  <div
                    className={cn('mx-auto max-w-xl text-center', themeTokens.sheetClass || `${themeTokens.cardRadiusClass} border p-6 sm:p-8 shadow-sm`)}
                    style={themeTokens.sheetClass ? themeTokens.sheetStyle : { borderColor: `${page.textColor}20` }}
                  >
                    <h2 className="text-2xl font-bold tracking-tight" style={{ color: themeTokens.surfaceTextColor }}>
                      {groupedSections.welcomeField.label || form.title}
                    </h2>
                    {groupedSections.welcomeField.description && (
                      <p className="mt-3 text-base opacity-75 whitespace-pre-line" style={{ color: themeTokens.surfaceTextColor }}>
                        {groupedSections.welcomeField.description}
                      </p>
                    )}
                    <p className="mt-4 text-xs opacity-65" style={{ color: themeTokens.surfaceTextColor }}>
                      {groupedSections.sections.length} sections · {groupedSections.totalInputs} questions
                    </p>
                    <div className="mt-6 flex justify-center">
                      <Button
                        size="lg"
                        onClick={() => {
                          setWelcomeDismissed(true);
                          scrollToPreviewSection(0);
                        }}
                        className={themeTokens.controlRadiusClass}
                        style={accentButton}
                      >
                        {groupedSections.welcomeField.properties.buttonText || 'Begin Form'}
                        <ChevronRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                ) : groupedSections.hasExplicitSections ? (
                  <div className={cn(previewDevice === 'desktop' && 'lg:flex lg:items-start lg:gap-6')}>
                    <FormSectionNav
                      sections={groupedSections.sections}
                      activeIndex={safeSectionIndex}
                      onSelectSection={(idx) => {
                        setActiveSectionIndex(idx);
                        scrollToPreviewSection(idx);
                      }}
                      totalInputs={groupedSections.totalInputs}
                      answeredCount={groupedSections.answeredCount}
                      sectionViewMode={sectionViewMode}
                      onToggleSectionViewMode={setSectionViewMode}
                      primaryColor={form.theme.primaryColor}
                      darkSurface={page.dark}
                      radiusClass={themeTokens.cardRadiusClass}
                      forceCompact={previewDevice === 'mobile'}
                    />

                    <div
                      className={cn('min-w-0 flex-1', themeTokens.sheetClass)}
                      style={themeTokens.sheetClass ? themeTokens.sheetStyle : undefined}
                    >
                      {(sectionViewMode === 'paged' && activeSection ? [activeSection] : groupedSections.sections).map((sec) => (
                        <section
                          key={sec.id}
                          id={`preview-section-block-${sec.index}`}
                          aria-label={sec.title}
                          className="mb-8 last:mb-0 scroll-mt-6"
                        >
                          <div
                            className={cn('mb-5 border px-5 py-4', themeTokens.cardRadiusClass)}
                            style={{
                              borderColor: `${form.theme.primaryColor}35`,
                              backgroundColor: `${form.theme.primaryColor}0d`,
                            }}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: form.theme.primaryColor }}>
                              <span>Section {sec.index + 1} of {groupedSections.sections.length}</span>
                              <span className="tabular-nums opacity-80">{sec.answeredCount} / {sec.totalInputs} answered</span>
                            </div>
                            <h2 className="mt-1 text-xl font-bold tracking-tight" style={{ color: themeTokens.surfaceTextColor }}>
                              {sec.title}
                            </h2>
                            {sec.description && (
                              <p className="mt-1 text-sm opacity-75 whitespace-pre-line" style={{ color: themeTokens.surfaceTextColor }}>
                                {sec.description}
                              </p>
                            )}
                          </div>

                          <div className={themeTokens.fieldSpacingClass}>
                            {sec.fields.map((field) => (
                              <div
                                key={field.id}
                                id={`field-${field.id}`}
                                className={cn(themeTokens.density === 'compact' ? 'pb-4' : 'pb-6', 'border-b border-current/10 last:border-0')}
                              >
                                <FieldResponse
                                  field={field}
                                  value={answers[field.id]}
                                  onChange={(val) => handleAnswerChange(field.id, val)}
                                  isRequired={getFieldRequired(field)}
                                  primaryColor={form.theme.primaryColor}
                                  textColor={themeTokens.surfaceTextColor}
                                  theme={resolvedTheme}
                                  compactHeading
                                  allAnswers={allFormData}
                                  allFieldIds={form.fields.map(f => f.id)}
                                  onCalculated={handleCalculated}
                                  formId={formId}
                                />
                              </div>
                            ))}
                          </div>
                        </section>
                      ))}

                      {sectionViewMode === 'paged' ? (
                        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-current/15 pt-5">
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={safeSectionIndex === 0}
                            className={themeTokens.controlRadiusClass}
                            onClick={() => {
                              const prev = Math.max(0, safeSectionIndex - 1);
                              setActiveSectionIndex(prev);
                              scrollToPreviewSection(prev);
                            }}
                            leftIcon={<ChevronLeft className="h-4 w-4" />}
                          >
                            Previous section
                          </Button>

                          {safeSectionIndex < groupedSections.sections.length - 1 ? (
                            <Button
                              type="button"
                              size="lg"
                              className={themeTokens.controlRadiusClass}
                              onClick={() => {
                                const next = Math.min(groupedSections.sections.length - 1, safeSectionIndex + 1);
                                setActiveSectionIndex(next);
                                scrollToPreviewSection(next);
                              }}
                              style={accentButton}
                              rightIcon={<ChevronRight className="h-4 w-4" />}
                            >
                              Next: {groupedSections.sections[safeSectionIndex + 1]?.title}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="lg"
                              className={themeTokens.controlRadiusClass}
                              onClick={() => toast.info('Preview only', "This is a preview — responses aren't saved. Publish your form and open its share link to collect real responses.")}
                              style={accentButton}
                            >
                              {form.settings.submitButtonText || 'Submit'}
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="pt-6">
                          <Button
                            className={cn('w-full', themeTokens.controlRadiusClass)}
                            size="lg"
                            onClick={() => toast.info('Preview only', "This is a preview — responses aren't saved. Publish your form and open its share link to collect real responses.")}
                            style={accentButton}
                          >
                            {form.settings.submitButtonText || 'Submit'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    className={cn(themeTokens.fieldSpacingClass, themeTokens.sheetClass)}
                    style={themeTokens.sheetClass ? themeTokens.sheetStyle : undefined}
                  >
                    {visibleFields.map((field) => (
                      <div key={field.id} id={`field-${field.id}`} className="pb-5 border-b border-current/10 last:border-0">
                        <FieldResponse
                          field={field}
                          value={answers[field.id]}
                          onChange={(val) => handleAnswerChange(field.id, val)}
                          isRequired={getFieldRequired(field)}
                          primaryColor={form.theme.primaryColor}
                          textColor={themeTokens.surfaceTextColor}
                          theme={resolvedTheme}
                          compactHeading
                          allAnswers={allFormData}
                          allFieldIds={form.fields.map(f => f.id)}
                          onCalculated={handleCalculated}
                          formId={formId}
                        />
                      </div>
                    ))}

                    <div className="pt-4">
                      <Button
                        className={cn('w-full', themeTokens.controlRadiusClass)}
                        size="lg"
                        onClick={() => toast.info('Preview only', "This is a preview — responses aren't saved. Publish your form and open its share link to collect real responses.")}
                        style={accentButton}
                      >
                        {form.settings.submitButtonText || 'Submit'}
                      </Button>
                    </div>
                  </div>
                )}
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
                  if (groupedSections.hasExplicitSections) {
                    setWelcomeDismissed(true);
                    const secIdx = groupedSections.sections.findIndex((s) => s.fields.some((f) => f.id === fieldId));
                    if (secIdx >= 0 && sectionViewMode === 'paged') {
                      setActiveSectionIndex(secIdx);
                      window.setTimeout(() => {
                        document.getElementById(`field-${fieldId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }, 50);
                      return;
                    }
                  }
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
