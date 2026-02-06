import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Monitor, Smartphone, ExternalLink, ChevronUp, ChevronDown, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { useFormStore } from '../stores/formStore';
import { useUIStore } from '../stores/uiStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import type { FormField } from '../types/form';

// Field Preview Component
function FieldPreview({ field, value, onChange, isRequired, textColor }: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  isRequired?: boolean;
  textColor?: string;
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
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'long_text':
        return (
          <textarea
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || 'Type your answer here...'}
            rows={4}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-lg resize-none transition-colors"
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={(value as number) || ''}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            placeholder={field.placeholder || '0'}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'date':
        return (
          <input
            type="date"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'time':
        return (
          <input
            type="time"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
          />
        );

      case 'datetime':
        return (
          <input
            type="datetime-local"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-lg transition-colors"
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
                  'w-full flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all',
                  value === option.value
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
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
                  'w-full flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all',
                  selectedValues.includes(option.value)
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                )}
              >
                <span className={cn(
                  'w-6 h-6 rounded border-2 flex items-center justify-center',
                  selectedValues.includes(option.value)
                    ? 'bg-primary-500 border-primary-500 text-white'
                    : 'border-gray-400'
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
        return (
          <select
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-white border-2 border-gray-300 focus:border-primary-500 outline-none py-3 px-4 rounded-lg text-lg transition-colors"
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
          <div className="flex gap-2">
            {Array.from({ length: maxStars }, (_, i) => (
              <button
                key={i}
                onClick={() => onChange(i + 1)}
                className={cn(
                  'text-4xl transition-transform hover:scale-110',
                  i < currentRating ? 'text-yellow-400' : 'text-gray-300'
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
            <div className="flex justify-between text-sm text-gray-500 mb-2">
              <span>{field.properties.scaleStartLabel || start}</span>
              <span>{field.properties.scaleEndLabel || end}</span>
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
                      'py-3 rounded-lg border-2 font-medium transition-all',
                      scaleValue === num
                        ? 'border-primary-500 bg-primary-500 text-white'
                        : 'border-gray-200 hover:border-gray-300'
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
          <p className="text-lg text-gray-600">{field.description || 'Statement content'}</p>
        );

      case 'file_upload': {
        const uploadedFiles = (value as File[]) || [];
        const formatFileSize = (bytes: number) => {
          if (bytes < 1024) return bytes + ' B';
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
          return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };
        return (
          <div className="space-y-4">
            <label className={cn(
              "flex flex-col items-center justify-center w-full h-36 border-2 border-dashed rounded-xl cursor-pointer transition-all",
              uploadedFiles.length > 0
                ? "border-primary-300 bg-primary-50 hover:bg-primary-100"
                : "border-gray-300 bg-gray-50 hover:bg-gray-100 hover:border-gray-400"
            )}>
              <div className="flex flex-col items-center justify-center py-4">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                  <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">
                  <span className="font-semibold text-primary-600">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-gray-400 mt-1">
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
                  <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="w-10 h-10 rounded-lg bg-primary-100 flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">{file.name}</p>
                      <p className="text-xs text-gray-400">{formatFileSize(file.size)}</p>
                    </div>
                    <button
                      onClick={() => onChange(uploadedFiles.filter((_, i) => i !== index))}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        const signatureId = `signature-${field.id}`;
        return (
          <div className="space-y-3">
            <div
              className={cn(
                "w-full h-40 border-2 rounded-lg bg-white cursor-crosshair relative overflow-hidden transition-colors",
                value ? "border-primary-500" : "border-gray-300"
              )}
              onMouseDown={(e) => {
                const canvas = e.currentTarget.querySelector('canvas');
                if (!canvas) return;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                ctx.strokeStyle = '#1f2937';
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

                ctx.strokeStyle = '#1f2937';
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
                  <p className="text-gray-400 flex items-center gap-2">
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
                onClick={() => {
                  const canvas = document.getElementById(signatureId) as HTMLCanvasElement;
                  if (canvas) {
                    const ctx = canvas.getContext('2d');
                    ctx?.clearRect(0, 0, canvas.width, canvas.height);
                  }
                  onChange(null);
                }}
                className="text-sm text-red-500 hover:text-red-700 flex items-center gap-1"
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
        const amount = field.properties.min || 0;
        const currency = field.properties.currency || 'USD';
        return (
          <div className="p-5 border-2 border-gray-200 rounded-xl bg-gray-50">
            <div className="flex items-center justify-between mb-5">
              <span className="text-gray-600">Amount:</span>
              <span className="text-2xl font-bold text-gray-900">
                {new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)}
              </span>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Card number</label>
                <input
                  type="text"
                  placeholder="1234 5678 9012 3456"
                  className="w-full p-3 border border-gray-300 rounded-lg bg-white text-gray-400"
                  disabled
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Expiry</label>
                  <input
                    type="text"
                    placeholder="MM / YY"
                    className="w-full p-3 border border-gray-300 rounded-lg bg-white text-gray-400"
                    disabled
                  />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-gray-500 mb-1">CVC</label>
                  <input
                    type="text"
                    placeholder="123"
                    className="w-full p-3 border border-gray-300 rounded-lg bg-white text-gray-400"
                    disabled
                  />
                </div>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-4 text-center flex items-center justify-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              Secure payment (preview only)
            </p>
          </div>
        );
      }

      case 'calculated':
        return (
          <div className="p-4 bg-gray-100 rounded-lg">
            <p className="text-sm text-gray-500 mb-1">Calculated value:</p>
            <p className="text-2xl font-semibold text-gray-800">
              {value !== undefined ? String(value) : '—'}
            </p>
            {field.properties.calculationExpression && (
              <p className="text-xs text-gray-400 mt-2">
                Formula: {field.properties.calculationExpression}
              </p>
            )}
          </div>
        );

      default:
        return (
          <p className="text-gray-500 italic">Preview not available for this field type</p>
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
}

// Main Preview Component
export default function FormPreview() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const { getForm } = useFormStore();
  const { previewDevice, setPreviewDevice, previewMode, setPreviewMode } = useUIStore();

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [showEmbedModal, setShowEmbedModal] = useState(false);

  const form = formId ? getForm(formId) : undefined;

  // Use conditional logic to determine field visibility
  const { isFieldVisible, isFieldRequired, isEvaluating } = useConditionalLogic(
    form?.fields ?? [],
    answers
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
              className={cn(
                'p-2 rounded-md transition-all duration-200',
                previewDevice === 'desktop'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              <Monitor className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPreviewDevice('mobile')}
              className={cn(
                'p-2 rounded-md transition-all duration-200',
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
                'px-2 sm:px-3 py-1.5 text-xs sm:text-sm rounded-md transition-all duration-200',
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
                'px-2 sm:px-3 py-1.5 text-xs sm:text-sm rounded-md transition-all duration-200',
                previewMode === 'classic'
                  ? 'bg-white dark:bg-slate-700 shadow-sm text-gray-900 dark:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-500 dark:text-slate-400'
              )}
            >
              Classic
            </button>
          </div>

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
            onClick={() => window.open(`/form/${form.id}`, '_blank')}
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
      <div className="flex-1 flex items-center justify-center p-8">
        <div
          className={cn(
            'bg-white rounded-2xl shadow-2xl overflow-hidden transition-all duration-300',
            previewDevice === 'mobile' ? 'w-[375px] h-[667px]' : 'w-full max-w-4xl h-[600px]'
          )}
          style={{
            backgroundColor: form.theme.backgroundColor,
            color: form.theme.textColor,
          }}
        >
          {visibleFields.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-500">
              <p>Add some fields to preview your form</p>
            </div>
          ) : previewMode === 'focused' ? (
            /* Focused Mode */
            <div className="h-full flex flex-col">
              {/* Progress */}
              <div className="p-4">
                <ProgressBar value={progress} size="sm" />
                <p className="text-sm text-gray-500 mt-2 text-right">
                  {safeCurrentStep + 1} of {visibleFields.length}
                  {isEvaluating && <span className="ml-2 animate-pulse">...</span>}
                </p>
              </div>

              {/* Content */}
              <div className="flex-1 flex items-center justify-center p-8">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentField.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.3 }}
                    className="w-full max-w-lg"
                  >
                    <FieldPreview
                      field={currentField}
                      value={answers[currentField.id]}
                      onChange={(val) => handleAnswerChange(currentField.id, val)}
                      isRequired={getFieldRequired(currentField)}
                      textColor={form.theme.textColor}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Navigation */}
              <div className="p-4 flex items-center justify-between border-t border-gray-100">
                <button
                  onClick={handlePrev}
                  disabled={safeCurrentStep === 0}
                  className="p-2 text-gray-400 hover:text-gray-600 disabled:opacity-50"
                >
                  <ChevronUp className="h-6 w-6" />
                </button>
                <Button onClick={handleNext} style={{ backgroundColor: form.theme.primaryColor }}>
                  {isLastStep ? 'Submit' : 'OK'} ✓
                </Button>
                <button
                  onClick={handleNext}
                  disabled={isLastStep}
                  className="p-2 text-gray-400 hover:text-gray-600 disabled:opacity-50"
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
                  <h1 className="text-3xl font-bold">{form.title}</h1>
                  {form.description && (
                    <p className="text-gray-600 mt-2">{form.description}</p>
                  )}
                </div>

                {visibleFields.map((field) => (
                  <div key={field.id} className="pb-6 border-b border-gray-100 last:border-0">
                    <FieldPreview
                      field={field}
                      value={answers[field.id]}
                      onChange={(val) => handleAnswerChange(field.id, val)}
                      isRequired={getFieldRequired(field)}
                      textColor={form.theme.textColor}
                    />
                  </div>
                ))}

                <div className="pt-4">
                  <Button
                    className="w-full"
                    size="lg"
                    style={{ backgroundColor: form.theme.primaryColor }}
                  >
                    {form.settings.submitButtonText || 'Submit'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
