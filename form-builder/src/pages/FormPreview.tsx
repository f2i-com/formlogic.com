import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Monitor, Smartphone, ExternalLink, ChevronUp, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../components/ui/Button';
import { ProgressBar } from '../components/ui/ProgressBar';
import { useFormStore } from '../stores/formStore';
import { useUIStore } from '../stores/uiStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { cn } from '../lib/utils';
import type { FormField } from '../types/form';

// Field Preview Component
function FieldPreview({ field, value, onChange, isRequired }: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
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

      case 'multiple_choice':
        return (
          <div className="space-y-3">
            {field.properties.options?.map((option, index) => (
              <button
                key={option.id}
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

      case 'checkboxes':
        const selectedValues = (value as string[]) || [];
        return (
          <div className="space-y-3">
            {field.properties.options?.map((option) => (
              <button
                key={option.id}
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

      case 'rating':
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

      case 'scale':
        const start = field.properties.scaleStart || 1;
        const end = field.properties.scaleEnd || 10;
        const scaleValue = (value as number) || null;
        return (
          <div>
            <div className="flex justify-between text-sm text-gray-500 mb-2">
              <span>{field.properties.scaleStartLabel || start}</span>
              <span>{field.properties.scaleEndLabel || end}</span>
            </div>
            <div className="flex gap-2">
              {Array.from({ length: end - start + 1 }, (_, i) => {
                const num = start + i;
                return (
                  <button
                    key={num}
                    onClick={() => onChange(num)}
                    className={cn(
                      'flex-1 py-3 rounded-lg border-2 font-medium transition-all',
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

      case 'statement':
        return (
          <p className="text-lg text-gray-600">{field.description || 'Statement content'}</p>
        );

      default:
        return (
          <p className="text-gray-500 italic">Preview not available for this field type</p>
        );
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        {field.label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </h2>
      {field.description && field.type !== 'statement' && (
        <p className="text-gray-600 mb-6">{field.description}</p>
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
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-500">Form not found</p>
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
      alert('Form submitted! (This is a preview)');
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
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/builder/${form.id}`)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Exit Preview
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setPreviewDevice('desktop')}
              className={cn(
                'p-2 rounded-md transition-colors',
                previewDevice === 'desktop' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
              )}
            >
              <Monitor className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPreviewDevice('mobile')}
              className={cn(
                'p-2 rounded-md transition-colors',
                previewDevice === 'mobile' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
              )}
            >
              <Smartphone className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setPreviewMode('typeform')}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                previewMode === 'typeform' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
              )}
            >
              Typeform
            </button>
            <button
              onClick={() => setPreviewMode('classic')}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                previewMode === 'classic' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
              )}
            >
              Classic
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/form/${form.id}`, '_blank')}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Open
          </Button>
        </div>
      </header>

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
          ) : previewMode === 'typeform' ? (
            /* Typeform Mode */
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
