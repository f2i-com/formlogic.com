import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Zap,
  ShieldCheck,
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
import { FIELD_TYPE_INFO, type FormField, type ConditionalLogic } from '../../types/form';

export function FieldSettingsPanel({
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

  const handleSaveLogic = (logic: ConditionalLogic | undefined) => {
    onUpdate({ conditionalLogic: logic });
  };

  // Check if field has conditional logic
  const hasLogic = !!field.conditionalLogic?.expression;
  // Check if field has validation rules
  const hasValidation = (field.validation?.length || 0) > 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-slate-700">
        <h3 className="font-medium text-gray-900 dark:text-white">Field Settings</h3>
        <p className="text-sm text-gray-500 dark:text-slate-500 mt-1">{FIELD_TYPE_INFO[field.type]?.label}</p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="basic" className="flex-1 flex flex-col">
        <TabsList className="mx-4 mt-2">
          <TabsTrigger value="basic">Basic</TabsTrigger>
          <TabsTrigger value="validation">
            Validation
            {hasValidation && <Badge variant="info" className="ml-1" size="sm">{field.validation?.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="logic">
            Logic
            {hasLogic && <Zap className="ml-1 h-3 w-3 text-yellow-500" />}
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

          {!['statement', 'welcome_screen', 'thank_you', 'calculated', 'linked_record'].includes(field.type) && (
            <Input
              label="Placeholder"
              value={field.placeholder || ''}
              onChange={(e) => onUpdate({ placeholder: e.target.value })}
            />
          )}

          {!['statement', 'welcome_screen', 'thank_you'].includes(field.type) && (
            <Switch
              checked={field.required}
              onChange={(checked) => onUpdate({ required: checked })}
              label="Required"
              description="Make this field mandatory"
            />
          )}

          {/* Options for choice fields */}
          {['dropdown', 'multiple_choice', 'checkboxes'].includes(field.type) && (
            <div>
              <h4 className="font-medium text-gray-900 dark:text-white mb-2">Options</h4>
              <div className="space-y-2">
                {field.properties.options?.map((option, index) => (
                  <div key={option.id} className="flex gap-2">
                    <Input
                      value={option.label}
                      onChange={(e) => {
                        const newOptions = [...(field.properties.options || [])];
                        newOptions[index] = { ...option, label: e.target.value, value: e.target.value };
                        onUpdate({ properties: { ...field.properties, options: newOptions } });
                      }}
                      placeholder={`Option ${index + 1}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove option"
                      onClick={() => {
                        const newOptions = field.properties.options?.filter((_, i) => i !== index);
                        onUpdate({ properties: { ...field.properties, options: newOptions } });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newOption = {
                      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15),
                      label: `Option ${(field.properties.options?.length || 0) + 1}`,
                      value: `option_${(field.properties.options?.length || 0) + 1}`,
                    };
                    onUpdate({
                      properties: {
                        ...field.properties,
                        options: [...(field.properties.options || []), newOption],
                      },
                    });
                  }}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Add Option
                </Button>
              </div>
            </div>
          )}

          {/* Rating settings */}
          {field.type === 'rating' && (
            <div>
              <h4 className="font-medium text-gray-900 dark:text-white mb-2">Rating Settings</h4>
              <Input
                label="Max Stars"
                type="number"
                min={1}
                max={10}
                value={field.properties.maxStars || 5}
                onChange={(e) =>
                  onUpdate({
                    properties: { ...field.properties, maxStars: parseInt(e.target.value) },
                  })
                }
              />
            </div>
          )}

          {/* Scale settings */}
          {field.type === 'scale' && (
            <div className="space-y-3">
              <h4 className="font-medium text-gray-900 dark:text-white mb-2">Scale Settings</h4>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Start"
                  type="number"
                  value={field.properties.scaleStart || 1}
                  onChange={(e) =>
                    onUpdate({
                      properties: { ...field.properties, scaleStart: parseInt(e.target.value) },
                    })
                  }
                />
                <Input
                  label="End"
                  type="number"
                  value={field.properties.scaleEnd || 10}
                  onChange={(e) =>
                    onUpdate({
                      properties: { ...field.properties, scaleEnd: parseInt(e.target.value) },
                    })
                  }
                />
              </div>
              <Input
                label="Start Label"
                value={field.properties.scaleStartLabel || ''}
                onChange={(e) =>
                  onUpdate({
                    properties: { ...field.properties, scaleStartLabel: e.target.value },
                  })
                }
                placeholder="e.g., Not likely"
              />
              <Input
                label="End Label"
                value={field.properties.scaleEndLabel || ''}
                onChange={(e) =>
                  onUpdate({
                    properties: { ...field.properties, scaleEndLabel: e.target.value },
                  })
                }
                placeholder="e.g., Very likely"
              />
            </div>
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

          {/* Linked record settings */}
          {field.type === 'linked_record' && (
            <LinkedRecordSettings
              properties={field.properties}
              onChange={(props) => onUpdate({ properties: props })}
              appId={appId}
              currentFormId={formId}
            />
          )}
        </TabsContent>

        {/* Validation Tab */}
        <TabsContent value="validation" className="flex-1 overflow-y-auto p-4">
          {['statement', 'welcome_screen', 'thank_you', 'calculated', 'linked_record'].includes(field.type) ? (
            <div className="text-center py-8 text-gray-500 dark:text-slate-500">
              <ShieldCheck className="h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
              <p>Validation is not applicable for this field type.</p>
            </div>
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
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-gray-900 dark:text-white">Conditional Logic</h4>
                <p className="text-sm text-gray-500 dark:text-slate-500">
                  Show or hide this field based on conditions
                </p>
              </div>
            </div>

            {hasLogic ? (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/50 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <Zap className="h-5 w-5 text-yellow-600 dark:text-yellow-500 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
                      {field.conditionalLogic?.action === 'show' && 'Show when:'}
                      {field.conditionalLogic?.action === 'hide' && 'Hide when:'}
                      {field.conditionalLogic?.action === 'require' && 'Require when:'}
                      {field.conditionalLogic?.action === 'skip' && 'Skip when:'}
                    </p>
                    <code className="text-xs text-yellow-700 dark:text-yellow-400 block mt-1 break-all">
                      {field.conditionalLogic?.expression}
                    </code>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="outline" onClick={() => setShowLogicEditor(true)}>
                    Edit Logic
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
                className="w-full"
                onClick={() => setShowLogicEditor(true)}
                leftIcon={<Zap className="h-4 w-4" />}
              >
                Add Conditional Logic
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
}
