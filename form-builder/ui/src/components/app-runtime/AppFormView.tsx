import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, ChevronUp, ChevronDown, CheckCircle, ClipboardCheck } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { LinkedRecordInput } from './LinkedRecordInput';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { PhoneInput } from '../ui/PhoneInput';
import { CalculatedFieldDisplay } from '../ui/CalculatedFieldDisplay';
import { DynamicIcon } from '../ui/DynamicIcon';
import { FileUploadField } from '../ui/FileUploadField';
import { LocationField } from '../ui/LocationField';
import { NigoDashboard } from '../builder/NigoDashboard';
import { useConditionalLogic } from '../../hooks/useFormLogic';
import type { FormField as FormFieldType } from '../../types/form';

interface FormField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  placeholder?: string;
  description?: string;
  properties?: Record<string, unknown>;
  validation?: Array<{ type: string; value?: string | number; message?: string }>;
}

interface FormTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily?: string;
}

// Signature pad as its own component so it can legally run a hook that restores
// a previously-saved signature (data URL) onto the canvas when it mounts or the
// value changes — otherwise a saved signature shows up blank after re-mount.
function SignatureField({
  value,
  onChange,
  primaryColor,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const getStrokeColor = () =>
    document.documentElement.classList.contains('dark') ? '#e2e8f0' : '#1f2937';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (typeof value === 'string' && value.startsWith('data:image')) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = value;
    }
  }, [value]);

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'w-full h-36 border-2 rounded-lg cursor-crosshair relative overflow-hidden transition-colors',
          value ? 'border-gray-400 dark:border-slate-500' : 'border-gray-300 dark:border-slate-600'
        )}
        style={{ borderColor: value ? primaryColor : undefined }}
        onMouseDown={(e) => {
          e.preventDefault();
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.strokeStyle = getStrokeColor();
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          const rect = canvas.getBoundingClientRect();
          const sx = canvas.width / rect.width;
          const sy = canvas.height / rect.height;
          ctx.beginPath();
          ctx.moveTo((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
          const onMove = (me: MouseEvent) => { ctx.lineTo((me.clientX - rect.left) * sx, (me.clientY - rect.top) * sy); ctx.stroke(); };
          const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); onChange(canvas.toDataURL()); };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        onTouchStart={(e) => {
          e.preventDefault();
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.strokeStyle = getStrokeColor();
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          const rect = canvas.getBoundingClientRect();
          const sx = canvas.width / rect.width;
          const sy = canvas.height / rect.height;
          const t = e.touches[0];
          ctx.beginPath();
          ctx.moveTo((t.clientX - rect.left) * sx, (t.clientY - rect.top) * sy);
          const onMove = (te: TouchEvent) => { te.preventDefault(); const mt = te.touches[0]; ctx.lineTo((mt.clientX - rect.left) * sx, (mt.clientY - rect.top) * sy); ctx.stroke(); };
          const onEnd = () => { document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd); onChange(canvas.toDataURL()); };
          document.addEventListener('touchmove', onMove, { passive: false });
          document.addEventListener('touchend', onEnd);
        }}
      >
        <canvas ref={canvasRef} width={500} height={180} className="w-full h-full" style={{ touchAction: 'none' }} />
        {!value && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-gray-400 dark:text-slate-500">Sign here</p>
          </div>
        )}
      </div>
      {Boolean(value) && (
        <button
          type="button"
          onClick={() => {
            const c = canvasRef.current;
            if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
            onChange(null);
          }}
          className="text-sm text-red-500 hover:text-red-700 cursor-pointer"
        >
          Clear signature
        </button>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  primaryColor,
  formId,
  appSlug,
  allAnswers,
  allFieldIds,
  onCalculated,
}: {
  field: FormField;
  value: unknown;
  onChange: (val: unknown) => void;
  primaryColor: string;
  formId?: string;
  appSlug?: string;
  allAnswers?: Record<string, unknown>;
  allFieldIds?: string[];
  onCalculated?: (fieldId: string, value: unknown) => void;
}) {
  const inputClass = 'w-full bg-transparent border-b-2 border-gray-200 dark:border-slate-700 outline-none py-2.5 text-base sm:text-lg md:text-xl text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 transition-all duration-200 focus:border-current';
  const focusStyle = { '--focus-color': primaryColor } as React.CSSProperties;

  if (field.type === 'phone') {
    return (
      <PhoneInput
        value={(value as string) || ''}
        onChange={(val) => onChange(val)}
        primaryColor={primaryColor}
        autoFocus
      />
    );
  }

  if (['short_text', 'email', 'url'].includes(field.type)) {
    return (
      <input
        type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
        inputMode={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : undefined}
        autoComplete={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : undefined}
        aria-label={field.label}
        aria-required={field.required || undefined}
        value={(value as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder || 'Type your answer here...'}
        className={inputClass}
        style={{ ...focusStyle, borderColor: value ? primaryColor : undefined }}
        autoFocus
      />
    );
  }

  if (field.type === 'long_text') {
    return (
      <textarea
        aria-label={field.label}
        aria-required={field.required || undefined}
        value={(value as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder || 'Type your answer here...'}
        rows={4}
        className={cn(inputClass, 'resize-none')}
        style={{ ...focusStyle, borderColor: value ? primaryColor : undefined }}
        autoFocus
      />
    );
  }

  if (field.type === 'number') {
    return (
      <input
        type="number"
        inputMode="decimal"
        aria-label={field.label}
        aria-required={field.required || undefined}
        min={field.properties?.min as number | undefined}
        max={field.properties?.max as number | undefined}
        step={(field.properties?.step as number | undefined) ?? 'any'}
        value={(value as number) ?? ''}
        onChange={(e) => {
          const val = parseFloat(e.target.value);
          onChange(isNaN(val) ? undefined : val);
        }}
        placeholder={field.placeholder || 'Type a number...'}
        className={inputClass}
        style={{ ...focusStyle, borderColor: (value !== undefined && value !== null && value !== '') ? primaryColor : undefined }}
        autoFocus
      />
    );
  }

  if (['date', 'time', 'datetime'].includes(field.type)) {
    return (
      <input
        type={field.type === 'datetime' ? 'datetime-local' : field.type}
        aria-label={field.label}
        aria-required={field.required || undefined}
        value={(value as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
        className={cn(inputClass, 'max-w-full sm:max-w-xs cursor-pointer')}
        style={{ ...focusStyle, borderColor: value ? primaryColor : undefined }}
        autoFocus
      />
    );
  }

  if (field.type === 'multiple_choice') {
    const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
    if (options.length === 0) return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No options configured</p>;
    return (
      <div className="space-y-3" role="radiogroup" aria-label={field.label}>
        {options.map((option, index) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all cursor-pointer',
                selected ? 'shadow-sm' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500'
              )}
              style={selected ? { borderColor: primaryColor, backgroundColor: `${primaryColor}10` } : {}}
            >
              <span
                className={cn(
                  'w-8 h-8 rounded border-2 flex items-center justify-center text-sm font-bold flex-shrink-0',
                  !selected && 'border-gray-300 dark:border-slate-500 text-gray-500 dark:text-slate-400'
                )}
                style={selected ? { borderColor: primaryColor, color: primaryColor } : {}}
              >
                {String.fromCharCode(65 + index)}
              </span>
              <span className="flex-1 text-base sm:text-lg text-gray-900 dark:text-white">{option.label}</span>
              {selected && <Check className="h-5 w-5 flex-shrink-0" style={{ color: primaryColor }} />}
            </button>
          );
        })}
      </div>
    );
  }

  if (field.type === 'dropdown') {
    const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
    if (options.length === 0) return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No options configured</p>;
    return (
      <select
        value={(value as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={field.label}
        className="w-full bg-white dark:bg-slate-800 border-2 border-gray-300 dark:border-slate-600 outline-none py-3 px-4 rounded-lg text-base sm:text-lg text-gray-900 dark:text-white transition-colors"
        style={{ borderColor: (value !== undefined && value !== null && value !== '') ? primaryColor : undefined }}
      >
        <option value="">Select...</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    );
  }

  if (field.type === 'checkboxes') {
    const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
    const current = (value as string[]) ?? [];
    if (options.length === 0) return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No options configured</p>;
    return (
      <div className="space-y-3" role="group" aria-label={field.label}>
        {options.map((option, index) => {
          const checked = current.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={option.label}
              onClick={() => {
                onChange(checked ? current.filter((v) => v !== option.value) : [...current, option.value]);
              }}
              className={cn(
                'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all cursor-pointer',
                checked ? 'shadow-sm' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500'
              )}
              style={checked ? { borderColor: primaryColor, backgroundColor: `${primaryColor}10` } : {}}
            >
              <span
                className={cn(
                  'w-8 h-8 rounded border-2 flex items-center justify-center text-sm font-bold flex-shrink-0',
                  !checked && 'border-gray-300 dark:border-slate-500 text-gray-500 dark:text-slate-400'
                )}
                style={checked ? { borderColor: primaryColor, color: primaryColor } : {}}
              >
                {checked ? <Check className="h-4 w-4" /> : String.fromCharCode(65 + index)}
              </span>
              <span className="flex-1 text-base sm:text-lg text-gray-900 dark:text-white">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  if (field.type === 'rating') {
    const maxStars = (field.properties?.maxStars as number) ?? 5;
    const currentRating = (value as number) ?? 0;
    return (
      <div className="flex gap-2" role="radiogroup" aria-label={field.label}>
        {Array.from({ length: maxStars }, (_, i) => (
          <button
            key={i}
            type="button"
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
                onChange(Math.max(1, (currentRating || 0) - 1) || 1);
              }
            }}
            className={cn(
              'text-4xl transition-all duration-150 hover:scale-125 p-1 min-w-[44px] min-h-[44px] flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 rounded-lg',
              currentRating > i ? 'text-yellow-400' : 'text-gray-300 dark:text-slate-500'
            )}
          >
            ★
          </button>
        ))}
      </div>
    );
  }

  if (field.type === 'scale') {
    const min = (field.properties?.scaleStart as number) ?? (field.properties?.min as number) ?? 1;
    const max = (field.properties?.scaleEnd as number) ?? (field.properties?.max as number) ?? 10;
    const range = Math.max(1, max - min + 1);
    return (
      <div className="space-y-3">
        <div role="radiogroup" aria-label={field.label} className={cn('grid gap-2', range <= 5 ? 'grid-cols-5' : range <= 7 ? 'grid-cols-7' : 'grid-cols-5 sm:grid-cols-10')}>
          {Array.from({ length: range }, (_, i) => {
            const num = min + i;
            const selected = value === num;
            return (
              <button
                key={num}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${num} out of ${max}`}
                onClick={() => onChange(num)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    onChange(Math.min(max, ((value as number) ?? min) + 1));
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    onChange(Math.max(min, ((value as number) ?? min) - 1));
                  }
                }}
                className={cn(
                  'aspect-square min-h-[44px] rounded-lg border-2 flex items-center justify-center text-lg font-medium transition-all hover:scale-105',
                  selected ? 'shadow-sm' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500 text-gray-700 dark:text-slate-300'
                )}
                style={selected ? { backgroundColor: primaryColor, borderColor: primaryColor, color: 'var(--app-on-primary)' } : {}}
              >
                {num}
              </button>
            );
          })}
        </div>
        {Boolean(field.properties?.scaleStartLabel || field.properties?.minLabel || field.properties?.scaleEndLabel || field.properties?.maxLabel) && (
          <div className="flex justify-between text-sm text-gray-500 dark:text-slate-400">
            <span>{String(field.properties?.scaleStartLabel ?? field.properties?.minLabel ?? '')}</span>
            <span>{String(field.properties?.scaleEndLabel ?? field.properties?.maxLabel ?? '')}</span>
          </div>
        )}
      </div>
    );
  }

  if (field.type === 'statement' || field.type === 'welcome_screen') {
    const mediaUrl = field.properties?.mediaUrl as string | undefined;
    const mediaType = (field.properties?.mediaType as string | undefined) || 'image';
    return (
      <div className="space-y-4">
        {mediaUrl && (mediaType === 'video' ? (
          <video src={mediaUrl} controls className="w-full rounded-xl max-h-80" />
        ) : (
          <img src={mediaUrl} alt="" className="w-full rounded-xl max-h-80 object-contain" />
        ))}
        <p className="text-lg text-gray-600 dark:text-slate-400 whitespace-pre-line">{field.description || 'Statement content'}</p>
      </div>
    );
  }

  if (field.type === 'calculated') {
    return (
      <CalculatedFieldDisplay
        expression={field.properties?.calculationExpression as string | undefined}
        formData={allAnswers || {}}
        allFieldIds={allFieldIds || []}
        fieldId={field.id}
        onCalculated={onCalculated}
      >
        {(calcValue, isCalculating) => (
          <div className="p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
            <p className="text-sm text-gray-500 dark:text-slate-400 mb-1">Calculated value</p>
            <p className="text-2xl font-semibold text-gray-900 dark:text-white">
              {isCalculating ? '...' : calcValue !== undefined && calcValue !== null ? String(calcValue) : '—'}
            </p>
          </div>
        )}
      </CalculatedFieldDisplay>
    );
  }

  if (field.type === 'file_upload') {
    return (
      <FileUploadField
        field={field as unknown as import('../../types/form').FormField}
        value={value}
        onChange={onChange}
        primaryColor={primaryColor}
        formId={formId}
        appSlug={appSlug}
      />
    );
  }

  if (field.type === 'location') {
    return (
      <LocationField
        value={value}
        onChange={onChange}
        primaryColor={primaryColor}
      />
    );
  }

  if (field.type === 'signature') {
    return <SignatureField value={value} onChange={onChange} primaryColor={primaryColor} />;
  }

  if (field.type === 'linked_record' && formId) {
    const targetFormId = field.properties?.targetFormId as string;
    const displayFieldIds = field.properties?.displayFieldIds as string[] | undefined;
    const searchFieldIds = field.properties?.searchFieldIds as string[] | undefined;
    const allowMultiple = field.properties?.allowMultiple as boolean | undefined;
    if (!targetFormId) {
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">Linked record field not configured</p>;
    }
    return (
      <LinkedRecordInput
        formId={formId}
        targetFormId={targetFormId}
        displayFieldIds={displayFieldIds}
        searchFieldIds={searchFieldIds}
        allowMultiple={allowMultiple}
        value={value}
        onChange={onChange}
        primaryColor={primaryColor}
      />
    );
  }

  // Fallback for unknown types
  return (
    <input
      type="text"
      value={(value as string) || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder || 'Type your answer here...'}
      className={inputClass}
      style={focusStyle}
      autoFocus
    />
  );
}

/**
 * Validate a field value against the field's validation rules.
 * Returns an error message string if validation fails, or null if valid.
 */
function validateField(field: FormField, value: unknown): string | null {
  // Number Min/Max/Step live on field.properties (the builder applies them only as
  // native <input> attributes, which the custom submit flow bypasses) — enforce them
  // here. Runs regardless of the validation rules array, which is often empty.
  if (field.type === 'number' && typeof value === 'number' && !Number.isNaN(value)) {
    const p = field.properties as { min?: unknown; max?: unknown; step?: unknown };
    const min = p.min != null && p.min !== '' ? Number(p.min) : null;
    const max = p.max != null && p.max !== '' ? Number(p.max) : null;
    const step = p.step != null && p.step !== '' ? Number(p.step) : null;
    if (min != null && Number.isFinite(min) && value < min) return `Minimum value is ${min}`;
    if (max != null && Number.isFinite(max) && value > max) return `Maximum value is ${max}`;
    if (step != null && Number.isFinite(step) && step > 0) {
      const base = min != null && Number.isFinite(min) ? min : 0;
      const steps = (value - base) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) {
        return base ? `Value must be ${base} plus a multiple of ${step}` : `Value must be a multiple of ${step}`;
      }
    }
  }

  const validations = field.validation;
  if (!validations?.length) return null;

  for (const rule of validations) {
    const msg = rule.message || 'Invalid value';
    switch (rule.type) {
      case 'minLength':
        if (typeof value === 'string' && value.length > 0 && value.length < Number(rule.value)) return msg;
        break;
      case 'maxLength':
        if (typeof value === 'string' && value.length > Number(rule.value)) return msg;
        break;
      case 'min':
        if (typeof value === 'number' && value < Number(rule.value)) return msg;
        break;
      case 'max':
        if (typeof value === 'number' && value > Number(rule.value)) return msg;
        break;
      case 'pattern':
        if (typeof value === 'string' && value.length > 0 && rule.value) {
          const pat = String(rule.value);
          // ReDoS protection: limit length and reject catastrophic backtracking patterns
          if (pat.length > 500) return msg;
          if (/(\+|\*|\{[^}]*\})\s*(\+|\*|\{[^}]*\})/.test(pat) || /\([^)]*\|[^)]*\)\+/.test(pat)) return msg;
          try { if (!new RegExp(pat).test(value)) return msg; } catch { return msg; }
        }
        break;
      // 'custom' uses expressions - skip for now as it requires the expression engine
      // 'required' is handled separately in the required-field check
    }
  }
  return null;
}

export function AppFormView() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, createResponse, canSubmit, canViewOwn, canViewAll } = useAppRuntimeStore();
  const reduceMotion = useReducedMotion();
  const [form, setForm] = useState<Record<string, unknown> | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showNigo, setShowNigo] = useState(false);
  const [viewMode, setViewMode] = useState<'focused' | 'classic'>('focused');
  const [calculatedValues, setCalculatedValues] = useState<Record<string, unknown>>({});

  const handleCalculated = useCallback((fId: string, val: unknown) => {
    setCalculatedValues(prev => {
      if (prev[fId] === val) return prev;
      return { ...prev, [fId]: val };
    });
  }, []);

  useEffect(() => {
    if (!appSlug || !formId) return;

    // This component instance is reused across /form/:formId navigations, so
    // reset all per-form state — otherwise the previous form's answers/step leak
    // into (and get submitted with) the next form.
    setAnswers({});
    setCalculatedValues({});
    setCurrentStep(0);
    setSubmitted(false);
    setError(null);

    // Cancellation guard so a slow request for the previous form can't resolve
    // after the new one and render a stale form under the new URL.
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    api.getAppForm(appSlug, formId).then((result) => {
      if (cancelled) return;
      if (result.data?.form) {
        setForm(result.data.form as Record<string, unknown>);
      } else if (result.error) {
        setFetchError(result.error);
      }
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setFetchError(err instanceof Error ? err.message : 'Failed to load form');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [appSlug, formId]);

  // Merge user answers with computed calculated field values. Drives both the
  // calculated expressions and conditional logic, so it must be defined before
  // `fields` (whose visibility depends on it).
  const allFormData = useMemo(
    () => ({ ...answers, ...calculatedValues }),
    [answers, calculatedValues]
  );

  // Evaluate conditional logic (show/hide/skip/require) exactly like the public
  // runtime — otherwise deployed apps would ignore field conditions entirely:
  // hidden fields stay shown and conditionally-required rules are lost.
  const { isFieldVisible, isFieldRequired } = useConditionalLogic(
    (form?.fields ?? []) as FormFieldType[],
    allFormData
  );

  const fields = useMemo(
    () => ((form?.fields ?? []) as FormField[]).filter(
      (f) => f.type !== 'thank_you' && isFieldVisible(f.id)
    ),
    [form, isFieldVisible]
  );
  const thankYouField = useMemo(
    () => ((form?.fields ?? []) as FormField[]).find(f => f.type === 'thank_you'),
    [form]
  );
  const formTheme = form?.theme as FormTheme | undefined;
  const formSettings = form?.settings as Record<string, unknown> | undefined;
  const primaryColor = formTheme?.primaryColor || 'var(--app-primary, #6366f1)';
  const showProgress = formSettings?.showProgressBar !== false;
  const allowBack = formSettings?.allowBackNavigation !== false;
  const nigoEnabled = formSettings?.showNigoDashboard === true;
  const presentationMode = (formSettings?.presentationMode as string) || 'both';
  const effectiveMode = presentationMode === 'both' ? viewMode : presentationMode;
  const showModeToggle = presentationMode === 'both';

  // Set initial view mode from form settings
  useEffect(() => {
    const dflt = formSettings?.defaultPresentationMode as string;
    if (dflt === 'focused' || dflt === 'classic') {
      setViewMode(dflt);
    }
  }, [formSettings?.defaultPresentationMode]);

  // Build sets for NigoDashboard
  const visibleFieldIds = useMemo(() => new Set(fields.map((f) => f.id)), [fields]);
  const requiredFieldIds = useMemo(() => {
    const s = new Set<string>();
    fields.forEach((f) => { if (isFieldRequired(f.id)) s.add(f.id); });
    return s;
  }, [fields, isFieldRequired]);

  // Clamp the step when conditional logic shrinks the visible set so the user
  // isn't stranded past the last remaining field.
  useEffect(() => {
    setCurrentStep((s) => Math.min(s, Math.max(0, fields.length - 1)));
  }, [fields.length]);

  const safeStep = Math.min(currentStep, Math.max(0, fields.length - 1));
  const currentField = fields[safeStep];
  const progress = fields.length > 0 ? ((safeStep + 1) / fields.length) * 100 : 0;
  const isLastStep = safeStep === fields.length - 1;

  const runtimeForm = config?.forms.find((f) => f.formId === formId);

  const handleSetAnswer = useCallback((fieldId: string, val: unknown) => {
    setAnswers((prev) => ({ ...prev, [fieldId]: val }));
  }, []);

  // Use refs to avoid stale closure when handleSubmit is called from memoized handleNext
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const calculatedRef = useRef(calculatedValues);
  calculatedRef.current = calculatedValues;

  const submittingRef = useRef(false);
  const handleSubmit = useCallback(async () => {
    if (!formId || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Merge calculated field values into submission so they're stored with the response
      const submissionData = { ...answersRef.current, ...calculatedRef.current };
      await createResponse(formId, submissionData);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    }
    setSubmitting(false);
    submittingRef.current = false;
  }, [formId, createResponse]);

  const handleNext = useCallback(() => {
    if (currentField && isFieldRequired(currentField.id) && !['statement', 'calculated', 'welcome_screen'].includes(currentField.type)) {
      const answer = answersRef.current[currentField.id];
      if (answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0)) {
        setError('Please fill in this field before continuing');
        return;
      }
    }
    // Validate against field validation rules (minLength, maxLength, min, max, pattern)
    if (currentField) {
      const answer = answersRef.current[currentField.id];
      const validationError = validateField(currentField, answer);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    setError(null);
    if (isLastStep) {
      handleSubmit();
    } else {
      setCurrentStep((s) => Math.min(s + 1, fields.length - 1));
    }
  }, [currentField, isLastStep, fields.length, handleSubmit, isFieldRequired]);

  const handlePrev = useCallback(() => {
    setError(null);
    setCurrentStep((s) => Math.max(s - 1, 0));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Don't intercept Enter in textarea or select elements
      if (currentField?.type === 'long_text') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'SELECT') return;
      e.preventDefault();
      handleNext();
    }
  }, [handleNext, currentField?.type]);

  const handleClassicSubmit = useCallback(() => {
    setError(null);
    const missingFields = fields.filter(f => {
      if (!isFieldRequired(f.id)) return false;
      if (['statement', 'calculated', 'welcome_screen'].includes(f.type)) return false;
      const answer = answersRef.current[f.id];
      return answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0);
    });
    if (missingFields.length > 0) {
      setError(`Please fill in all required fields (${missingFields.length} remaining)`);
      return;
    }
    // Validate all fields against their validation rules
    for (const f of fields) {
      const answer = answersRef.current[f.id];
      const validationError = validateField(f, answer);
      if (validationError) {
        setError(`${f.label}: ${validationError}`);
        return;
      }
    }
    handleSubmit();
  }, [fields, handleSubmit, isFieldRequired]);

  if (!formId || !config) return null;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading form" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-center">
          <p className="text-red-600 dark:text-red-400 mb-4">{fetchError}</p>
          <button onClick={() => navigate(`/app/${appSlug}`)} className="text-sm app-text-primary hover:underline cursor-pointer">
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (!canSubmit(formId)) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-center">
          <p className="text-gray-500 dark:text-slate-400 mb-4">You don&apos;t have permission to submit responses to this form.</p>
          <button onClick={() => navigate(`/app/${appSlug}`)} className="text-sm app-text-primary hover:underline cursor-pointer">
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Success screen
  if (submitted) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center max-w-md mx-auto px-4"
        >
          {(() => {
            const m = thankYouField?.properties?.mediaUrl as string | undefined;
            if (!m) return (
              <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6" style={{ backgroundColor: primaryColor }}>
                <CheckCircle className="h-10 w-10" style={{ color: 'var(--app-on-primary)' }} />
              </div>
            );
            return (thankYouField?.properties?.mediaType as string | undefined) === 'video'
              ? <video src={m} controls className="w-full rounded-xl max-h-64 mb-6" />
              : <img src={m} alt="" className="w-full rounded-xl max-h-64 object-contain mb-6" />;
          })()}
          <h1 className="text-3xl font-bold mb-3 text-gray-900 dark:text-white tracking-tight">{thankYouField?.label?.trim() || 'Thank you!'}</h1>
          <p className="text-lg text-gray-500 dark:text-slate-400 mb-8 leading-relaxed whitespace-pre-line">{thankYouField?.description?.trim() || 'Your response has been submitted successfully.'}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => { setSubmitted(false); setAnswers({}); setCalculatedValues({}); setCurrentStep(0); setError(null); }}
              className="px-5 py-2.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
            >
              Submit Another
            </button>
            {(canViewOwn(formId) || canViewAll(formId)) && (
              <button
                onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)}
                className="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors app-btn-primary"
              >
                View Responses
              </button>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-center">
          <p className="text-gray-500 dark:text-slate-400">This form has no fields.</p>
          <button onClick={() => navigate(`/app/${appSlug}`)} className="mt-4 text-sm app-text-primary hover:underline cursor-pointer">
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col min-h-[60vh]" onKeyDown={effectiveMode === 'focused' ? handleKeyDown : undefined}>
      {/* Back button + Mode toggle */}
      <div className="pt-2 pb-0 px-1 flex items-center justify-between">
        <button
          onClick={() => navigate(`/app/${appSlug}`)}
          className="flex items-center gap-1.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 text-sm transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-4 w-4" /> {runtimeForm?.displayName || 'Back'}
        </button>
        {showModeToggle && (
          <div className="flex items-center bg-gray-100 dark:bg-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('focused')}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer',
                effectiveMode === 'focused'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
              )}
            >
              Focused
            </button>
            <button
              onClick={() => setViewMode('classic')}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer',
                effectiveMode === 'classic'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
              )}
            >
              Classic
            </button>
          </div>
        )}
      </div>

      {effectiveMode === 'focused' ? (
      <>
      {/* Progress bar */}
      {showProgress && (
        <div className="absolute top-0 left-0 right-0 z-10">
          <div
            className="h-1 transition-all duration-300 rounded-full"
            style={{ width: `${progress}%`, backgroundColor: primaryColor }}
          />
        </div>
      )}

      {/* Main field area */}
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentField.id}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -30 }}
              transition={{ duration: reduceMotion ? 0 : 0.35 }}
              className="w-full"
            >
              {/* Field label & description */}
              <div className="mb-8">
                <h2 className="text-2xl md:text-3xl font-bold mb-2 text-gray-900 dark:text-white tracking-tight">
                  {currentField.label}
                  {isFieldRequired(currentField.id) && <span className="text-red-500 ml-1">*</span>}
                </h2>
                {currentField.description && (
                  <p className="text-base md:text-lg text-gray-500 dark:text-slate-400 leading-relaxed">
                    {currentField.description}
                  </p>
                )}
              </div>

              {/* Field input */}
              <FieldInput
                field={currentField}
                value={answers[currentField.id]}
                onChange={(val) => handleSetAnswer(currentField.id, val)}
                primaryColor={primaryColor}
                formId={formId}
                appSlug={appSlug}
                allAnswers={allFormData}
                allFieldIds={fields.map(f => f.id)}
                onCalculated={handleCalculated}
              />

              {/* Error */}
              {error && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 text-sm text-red-600 dark:text-red-400"
                >
                  {error}
                </motion.p>
              )}

              {/* OK / Submit button */}
              <div className="mt-8 flex items-center gap-4">
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-control text-sm font-semibold transition-all duration-200 hover:shadow-lg disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-current/50"
                  style={{ backgroundColor: primaryColor, color: 'var(--app-on-primary)' }}
                >
                  {submitting
                    ? 'Submitting...'
                    : isLastStep
                      ? 'Submit'
                      : (currentField?.type === 'welcome_screen' && (currentField.properties?.buttonText as string | undefined)) || 'OK'}
                  {!submitting && <Check className="h-4 w-4" />}
                </button>
                {!submitting && (
                  <span className="text-sm text-gray-400 dark:text-slate-500">
                    press <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-slate-800 rounded text-xs text-gray-600 dark:text-slate-400 font-mono">Enter ↵</kbd>
                  </span>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Step counter (bottom-left) */}
      <div className="absolute bottom-4 left-4 text-sm text-gray-400 dark:text-slate-500">
        {safeStep + 1} / {fields.length}
      </div>

      {/* NIGO Dashboard toggle & panel (bottom-left area, above step counter) */}
      {nigoEnabled && (
        <>
          <button
            type="button"
            onClick={() => setShowNigo((v) => !v)}
            className={cn(
              'absolute bottom-14 left-4 p-2 rounded-lg shadow-md border transition-colors z-10',
              showNigo
                ? 'bg-primary-600 text-primary-foreground border-primary-500'
                : 'bg-white dark:bg-slate-800 text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white border-gray-100 dark:border-slate-700'
            )}
            aria-label="Toggle NIGO Dashboard"
          >
            <ClipboardCheck className="h-4 w-4" />
          </button>
          {showNigo && (
            <div className="absolute bottom-24 left-4 w-72 z-20">
              <NigoDashboard
                fields={fields as unknown as FormFieldType[]}
                formData={answers}
                visibleFields={visibleFieldIds}
                requiredFields={requiredFieldIds}
                onFieldClick={(fieldId) => {
                  const idx = fields.findIndex((f) => f.id === fieldId);
                  if (idx >= 0) setCurrentStep(idx);
                }}
              />
            </div>
          )}
        </>
      )}

      {/* Navigation arrows (bottom-right) */}
      {allowBack && (
        <div className="absolute bottom-4 right-4 flex flex-col gap-1">
          <button
            type="button"
            onClick={handlePrev}
            disabled={safeStep === 0}
            aria-label="Previous field"
            className="p-2 bg-white dark:bg-slate-800 rounded-lg shadow-sm text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 border border-gray-200/80 dark:border-slate-700 hover:shadow-md cursor-pointer"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={submitting}
            aria-label="Next field"
            className="p-2 bg-white dark:bg-slate-800 rounded-lg shadow-sm text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30 transition-all duration-200 border border-gray-200/80 dark:border-slate-700 hover:shadow-md cursor-pointer"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      )}
      </>
      ) : (
        /* Classic Mode */
        <div className="flex-1 overflow-y-auto px-4 py-8">
          <div className="max-w-xl mx-auto w-full">
            {Boolean(form?.title) && (
              <div className="text-center mb-8">
                {typeof form?.icon === 'string' && form.icon && <DynamicIcon name={form.icon} className="h-8 w-8 mx-auto mb-2 text-gray-900 dark:text-white" />}
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
                  {String(form!.title)}
                </h1>
                {Boolean(form!.description) && (
                  <p className="mt-2 text-gray-500 dark:text-slate-400">{String(form!.description)}</p>
                )}
              </div>
            )}

            <div className="space-y-8">
              {fields.map((field) => (
                <div key={field.id} className="pb-6 border-b border-gray-100 dark:border-slate-800 last:border-0">
                  <div className="mb-6">
                    <h2 className="text-xl md:text-2xl font-bold mb-2 text-gray-900 dark:text-white tracking-tight">
                      {field.label}
                      {isFieldRequired(field.id) && <span className="text-red-500 ml-1">*</span>}
                    </h2>
                    {field.description && (
                      <p className="text-sm md:text-base text-gray-500 dark:text-slate-400 leading-relaxed">
                        {field.description}
                      </p>
                    )}
                  </div>
                  <FieldInput
                    field={field}
                    value={answers[field.id]}
                    onChange={(val) => handleSetAnswer(field.id, val)}
                    primaryColor={primaryColor}
                    formId={formId}
                    appSlug={appSlug}
                    allAnswers={allFormData}
                    onCalculated={handleCalculated}
                    allFieldIds={fields.map(f => f.id)}
                  />
                </div>
              ))}
            </div>

            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 text-sm text-red-600 dark:text-red-400 text-center"
              >
                {error}
              </motion.p>
            )}

            <div className="mt-10">
              <button
                type="button"
                onClick={handleClassicSubmit}
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-control text-sm font-semibold transition-all duration-200 hover:shadow-lg disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-current/50"
                style={{ backgroundColor: primaryColor, color: 'var(--app-on-primary)' }}
              >
                {submitting ? 'Submitting...' : (formSettings?.submitButtonText as string) || 'Submit'}
                {!submitting && <Check className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
