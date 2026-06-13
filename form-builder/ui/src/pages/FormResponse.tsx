import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronUp, ChevronDown, Check } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { cn } from '../lib/utils';
import { readableForegroundColor } from '../lib/color';
import { api } from '../lib/api';
import { logger } from '../lib/logger';
import { PhoneInput } from '../components/ui/PhoneInput';
import { CalculatedFieldDisplay } from '../components/ui/CalculatedFieldDisplay';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { FileUploadField } from '../components/ui/FileUploadField';
import { LocationField } from '../components/ui/LocationField';
import type { FormField } from '../types/form';
import { DEFAULT_FORM_SETTINGS, DEFAULT_FORM_THEME } from '../types/form';

// Field Response Component
function FieldResponse({
  field,
  value,
  onChange,
  primaryColor,
  textColor,
  isRequired,
  allAnswers,
  allFieldIds,
  onCalculated,
  formId,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
  textColor?: string;
  isRequired?: boolean;
  allAnswers?: Record<string, unknown>;
  allFieldIds?: string[];
  onCalculated?: (fieldId: string, value: unknown) => void;
  formId?: string;
}) {
  const required = isRequired ?? field.required;

  // Restore a previously-drawn signature onto the canvas after (re)mount — in
  // focused mode FieldResponse remounts per step, so navigating back to a
  // signature field would otherwise show a blank canvas even though the data URL
  // is still the saved value. Keyed on the field (not value) so it runs once on
  // mount and never fights the per-stroke onChange while the user is drawing.
  useEffect(() => {
    if (field.type !== 'signature') return;
    if (typeof value !== 'string' || !value.startsWith('data:image')) return;
    const canvas = document.getElementById(`signature-canvas-${field.id}`) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, field.type]);

  const renderField = () => {
    switch (field.type) {
      case 'phone':
        return (
          <PhoneInput
            value={(value as string) || ''}
            onChange={(val) => onChange(val)}
            primaryColor={primaryColor}
            textColor={textColor}
            autoFocus
          />
        );

      case 'short_text':
      case 'email':
      case 'url':
        return (
          <input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            aria-label={field.label}
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || 'Type your answer here...'}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
            style={{ '--tw-ring-color': primaryColor } as React.CSSProperties}
            autoFocus
          />
        );

      case 'long_text':
        return (
          <textarea
            aria-label={field.label}
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || 'Type your answer here...'}
            rows={4}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl resize-none transition-colors"
            autoFocus
          />
        );

      case 'number':
        return (
          <input
            type="number"
            aria-label={field.label}
            aria-required={required}
            value={(value as number) ?? ''}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange(isNaN(val) ? undefined : val);
            }}
            placeholder={field.placeholder || '0'}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
            autoFocus
          />
        );

      case 'date':
        return (
          <input
            type="date"
            aria-label={field.label}
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors cursor-pointer"
          />
        );

      case 'time':
        return (
          <input
            type="time"
            aria-label={field.label}
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
          />
        );

      case 'datetime':
        return (
          <input
            type="datetime-local"
            aria-label={field.label}
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
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
                  'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all cursor-pointer',
                  value === option.value
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-current/20 hover:border-current/30'
                )}
                style={value === option.value ? { borderColor: primaryColor, backgroundColor: `${primaryColor}10` } : {}}
              >
                <span
                  className="w-8 h-8 rounded-full border-2 border-current/30 flex items-center justify-center text-sm font-bold"
                  style={value === option.value ? { borderColor: primaryColor, color: primaryColor } : {}}
                >
                  {String.fromCharCode(65 + index)}
                </span>
                <span className="flex-1 text-lg">{option.label}</span>
                {value === option.value && (
                  <Check className="h-5 w-5" style={{ color: primaryColor }} />
                )}
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
                  'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all cursor-pointer',
                  selectedValues.includes(option.value)
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-current/20 hover:border-current/30'
                )}
                style={selectedValues.includes(option.value) ? { borderColor: primaryColor, backgroundColor: `${primaryColor}10` } : {}}
              >
                <span
                  className="w-8 h-8 rounded border-2 flex items-center justify-center"
                  style={selectedValues.includes(option.value) ? { backgroundColor: primaryColor, borderColor: primaryColor, color: readableForegroundColor(primaryColor) } : {}}
                >
                  {selectedValues.includes(option.value) && <Check className="h-4 w-4" />}
                </span>
                <span className="flex-1 text-lg">{option.label}</span>
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
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-2 border-current/30 focus:border-current/60 outline-none py-3 px-4 rounded-lg text-xl transition-colors"
            style={{ borderColor: value ? primaryColor : undefined }}
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
          <div className="flex gap-3 justify-center" role="radiogroup" aria-label={`${field.label} rating`}>
            {Array.from({ length: maxStars }, (_, i) => (
              <button
                key={i}
                role="radio"
                aria-checked={currentRating === i + 1}
                aria-label={`${i + 1} star${i === 0 ? '' : 's'}`}
                onClick={() => onChange(i + 1)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    onChange(Math.min((currentRating || 0) + 1, maxStars));
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    onChange(Math.max((currentRating || 0) - 1, 1));
                  }
                }}
                className={cn(
                  'text-5xl transition-transform hover:scale-110 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 rounded-lg min-w-[44px] min-h-[44px] flex items-center justify-center',
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
        const scaleLength = end - start + 1;
        return (
          <div>
            <div className="flex justify-between text-sm opacity-60 mb-3">
              <span>{field.properties.scaleStartLabel || `${start}`}</span>
              <span>{field.properties.scaleEndLabel || `${end}`}</span>
            </div>
            <div
              role="radiogroup"
              aria-label={field.label}
              className={cn(
              "grid gap-2",
              scaleLength <= 5 ? "grid-cols-5" : scaleLength <= 7 ? "grid-cols-7" : "grid-cols-5 sm:grid-cols-10"
            )}>
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
                      'py-4 min-h-[44px] rounded-lg border-2 font-bold text-lg transition-all cursor-pointer',
                      scaleValue === num ? '' : 'border-current/20 hover:border-current/30'
                    )}
                    style={scaleValue === num ? { backgroundColor: primaryColor, borderColor: primaryColor, color: readableForegroundColor(primaryColor) } : {}}
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
      case 'welcome_screen':
        return field.description ? (
          <p className="text-lg opacity-70 whitespace-pre-line">{field.description}</p>
        ) : null;

      case 'file_upload':
        return (
          <FileUploadField
            field={field}
            value={value}
            onChange={onChange}
            primaryColor={primaryColor}
            formId={formId}
          />
        );

      case 'location':
        return (
          <LocationField
            value={value}
            onChange={onChange}
            primaryColor={primaryColor}
          />
        );

      case 'signature': {
        const signatureCanvasId = `signature-canvas-${field.id}`;
        const isTypedSignature = typeof value === 'string' && value.startsWith('typed:');
        const typedName = isTypedSignature ? (value as string).slice(6) : '';
        return (
          <div className="space-y-3">
            {/* Mode toggle */}
            <div className="flex gap-2 text-sm">
              <button
                type="button"
                onClick={() => {
                  // Switch to draw mode, clear typed value
                  onChange(null);
                }}
                className={`px-3 py-1.5 rounded-lg border transition-colors cursor-pointer ${!isTypedSignature ? 'border-current font-medium' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400'}`}
                style={!isTypedSignature ? { borderColor: primaryColor, color: primaryColor } : undefined}
              >
                Draw
              </button>
              <button
                type="button"
                onClick={() => {
                  // Switch to type mode
                  const canvas = document.getElementById(signatureCanvasId) as HTMLCanvasElement;
                  if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx?.clearRect(0, 0, canvas.width, canvas.height);
                  }
                  onChange('typed:');
                }}
                className={`px-3 py-1.5 rounded-lg border transition-colors cursor-pointer ${isTypedSignature ? 'border-current font-medium' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400'}`}
                style={isTypedSignature ? { borderColor: primaryColor, color: primaryColor } : undefined}
              >
                Type
              </button>
            </div>

            {isTypedSignature ? (
              /* Type your name mode */
              <div className="space-y-2">
                <input
                  type="text"
                  value={typedName}
                  onChange={(e) => onChange(`typed:${e.target.value}`)}
                  placeholder="Type your full name"
                  aria-label="Type your signature"
                  className="w-full px-4 py-3 border-2 rounded-xl bg-white text-lg transition-colors focus:outline-none"
                  style={{
                    borderColor: typedName ? primaryColor : `${textColor || '#1f2937'}30`,
                    fontFamily: "'Dancing Script', 'Segoe Script', 'Comic Sans MS', cursive",
                    fontSize: '1.5rem',
                    color: textColor || '#1f2937',
                  }}
                />
                {typedName && (
                  <div
                    className="w-full h-20 border-2 rounded-xl bg-white flex items-center justify-center"
                    style={{ borderColor: `${textColor || '#1f2937'}15` }}
                  >
                    <p
                      className="text-3xl"
                      style={{
                        fontFamily: "'Dancing Script', 'Segoe Script', 'Comic Sans MS', cursive",
                        color: textColor || '#1f2937',
                      }}
                    >
                      {typedName}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              /* Draw signature mode */
              <>
                <div
                  className="w-full h-52 border-2 rounded-xl bg-white cursor-crosshair relative overflow-hidden transition-colors"
                  style={{ borderColor: value ? primaryColor : `${textColor || '#1f2937'}30` }}
                  role="img"
                  aria-label="Signature drawing area"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const canvas = e.currentTarget.querySelector('canvas');
                    if (!canvas) return;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return;

                    ctx.strokeStyle = textColor || '#1f2937';
                    ctx.lineWidth = 2.5;
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
                    ctx.lineWidth = 2.5;
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
                    id={signatureCanvasId}
                    width={600}
                    height={208}
                    className="w-full h-full"
                    style={{ touchAction: 'none' }}
                  />
                  {!value && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <p className="text-lg opacity-40 flex items-center gap-2">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                        Sign here
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
            {Boolean(value) && !isTypedSignature && (
              <button
                type="button"
                onClick={() => {
                  const canvas = document.getElementById(signatureCanvasId) as HTMLCanvasElement;
                  if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx?.clearRect(0, 0, canvas.width, canvas.height);
                  }
                  onChange(null);
                }}
                className="text-red-500 hover:text-red-700 font-medium flex items-center gap-1.5 cursor-pointer"
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
              <div className="p-6 bg-current/5 rounded-lg text-center">
                <p className="text-sm opacity-60 mb-2">Calculated result:</p>
                <p className="text-4xl font-bold" style={{ color: primaryColor }}>
                  {isCalculating ? '...' : calcValue !== undefined && calcValue !== null ? String(calcValue) : '—'}
                </p>
                {field.properties.calculationExpression && (
                  <p className="text-sm opacity-50 mt-3">
                    Based on: {field.properties.calculationExpression}
                  </p>
                )}
              </div>
            )}
          </CalculatedFieldDisplay>
        );

      case 'linked_record':
        return (
          <p className="opacity-50 text-sm">
            Linked record fields are available in published apps only.
          </p>
        );

      default:
        return <p className="opacity-50">Field type not supported</p>;
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="mb-8">
        <h2
          className="text-3xl font-bold mb-3 tracking-tight"
          style={{ color: textColor }}
        >
          {field.label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </h2>
        {field.description && (
          <p className="text-lg" style={{ color: textColor, opacity: 0.7 }}>{field.description}</p>
        )}
      </div>
      {renderField()}
    </div>
  );
}

// Success Screen
function SuccessScreen({ form, isRedirecting, thankYou }: { form: { title: string; theme: { primaryColor: string; textColor: string } }; isRedirecting?: boolean; thankYou?: { label?: string; description?: string } }) {
  // Use a thank_you field's content as the completion message when the form defines one.
  const heading = thankYou?.label?.trim() || 'Thank you!';
  const subtext = thankYou?.description?.trim() || 'Your response has been submitted successfully.';
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="text-center"
    >
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
        style={{ backgroundColor: form.theme.primaryColor }}
      >
        <Check className="h-10 w-10" style={{ color: readableForegroundColor(form.theme.primaryColor) }} />
      </div>
      <h1 className="text-4xl font-bold mb-4" style={{ color: form.theme.textColor }}>{heading}</h1>
      <p className="text-xl whitespace-pre-line" style={{ color: form.theme.textColor, opacity: 0.7 }}>{subtext}</p>
      {isRedirecting && (
        <p className="text-lg mt-4 animate-pulse" style={{ color: form.theme.textColor, opacity: 0.5 }}>Redirecting...</p>
      )}
    </motion.div>
  );
}

// Normalize form data from API (PHP returns [] for empty objects)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeFormData(raw: any) {
  return {
    ...raw,
    settings: Array.isArray(raw.settings) || !raw.settings
      ? DEFAULT_FORM_SETTINGS
      : { ...DEFAULT_FORM_SETTINGS, ...raw.settings },
    theme: Array.isArray(raw.theme) || !raw.theme
      ? DEFAULT_FORM_THEME
      : { ...DEFAULT_FORM_THEME, ...raw.theme },
    fields: raw.fields ?? [],
    responseCount: raw.responseCount ?? 0,
  };
}

// Main Form Response Component
export default function FormResponse() {
  const { formId } = useParams<{ formId: string }>();
  const { getForm, updateForm } = useFormStore();
  const {
    startResponse,
    setAnswer,
    currentAnswers,
    currentStep,
    nextStep,
    prevStep,
    goToStep,
    submitResponse,
    resetCurrentResponse,
  } = useResponseStore();

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [publicForm, setPublicForm] = useState<ReturnType<typeof getForm> | null>(null);
  const [isLoadingForm, setIsLoadingForm] = useState(false);
  const [formLoadError, setFormLoadError] = useState(false);
  const [responseMode, setResponseMode] = useState<'focused' | 'classic'>('focused');
  const [calculatedValues, setCalculatedValues] = useState<Record<string, unknown>>({});

  const handleCalculated = useCallback((fId: string, val: unknown) => {
    setCalculatedValues(prev => {
      if (prev[fId] === val) return prev;
      return { ...prev, [fId]: val };
    });
    // Also store in response store so calculated values are included in submission
    setAnswer(fId, val);
  }, [setAnswer]);

  const storeForm = formId ? getForm(formId) : undefined;

  // Load form: try authenticated API (owner), then public API (visitor)
  useEffect(() => {
    if (!formId) return;

    // If store already has the form with fields loaded, no fetch needed
    if (storeForm && storeForm.fields.length > 0) {
      setPublicForm(null);
      return;
    }

    let cancelled = false;
    setIsLoadingForm(true);
    setFormLoadError(false);

    (async () => {
      // 1. Try authenticated form API (works for owner, any status)
      if (api.isAuthenticated()) {
        try {
          const result = await api.getForm(formId);
          if (!cancelled && !result.error && result.data?.form) {
            const raw = result.data.form;
            const normalized = normalizeFormData(raw);
            setPublicForm(normalized as ReturnType<typeof getForm>);
            setIsLoadingForm(false);
            return;
          }
        } catch {
          // Fall through to public API
        }
      }

      // 2. Fall back to public form API (works for visitors, published only)
      try {
        const result = await api.getPublicForm(formId);
        if (cancelled) return;

        if (result.data?.form) {
          const normalized = normalizeFormData(result.data.form);
          setPublicForm(normalized as ReturnType<typeof getForm>);
          setIsLoadingForm(false);
        } else {
          setFormLoadError(true);
          setIsLoadingForm(false);
        }
      } catch {
        if (!cancelled) {
          setFormLoadError(true);
          setIsLoadingForm(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [formId, storeForm?.id, storeForm?.fields.length]);

  // Use store form (with fields) if available, otherwise fetched form
  const form = (storeForm && storeForm.fields.length > 0) ? storeForm : publicForm ?? storeForm;

  // Merge user answers with computed calculated field values so dependent
  // calculated fields (e.g. risk_level depending on risk_score) can resolve
  const allFormData = useMemo(
    () => ({ ...currentAnswers, ...calculatedValues }),
    [currentAnswers, calculatedValues]
  );

  // Use conditional logic to determine field visibility
  // Note: hooks must be called before any early returns
  const { isFieldVisible, isFieldRequired, isEvaluating } = useConditionalLogic(
    form?.fields ?? [],
    allFormData
  );

  // Get visible fields based on conditional logic
  const visibleFields = useMemo(() => {
    if (!form) return [];
    return form.fields.filter((f) => {
      // thank_you is rendered as the post-submit success screen, not an in-form step.
      // welcome_screen IS shown (as a leading content step).
      if (f.type === 'thank_you') return false;
      return isFieldVisible(f.id);
    });
  }, [form, isFieldVisible]);

  // Clamp currentStep when visible fields shrink (e.g. conditional logic hides fields)
  useEffect(() => {
    if (visibleFields.length > 0 && currentStep >= visibleFields.length) {
      goToStep(visibleFields.length - 1);
    }
  }, [visibleFields.length, currentStep, goToStep]);

  useEffect(() => {
    if (formId) {
      resetCurrentResponse();
      startResponse(formId);
    }
    return () => resetCurrentResponse();
  }, [formId, resetCurrentResponse, startResponse]);

  // Set initial presentation mode from form settings
  useEffect(() => {
    if (form?.settings?.defaultPresentationMode) {
      setResponseMode(form.settings.defaultPresentationMode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.id]);

  // Get dynamic required status for a field
  const getFieldRequired = (field: FormField) => {
    return field.required || isFieldRequired(field.id);
  };

  if (isLoadingForm) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400" />
      </div>
    );
  }

  if (!form || formLoadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950">
        <p className="text-gray-500 dark:text-slate-400">Form not found</p>
      </div>
    );
  }

  if (form.settings.isClosed) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: form.theme.backgroundColor }}
      >
        <div className="text-center" style={{ color: form.theme.textColor }}>
          <h1 className="text-2xl font-bold mb-2 tracking-tight">Form Closed</h1>
          <p className="opacity-70">
            {form.settings.closedMessage || 'This form is no longer accepting responses.'}
          </p>
        </div>
      </div>
    );
  }

  // Determine presentation mode
  const presentationMode = form.settings.presentationMode || 'both';
  const effectiveMode = presentationMode === 'both' ? responseMode : presentationMode;
  const showModeToggle = presentationMode === 'both';

  // Ensure currentStep is within bounds when fields change
  const safeCurrentStep = Math.min(currentStep, Math.max(0, visibleFields.length - 1));
  const currentField = visibleFields[safeCurrentStep];
  const progress = visibleFields.length > 0 ? ((safeCurrentStep + 1) / visibleFields.length) * 100 : 0;
  const isLastStep = safeCurrentStep === visibleFields.length - 1;

  const handleSubmit = async () => {
    setSubmitError(null);
    if (!form) return;
    // In-flight guard: pressing Enter twice or double-clicking Submit must not
    // POST the same answers twice (the server has no dedup, so it would create
    // duplicate responses).
    if (isSubmitting) return;
    setIsSubmitting(true);

    // Capture completion time before the store clears in-progress state.
    const startTime = useResponseStore.getState().startTime;
    const completionTime = startTime ? Math.max(0, Date.now() - startTime) : undefined;

    // Server persistence. For a PUBLISHED (server-backed) form while ONLINE, a
    // server rejection means the response was NOT saved — surface it and keep the
    // user on the form rather than showing a success screen that lies. For
    // local-only/draft forms, or when offline (the service worker queues the POST
    // for retry), keep the best-effort behavior and don't block the user.
    const serverBacked = form.status === 'published';
    let serverFailed = false;
    try {
      const result = await api.submitResponse(form.id, { answers: currentAnswers, completionTime });
      if (result.error) {
        if (serverBacked && navigator.onLine) {
          serverFailed = true;
          setSubmitError(typeof result.error === 'string' ? result.error : 'Your response could not be submitted. Please try again.');
        } else {
          logger.warn('Response not persisted to server (kept locally):', result.error);
        }
      }
    } catch (err) {
      logger.error('Failed to submit response to server', err);
      if (serverBacked && navigator.onLine) {
        serverFailed = true;
        setSubmitError('Your response could not be submitted. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }

    // Abort the success flow on a real server failure for a published form.
    if (serverFailed) return;

    // Record locally (clears in-progress answers) and reflect in the local view.
    const response = submitResponse();
    if (!response) return;
    updateForm(form.id, { responseCount: form.responseCount + 1 });
    setIsSubmitted(true);

    // Handle redirectUrl (strict URL validation to prevent XSS)
    const redirectUrl = form.settings?.redirectUrl;
    if (redirectUrl) {
      try {
        const url = new URL(redirectUrl);
        if (['http:', 'https:'].includes(url.protocol)) {
          setIsRedirecting(true);
          setTimeout(() => {
            window.location.href = url.toString();
          }, 2000);
        }
      } catch {
        // Invalid URL — don't redirect
      }
    }
  };

  const handleNext = () => {
    setFieldError(null);
    setSubmitError(null);

    // Don't advance/submit while a submission is in flight (prevents a double Enter).
    if (isSubmitting) return;

    // Skip the required/validation gate for non-input field types — a calculated
    // or layout step has nothing for the user to fill in, so requiring it would
    // be an unrecoverable dead-end. Matches the classic-mode exclusion.
    if (currentField && !['statement', 'calculated', 'welcome_screen', 'thank_you'].includes(currentField.type)) {
      const answer = currentAnswers[currentField.id];

      // Check required
      if (getFieldRequired(currentField)) {
        if (answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0)) {
          setFieldError('This field is required');
          return;
        }
      }

      // Run field validation rules (minLength, maxLength, pattern, min, max)
      if (answer !== undefined && answer !== null && answer !== '' && currentField.validation?.length) {
        for (const rule of currentField.validation) {
          if (rule.type === 'minLength' && typeof answer === 'string' && answer.length < (rule.value as number)) {
            setFieldError(rule.message || `Minimum ${rule.value} characters required`);
            return;
          }
          if (rule.type === 'maxLength' && typeof answer === 'string' && answer.length > (rule.value as number)) {
            setFieldError(rule.message || `Maximum ${rule.value} characters allowed`);
            return;
          }
          if (rule.type === 'min' && typeof answer === 'number' && answer < (rule.value as number)) {
            setFieldError(rule.message || `Minimum value is ${rule.value}`);
            return;
          }
          if (rule.type === 'max' && typeof answer === 'number' && answer > (rule.value as number)) {
            setFieldError(rule.message || `Maximum value is ${rule.value}`);
            return;
          }
          if (rule.type === 'pattern' && typeof answer === 'string') {
            try {
              const pat = String(rule.value);
              if (pat.length > 500) { setFieldError(rule.message || 'Invalid format'); return; }
              if (/(\+|\*|\{[^}]*\})\s*(\+|\*|\{[^}]*\})/.test(pat) || /\([^)]*\|[^)]*\)\+/.test(pat)) { setFieldError(rule.message || 'Invalid format'); return; }
              if (!new RegExp(pat).test(answer)) {
                setFieldError(rule.message || 'Invalid format');
                return;
              }
            } catch {
              // Invalid regex pattern, skip
            }
          }
        }
      }
    }

    if (isLastStep) {
      handleSubmit();
    } else {
      nextStep();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Allow newlines in long_text fields
      if (currentField?.type === 'long_text') return;
      e.preventDefault();
      handleNext();
    }
  };

  const handleClassicSubmit = () => {
    setSubmitError(null);
    setFieldError(null);
    const missingFields = visibleFields.filter(f => {
      if (!getFieldRequired(f)) return false;
      if (['statement', 'calculated'].includes(f.type)) return false;
      const answer = currentAnswers[f.id];
      return answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0);
    });
    if (missingFields.length > 0) {
      setSubmitError(`Please fill in all required fields (${missingFields.length} remaining)`);
      return;
    }

    // Run field validation rules
    for (const f of visibleFields) {
      if (['statement', 'calculated', 'welcome_screen', 'thank_you'].includes(f.type)) continue;
      const answer = currentAnswers[f.id];
      if (answer === undefined || answer === null || answer === '') continue;
      if (f.validation?.length) {
        for (const rule of f.validation) {
          if (rule.type === 'minLength' && typeof answer === 'string' && answer.length < (rule.value as number)) {
            setSubmitError(`${f.label}: ${rule.message || `Minimum ${rule.value} characters required`}`);
            return;
          }
          if (rule.type === 'maxLength' && typeof answer === 'string' && answer.length > (rule.value as number)) {
            setSubmitError(`${f.label}: ${rule.message || `Maximum ${rule.value} characters allowed`}`);
            return;
          }
          if (rule.type === 'min' && typeof answer === 'number' && answer < (rule.value as number)) {
            setSubmitError(`${f.label}: ${rule.message || `Minimum value is ${rule.value}`}`);
            return;
          }
          if (rule.type === 'max' && typeof answer === 'number' && answer > (rule.value as number)) {
            setSubmitError(`${f.label}: ${rule.message || `Maximum value is ${rule.value}`}`);
            return;
          }
          if (rule.type === 'pattern' && typeof answer === 'string') {
            try {
              const pat = String(rule.value);
              if (pat.length > 500) { setSubmitError(`${f.label}: ${rule.message || 'Invalid format'}`); return; }
              if (/(\+|\*|\{[^}]*\})\s*(\+|\*|\{[^}]*\})/.test(pat) || /\([^)]*\|[^)]*\)\+/.test(pat)) { setSubmitError(`${f.label}: ${rule.message || 'Invalid format'}`); return; }
              if (!new RegExp(pat).test(answer)) {
                setSubmitError(`${f.label}: ${rule.message || 'Invalid format'}`);
                return;
              }
            } catch {
              // Invalid regex pattern, skip
            }
          }
        }
      }
    }

    handleSubmit();
  };

  if (isSubmitted) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: form.theme.backgroundColor }}
      >
        <SuccessScreen form={form} isRedirecting={isRedirecting} thankYou={form.fields.find((f) => f.type === 'thank_you')} />
      </div>
    );
  }

  if (visibleFields.length === 0) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: form.theme.backgroundColor }}
      >
        <p style={{ color: form.theme.textColor, opacity: 0.5 }}>This form has no questions.</p>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        backgroundColor: form.theme.backgroundColor,
        color: form.theme.textColor,
        fontFamily: form.theme.fontFamily,
      }}
      onKeyDown={effectiveMode === 'focused' ? handleKeyDown : undefined}
    >
      {/* Mode Toggle */}
      {showModeToggle && (
        <div className="fixed top-3 right-4 z-20 flex items-center rounded-lg p-0.5" style={{ backgroundColor: `${form.theme.textColor}15` }}>
          <button
            onClick={() => setResponseMode('focused')}
            className={cn(
              'px-3 py-1 text-xs rounded-md transition-all cursor-pointer',
              effectiveMode === 'focused' ? 'shadow-sm' : 'opacity-50 hover:opacity-80'
            )}
            style={effectiveMode === 'focused' ? { backgroundColor: form.theme.primaryColor, color: readableForegroundColor(form.theme.primaryColor) } : { color: form.theme.textColor }}
          >
            Focused
          </button>
          <button
            onClick={() => setResponseMode('classic')}
            className={cn(
              'px-3 py-1 text-xs rounded-md transition-all cursor-pointer',
              effectiveMode === 'classic' ? 'shadow-sm' : 'opacity-50 hover:opacity-80'
            )}
            style={effectiveMode === 'classic' ? { backgroundColor: form.theme.primaryColor, color: readableForegroundColor(form.theme.primaryColor) } : { color: form.theme.textColor }}
          >
            Classic
          </button>
        </div>
      )}

      {effectiveMode === 'focused' ? (
      <>
      {/* Progress Bar */}
      {form.settings.showProgressBar && (
        <div className="fixed top-0 left-0 right-0 z-10">
          <div
            className="h-1 transition-all duration-300"
            style={{ width: `${progress}%`, backgroundColor: form.theme.primaryColor }}
          />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center p-4 md:p-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentField.id}
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            transition={{ duration: 0.4 }}
            className="w-full"
          >
            <FieldResponse
              field={currentField}
              value={currentAnswers[currentField.id]}
              onChange={(val) => setAnswer(currentField.id, val)}
              primaryColor={form.theme.primaryColor}
              textColor={form.theme.textColor}
              isRequired={getFieldRequired(currentField)}
              allAnswers={allFormData}
              allFieldIds={form.fields.map(f => f.id)}
              onCalculated={handleCalculated}
              formId={formId}
            />

            {/* Inline validation error */}
            {fieldError && (
              <p role="alert" aria-live="polite" className="mt-3 text-red-500 text-sm">{fieldError}</p>
            )}

            {/* OK Button */}
            <div className="mt-8 flex items-center gap-4 justify-center">
              <Button
                size="lg"
                onClick={handleNext}
                disabled={isSubmitting}
                isLoading={isLastStep && isSubmitting}
                style={{ backgroundColor: form.theme.primaryColor, color: readableForegroundColor(form.theme.primaryColor) }}
                className="px-8"
              >
                {isLastStep ? 'Submit' : 'OK'} <Check className="ml-2 h-4 w-4" />
              </Button>
              <span className="hidden sm:inline text-sm opacity-50">
                press <kbd className="px-2 py-1 bg-current/10 rounded opacity-80">Enter</kbd>
              </span>
            </div>

            {/* Submission error */}
            {submitError && (
              <p role="alert" aria-live="polite" className="mt-4 text-red-500 text-sm text-center">{submitError}</p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Navigation */}
      {form.settings.allowBackNavigation && (
        <div className="fixed bottom-4 right-4 flex flex-col gap-1">
          <button
            onClick={prevStep}
            disabled={safeCurrentStep === 0}
            aria-label="Previous question"
            className="p-3 bg-current/10 backdrop-blur-sm rounded-control shadow-md opacity-60 hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-current/60"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
          <button
            onClick={handleNext}
            aria-label="Next question"
            className="p-3 bg-current/10 backdrop-blur-sm rounded-control shadow-md opacity-60 hover:opacity-90 transition-opacity cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-current/60"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Step Counter */}
      <div className="fixed bottom-4 left-4 text-sm opacity-50">
        {safeCurrentStep + 1} / {visibleFields.length}
        {isEvaluating && <span className="ml-1 animate-pulse">...</span>}
      </div>
      </>
      ) : (
        /* Classic Mode */
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto px-4 py-12 w-full">
            <div className="text-center mb-10">
              {form.icon && <DynamicIcon name={form.icon} className="h-8 w-8 mx-auto mb-2" style={{ color: form.theme.textColor }} />}
              <h1 className="text-3xl font-bold tracking-tight" style={{ color: form.theme.textColor }}>
                {form.title}
              </h1>
              {form.description && (
                <p className="mt-2 opacity-70" style={{ color: form.theme.textColor }}>{form.description}</p>
              )}
            </div>

            <div className="space-y-8">
              {visibleFields.map((field) => (
                <div key={field.id} className="pb-6 border-b last:border-0" style={{ borderColor: `${form.theme.textColor}15` }}>
                  <FieldResponse
                    field={field}
                    value={currentAnswers[field.id]}
                    onChange={(val) => setAnswer(field.id, val)}
                    primaryColor={form.theme.primaryColor}
                    textColor={form.theme.textColor}
                    isRequired={getFieldRequired(field)}
                    allAnswers={allFormData}
                    allFieldIds={form.fields.map(f => f.id)}
                    onCalculated={handleCalculated}
                    formId={formId}
                  />
                </div>
              ))}
            </div>

            {submitError && (
              <p role="alert" aria-live="polite" className="mt-4 text-red-500 text-sm text-center">{submitError}</p>
            )}

            <div className="mt-10">
              <Button
                size="lg"
                onClick={handleClassicSubmit}
                disabled={isSubmitting}
                isLoading={isSubmitting}
                style={{ backgroundColor: form.theme.primaryColor, color: readableForegroundColor(form.theme.primaryColor) }}
                className="w-full"
              >
                {form.settings.submitButtonText || 'Submit'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
