import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronUp, ChevronDown, Check } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import type { FormField } from '../types/form';

// Field Response Component
function FieldResponse({
  field,
  value,
  onChange,
  primaryColor,
  textColor,
  isRequired,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
  textColor?: string;
  isRequired?: boolean;
}) {
  const required = isRequired ?? field.required;
  const renderField = () => {
    switch (field.type) {
      case 'short_text':
      case 'email':
      case 'phone':
      case 'url':
        return (
          <input
            type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
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
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
          />
        );

      case 'time':
        return (
          <input
            type="time"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
          />
        );

      case 'datetime':
        return (
          <input
            type="datetime-local"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
          />
        );

      case 'multiple_choice':
        return (
          <div className="space-y-3" role="radiogroup" aria-label={field.label}>
            {field.properties.options?.map((option, index) => (
              <button
                key={option.id}
                role="radio"
                aria-checked={value === option.value}
                onClick={() => onChange(option.value)}
                className={cn(
                  'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all',
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
            {field.properties.options?.map((option) => (
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
                  'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all',
                  selectedValues.includes(option.value)
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-current/20 hover:border-current/30'
                )}
                style={selectedValues.includes(option.value) ? { borderColor: primaryColor, backgroundColor: `${primaryColor}10` } : {}}
              >
                <span
                  className={cn(
                    'w-8 h-8 rounded border-2 flex items-center justify-center',
                    selectedValues.includes(option.value) ? 'text-white' : ''
                  )}
                  style={selectedValues.includes(option.value) ? { backgroundColor: primaryColor, borderColor: primaryColor } : {}}
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
        return (
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
          <div className="flex gap-3 justify-center">
            {Array.from({ length: maxStars }, (_, i) => (
              <button
                key={i}
                onClick={() => onChange(i + 1)}
                className={cn(
                  'text-5xl transition-transform hover:scale-110',
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
        const start = field.properties.scaleStart || 1;
        const end = field.properties.scaleEnd || 10;
        const scaleValue = (value as number) || null;
        const scaleLength = end - start + 1;
        return (
          <div>
            <div className="flex justify-between text-sm opacity-60 mb-3">
              <span>{field.properties.scaleStartLabel || `${start}`}</span>
              <span>{field.properties.scaleEndLabel || `${end}`}</span>
            </div>
            <div className={cn(
              "grid gap-2",
              scaleLength <= 5 ? "grid-cols-5" : scaleLength <= 7 ? "grid-cols-7" : "grid-cols-5 sm:grid-cols-10"
            )}>
              {Array.from({ length: scaleLength }, (_, i) => {
                const num = start + i;
                return (
                  <button
                    key={num}
                    onClick={() => onChange(num)}
                    className={cn(
                      'py-4 rounded-lg border-2 font-bold text-lg transition-all',
                      scaleValue === num
                        ? 'text-white'
                        : 'border-current/20 hover:border-current/30'
                    )}
                    style={scaleValue === num ? { backgroundColor: primaryColor, borderColor: primaryColor } : {}}
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
        return null;

      case 'file_upload': {
        const uploadedFiles = (value as File[]) || [];
        const formatFileSize = (bytes: number) => {
          if (bytes < 1024) return bytes + ' B';
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
          return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };
        return (
          <div className="space-y-4">
            <label
              className={cn(
                "flex flex-col items-center justify-center w-full h-44 border-2 border-dashed rounded-xl cursor-pointer transition-all",
                uploadedFiles.length > 0
                  ? "border-current/30 bg-current/5"
                  : "border-current/30 hover:border-current/40 hover:bg-current/5"
              )}
              style={uploadedFiles.length > 0 ? { borderColor: primaryColor, backgroundColor: `${primaryColor}08` } : {}}
            >
              <div className="flex flex-col items-center justify-center py-5">
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
                  style={{ backgroundColor: `${primaryColor}15` }}
                >
                  <svg className="w-7 h-7" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </div>
                <p className="text-lg opacity-70">
                  <span className="font-semibold" style={{ color: primaryColor }}>Click to upload</span> or drag and drop
                </p>
                <p className="text-sm opacity-50 mt-2">
                  {field.properties.acceptedFileTypes?.length
                    ? field.properties.acceptedFileTypes.join(', ')
                    : 'Any file type'}
                  {field.properties.maxFileSize && ` • Max ${formatFileSize(field.properties.maxFileSize)}`}
                </p>
              </div>
              <input
                type="file"
                className="hidden"
                multiple={field.properties.allowMultiple}
                accept={field.properties.acceptedFileTypes?.join(',')}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  const maxSize = field.properties.maxFileSize;

                  // Validate file sizes
                  if (maxSize) {
                    const oversizedFiles = files.filter(f => f.size > maxSize);
                    if (oversizedFiles.length > 0) {
                      toast.error(
                        'File Too Large',
                        `${oversizedFiles[0].name} exceeds the maximum size of ${formatFileSize(maxSize)}`
                      );
                      // Filter out oversized files
                      const validFiles = files.filter(f => f.size <= maxSize);
                      if (validFiles.length === 0) return;
                      onChange(field.properties.allowMultiple ? [...uploadedFiles, ...validFiles] : validFiles);
                      return;
                    }
                  }

                  onChange(field.properties.allowMultiple ? [...uploadedFiles, ...files] : files);
                }}
              />
            </label>
            {uploadedFiles.length > 0 && (
              <div className="space-y-2">
                {uploadedFiles.map((file, index) => (
                  <div key={index} className="flex items-center gap-3 p-4 bg-current/5 rounded-xl border border-current/15">
                    <div
                      className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: `${primaryColor}15` }}
                    >
                      <svg className="w-6 h-6" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium opacity-80 truncate">{file.name}</p>
                      <p className="text-sm opacity-50">{formatFileSize(file.size)}</p>
                    </div>
                    <button
                      onClick={() => onChange(uploadedFiles.filter((_, i) => i !== index))}
                      className="p-2 opacity-50 hover:text-red-500 hover:opacity-100 hover:bg-red-500/10 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      case 'signature': {
        const signatureCanvasId = `signature-canvas-${field.id}`;
        return (
          <div className="space-y-4">
            <div
              className="w-full h-52 border-2 rounded-xl bg-white cursor-crosshair relative overflow-hidden transition-colors"
              style={{ borderColor: value ? primaryColor : `${textColor || '#1f2937'}30` }}
              onMouseDown={(e) => {
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
            {Boolean(value) && (
              <button
                onClick={() => {
                  const canvas = document.getElementById(signatureCanvasId) as HTMLCanvasElement;
                  if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx?.clearRect(0, 0, canvas.width, canvas.height);
                  }
                  onChange(null);
                }}
                className="text-red-500 hover:text-red-700 font-medium flex items-center gap-1.5"
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

      case 'payment': {
        const paymentAmount = field.properties.min || 0;
        const paymentCurrency = field.properties.currency || 'USD';
        return (
          <div className="p-6 border-2 border-current/20 rounded-xl bg-current/5">
            <div className="flex items-center justify-between mb-6">
              <span className="text-lg opacity-70">Amount due:</span>
              <span className="text-3xl font-bold" style={{ color: primaryColor }}>
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: paymentCurrency }).format(paymentAmount)}
              </span>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium opacity-60 mb-1.5">Card number</label>
                <input
                  type="text"
                  placeholder="1234 5678 9012 3456"
                  className="w-full p-4 border border-current/30 rounded-lg bg-transparent text-lg focus:ring-2 focus:ring-offset-0 focus:border-current/50 outline-none transition-colors"
                  style={{ '--tw-ring-color': primaryColor } as React.CSSProperties}
                  maxLength={19}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
                    e.target.value = val;
                  }}
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium opacity-60 mb-1.5">Expiry date</label>
                  <input
                    type="text"
                    placeholder="MM / YY"
                    className="w-full p-4 border border-current/30 rounded-lg bg-transparent text-lg focus:ring-2 focus:ring-offset-0 focus:border-current/50 outline-none transition-colors"
                    maxLength={7}
                    onChange={(e) => {
                      let val = e.target.value.replace(/\D/g, '');
                      if (val.length >= 2) {
                        val = val.slice(0, 2) + ' / ' + val.slice(2, 4);
                      }
                      e.target.value = val;
                    }}
                  />
                </div>
                <div className="w-28">
                  <label className="block text-sm font-medium opacity-60 mb-1.5">CVC</label>
                  <input
                    type="text"
                    placeholder="123"
                    className="w-full p-4 border border-current/30 rounded-lg bg-transparent text-lg focus:ring-2 focus:ring-offset-0 focus:border-current/50 outline-none transition-colors"
                    maxLength={4}
                  />
                </div>
              </div>
            </div>
            <p className="text-sm opacity-50 mt-5 text-center flex items-center justify-center gap-1.5">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              Secure payment processing
            </p>
          </div>
        );
      }

      case 'calculated':
        return (
          <div className="p-6 bg-current/5 rounded-lg text-center">
            <p className="text-sm opacity-60 mb-2">Calculated result:</p>
            <p className="text-4xl font-bold" style={{ color: primaryColor }}>
              {value !== undefined ? String(value) : '—'}
            </p>
            {field.properties.calculationExpression && (
              <p className="text-sm opacity-50 mt-3">
                Based on: {field.properties.calculationExpression}
              </p>
            )}
          </div>
        );

      default:
        return <p className="opacity-50">Field type not supported</p>;
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="mb-8">
        <h2
          className="text-3xl font-bold mb-3"
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
function SuccessScreen({ form, isRedirecting }: { form: { title: string; theme: { primaryColor: string; textColor: string } }; isRedirecting?: boolean }) {
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
        <Check className="h-10 w-10 text-white" />
      </div>
      <h1 className="text-4xl font-bold mb-4" style={{ color: form.theme.textColor }}>Thank you!</h1>
      <p className="text-xl" style={{ color: form.theme.textColor, opacity: 0.7 }}>Your response has been submitted successfully.</p>
      {isRedirecting && (
        <p className="text-lg mt-4 animate-pulse" style={{ color: form.theme.textColor, opacity: 0.5 }}>Redirecting...</p>
      )}
    </motion.div>
  );
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  const form = formId ? getForm(formId) : undefined;

  // Use conditional logic to determine field visibility
  // Note: hooks must be called before any early returns
  const { isFieldVisible, isFieldRequired, isEvaluating } = useConditionalLogic(
    form?.fields ?? [],
    currentAnswers
  );

  // Get visible fields based on conditional logic
  const visibleFields = useMemo(() => {
    if (!form) return [];
    return form.fields.filter((f) => {
      if (['welcome_screen', 'thank_you'].includes(f.type)) return false;
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

  // Get dynamic required status for a field
  const getFieldRequired = (field: FormField) => {
    return field.required || isFieldRequired(field.id);
  };

  if (!form) {
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
          <h1 className="text-2xl font-bold mb-2">Form Closed</h1>
          <p className="opacity-70">
            {form.settings.closedMessage || 'This form is no longer accepting responses.'}
          </p>
        </div>
      </div>
    );
  }

  // Ensure currentStep is within bounds when fields change
  const safeCurrentStep = Math.min(currentStep, Math.max(0, visibleFields.length - 1));
  const currentField = visibleFields[safeCurrentStep];
  const progress = visibleFields.length > 0 ? ((safeCurrentStep + 1) / visibleFields.length) * 100 : 0;
  const isLastStep = safeCurrentStep === visibleFields.length - 1;

  const handleSubmit = () => {
    setSubmitError(null);
    try {
      const response = submitResponse();
      if (response) {
        updateForm(form.id, { responseCount: form.responseCount + 1 });
        setIsSubmitted(true);

        // Handle redirectUrl (validate to prevent javascript: XSS)
        const redirectUrl = form.settings?.redirectUrl;
        if (redirectUrl && /^https?:\/\//i.test(redirectUrl)) {
          setIsRedirecting(true);
          setTimeout(() => {
            window.location.href = redirectUrl;
          }, 2000);
        }
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to submit response. Please try again.');
    }
  };

  const handleNext = () => {
    setFieldError(null);
    setSubmitError(null);

    if (currentField && getFieldRequired(currentField)) {
      const answer = currentAnswers[currentField.id];
      if (answer === undefined || answer === '' || (Array.isArray(answer) && answer.length === 0)) {
        setFieldError('This field is required');
        return;
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
      e.preventDefault();
      handleNext();
    }
  };

  if (isSubmitted) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: form.theme.backgroundColor }}
      >
        <SuccessScreen form={form} isRedirecting={isRedirecting} />
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
      onKeyDown={handleKeyDown}
    >
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
            />

            {/* Inline validation error */}
            {fieldError && (
              <p className="mt-3 text-red-500 text-sm">{fieldError}</p>
            )}

            {/* OK Button */}
            <div className="mt-8 flex items-center gap-4 justify-center">
              <Button
                size="lg"
                onClick={handleNext}
                style={{ backgroundColor: form.theme.primaryColor }}
                className="text-white px-8"
              >
                {isLastStep ? 'Submit' : 'OK'} <Check className="ml-2 h-4 w-4" />
              </Button>
              <span className="text-sm opacity-50">
                press <kbd className="px-2 py-1 bg-current/10 rounded opacity-80">Enter</kbd>
              </span>
            </div>

            {/* Submission error */}
            {submitError && (
              <p className="mt-4 text-red-500 text-sm text-center">{submitError}</p>
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
            className="p-2 bg-current/10 backdrop-blur-sm rounded-lg shadow-md opacity-60 hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
          <button
            onClick={handleNext}
            aria-label="Next question"
            className="p-2 bg-current/10 backdrop-blur-sm rounded-lg shadow-md opacity-60 hover:opacity-90 transition-opacity"
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
    </div>
  );
}
