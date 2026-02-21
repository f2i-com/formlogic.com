import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, ChevronUp, ChevronDown, CheckCircle, ClipboardCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { LinkedRecordInput } from './LinkedRecordInput';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { NigoDashboard } from '../builder/NigoDashboard';
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

function FieldInput({
  field,
  value,
  onChange,
  primaryColor,
  formId,
}: {
  field: FormField;
  value: unknown;
  onChange: (val: unknown) => void;
  primaryColor: string;
  formId?: string;
}) {
  const inputClass = 'w-full bg-transparent border-b-2 border-gray-300 dark:border-slate-600 outline-none py-2 text-xl text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 transition-colors focus:border-current';
  const focusStyle = { '--focus-color': primaryColor } as React.CSSProperties;

  if (['short_text', 'email', 'phone', 'url'].includes(field.type)) {
    return (
      <input
        type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'url' ? 'url' : 'text'}
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
        step="any"
        value={(value as number) ?? ''}
        onChange={(e) => {
          const val = parseFloat(e.target.value);
          onChange(isNaN(val) ? undefined : val);
        }}
        placeholder={field.placeholder || 'Type a number...'}
        className={inputClass}
        style={{ ...focusStyle, borderColor: value ? primaryColor : undefined }}
        autoFocus
      />
    );
  }

  if (['date', 'time', 'datetime'].includes(field.type)) {
    return (
      <input
        type={field.type === 'datetime' ? 'datetime-local' : field.type}
        value={(value as string) || ''}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, 'max-w-xs')}
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
                'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all',
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
              <span className="flex-1 text-lg text-gray-900 dark:text-white">{option.label}</span>
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
        className="w-full bg-white dark:bg-slate-800 border-2 border-gray-300 dark:border-slate-600 outline-none py-3 px-4 rounded-lg text-xl text-gray-900 dark:text-white transition-colors"
        style={{ borderColor: value ? primaryColor : undefined }}
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
      <div className="space-y-3">
        {options.map((option, index) => {
          const checked = current.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(checked ? current.filter((v) => v !== option.value) : [...current, option.value]);
              }}
              className={cn(
                'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all',
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
              <span className="flex-1 text-lg text-gray-900 dark:text-white">{option.label}</span>
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
                onChange(Math.max(1, (currentRating || 2) - 1));
              }
            }}
            className={cn(
              'text-4xl transition-all duration-150 hover:scale-125',
              currentRating > i ? 'text-yellow-400' : 'text-gray-300 dark:text-slate-600'
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
        <div className={cn('grid gap-2', range <= 5 ? 'grid-cols-5' : range <= 7 ? 'grid-cols-7' : 'grid-cols-10')}>
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
                    onChange(Math.min(max, ((value as number) || min - 1) + 1));
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    onChange(Math.max(min, ((value as number) || min + 1) - 1));
                  }
                }}
                className={cn(
                  'aspect-square rounded-lg border-2 flex items-center justify-center text-lg font-medium transition-all hover:scale-105',
                  selected ? 'text-white shadow-sm' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500 text-gray-700 dark:text-slate-300'
                )}
                style={selected ? { backgroundColor: primaryColor, borderColor: primaryColor } : {}}
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

  if (field.type === 'statement') {
    return (
      <p className="text-lg text-gray-600 dark:text-slate-400">{field.description || 'Statement content'}</p>
    );
  }

  if (field.type === 'calculated') {
    return (
      <div className="p-4 bg-gray-50 dark:bg-slate-800 rounded-lg">
        <p className="text-sm text-gray-500 dark:text-slate-400 mb-1">Calculated value</p>
        <p className="text-2xl font-semibold text-gray-900 dark:text-white">
          {value !== undefined && value !== null ? String(value) : '—'}
        </p>
      </div>
    );
  }

  if (field.type === 'file_upload') {
    const uploadedFiles = (value as File[]) || [];
    const maxSize = field.properties?.maxFileSize as number | undefined;
    const formatFileSize = (bytes: number) => {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };
    return (
      <div className="space-y-3">
        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 dark:border-slate-600 rounded-xl cursor-pointer hover:border-gray-400 dark:hover:border-slate-500 transition-colors">
          <div className="flex flex-col items-center py-4">
            <svg className="w-8 h-8 text-gray-400 dark:text-slate-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              <span className="font-medium" style={{ color: primaryColor }}>Click to upload</span> or drag and drop
            </p>
            {maxSize && <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">Max {formatFileSize(maxSize)}</p>}
          </div>
          <input
            type="file"
            className="hidden"
            multiple={field.properties?.allowMultiple as boolean}
            accept={(field.properties?.acceptedFileTypes as string[])?.join(',')}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (maxSize) {
                const valid = files.filter(f => f.size <= maxSize);
                onChange(field.properties?.allowMultiple ? [...uploadedFiles, ...valid] : valid);
              } else {
                onChange(field.properties?.allowMultiple ? [...uploadedFiles, ...files] : files);
              }
            }}
          />
        </label>
        {uploadedFiles.length > 0 && (
          <div className="space-y-2">
            {uploadedFiles.map((file, i) => (
              <div key={i} className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-slate-800 rounded-lg text-sm">
                <span className="flex-1 truncate text-gray-700 dark:text-slate-300">{file.name}</span>
                <span className="text-gray-400 dark:text-slate-500 text-xs">{formatFileSize(file.size)}</span>
                <button onClick={() => onChange(uploadedFiles.filter((_, idx) => idx !== i))} className="text-red-500 hover:text-red-700">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (field.type === 'signature') {
    const sigId = `sig-${field.id}`;
    const getStrokeColor = () => document.documentElement.classList.contains('dark') ? '#e2e8f0' : '#1f2937';
    return (
      <div className="space-y-2">
        <div
          className={cn(
            'w-full h-36 border-2 rounded-lg cursor-crosshair relative overflow-hidden transition-colors',
            value ? 'border-gray-400 dark:border-slate-500' : 'border-gray-300 dark:border-slate-600'
          )}
          style={{ borderColor: value ? primaryColor : undefined }}
          onMouseDown={(e) => {
            const canvas = e.currentTarget.querySelector('canvas');
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
            const onMove = (me: MouseEvent) => { ctx.lineTo((me.clientX - rect.left) * sx, (me.clientY - rect.top) * sy); ctx.stroke(); onChange(canvas.toDataURL()); };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
          onTouchStart={(e) => {
            e.preventDefault();
            const canvas = e.currentTarget.querySelector('canvas');
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
            const onMove = (te: TouchEvent) => { te.preventDefault(); const mt = te.touches[0]; ctx.lineTo((mt.clientX - rect.left) * sx, (mt.clientY - rect.top) * sy); ctx.stroke(); onChange(canvas.toDataURL()); };
            const onEnd = () => { document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd); };
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
          }}
        >
          <canvas id={sigId} width={500} height={180} className="w-full h-full" style={{ touchAction: 'none' }} />
          {!value && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-gray-400 dark:text-slate-500">Sign here</p>
            </div>
          )}
        </div>
        {Boolean(value) && (
          <button
            onClick={() => { const c = document.getElementById(sigId) as HTMLCanvasElement; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); onChange(null); }}
            className="text-sm text-red-500 hover:text-red-700"
          >
            Clear signature
          </button>
        )}
      </div>
    );
  }

  if (field.type === 'payment') {
    const amount = (field.properties?.amount as number) ?? (field.properties?.min as number) ?? 0;
    const currency = (field.properties?.currency as string) || 'USD';
    return (
      <div className="p-4 border-2 border-gray-200 dark:border-slate-600 rounded-xl bg-gray-50 dark:bg-slate-800">
        <div className="flex items-center justify-between mb-4">
          <span className="text-gray-500 dark:text-slate-400">Amount:</span>
          <span className="text-2xl font-bold text-gray-900 dark:text-white">
            {new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)}
          </span>
        </div>
        <p className="text-xs text-gray-400 dark:text-slate-500 text-center">Payment processing (preview only)</p>
      </div>
    );
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

export function AppFormView() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, createResponse, canSubmit } = useAppRuntimeStore();
  const [form, setForm] = useState<Record<string, unknown> | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showNigo, setShowNigo] = useState(false);

  useEffect(() => {
    if (appSlug && formId) {
      setLoading(true);
      setFetchError(null);
      api.getAppForm(appSlug, formId).then((result) => {
        if (result.data?.form) {
          setForm(result.data.form as Record<string, unknown>);
        } else if (result.error) {
          setFetchError(result.error);
        }
        setLoading(false);
      }).catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load form');
        setLoading(false);
      });
    }
  }, [appSlug, formId]);

  const fields = useMemo(
    () => ((form?.fields ?? []) as FormField[]).filter(f => !['welcome_screen', 'thank_you'].includes(f.type)),
    [form]
  );
  const formTheme = form?.theme as FormTheme | undefined;
  const formSettings = form?.settings as Record<string, unknown> | undefined;
  const primaryColor = formTheme?.primaryColor || 'var(--app-primary, #6366f1)';
  const showProgress = formSettings?.showProgressBar !== false;
  const allowBack = formSettings?.allowBackNavigation !== false;
  const nigoEnabled = formSettings?.showNigoDashboard === true;

  // Build sets for NigoDashboard
  const visibleFieldIds = useMemo(() => new Set(fields.map((f) => f.id)), [fields]);
  const requiredFieldIds = useMemo(() => {
    const s = new Set<string>();
    fields.forEach((f) => { if (f.required) s.add(f.id); });
    return s;
  }, [fields]);

  const safeStep = Math.min(currentStep, Math.max(0, fields.length - 1));
  const currentField = fields[safeStep];
  const progress = fields.length > 0 ? ((safeStep + 1) / fields.length) * 100 : 0;
  const isLastStep = safeStep === fields.length - 1;

  const runtimeForm = config?.forms.find((f) => f.formId === formId);

  const handleSetAnswer = useCallback((fieldId: string, val: unknown) => {
    setAnswers((prev) => ({ ...prev, [fieldId]: val }));
  }, []);

  // Use ref to avoid stale closure when handleSubmit is called from memoized handleNext
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const handleSubmit = useCallback(async () => {
    if (!formId) return;
    setSubmitting(true);
    setError(null);
    try {
      await createResponse(formId, answersRef.current);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    }
    setSubmitting(false);
  }, [formId, createResponse]);

  const handleNext = useCallback(() => {
    if (currentField?.required && !['statement', 'calculated'].includes(currentField.type)) {
      const answer = answers[currentField.id];
      if (answer === undefined || answer === '' || (Array.isArray(answer) && answer.length === 0)) {
        setError('Please fill in this field before continuing');
        return;
      }
    }
    setError(null);
    if (isLastStep) {
      handleSubmit();
    } else {
      setCurrentStep((s) => Math.min(s + 1, fields.length - 1));
    }
  }, [currentField, answers, isLastStep, fields.length, handleSubmit]);

  const handlePrev = useCallback(() => {
    setError(null);
    setCurrentStep((s) => Math.max(s - 1, 0));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Don't intercept Enter in textarea
      if (currentField?.type === 'long_text') return;
      e.preventDefault();
      handleNext();
    }
  }, [handleNext, currentField?.type]);

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
          <button onClick={() => navigate(`/app/${appSlug}`)} className="text-sm app-text-primary hover:underline">
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
          <button onClick={() => navigate(`/app/${appSlug}`)} className="text-sm app-text-primary hover:underline">
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
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
            style={{ backgroundColor: primaryColor }}
          >
            <CheckCircle className="h-10 w-10 text-white" />
          </div>
          <h1 className="text-3xl font-bold mb-3 text-gray-900 dark:text-white">Thank you!</h1>
          <p className="text-lg text-gray-500 dark:text-slate-400 mb-8">Your response has been submitted successfully.</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => { setSubmitted(false); setAnswers({}); setCurrentStep(0); setError(null); }}
              className="px-5 py-2.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
            >
              Submit Another
            </button>
            <button
              onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)}
              className="px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors app-btn-primary"
            >
              View Responses
            </button>
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
          <button onClick={() => navigate(`/app/${appSlug}`)} className="mt-4 text-sm app-text-primary hover:underline">
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col min-h-[60vh]" onKeyDown={handleKeyDown}>
      {/* Progress bar */}
      {showProgress && (
        <div className="absolute top-0 left-0 right-0 z-10">
          <div
            className="h-1 transition-all duration-300 rounded-full"
            style={{ width: `${progress}%`, backgroundColor: primaryColor }}
          />
        </div>
      )}

      {/* Back button */}
      <div className="pt-2 pb-0 px-1">
        <button
          onClick={() => navigate(`/app/${appSlug}`)}
          className="flex items-center gap-1.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 text-sm transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> {runtimeForm?.displayName || 'Back'}
        </button>
      </div>

      {/* Main field area */}
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentField.id}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.35 }}
              className="w-full"
            >
              {/* Field label & description */}
              <div className="mb-8">
                <h2 className="text-2xl md:text-3xl font-bold mb-2 text-gray-900 dark:text-white">
                  {currentField.label}
                  {currentField.required && <span className="text-red-500 ml-1">*</span>}
                </h2>
                {currentField.description && (
                  <p className="text-base md:text-lg text-gray-500 dark:text-slate-400">
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
              />

              {/* Error */}
              {error && (
                <motion.p
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
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-white text-sm font-medium transition-all hover:shadow-md disabled:opacity-50"
                  style={{ backgroundColor: primaryColor }}
                >
                  {submitting ? 'Submitting...' : isLastStep ? 'Submit' : 'OK'}
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
                ? 'bg-primary-600 text-white border-primary-500'
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
                collapsed={false}
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
            className="p-2 bg-white dark:bg-slate-800 rounded-lg shadow-md text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-gray-100 dark:border-slate-700"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={submitting}
            aria-label="Next field"
            className="p-2 bg-white dark:bg-slate-800 rounded-lg shadow-md text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30 transition-colors border border-gray-100 dark:border-slate-700"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
