import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronUp, ChevronDown, Check } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { cn } from '../lib/utils';
import type { FormField } from '../types/form';

// Field Response Component
function FieldResponse({
  field,
  value,
  onChange,
  primaryColor,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  primaryColor: string;
}) {
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
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-xl transition-colors"
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
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-xl resize-none transition-colors"
            autoFocus
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={(value as number) || ''}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            placeholder={field.placeholder || '0'}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-xl transition-colors"
            autoFocus
          />
        );

      case 'date':
        return (
          <input
            type="date"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-b-2 border-gray-300 focus:border-primary-500 outline-none py-2 text-xl transition-colors"
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
                  'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all',
                  value === option.value
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                )}
                style={value === option.value ? { borderColor: primaryColor, backgroundColor: `${primaryColor}10` } : {}}
              >
                <span
                  className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-sm font-bold"
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
                  'w-full flex items-center gap-4 p-4 rounded-lg border-2 text-left transition-all',
                  selectedValues.includes(option.value)
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
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

      case 'rating':
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
            <div className="flex justify-between text-sm text-gray-500 mb-3">
              <span>{field.properties.scaleStartLabel || `${start}`}</span>
              <span>{field.properties.scaleEndLabel || `${end}`}</span>
            </div>
            <div className="flex gap-2">
              {Array.from({ length: end - start + 1 }, (_, i) => {
                const num = start + i;
                return (
                  <button
                    key={num}
                    onClick={() => onChange(num)}
                    className={cn(
                      'flex-1 py-4 rounded-lg border-2 font-bold text-lg transition-all',
                      scaleValue === num
                        ? 'text-white'
                        : 'border-gray-200 hover:border-gray-300'
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

      case 'statement':
        return null;

      default:
        return <p className="text-gray-500">Field type not supported</p>;
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 mb-3">
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </h2>
        {field.description && (
          <p className="text-lg text-gray-600">{field.description}</p>
        )}
      </div>
      {renderField()}
    </div>
  );
}

// Success Screen
function SuccessScreen({ form }: { form: { title: string; theme: { primaryColor: string } } }) {
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
      <h1 className="text-4xl font-bold text-gray-900 mb-4">Thank you!</h1>
      <p className="text-xl text-gray-600">Your response has been submitted successfully.</p>
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
    submitResponse,
    resetCurrentResponse,
  } = useResponseStore();

  const [isSubmitted, setIsSubmitted] = useState(false);

  const form = formId ? getForm(formId) : undefined;

  useEffect(() => {
    if (formId) {
      resetCurrentResponse();
      startResponse(formId);
    }
    return () => resetCurrentResponse();
  }, [formId]);

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-500">Form not found</p>
      </div>
    );
  }

  if (form.settings.isClosed) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: form.theme.backgroundColor }}
      >
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Form Closed</h1>
          <p className="text-gray-600">
            {form.settings.closedMessage || 'This form is no longer accepting responses.'}
          </p>
        </div>
      </div>
    );
  }

  const visibleFields = form.fields.filter((f) => !['welcome_screen', 'thank_you'].includes(f.type));
  const currentField = visibleFields[currentStep];
  const progress = visibleFields.length > 0 ? ((currentStep + 1) / visibleFields.length) * 100 : 0;
  const isLastStep = currentStep === visibleFields.length - 1;

  const handleSubmit = () => {
    const response = submitResponse();
    if (response) {
      updateForm(form.id, { responseCount: form.responseCount + 1 });
      setIsSubmitted(true);
    }
  };

  const handleNext = () => {
    if (currentField?.required) {
      const answer = currentAnswers[currentField.id];
      if (answer === undefined || answer === '' || (Array.isArray(answer) && answer.length === 0)) {
        alert('This field is required');
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
        <SuccessScreen form={form} />
      </div>
    );
  }

  if (visibleFields.length === 0) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: form.theme.backgroundColor }}
      >
        <p className="text-gray-500">This form has no questions.</p>
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
            />

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
              <span className="text-sm text-gray-500">
                press <kbd className="px-2 py-1 bg-gray-100 rounded text-gray-700">Enter</kbd>
              </span>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Navigation */}
      {form.settings.allowBackNavigation && (
        <div className="fixed bottom-4 right-4 flex flex-col gap-1">
          <button
            onClick={prevStep}
            disabled={currentStep === 0}
            className="p-2 bg-white rounded-lg shadow-md text-gray-600 hover:text-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
          <button
            onClick={handleNext}
            className="p-2 bg-white rounded-lg shadow-md text-gray-600 hover:text-gray-900"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Step Counter */}
      <div className="fixed bottom-4 left-4 text-sm text-gray-500">
        {currentStep + 1} / {visibleFields.length}
      </div>
    </div>
  );
}
