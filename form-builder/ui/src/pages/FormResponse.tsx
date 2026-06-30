import { useEffect, useState, useMemo, useCallback, useRef, cloneElement, isValidElement, type ReactElement } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ChevronUp, ChevronDown, Check, FileQuestion, RefreshCw, ClipboardCheck } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { NigoDashboard } from '../components/builder/NigoDashboard';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { useConditionalLogic } from '../hooks/useFormLogic';
import { cn } from '../lib/utils';
import { readableForegroundColor, parseHex, luminance } from '../lib/color';
import { useUIStore } from '../stores/uiStore';
import { api } from '../lib/api';
import { CustomScreenRuntime } from '../components/custom-screen/CustomScreenRuntime';
import { logger } from '../lib/logger';
import { PhoneInput } from '../components/ui/PhoneInput';
import { CalculatedFieldDisplay } from '../components/ui/CalculatedFieldDisplay';
import { DynamicIcon } from '../components/ui/DynamicIcon';
import { FileUploadField } from '../components/ui/FileUploadField';
import { LocationField } from '../components/ui/LocationField';
import type { FormField } from '../types/form';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { handleRovingKeys } from '../lib/a11y';
import { DEFAULT_FORM_SETTINGS, DEFAULT_FORM_THEME } from '../types/form';

// Field Response Component
export function FieldResponse({
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
  error,
  autoFocus = true,
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
  error?: string;
  autoFocus?: boolean;
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
            autoFocus={autoFocus}
            required={required}
          />
        );

      case 'short_text':
      case 'email':
      case 'url':
        return (
          <input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            inputMode={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : undefined}
            autoComplete={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : undefined}
            aria-label={field.label}
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder || 'Type your answer here...'}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
            style={{ '--tw-ring-color': primaryColor } as React.CSSProperties}
            autoFocus={autoFocus}
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
            autoFocus={autoFocus}
          />
        );

      case 'number':
        return (
          <input
            type="number"
            inputMode="decimal"
            aria-label={field.label}
            aria-required={required}
            value={(value as number) ?? ''}
            min={field.properties.min}
            max={field.properties.max}
            step={field.properties.step ?? 'any'}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange(isNaN(val) ? undefined : val);
            }}
            placeholder={field.placeholder || '0'}
            className="w-full bg-transparent border-b-2 border-current/30 focus:border-current/60 outline-none py-2 text-xl transition-colors"
            autoFocus={autoFocus}
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
            autoFocus={autoFocus}
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
            autoFocus={autoFocus}
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
            autoFocus={autoFocus}
          />
        );

      case 'multiple_choice': {
        const mcOpts = field.properties.options ?? [];
        const radioFocusIdx = Math.max(0, mcOpts.findIndex((o) => o.value === value));
        return (
          <div className="space-y-3" role="radiogroup" aria-label={field.label} aria-required={required || undefined}>
            {mcOpts.length === 0 ? (
              <p className="opacity-50 italic text-sm">No options configured</p>
            ) : mcOpts.map((option, index) => (
              <button
                key={option.id}
                role="radio"
                aria-checked={value === option.value}
                tabIndex={index === radioFocusIdx ? 0 : -1}
                onKeyDown={(e) => handleRovingKeys(e, mcOpts, true, onChange)}
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
                <span className="flex-1 min-w-0 break-words text-lg">{option.label?.trim() || option.value}</span>
                {value === option.value && (
                  <Check className="h-5 w-5" style={{ color: primaryColor }} />
                )}
              </button>
            ))}
          </div>
        );
      }

      case 'checkboxes': {

        const selectedValues = (value as string[]) || [];
        const cbOpts = field.properties.options ?? [];
        return (
          <div className="space-y-3" role="group" aria-label={field.label} aria-required={required || undefined}>
            {cbOpts.length === 0 ? (
              <p className="opacity-50 italic text-sm">No options configured</p>
            ) : cbOpts.map((option, index) => (
              <button
                key={option.id}
                role="checkbox"
                aria-checked={selectedValues.includes(option.value)}
                tabIndex={index === 0 ? 0 : -1}
                onKeyDown={(e) => handleRovingKeys(e, cbOpts, false)}
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
                <span className="flex-1 min-w-0 break-words text-lg">{option.label?.trim() || option.value}</span>
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
            aria-required={required}
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-2 border-current/30 focus:border-current/60 outline-none py-3 px-4 rounded-lg text-xl transition-colors"
            style={{ borderColor: value ? primaryColor : undefined }}
            autoFocus={autoFocus}
          >
            <option value="">{field.placeholder || 'Select an option...'}</option>
            {field.properties.options?.map((option) => (
              <option key={option.id} value={option.value}>
                {option.label?.trim() || option.value}
              </option>
            ))}
          </select>
        );

      case 'rating': {
        const maxStars = field.properties.maxStars || 5;
        const currentRating = (value as number) || 0;
        return (
          <div className="flex gap-3 justify-center" role="radiogroup" aria-label={`${field.label} rating`} aria-required={required || undefined}>
            {Array.from({ length: maxStars }, (_, i) => (
              <button
                key={i}
                role="radio"
                aria-checked={currentRating === i + 1}
                aria-label={`${i + 1} star${i === 0 ? '' : 's'}`}
                tabIndex={currentRating === i + 1 || (!currentRating && i === 0) ? 0 : -1}
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
              aria-required={required || undefined}
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
                    tabIndex={scaleValue === num || (scaleValue == null && i === 0) ? 0 : -1}
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
      case 'welcome_screen': {
        const mediaUrl = field.properties.mediaUrl;
        if (!mediaUrl && !field.description) return null;
        const mediaType = field.properties.mediaType || 'image';
        return (
          <div className="space-y-4">
            {mediaUrl && (mediaType === 'video' ? (
              <video src={mediaUrl} controls className="w-full rounded-xl max-h-80" />
            ) : (
              <img src={mediaUrl} alt={field.properties.mediaAlt || field.label || ''} className="w-full rounded-xl max-h-80 object-contain" />
            ))}
            {field.description && (
              <p className="text-lg opacity-70 whitespace-pre-line">{field.description}</p>
            )}
          </div>
        );
      }

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
                    };

                    const onMouseUp = () => {
                      // Serialize once per completed stroke, not on every move event.
                      onChange(canvas.toDataURL());
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
                    };

                    const onTouchEnd = () => {
                      // Serialize once per completed stroke, not on every move event.
                      onChange(canvas.toDataURL());
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

      // Hidden fields are never a form step; render nothing if one ever reaches here.
      case 'hidden':
        return null;

      default:
        return <p className="opacity-50">Field type not supported</p>;
    }
  };

  // Associate a validation error with the rendered control so screen readers
  // announce it as part of the field (aria-invalid + aria-describedby). cloneElement
  // targets the top element each case returns — the input for simple fields, or the
  // role="radiogroup" wrapper for rating/scale/choice.
  const errorId = error ? `field-error-${field.id}` : undefined;
  const rendered = renderField();
  const fieldEl = error && isValidElement(rendered)
    ? cloneElement(rendered as ReactElement<Record<string, unknown>>, { 'aria-invalid': true, 'aria-describedby': errorId })
    : rendered;

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="mb-8">
        <h2
          className="text-3xl font-bold mb-3 tracking-tight break-words"
          style={{ color: textColor }}
        >
          {field.label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </h2>
        {field.description && field.type !== 'statement' && field.type !== 'welcome_screen' && (
          <p className="text-lg" style={{ color: textColor, opacity: 0.7 }}>{field.description}</p>
        )}
      </div>
      {fieldEl}
    </div>
  );
}

// Success Screen
function SuccessScreen({ form, isRedirecting, thankYou }: { form: { title: string; theme: { primaryColor: string; textColor: string } }; isRedirecting?: boolean; thankYou?: { label?: string; description?: string; properties?: { mediaUrl?: string; mediaType?: 'image' | 'video'; mediaAlt?: string } } }) {
  // Use a thank_you field's content as the completion message when the form defines one.
  const heading = thankYou?.label?.trim() || 'Thank you!';
  const subtext = thankYou?.description?.trim() || 'Your response has been submitted successfully.';
  const mediaUrl = thankYou?.properties?.mediaUrl;
  const mediaType = thankYou?.properties?.mediaType || 'image';
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
      {mediaUrl && (mediaType === 'video' ? (
        <video src={mediaUrl} controls className="w-full max-w-md mx-auto rounded-xl max-h-64 mb-6" />
      ) : (
        <img src={mediaUrl} alt={thankYou?.properties?.mediaAlt || thankYou?.label || ''} className="w-full max-w-md mx-auto rounded-xl max-h-64 object-contain mb-6" />
      ))}
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

  // Respect the OS "reduce motion" setting — framer-motion ignores the CSS query,
  // so flatten the per-question slide to a plain fade for those users.
  const reduceMotion = useReducedMotion();
  // Tracks the last step we moved focus/scroll to, so the per-step effect fires
  // once per navigation (not on every re-render). Init to 0 = skip initial mount.
  const lastFocusedStepRef = useRef(0);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Classic mode: id of the field the current error belongs to, so the per-control
  // aria-invalid/aria-describedby wiring (already supported by FieldResponse) activates
  // and keyboard/SR focus can land on the offending field.
  const [errorFieldId, setErrorFieldId] = useState<string | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally narrow deps: only re-fetch when the form id or whether fields are loaded changes; depending on the whole storeForm object would re-run on every unrelated store mutation and cause redundant fetches
  }, [formId, storeForm?.id, storeForm?.fields.length]);

  // Use store form (with fields) if available, otherwise fetched form
  const form = (storeForm && storeForm.fields.length > 0) ? storeForm : publicForm ?? storeForm;
  useDocumentTitle(form?.title);

  // The public form must render in its OWN theme, not the visitor's app dark-mode
  // preference — otherwise Tailwind `dark:` control colors (e.g. slate-400 text) leak
  // onto a light themed background and break contrast. Drive the document's `.dark`
  // class from the form theme's background luminance while this page is mounted, and
  // restore the app preference on unmount.
  const formBg = form?.theme?.backgroundColor;
  useEffect(() => {
    if (!formBg) return;
    const rgb = parseHex(formBg);
    const themeIsDark = rgb ? luminance(rgb) < 0.5 : false;
    const root = document.documentElement;
    root.classList.toggle('dark', themeIsDark);
    return () => {
      // Restore the app's own theme preference when leaving the form.
      root.classList.toggle('dark', useUIStore.getState().theme === 'dark');
    };
  }, [formBg]);

  // Merge user answers with computed calculated field values so dependent
  // calculated fields (e.g. risk_level depending on risk_score) can resolve
  const allFormData = useMemo(
    () => ({ ...currentAnswers, ...calculatedValues }),
    [currentAnswers, calculatedValues]
  );

  // Every field id — for resolving calculation-expression dependencies.
  const allFieldIds = useMemo(() => (form?.fields ?? []).map((f) => f.id), [form]);

  // Hidden fields are never rendered, but their values (static default, calculation
  // expression, or backend-script-set) are still collected into the submission.
  const hiddenFields = useMemo(() => (form?.fields ?? []).filter((f) => f.type === 'hidden'), [form]);

  // Seed static defaults for hidden fields that have no calculation expression.
  useEffect(() => {
    hiddenFields.forEach((f) => {
      if (!f.properties.calculationExpression && f.properties.defaultValue !== undefined && currentAnswers[f.id] === undefined) {
        setAnswer(f.id, f.properties.defaultValue);
      }
    });
  }, [hiddenFields, currentAnswers, setAnswer]);

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
      // welcome_screen IS shown (as a leading content step). hidden fields are never shown.
      if (f.type === 'thank_you' || f.type === 'hidden') return false;
      return isFieldVisible(f.id);
    });
  }, [form, isFieldVisible]);

  // NIGO ("not in good order") dashboard — same wiring as the builder preview/app runtime,
  // gated on the form's showNigoDashboard setting.
  const [showNigo, setShowNigo] = useState(false);
  const nigoVisibleIds = useMemo(() => new Set(visibleFields.map((f) => f.id)), [visibleFields]);
  const nigoRequiredIds = useMemo(() => {
    const s = new Set<string>();
    visibleFields.forEach((f) => { if (f.required || isFieldRequired(f.id)) s.add(f.id); });
    return s;
  }, [visibleFields, isFieldRequired]);

  // Record a "start" (first interaction) once per fill, for the analytics funnel.
  const startRecordedRef = useRef(false);
  useEffect(() => {
    if (startRecordedRef.current || !formId) return;
    if (Object.keys(currentAnswers).length === 0) return;
    startRecordedRef.current = true;
    api.recordFormStart(formId);
  }, [currentAnswers, formId]);

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
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950 p-4">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 bg-gray-200/70 dark:bg-slate-800 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FileQuestion className="h-8 w-8 text-gray-400 dark:text-slate-500" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">We couldn't load this form</h1>
          <p className="text-gray-500 dark:text-slate-400 mb-6">
            It may have been unpublished or removed — or your connection dropped. Check the link and try again.
          </p>
          <Button onClick={() => window.location.reload()} leftIcon={<RefreshCw className="h-4 w-4" />}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // A custom screen takes over the whole form experience (public link + embed).
  if (form.customScreen?.enabled && (form.customScreen.html || form.customScreen.js)) {
    return (
      <div className="h-screen w-full bg-white dark:bg-slate-950">
        <CustomScreenRuntime
          screen={form.customScreen}
          formId={form.id}
          formTitle={form.title}
          fields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
          publicMode={!api.isAuthenticated()}
          className="w-full h-full border-0"
        />
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

  // Enforce builder-configured number Min/Max/Step. These live on field.properties
  // and are only applied as native <input> attributes, which the custom submit flow
  // (onClick handlers, no native form validation) bypasses — so without this check
  // they're silently ignored. Returns an error message, or null when valid.
  const validateNumberConstraints = (field: FormField, answer: unknown): string | null => {
    if (field.type !== 'number' || typeof answer !== 'number' || Number.isNaN(answer)) return null;
    const p = field.properties as { min?: unknown; max?: unknown; step?: unknown };
    const min = p.min != null && p.min !== '' ? Number(p.min) : null;
    const max = p.max != null && p.max !== '' ? Number(p.max) : null;
    const step = p.step != null && p.step !== '' ? Number(p.step) : null;
    if (min != null && Number.isFinite(min) && answer < min) return `Minimum value is ${min}`;
    if (max != null && Number.isFinite(max) && answer > max) return `Maximum value is ${max}`;
    if (step != null && Number.isFinite(step) && step > 0) {
      const base = min != null && Number.isFinite(min) ? min : 0;
      const steps = (answer - base) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) {
        return base ? `Value must be ${base} plus a multiple of ${step}` : `Value must be a multiple of ${step}`;
      }
    }
    return null;
  };

  const handleNext = () => {
    setFieldError(null);
    setSubmitError(null);

    // Don't advance/submit while a submission is in flight (prevents a double Enter).
    if (isSubmitting) return;

    // Skip the required/validation gate for non-input field types — a calculated
    // or layout step has nothing for the user to fill in, so requiring it would
    // be an unrecoverable dead-end. Matches the classic-mode exclusion.
    if (currentField && !['statement', 'calculated', 'welcome_screen', 'thank_you', 'hidden'].includes(currentField.type)) {
      const answer = currentAnswers[currentField.id];

      // Check required
      if (getFieldRequired(currentField)) {
        if (answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0)
          // An empty typed signature is the sentinel 'typed:' (non-empty string) — treat as blank.
          || (typeof answer === 'string' && answer.startsWith('typed:') && answer.slice(6).trim() === '')) {
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

      // Format check for email/url. The form submits via onClick handlers (not a
      // native <form> submit), so native input validation is bypassed — mirror the
      // server so the user sees the error inline instead of after a round-trip.
      if (typeof answer === 'string' && answer !== '') {
        if (currentField.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)) {
          setFieldError('Please enter a valid email address');
          return;
        }
        if (currentField.type === 'url' && !/^https?:\/\/.+\..+/.test(answer)) {
          setFieldError('Please enter a valid URL (starting with http:// or https://)');
          return;
        }
      }

      // Enforce builder-configured number min/max/step (stored on field.properties,
      // not the validation rules array — the loop above never checks them).
      const numErr = validateNumberConstraints(currentField, answer);
      if (numErr) {
        setFieldError(numErr);
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
      // Allow newlines in long_text fields
      if (currentField?.type === 'long_text') return;
      // Let Enter operate a native dropdown (open/select) instead of advancing.
      if ((e.target as HTMLElement).tagName === 'SELECT') return;
      e.preventDefault();
      handleNext();
    }
  };

  const failClassic = (fieldId: string, message: string) => {
    setSubmitError(message);
    setErrorFieldId(fieldId);
    const el = document.getElementById(`field-${fieldId}`);
    el?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    (el?.querySelector('input,textarea,select,[role="radiogroup"],[role="group"],button') as HTMLElement | null)?.focus();
  };

  const handleClassicSubmit = () => {
    setSubmitError(null);
    setFieldError(null);
    setErrorFieldId(null);
    const missingFields = visibleFields.filter(f => {
      if (!getFieldRequired(f)) return false;
      if (['statement', 'calculated', 'welcome_screen', 'thank_you', 'hidden'].includes(f.type)) return false;
      const answer = currentAnswers[f.id];
      return answer === undefined || answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0)
        // An empty typed signature is the sentinel 'typed:' (a non-empty string) — treat as blank.
        || (typeof answer === 'string' && answer.startsWith('typed:') && answer.slice(6).trim() === '');
    });
    if (missingFields.length > 0) {
      const names = missingFields.map(f => f.label).filter(Boolean);
      const shown = names.slice(0, 3).join(', ');
      failClassic(missingFields[0].id, names.length <= 3 ? `Please fill in: ${shown}` : `Please fill in: ${shown} and ${names.length - 3} more`);
      return;
    }

    // Run field validation rules
    for (const f of visibleFields) {
      if (['statement', 'calculated', 'welcome_screen', 'thank_you', 'hidden'].includes(f.type)) continue;
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

      // Format check for email/url (parity with the server + focused mode).
      if (typeof answer === 'string' && answer !== '') {
        if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)) {
          failClassic(f.id, `${f.label}: please enter a valid email address`);
          return;
        }
        if (f.type === 'url' && !/^https?:\/\/.+\..+/.test(answer)) {
          failClassic(f.id, `${f.label}: please enter a valid URL (starting with http:// or https://)`);
          return;
        }
      }

      // Enforce builder-configured number min/max/step (see validateNumberConstraints).
      const numErr = validateNumberConstraints(f, answer);
      if (numErr) {
        setSubmitError(`${f.label}: ${numErr}`);
        return;
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
      className="min-h-screen flex flex-col bg-cover bg-center bg-fixed"
      style={{
        backgroundColor: form.theme.backgroundColor,
        backgroundImage: form.theme.backgroundImage ? `url(${form.theme.backgroundImage})` : undefined,
        color: form.theme.textColor,
        fontFamily: form.theme.fontFamily,
      }}
      onKeyDown={effectiveMode === 'focused' ? handleKeyDown : undefined}
    >
      {/* Brand logo */}
      {form.theme.logo && (
        <div className="pt-6 pb-1 flex justify-center shrink-0">
          <img src={form.theme.logo} alt="" className="max-h-16 max-w-[60%] object-contain" />
        </div>
      )}

      {/* Mode Toggle */}
      {showModeToggle && (
        <div className="fixed top-3 right-4 z-20 flex items-center rounded-lg p-0.5" style={{ backgroundColor: `${form.theme.textColor}15` }} role="group" aria-label="Presentation mode">
          <button
            onClick={() => setResponseMode('focused')}
            aria-pressed={effectiveMode === 'focused'}
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
            aria-pressed={effectiveMode === 'classic'}
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

      {/* NIGO dashboard toggle + panel (when enabled for this form) */}
      {form.settings?.showNigoDashboard && (
        <button
          type="button"
          onClick={() => setShowNigo((v) => !v)}
          className="fixed top-3 left-4 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all cursor-pointer shadow-sm"
          style={showNigo
            ? { backgroundColor: form.theme.primaryColor, color: readableForegroundColor(form.theme.primaryColor) }
            : { backgroundColor: `${form.theme.textColor}15`, color: form.theme.textColor }}
          aria-pressed={showNigo}
          title="Completion checklist"
        >
          <ClipboardCheck className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Checklist</span>
        </button>
      )}
      {showNigo && form.settings?.showNigoDashboard && (
        <div className="fixed top-14 right-4 w-72 max-w-[calc(100vw-2rem)] z-20">
          <NigoDashboard
            fields={form.fields}
            formData={allFormData}
            visibleFields={nigoVisibleIds}
            requiredFields={nigoRequiredIds}
            onFieldClick={(fieldId) => {
              const idx = visibleFields.findIndex((f) => f.id === fieldId);
              if (idx >= 0) {
                if (effectiveMode === 'focused') goToStep(idx);
                const el = document.getElementById(`field-${fieldId}`);
                if (el) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
              }
            }}
          />
        </div>
      )}

      {/* Hidden fields with a calculation expression compute off-screen, so their value is
          captured in the submission without ever being shown to the respondent. */}
      {hiddenFields.filter((f) => f.properties.calculationExpression).map((f) => (
        <div key={f.id} className="hidden" aria-hidden="true">
          <CalculatedFieldDisplay
            expression={f.properties.calculationExpression}
            formData={allFormData}
            allFieldIds={allFieldIds}
            fieldId={f.id}
            onCalculated={handleCalculated}
          >
            {() => null}
          </CalculatedFieldDisplay>
        </div>
      ))}

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
      <main id="form-main" className="flex-1 flex items-center justify-center p-4 md:p-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentField.id}
            ref={(el) => {
              // On step change, bring the new question into view and — for field
              // types that don't autoFocus an input — move focus to the question so
              // keyboard/screen-reader users aren't stranded on the old control.
              if (!el || lastFocusedStepRef.current === safeCurrentStep) return;
              lastFocusedStepRef.current = safeCurrentStep;
              const TEXTUAL = ['short_text', 'long_text', 'email', 'url', 'number', 'phone', 'date', 'time', 'datetime', 'dropdown'];
              if (currentField && !TEXTUAL.includes(currentField.type)) el.focus({ preventScroll: true });
              el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
            }}
            tabIndex={-1}
            role="group"
            aria-label={currentField.label}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -30 }}
            transition={{ duration: reduceMotion ? 0 : 0.4 }}
            className="w-full outline-none"
          >
            <FieldResponse
              field={currentField}
              value={currentAnswers[currentField.id]}
              onChange={(val) => { if (fieldError) setFieldError(null); setAnswer(currentField.id, val); }}
              primaryColor={form.theme.primaryColor}
              textColor={form.theme.textColor}
              isRequired={getFieldRequired(currentField)}
              allAnswers={allFormData}
              allFieldIds={form.fields.map(f => f.id)}
              onCalculated={handleCalculated}
              formId={formId}
              error={fieldError || undefined}
            />

            {/* Inline validation error — constrained to the same width as the field
                (FieldResponse uses max-w-xl mx-auto) so it lines up under it on wide
                screens instead of sitting at the far left. */}
            {fieldError && (
              <div className="w-full max-w-xl mx-auto">
                <p id={`field-error-${currentField.id}`} role="alert" aria-live="polite" className="mt-3 text-red-500 text-sm">{fieldError}</p>
              </div>
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
                {isLastStep
                  ? 'Submit'
                  : (currentField?.type === 'welcome_screen' && currentField.properties.buttonText) || 'OK'} <Check className="ml-2 h-4 w-4" />
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
      </main>

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
        <main id="form-main" className="flex-1 overflow-y-auto">
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
                <div key={field.id} id={`field-${field.id}`} className="pb-6 border-b last:border-0 scroll-mt-24" style={{ borderColor: `${form.theme.textColor}15` }}>
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
                    autoFocus={false}
                    error={errorFieldId === field.id ? (submitError || undefined) : undefined}
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
        </main>
      )}
    </div>
  );
}
