import { useMemo, useState, memo, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Zap,
  ShieldCheck,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { Badge } from '../ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/Tabs';
import { LogicEditor } from './LogicEditor';
import { ValidationEditor } from './ValidationEditor';
import { CalculatedFieldEditor } from './CalculatedFieldEditor';
import { LinkedRecordSettings } from './LinkedRecordSettings';
import { type FormField, type ConditionalLogic } from '../../types/form';
import { cn, createFieldVariableMap, replaceIdsWithVariables } from '../../lib/utils';

// A group of settings that only one kind of field has: a small heading over it and a hairline
// above, so the panel reads as the field's own settings and then what its kind adds.
const SECTION = 'space-y-3 border-t border-gray-200 pt-4 dark:border-slate-800';
const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400';
const OPTION_BUTTON = 'h-9 w-8 flex-none px-0 max-sm:w-10';

export const FieldSettingsPanel = memo(function FieldSettingsPanel({
  field,
  allFields,
  onUpdate,
}: {
  field: FormField;
  allFields: FormField[];
  onUpdate: (updates: Partial<FormField>) => void;
}) {
  const [searchParams] = useSearchParams();
  const appId = searchParams.get('appId');
  const formId = searchParams.get('formId') || undefined;
  const [showLogicEditor, setShowLogicEditor] = useState(false);
  // What is typed in Accepted File Types, shown as typed until the input is left: the stored list
  // drops an empty entry, so re-rendering from it would remove a comma the moment it is typed.
  const [typesDraft, setTypesDraft] = useState<{ fieldId: string; text: string } | null>(null);
  // A scale End being typed that is not yet above the Start (see the End input).
  const [endDraft, setEndDraft] = useState<{ fieldId: string; text: string } | null>(null);
  // The other number settings are typed a key at a time too, and what is in the box part-way is
  // not always a value to store: a cleared box is no number, and the "9" of "99" is below a Min of
  // 18. Text a setting does not take is held here, shown as typed, and settled when the input is
  // left. So a default is not written into a box the author has just cleared (the next key then
  // landed after it: a 3 typed over Max Stars 5 read "53"), and a paired bound moves only for the
  // value the author settles on (a Max of 99 typed over 65 no longer stores a Min of 9 on the way).
  const [numberDraft, setNumberDraft] = useState<{ fieldId: string; name: string; text: string } | null>(null);
  /**
   * The props of one such input. `take` stores the number and answers true, or answers false to
   * have it held; `settle` is given a held number when the input is left; `empty` is called at
   * once when the box is emptied, for a setting that may be blank. Without `empty`, an emptied
   * box is held, and left empty it shows what is stored again.
   */
  const heldNumber = (
    name: string,
    stored: number | string,
    on: { take: (n: number) => boolean; settle?: (n: number) => void; empty?: () => void },
  ) => {
    const held = numberDraft?.fieldId === field.id && numberDraft.name === name ? numberDraft.text : null;
    const read = (text: string) => (text.trim() === '' ? NaN : Number(text));
    return {
      value: held ?? stored,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        const text = e.target.value;
        const n = read(text);
        if (text === '' && on.empty) {
          on.empty();
          setNumberDraft(null);
        } else if (!Number.isNaN(n) && on.take(n)) {
          setNumberDraft(null);
        } else {
          setNumberDraft({ fieldId: field.id, name, text });
        }
      },
      onBlur: () => {
        if (held === null) return;
        setNumberDraft(null);
        const n = read(held);
        if (!Number.isNaN(n)) on.settle?.(n);
      },
    };
  };
  /** A whole number kept within [min, max]: stored as typed while inside, brought inside on leaving. */
  const wholeNumber = (name: string, stored: number, min: number, max: number, store: (n: number) => void) =>
    heldNumber(name, stored, {
      take: (n) => {
        const whole = Math.trunc(n);
        if (whole < min || whole > max) return false;
        store(whole);
        return true;
      },
      settle: (n) => store(Math.min(max, Math.max(min, Math.trunc(n)))),
    });

  const handleSaveLogic = (logic: ConditionalLogic | undefined) => {
    onUpdate({ conditionalLogic: logic });
  };

  // Check if field has conditional logic
  const hasLogic = !!field.conditionalLogic?.expression;
  // The rule as the logic editor shows it: the other fields by their names. It is stored with
  // their ids, which say nothing to a person.
  const logicAsRead = useMemo(() => {
    const expression = field.conditionalLogic?.expression ?? '';
    if (!expression) return '';
    const others = allFields.filter((f) => f.id !== field.id && !['welcome_screen', 'thank_you', 'statement'].includes(f.type));
    return replaceIdsWithVariables(expression, createFieldVariableMap(others).toVar);
  }, [allFields, field.conditionalLogic?.expression, field.id]);
  // Check if field has validation rules
  const hasValidation = (field.validation?.length || 0) > 0;

  return (
    // The panel is 320 px wide beside the canvas: its boxes are a size smaller than a page
    // form's there. As a sheet on a phone they keep the full size (a finger's height, and text
    // of 16 px: smaller, and iOS zooms the page in when a box takes the cursor).
    <div className="h-full flex flex-col md:[&_input:not([type=checkbox])]:py-2 md:[&_input:not([type=checkbox])]:text-sm">

      {/* Tabs: the three share the panel's width, so the strip reads as one control. */}
      <Tabs key={field.id} defaultValue="basic" className="flex-1 flex flex-col">
        <TabsList className="mx-4 mt-3" aria-label="Field settings">
          <TabsTrigger value="basic" className="flex-1 justify-center text-center">Basic</TabsTrigger>
          <TabsTrigger value="validation" className="inline-flex flex-1 items-center justify-center">
            Validation
            {hasValidation && <Badge variant="primary" className="ml-1.5 px-1.5 tabular-nums" size="sm">{field.validation?.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="logic" className="inline-flex flex-1 items-center justify-center">
            Logic
            {hasLogic && <Zap className="ml-1 h-3 w-3 text-primary-600 dark:text-primary-400" />}
          </TabsTrigger>
        </TabsList>

        {/* Basic Settings Tab */}
        <TabsContent value="basic" className="flex-1 overflow-y-auto p-4 space-y-4">
          <Input
            label="Label"
            value={field.label}
            onChange={(e) => onUpdate({ label: e.target.value })}
          />

          <Input
            label="Description (optional)"
            value={field.description || ''}
            onChange={(e) => onUpdate({ description: e.target.value })}
          />

          {/* Placeholder only applies to free-text controls — native date/time pickers and
              the phone input ignore it, so don't offer a setting that does nothing. */}
          {!['statement', 'welcome_screen', 'thank_you', 'calculated', 'linked_record', 'hidden', 'phone', 'date', 'time', 'datetime', 'multiple_choice', 'checkboxes', 'rating', 'scale', 'file_upload', 'signature', 'location'].includes(field.type) && (
            <Input
              label="Placeholder"
              value={field.placeholder || ''}
              onChange={(e) => onUpdate({ placeholder: e.target.value })}
            />
          )}

          {/* 'calculated' is computed + read-only, so a Required toggle would be a no-op. */}
          {!['statement', 'welcome_screen', 'thank_you', 'hidden', 'calculated'].includes(field.type) && (
            <Switch
              checked={field.required}
              onChange={(checked) => onUpdate({ required: checked })}
              label="Required"
              description="The form cannot be sent without an answer"
            />
          )}

          {/* Options for choice fields */}
          {['dropdown', 'multiple_choice', 'checkboxes'].includes(field.type) && (
            <section className={SECTION}>
              <h4 className={SECTION_TITLE}>Options</h4>
              <div className="space-y-2">
                {field.properties.options?.map((option, index) => {
                  const optionCount = field.properties.options?.length ?? 0;
                  const moveOption = (to: number) => {
                    const newOptions = [...(field.properties.options || [])];
                    [newOptions[index], newOptions[to]] = [newOptions[to], newOptions[index]];
                    onUpdate({ properties: { ...field.properties, options: newOptions } });
                  };
                  return (
                  // The three buttons are narrow, so the option's own text keeps most of the row.
                  <div key={option.id} className="flex items-center gap-0.5">
                    <div className="mr-1 min-w-0 flex-1">
                      <Input
                        value={option.label}
                        aria-label={`Option ${index + 1} label`}
                        onChange={(e) => {
                          const newOptions = [...(field.properties.options || [])];
                          newOptions[index] = { ...option, label: e.target.value };
                          onUpdate({ properties: { ...field.properties, options: newOptions } });
                        }}
                        placeholder={`Option ${index + 1}`}
                      />
                    </div>
                    <Button variant="ghost" size="sm" className={OPTION_BUTTON} aria-label={`Move option ${index + 1} up`} title="Move up" disabled={index === 0} onClick={() => moveOption(index - 1)}>
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" className={OPTION_BUTTON} aria-label={`Move option ${index + 1} down`} title="Move down" disabled={index === optionCount - 1} onClick={() => moveOption(index + 1)}>
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(OPTION_BUTTON, 'hover:text-red-600 dark:hover:text-red-400')}
                      aria-label="Remove option"
                      title="Remove option"
                      onClick={() => {
                        const newOptions = field.properties.options?.filter((_, i) => i !== index);
                        onUpdate({ properties: { ...field.properties, options: newOptions } });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const existing = field.properties.options || [];
                    // Derive a value that isn't already taken — deriving purely
                    // from length collides after a middle option is deleted, and
                    // duplicate values make selections indistinguishable.
                    const used = new Set(existing.map((o) => o.value));
                    let n = existing.length + 1;
                    while (used.has(`option_${n}`)) n++;
                    const newOption = {
                      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
                      label: `Option ${n}`,
                      value: `option_${n}`,
                    };
                    onUpdate({
                      properties: {
                        ...field.properties,
                        options: [...existing, newOption],
                      },
                    });
                  }}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Add option
                </Button>
              </div>
            </section>
          )}

          {/* Rating settings */}
          {field.type === 'rating' && (
            <section className={SECTION}>
              <h4 className={SECTION_TITLE}>Rating</h4>
              <Input
                label="Max stars"
                type="number"
                min={1}
                max={10}
                {...wholeNumber('maxStars', field.properties.maxStars || 5, 1, 10, (maxStars) =>
                  onUpdate({ properties: { ...field.properties, maxStars } }))}
              />
            </section>
          )}

          {/* Scale settings */}
          {field.type === 'scale' && (
            <section className={SECTION}>
              <h4 className={SECTION_TITLE}>Scale</h4>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Start"
                  type="number"
                  min={0}
                  max={99}
                  // The mirror of the End beside it: only a Start below the End is stored as it is
                  // typed, and the End moves up only for the Start the author settles on.
                  {...heldNumber('scaleStart', field.properties.scaleStart ?? 1, {
                    take: (n) => {
                      const start = Math.trunc(n);
                      if (start < 0 || start > 99 || start >= (field.properties.scaleEnd ?? 10)) return false;
                      onUpdate({ properties: { ...field.properties, scaleStart: start } });
                      return true;
                    },
                    settle: (n) => {
                      const start = Math.max(0, Math.min(99, Math.trunc(n)));
                      const end = field.properties.scaleEnd ?? 10;
                      onUpdate({ properties: { ...field.properties, scaleStart: start, scaleEnd: Math.max(start + 1, end) } });
                    },
                  })}
                />
                <Input
                  label="End"
                  type="number"
                  min={1}
                  max={100}
                  value={endDraft?.fieldId === field.id ? endDraft.text : (field.properties.scaleEnd ?? 10)}
                  // An End is typed a key at a time, and the "1" of "10" is not above a Start of 1.
                  // Only an End above the Start is stored as it is typed; anything else is held here
                  // and settled when the input is left, so the Start moves down only for the End the
                  // author settles on, and the stored scale never runs backwards (it would draw no
                  // buttons) while the form saves in between.
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    const end = Math.max(1, Math.min(100, val));
                    if (!isNaN(val) && end > (field.properties.scaleStart ?? 1)) {
                      setEndDraft(null);
                      onUpdate({ properties: { ...field.properties, scaleEnd: end } });
                    } else {
                      setEndDraft({ fieldId: field.id, text: e.target.value });
                    }
                  }}
                  onBlur={() => {
                    if (endDraft?.fieldId !== field.id) return;
                    setEndDraft(null);
                    const val = parseInt(endDraft.text);
                    if (isNaN(val)) return;
                    const end = Math.max(1, Math.min(100, val));
                    const start = field.properties.scaleStart ?? 1;
                    onUpdate({ properties: { ...field.properties, scaleEnd: end, scaleStart: Math.min(start, end - 1) } });
                  }}
                />
              </div>
              <Input
                label="Start label"
                value={field.properties.scaleStartLabel || ''}
                onChange={(e) =>
                  onUpdate({
                    properties: { ...field.properties, scaleStartLabel: e.target.value },
                  })
                }
                placeholder="e.g. Not likely"
              />
              <Input
                label="End label"
                value={field.properties.scaleEndLabel || ''}
                onChange={(e) =>
                  onUpdate({
                    properties: { ...field.properties, scaleEndLabel: e.target.value },
                  })
                }
                placeholder="e.g. Very likely"
              />
            </section>
          )}

          {/* Number settings */}
          {field.type === 'number' && (
            <section className={SECTION}>
              <h4 className={SECTION_TITLE}>Number</h4>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Min"
                  type="number"
                  // Keep min <= max (self-correct like the Scale editor) so the field can't be
                  // made unsubmittable with min > max. The other bound is corrected for the value
                  // the author settles on, not for each key on the way to it.
                  {...heldNumber('min', field.properties.min ?? '', {
                    take: (min) => {
                      const max = field.properties.max;
                      if (max !== undefined && min > max) return false;
                      onUpdate({ properties: { ...field.properties, min } });
                      return true;
                    },
                    settle: (min) => {
                      const max = field.properties.max;
                      onUpdate({ properties: { ...field.properties, min, max: max !== undefined && min > max ? min : max } });
                    },
                    empty: () => onUpdate({ properties: { ...field.properties, min: undefined } }),
                  })}
                  placeholder="—"
                />
                <Input
                  label="Max"
                  type="number"
                  {...heldNumber('max', field.properties.max ?? '', {
                    take: (max) => {
                      const min = field.properties.min;
                      if (min !== undefined && max < min) return false;
                      onUpdate({ properties: { ...field.properties, max } });
                      return true;
                    },
                    settle: (max) => {
                      const min = field.properties.min;
                      onUpdate({ properties: { ...field.properties, max, min: min !== undefined && max < min ? max : min } });
                    },
                    empty: () => onUpdate({ properties: { ...field.properties, max: undefined } }),
                  })}
                  placeholder="—"
                />
                <Input
                  label="Step"
                  type="number"
                  value={field.properties.step ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    onUpdate({ properties: { ...field.properties, step: v === '' ? undefined : Number(v) } });
                  }}
                  placeholder="any"
                />
              </div>
              <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">The smallest and largest number the box takes, and the step between numbers. Leave one blank for no limit.</p>
            </section>
          )}

          {/* Layout-screen media (statement / welcome / thank-you) */}
          {['statement', 'welcome_screen', 'thank_you'].includes(field.type) && (
            <section className={SECTION}>
              <h4 className={SECTION_TITLE}>Picture or video (optional)</h4>
              <Input
                label="Media URL"
                value={field.properties.mediaUrl || ''}
                onChange={(e) => onUpdate({ properties: { ...field.properties, mediaUrl: e.target.value } })}
                placeholder="https://… image or video URL"
              />
              {field.properties.mediaUrl && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Media type</label>
                    <select
                      value={field.properties.mediaType || 'image'}
                      onChange={(e) => onUpdate({ properties: { ...field.properties, mediaType: e.target.value as 'image' | 'video' } })}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="image">Image</option>
                      <option value="video">Video</option>
                    </select>
                  </div>
                  {(field.properties.mediaType || 'image') !== 'video' && (
                    <Input
                      label="Image alt text"
                      value={field.properties.mediaAlt || ''}
                      onChange={(e) => onUpdate({ properties: { ...field.properties, mediaAlt: e.target.value } })}
                      placeholder="Describe the image for screen readers"
                      hint="Leave blank if the image is purely decorative."
                    />
                  )}
                </>
              )}
              {field.type === 'welcome_screen' && (
                <Input
                  label="Button text"
                  value={field.properties.buttonText || ''}
                  onChange={(e) => onUpdate({ properties: { ...field.properties, buttonText: e.target.value } })}
                  placeholder="e.g. Get started"
                />
              )}
            </section>
          )}

          {/* File upload settings */}
          {field.type === 'file_upload' && (
            <section className={SECTION}>
              <h4 className={SECTION_TITLE}>
                {field.properties.captureMode === 'camera' ? 'Camera' : 'File upload'}
              </h4>
              <Switch
                label="Capture from camera"
                checked={field.properties.captureMode === 'camera'}
                onChange={(checked) => onUpdate({
                  properties: {
                    ...field.properties,
                    captureMode: checked ? 'camera' : undefined,
                    // Camera mode is image-only; leaving it restores "any type".
                    acceptedFileTypes: checked ? ['image/*'] : (field.properties.acceptedFileTypes?.length === 1 && field.properties.acceptedFileTypes[0] === 'image/*' ? [] : field.properties.acceptedFileTypes),
                  },
                })}
              />
              {field.properties.captureMode === 'camera' && (
                <p className="text-xs text-gray-500 dark:text-slate-400 -mt-1">
                  Respondents take a photo with their device camera (or pick one from their
                  gallery). Photos are resized on the device before upload.
                </p>
              )}
              <Input
                label="Max file size (MB)"
                type="number"
                min={1}
                max={500}
                {...wholeNumber('maxFileSize', Math.max(1, Math.round((field.properties.maxFileSize ?? 10 * 1024 * 1024) / (1024 * 1024))), 1, 500, (mb) =>
                  onUpdate({ properties: { ...field.properties, maxFileSize: mb * 1024 * 1024 } }))}
                hint="Per-file limit. The server may enforce a lower cap."
              />
              <Input
                label="Accepted file types"
                value={typesDraft?.fieldId === field.id ? typesDraft.text : (field.properties.acceptedFileTypes || []).join(', ')}
                onChange={(e) => {
                  setTypesDraft({ fieldId: field.id, text: e.target.value });
                  const types = e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean);
                  onUpdate({ properties: { ...field.properties, acceptedFileTypes: types } });
                }}
                onBlur={() => setTypesDraft(null)}
                placeholder="e.g. .pdf, .jpg, image/*"
                hint="Comma-separated extensions or MIME types. Leave blank to allow any."
              />
              <Switch
                label="Allow multiple files"
                checked={!!field.properties.allowMultiple}
                onChange={(checked) => onUpdate({ properties: { ...field.properties, allowMultiple: checked } })}
              />
              {field.properties.allowMultiple && (
                <Input
                  label="Maximum number of files"
                  type="number"
                  min={1}
                  max={50}
                  {...wholeNumber('maxFiles', field.properties.maxFiles ?? 20, 1, 50, (maxFiles) =>
                    onUpdate({ properties: { ...field.properties, maxFiles } }))}
                  hint="Between 1 and 50."
                />
              )}
              <p className="text-xs text-amber-700 dark:text-amber-400/90 bg-amber-50 dark:bg-amber-500/10 border border-amber-200/70 dark:border-amber-500/25 rounded-xl px-3 py-2 leading-5">
                Files uploaded to a <strong>public standalone form</strong> can be opened by anyone
                with the file link. For member-only access, collect uploads through an app form.
              </p>
            </section>
          )}

          {/* Calculated field expression */}
          {field.type === 'calculated' && (
            <CalculatedFieldEditor
              expression={field.properties.calculationExpression || ''}
              allFields={allFields}
              onChange={(expr) =>
                onUpdate({
                  properties: { ...field.properties, calculationExpression: expr },
                })
              }
            />
          )}

          {/* Hidden field: never shown to respondents; stores computed/script-set data */}
          {field.type === 'hidden' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-3 text-xs leading-5 text-gray-500 dark:text-slate-400">
                This field is never shown to respondents. Use it to store computed or script-set
                data — it's saved with each response and appears in exports.
              </div>
              <Input
                label="Default value"
                value={field.properties.defaultValue || ''}
                onChange={(e) => onUpdate({ properties: { ...field.properties, defaultValue: e.target.value } })}
                placeholder="Optional starting value"
              />
              <div>
                <p className="text-xs text-gray-500 dark:text-slate-500 mb-2">
                  Optional: compute the value from other fields. If set, this overrides the default.
                </p>
                <CalculatedFieldEditor
                  expression={field.properties.calculationExpression || ''}
                  allFields={allFields}
                  onChange={(expr) =>
                    onUpdate({ properties: { ...field.properties, calculationExpression: expr } })
                  }
                />
              </div>
            </div>
          )}

          {/* Linked record settings */}
          {field.type === 'linked_record' && (
            <LinkedRecordSettings
              properties={field.properties}
              onChange={(props) => onUpdate({ properties: props })}
              appId={appId}
              currentFormId={formId}
              ownFields={allFields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
            />
          )}
        </TabsContent>

        {/* Validation Tab */}
        <TabsContent value="validation" className="flex-1 overflow-y-auto p-4">
          {['statement', 'welcome_screen', 'thank_you', 'calculated', 'linked_record', 'hidden'].includes(field.type) ? (
            <p className="flex items-start gap-2 text-sm text-gray-500 dark:text-slate-400">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-gray-400 dark:text-slate-500" />
              This kind of field takes no answer to check, so it has no validation rules.
            </p>
          ) : (
            <ValidationEditor
              rules={field.validation || []}
              fieldType={field.type}
              onChange={(rules) => onUpdate({ validation: rules })}
            />
          )}
        </TabsContent>

        {/* Logic Tab */}
        <TabsContent value="logic" className="flex-1 overflow-y-auto p-4">
          <div className="space-y-3">
            <div>
              <h4 className={SECTION_TITLE}>Conditional logic</h4>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                Show, hide or require this field by the answers to other fields.
              </p>
            </div>

            {hasLogic ? (
              // A rule that is set is a fact about the field, not a warning: a plain box, the
              // accent on its mark. The rule reads with the other fields' names, as the editor
              // shows it, not with their ids.
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
                <div className="flex items-start gap-2.5">
                  <Zap className="mt-0.5 h-4 w-4 flex-none text-primary-600 dark:text-primary-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {field.conditionalLogic?.action === 'show' && 'Show when:'}
                      {field.conditionalLogic?.action === 'hide' && 'Hide when:'}
                      {field.conditionalLogic?.action === 'require' && 'Require when:'}
                      {field.conditionalLogic?.action === 'skip' && 'Skip when:'}
                    </p>
                    <code className="mt-1 block break-words font-mono text-xs leading-5 text-gray-600 dark:text-slate-300">
                      {logicAsRead}
                    </code>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setShowLogicEditor(true)}>
                    Edit rule
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onUpdate({ conditionalLogic: undefined })}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full max-sm:min-h-11"
                onClick={() => setShowLogicEditor(true)}
                leftIcon={<Zap className="h-4 w-4" />}
              >
                Add a rule
              </Button>
            )}

            {/* Logic Editor Modal */}
            <LogicEditor
              isOpen={showLogicEditor}
              onClose={() => setShowLogicEditor(false)}
              field={field}
              allFields={allFields}
              onSave={handleSaveLogic}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
});
