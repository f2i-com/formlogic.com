import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Eye,
  Settings,
  GripVertical,
  Plus,
  Trash2,
  HelpCircle,
  Type,
  AlignLeft,
  Mail,
  Phone,
  Hash,
  Link,
  Calendar,
  Clock,
  CalendarClock,
  ChevronDown,
  CircleDot,
  CheckSquare,
  Star,
  Sliders,
  Paperclip,
  PenTool,
  CreditCard,
  Calculator,
  MessageSquare,
  PartyPopper,
  Heart
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Switch } from '../components/ui/Switch';
import { useFormStore } from '../stores/formStore';
import { useUIStore } from '../stores/uiStore';
import { cn } from '../lib/utils';
import { FIELD_TYPE_INFO, type FormField, type FieldType } from '../types/form';

// Icon map for field types
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Type, AlignLeft, Mail, Phone, Hash, Link, Calendar, Clock, CalendarClock,
  ChevronDown, CircleDot, CheckSquare, Star, Sliders, Paperclip, PenTool,
  CreditCard, Calculator, MessageSquare, PartyPopper, Heart, HelpCircle
};

// Field Palette Component
function FieldPalette({ onAddField }: { onAddField: (type: FieldType) => void }) {
  const categories = {
    text: 'Text Inputs',
    datetime: 'Date & Time',
    choice: 'Choices',
    rating: 'Rating & Scale',
    advanced: 'Advanced',
    layout: 'Layout',
  };

  const fieldsByCategory = Object.entries(FIELD_TYPE_INFO).reduce(
    (acc, [type, info]) => {
      if (!acc[info.category]) acc[info.category] = [];
      acc[info.category].push({ type: type as FieldType, ...info });
      return acc;
    },
    {} as Record<string, Array<{ type: FieldType; label: string; icon: string }>>
  );

  return (
    <div className="p-4 space-y-6">
      {Object.entries(categories).map(([category, title]) => (
        <div key={category}>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            {title}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {fieldsByCategory[category]?.map((field) => {
              const IconComponent = ICON_MAP[field.icon] || HelpCircle;
              return (
                <button
                  key={field.type}
                  onClick={() => onAddField(field.type)}
                  className="flex items-center gap-2 p-2 text-left text-sm rounded-lg border border-gray-200 hover:border-primary-300 hover:bg-primary-50 transition-colors"
                >
                  <IconComponent className="h-4 w-4 text-gray-500" />
                  <span className="text-gray-700 truncate">{field.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Sortable Field Card Component
function SortableFieldCard({
  field,
  isSelected,
  onSelect,
  onDelete,
}: {
  field: FormField;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const fieldInfo = FIELD_TYPE_INFO[field.type];
  const IconComponent = ICON_MAP[fieldInfo.icon] || HelpCircle;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative bg-white rounded-lg border-2 transition-all',
        isSelected ? 'border-primary-500 shadow-md' : 'border-gray-200 hover:border-gray-300',
        isDragging && 'opacity-50 shadow-lg'
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          {...attributes}
          {...listeners}
          className="mt-1 p-1 text-gray-400 hover:text-gray-600 cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="flex-1 min-w-0" onClick={onSelect}>
          <div className="flex items-center gap-2 mb-1">
            <IconComponent className="h-4 w-4 text-gray-400" />
            <span className="text-xs text-gray-500">{fieldInfo.label}</span>
            {field.required && (
              <span className="text-xs text-red-500">*</span>
            )}
          </div>
          <p className="font-medium text-gray-900 truncate">{field.label}</p>
          {field.description && (
            <p className="text-sm text-gray-500 truncate mt-1">{field.description}</p>
          )}
        </div>

        <button
          onClick={onDelete}
          className="p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// Field Settings Panel
function FieldSettingsPanel({
  field,
  onUpdate,
}: {
  field: FormField;
  onUpdate: (updates: Partial<FormField>) => void;
}) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="font-medium text-gray-900 mb-4">Field Settings</h3>

        <div className="space-y-4">
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

          <Input
            label="Placeholder"
            value={field.placeholder || ''}
            onChange={(e) => onUpdate({ placeholder: e.target.value })}
          />

          <Switch
            checked={field.required}
            onChange={(checked) => onUpdate({ required: checked })}
            label="Required"
            description="Make this field mandatory"
          />
        </div>
      </div>

      {/* Options for choice fields */}
      {['dropdown', 'multiple_choice', 'checkboxes'].includes(field.type) && (
        <div>
          <h4 className="font-medium text-gray-900 mb-2">Options</h4>
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
                  id: crypto.randomUUID(),
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
          <h4 className="font-medium text-gray-900 mb-2">Rating Settings</h4>
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
          <h4 className="font-medium text-gray-900 mb-2">Scale Settings</h4>
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
    </div>
  );
}

// Main Form Builder Component
export default function FormBuilder() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();

  const {
    getForm,
    updateForm,
    addField,
    updateField,
    deleteField,
    reorderFields,
    selectedFieldId,
    setSelectedField,
  } = useFormStore();

  const { isMobile, mobilePanel, setMobilePanel } = useUIStore();

  const form = formId ? getForm(formId) : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    if (!form && formId) {
      navigate('/forms');
    }
  }, [form, formId, navigate]);

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Form not found</p>
      </div>
    );
  }

  const selectedField = form.fields.find((f) => f.id === selectedFieldId);

  const handleAddField = (type: FieldType) => {
    const defaultLabels: Partial<Record<FieldType, string>> = {
      short_text: 'Your answer',
      long_text: 'Your thoughts',
      email: 'Email address',
      phone: 'Phone number',
      number: 'Number',
      url: 'Website URL',
      date: 'Select a date',
      time: 'Select a time',
      datetime: 'Select date and time',
      dropdown: 'Select an option',
      multiple_choice: 'Choose one',
      checkboxes: 'Select all that apply',
      rating: 'Rate your experience',
      scale: 'Rate on a scale',
      file_upload: 'Upload a file',
      signature: 'Your signature',
      payment: 'Payment',
      statement: 'Information',
      welcome_screen: 'Welcome',
      thank_you: 'Thank you!',
      calculated: 'Calculated value',
    };

    const defaultOptions = ['dropdown', 'multiple_choice', 'checkboxes'].includes(type)
      ? [
          { id: crypto.randomUUID(), label: 'Option 1', value: 'option_1' },
          { id: crypto.randomUUID(), label: 'Option 2', value: 'option_2' },
          { id: crypto.randomUUID(), label: 'Option 3', value: 'option_3' },
        ]
      : undefined;

    const field = addField(form.id, {
      type,
      label: defaultLabels[type] || 'New Field',
      required: false,
      properties: {
        options: defaultOptions,
        maxStars: type === 'rating' ? 5 : undefined,
        scaleStart: type === 'scale' ? 1 : undefined,
        scaleEnd: type === 'scale' ? 10 : undefined,
      },
    });

    setSelectedField(field.id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = form.fields.findIndex((f) => f.id === active.id);
      const newIndex = form.fields.findIndex((f) => f.id === over.id);
      const newOrder = arrayMove(
        form.fields.map((f) => f.id),
        oldIndex,
        newIndex
      );
      reorderFields(form.id, newOrder);
    }
  };

  const handleUpdateField = (updates: Partial<FormField>) => {
    if (selectedFieldId) {
      updateField(form.id, selectedFieldId, updates);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/forms')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input
            value={form.title}
            onChange={(e) => updateForm(form.id, { title: e.target.value })}
            className="border-none bg-transparent font-semibold text-lg focus:ring-0 p-0 w-48 md:w-auto"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/preview/${form.id}`)}>
            <Eye className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">Preview</span>
          </Button>
          <Button
            size="sm"
            onClick={() => updateForm(form.id, { status: 'published' })}
          >
            Publish
          </Button>
        </div>
      </header>

      {/* Mobile Tabs */}
      {isMobile && (
        <div className="bg-white border-b border-gray-200 px-4 py-2 flex-shrink-0">
          <div className="flex gap-2">
            <Button
              variant={mobilePanel === 'palette' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setMobilePanel('palette')}
            >
              Fields
            </Button>
            <Button
              variant={mobilePanel === 'canvas' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setMobilePanel('canvas')}
            >
              Canvas
            </Button>
            <Button
              variant={mobilePanel === 'settings' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setMobilePanel('settings')}
              disabled={!selectedField}
            >
              Settings
            </Button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Field Palette - Desktop or Mobile when selected */}
        {(!isMobile || mobilePanel === 'palette') && (
          <aside className="w-full md:w-64 bg-white border-r border-gray-200 overflow-y-auto flex-shrink-0">
            <div className="p-4 border-b border-gray-200">
              <h2 className="font-semibold text-gray-900">Add Fields</h2>
            </div>
            <FieldPalette onAddField={handleAddField} />
          </aside>
        )}

        {/* Canvas - Desktop or Mobile when selected */}
        {(!isMobile || mobilePanel === 'canvas') && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <div className="max-w-2xl mx-auto">
              {form.fields.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-gray-300 rounded-xl">
                  <Plus className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">
                    Add your first field
                  </h3>
                  <p className="text-gray-500 mb-4">
                    Click a field type from the left panel to get started
                  </p>
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={form.fields.map((f) => f.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-3">
                      {form.fields.map((field) => (
                        <SortableFieldCard
                          key={field.id}
                          field={field}
                          isSelected={field.id === selectedFieldId}
                          onSelect={() => setSelectedField(field.id)}
                          onDelete={() => deleteField(form.id, field.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}

              {form.fields.length > 0 && (
                <button
                  onClick={() => setMobilePanel('palette')}
                  className="mt-4 w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 hover:border-primary-300 hover:text-primary-600 transition-colors flex items-center justify-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add Field
                </button>
              )}
            </div>
          </div>
        )}

        {/* Settings Panel - Desktop or Mobile when selected */}
        {(!isMobile || mobilePanel === 'settings') && (
          <aside className="w-full md:w-80 bg-white border-l border-gray-200 overflow-y-auto flex-shrink-0">
            {selectedField ? (
              <FieldSettingsPanel
                field={selectedField}
                onUpdate={handleUpdateField}
              />
            ) : (
              <div className="p-6 text-center text-gray-500">
                <Settings className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                <p>Select a field to edit its settings</p>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
