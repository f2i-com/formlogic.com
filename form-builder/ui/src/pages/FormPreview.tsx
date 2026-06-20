import { useState, useMemo, useEffect, useCallback, memo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Monitor, Smartphone, ExternalLink, ChevronUp, ChevronDown, Share2, ClipboardCheck } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Button } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { useFormStore } from '../stores/formStore';
import { useUIStore } from '../stores/uiStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { NigoDashboard } from '../components/builder/NigoDashboard';
import { PhoneInput } from '../components/ui/PhoneInput';
import { CalculatedFieldDisplay } from '../components/ui/CalculatedFieldDisplay';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { FileUploadField } from '../components/ui/FileUploadField';
import { LocationField } from '../components/ui/LocationField';
import type { FormField } from '../types/form';

// Field Preview Component (memoized to prevent re-renders when other fields change)
const FieldPreview = memo(function FieldPreview({ field, value, onChange, isRequired, textColor, allAnswers, allFieldIds, onCalculated, formId }: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  isRequired?: boolean;
  textColor?: string;
  allAnswers?: Record<string, unknown>;
  allFieldIds?: string[];
  onCalculated?: (fieldId: string, value: unknown) => void;
  formId?: string;
}) {
  const required = isRequired ?? field.required;
  const renderField = () => {
    switch (field.type) {
      case 'phone':
        return (
          <PhoneInput
            value={(value as string) || ''}
            onChange={(val) => onChange(val)}
            textColor={textColor}
          />
        );

      case 'short_text':
      case 'email':
      case 'url':
        return (
          <input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            aria-label={field.label}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || 'Type your answer here...'}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'long_text':
        return (
          <textarea
            aria-label={field.label}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || 'Type your answer here...'}
            rows={4}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-primary-500 outline-none py-2 text-lg resize-none transition-colors"
          />
        );

      case 'number':
        return (
          <input
            type="number"
            aria-label={field.label}
            min={field.properties.min}
            max={field.properties.max}
            step={field.properties.step ?? 'any'}
            value={(value as number) ?? ''}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange(isNaN(val) ? undefined : val);
            }}
            placeholder={field.placeholder || '0'}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'date':
        return (
          <input
            type="date"
            aria-label={field.label}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-primary-500 outline-none py-2 text-lg transition-colors cursor-pointer"
          />
        );

      case 'time':
        return (
          <input
            type="time"
            aria-label={field.label}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'datetime':
        return (
          <input
            type="datetime-local"
            aria-label={field.label}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'multiple_choice':
        return (
          <div className="space-y-3" role="radiogroup" aria-label={field.label}>
            {(field.properties.options?.length ?? 0) === 0 ? (
              <p className="opacity-50 italic text-sm">No options configured</p>
            ) : field.properties.options?.map((option, index) => (
              <button
                key={option.id}
                role="radio"
                aria-checked={value === option.value}
                onClick={() => onChange(option.value)}
                className={cn(
                  'w-full flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all cursor-pointer',
                  value === option.value
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-current/20 hover:border-current/40'
                )}
              >
                <span className="w-6 h-6 rounded-full border-2 border-current flex items-center justify-center text-sm font-medium">
                  {String.fromCharCode(65 + index)}
                </span>
                <span className="flex-1">{option.label}</span>
              </button>
            ))}
          </div>
        );

      case 'checkboxes': {
        const selectedValues = (value as string[]) || [];
        return (
          <div className="space-y-3" role="group" aria-label={field.label}>
            {(field.properties.options?.length ?? 0) === 0 ? (
              <p className="opacity-50 italic text-sm">No options configured</p>
            ) : field.properties.options?.map((option) => (
              <button
                key={option.id}
                role="checkbox"
                aria-checked={selectedValues.includes(option.value)}
                onClick={() => {
                  const newValues = selectedValues.includes(option.value)
                    ? selectedValues.filter((v) => v !== option.value)
                    : [...selectedValues, option.value];
                  onChange(newValues);
                }}
                className={cn(
                  'w-full flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all cursor-pointer',
                  selectedValues.includes(option.value)
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-current/20 hover:border-current/40'
                )}
              >
                <span className={cn(
                  'w-6 h-6 rounded border-2 flex items-center justify-center',
                  selectedValues.includes(option.value)
                    ? 'bg-primary-500 border-primary-500 text-primary-foreground'
                    : 'border-current/40'
                )}>
                  {selectedValues.includes(option.value) && '✓'}
                </span>
                <span className="flex-1">{option.label}</span>
              </button>
            ))}
          </div>
        );
      }

      case 'dropdown':
        return (field.properties.options?.length ?? 0) === 0 ? (
          <p className="opacity-50 italic text-sm">No options configured</p>
        ) : (
          <select
            aria-label={field.label}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-2 border-current/30 focus:border-primary-500 outline-none py-3 px-4 rounded-lg text-lg transition-colors"
          >
            <option value="">Select an option...</option>
            {field.properties.options?.map((option) => (
              <option key={option.id} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );

      case 'rating': {
        const maxStars = field.properties.maxStars || 5;
        const currentRating = (value as number) || 0;
        return (
          <div className="flex gap-2" role="radiogroup" aria-label={field.label}>
            {Array.from({ length: maxStars }, (_, i) => (
              <button
                key={i}
                role="radio"
                aria-checked={currentRating === i + 1}
                aria-label={`${i + 1} out of ${maxStars} stars`}
                onClick={() => onChange(i + 1)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    onChange(Math.min(maxStars, (currentRating || 0) + 1));
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    onChange(Math.max((currentRating || 0) - 1, 1));
                  }
                }}
                className={cn(
                  'text-4xl transition-transform hover:scale-110 cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 rounded-lg',
                  i < currentRating ? 'text-yellow-400' : 'opacity-30'
                )}
              >
                ★
              </button>
            ))}
          </div>
        );
      }

      case 'scale': {
        const start = field.properties.scaleStart ?? 1;
        const end = field.properties.scaleEnd ?? 10;
        const scaleValue = (value as number) || null;
        const scaleLength = Math.max(1, end - start + 1);
        return (
          <div>
            <div className="flex justify-between text-sm opacity-60 mb-2">
              <span>{field.properties.scaleStartLabel || start}</span>
              <span>{field.properties.scaleEndLabel || end}</span>
            </div>
            <div
              role="radiogroup"
              aria-label={field.label}
              className={cn(
                "grid gap-2",
                scaleLength <= 5 ? "grid-cols-5" : scaleLength <= 7 ? "grid-cols-7" : "grid-cols-5 sm:grid-cols-10"
              )}
            >
              {Array.from({ length: scaleLength }, (_, i) => {
                const num = start + i;
                return (
                  <button
                    key={num}
                    role="radio"
                    aria-checked={scaleValue === num}
                    aria-label={`${num} out of ${end}`}
                    onClick={() => onChange(num)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        onChange(Math.min(end, (scaleValue ?? start) + 1));
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        onChange(Math.max(start, (scaleValue ?? start) - 1));
                      }
                    }}
                    className={cn(
                      'py-3 min-h-[44px] rounded-lg border-2 font-medium transition-all cursor-pointer',
                      scaleValue === num
                        ? 'border-primary-500 bg-primary-500 text-primary-foreground'
                        : 'border-current/20 hover:border-current/40'
                    )}
                  >
                    {num}
                  </button>
                );
              })}
            </div>
          </div>
        );
      }

      case 'statement':
        return (
          <p className="text-lg opacity-70">{field.description || 'Statement content'}</p>
        );

      case 'file_upload':
        return (
          <FileUploadField
            field={field}
            value={value}
            onChange={onChange}
            primaryColor="var(--color-primary-500, #6366f1)"
            formId={formId}
          />
        );

      case 'location':
        return (
          <LocationField
            value={value}
            onChange={onChange}
            primaryColor="var(--color-primary-500, #6366f1)"
          />
        );

      case 'signature': {
        const signatureId = `signature-${field.id}`;
        return (
          <div className="space-y-3">
            <div
              className={cn(
                "w-full h-40 border-2 rounded-lg cursor-crosshair relative overflow-hidden transition-colors",
                value ? "border-primary-500" : "border-current/30"
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                const canvas = e.currentTarget.querySelector('canvas');
                if (!canvas) return;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                ctx.strokeStyle = textColor || '#1f2937';
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;

                ctx.beginPath();
                ctx.moveTo((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY);

                const onMouseMove = (moveEvent: MouseEvent) => {
                  ctx.lineTo((moveEvent.clientX - rect.left) * scaleX, (moveEvent.clientY - rect.top) * scaleY);
                  ctx.stroke();
                  onChange(canvas.toDataURL());
                };

                const onMouseUp = () => {
                  document.removeEventListener('mousemove', onMouseMove);
                  document.removeEventListener('mouseup', onMouseUp);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                const canvas = e.currentTarget.querySelector('canvas');
                if (!canvas) return;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                ctx.strokeStyle = textColor || '#1f2937';
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const touch = e.touches[0];

                ctx.beginPath();
                ctx.moveTo((touch.clientX - rect.left) * scaleX, (touch.clientY - rect.top) * scaleY);

                const onTouchMove = (moveEvent: TouchEvent) => {
                  moveEvent.preventDefault();
                  const moveTouch = moveEvent.touches[0];
                  ctx.lineTo((moveTouch.clientX - rect.left) * scaleX, (moveTouch.clientY - rect.top) * scaleY);
                  ctx.stroke();
                  onChange(canvas.toDataURL());
                };

                const onTouchEnd = () => {
                  document.removeEventListener('touchmove', onTouchMove);
                  document.removeEventListener('touchend', onTouchEnd);
                };

                document.addEventListener('touchmove', onTouchMove, { passive: false });
                document.addEventListener('touchend', onTouchEnd);
              }}
            >
              <canvas
                id={signatureId}
                width={500}
                height={200}
                className="w-full h-full"
                style={{ touchAction: 'none' }}
              />
              {!value && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="opacity-40 flex items-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                    Sign here
                  </p>
                </div>
              )}
            </div>
            {Boolean(value) && (
              <button
                type="button"
                onClick={() => {
                  const canvas = document.getElementById(signatureId) as HTMLCanvasElement;
                  if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx?.clearRect(0, 0, canvas.width, canvas.height);
                  }
                  onChange(null);
                }}
                className="text-sm text-red-500 hover:text-red-700 flex items-center gap-1 cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Clear signature
              </button>
            )}
          </div>
        );
      }

      case 'calculated':
        return (
          <CalculatedFieldDisplay
            expression={field.properties.calculationExpression}
            formData={allAnswers || {}}
            allFieldIds={allFieldIds || []}
            fieldId={field.id}
            onCalculated={onCalculated}
          >
            {(calcValue, isCalculating) => (
              <div className="p-4 bg-current/5 rounded-lg">
                <p className="text-sm opacity-60 mb-1">Calculated value:</p>
                <p className="text-2xl font-semibold">
                  {isCalculating ? '...' : calcValue !== undefined && calcValue !== null ? String(calcValue) : '—'}
                </p>
                {field.properties.calculationExpression && (
                  <p className="text-xs opacity-50 mt-2">
                    Formula: {field.properties.calculationExpression}
                  </p>
                )}
              </div>
            )}
          </CalculatedFieldDisplay>
        );

      case 'linked_record':
        return (
          <div className="p-4 border-2 border-dashed border-current/20 rounded-lg">
            <p className="text-sm opacity-60 mb-1">Linked Record</p>
            <p className="opacity-50 text-sm">
              {field.properties.targetFormId
                ? 'Record selection is available in the published app'
                : 'No target form configured'}
            </p>
          </div>
        );

      default:
        return (
          <p className="opacity-50 italic">Preview not available for this field type</p>
        );
    }
  };

  return (
    <div>
      <h2
        className="text-2xl font-bold mb-2"
        style={{ color: textColor }}
      >
        {field.label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </h2>
      {field.description && field.type !== 'statement' && (
        <p className="mb-6" style={{ color: textColor, opacity: 0.7 }}>{field.description}</p>
      )}
      <div className="mt-6">{renderField()}</div>
    </div>
  );
});

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
      // Always hide welcome/thank_you screens from the main flow
      if (['welcome_screen', 'thank_you'].includes(f.type)) return false;
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

  // Ensure currentStep is within bounds when fields change
  const safeCurrentStep = Math.min(currentStep, Math.max(0, visibleFields.length - 1));
  const currentField = visibleFields[safeCurrentStep];
  const progress = visibleFields.length > 0 ? ((safeCurrentStep + 1) / visibleFields.length) * 100 : 0;
  const isLastStep = safeCurrentStep === visibleFields.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      // Submit form
      toast.success('Preview Submitted', 'Form submitted! (This is a preview)');
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
            'bg-white rounded-2xl shadow-2xl overflow-hidden transition-all duration-300',
            previewDevice === 'mobile' ? 'w-full max-w-[375px] h-[667px] max-h-[calc(100vh-8rem)]' : 'w-full max-w-4xl h-[600px] max-h-[calc(100vh-8rem)]'
          )}
          style={{
            backgroundColor: form.theme.backgroundColor,
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
                <ProgressBar value={progress} size="sm" />
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
                    <FieldPreview
                      field={currentField}
                      value={answers[currentField.id]}
                      onChange={(val) => handleAnswerChange(currentField.id, val)}
                      isRequired={getFieldRequired(currentField)}
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
                    <FieldPreview
                      field={field}
                      value={answers[field.id]}
                      onChange={(val) => handleAnswerChange(field.id, val)}
                      isRequired={getFieldRequired(field)}
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
                    onClick={() => toast.success('Preview Submitted', 'Form submitted! (This is a preview)')}
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
