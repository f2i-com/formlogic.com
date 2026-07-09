import { memo, useCallback } from 'react';
import { GripVertical, Trash2, Copy, HelpCircle } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '../../lib/utils';
import { FIELD_TYPE_INFO, type FormField } from '../../types/form';
import { ICON_MAP } from './fieldIcons';

export const SortableFieldCard = memo(function SortableFieldCard({
  field,
  isSelected,
  onSelect,
  onDelete,
  onDuplicate,
}: {
  field: FormField;
  isSelected: boolean;
  onSelect: (fieldId: string) => void;
  onDelete: (fieldId: string) => void;
  onDuplicate: (fieldId: string) => void;
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

  const fieldInfo = FIELD_TYPE_INFO[field.type] ?? { label: field.type, icon: 'HelpCircle', category: 'other' };
  const IconComponent = ICON_MAP[fieldInfo.icon] || HelpCircle;

  const handleSelect = useCallback(() => onSelect(field.id), [onSelect, field.id]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(field.id);
  }, [onDelete, field.id]);
  const handleDuplicate = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDuplicate(field.id);
  }, [onDuplicate, field.id]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative bg-white dark:bg-slate-900 rounded-lg border-2 motion-safe:transition-all',
        isSelected
          ? 'border-primary-500 bg-primary-50/40 dark:bg-primary-500/5 ring-2 ring-primary-500/20 shadow-lg'
          : 'border-gray-200 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700',
        isDragging && 'opacity-50 shadow-lg'
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="-mt-1 inline-flex items-center justify-center min-h-10 min-w-10 rounded-md text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-grab active:cursor-grabbing touch-none motion-safe:transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          aria-label="Drag to reorder"
          title="Drag to reorder"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        {/* The content block is the selection control so keyboard users can focus +
            select a field (focus ring + pressed state), not just mouse users. */}
        <button
          type="button"
          id={`field-select-${field.id}`}
          onClick={handleSelect}
          aria-pressed={isSelected}
          aria-label={`Edit field: ${field.label || fieldInfo.label}`}
          className="flex-1 min-w-0 text-left cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <div className="flex min-w-0 items-center gap-2 mb-1">
            <IconComponent className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" />
            <span className="min-w-0 truncate text-xs text-gray-500 dark:text-slate-500">{fieldInfo.label}</span>
            {field.required && (
              <span className="shrink-0 text-xs font-semibold leading-none text-red-500 dark:text-red-400" title="Required field">*</span>
            )}
            {field.type === 'hidden' && (
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200/70 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                Not shown
              </span>
            )}
          </div>
          <p className="font-medium text-gray-900 dark:text-white truncate">{field.label}</p>
          {field.description && (
            <p className="text-sm text-gray-500 dark:text-slate-500 truncate mt-1">{field.description}</p>
          )}
        </button>

        <button
          onClick={handleDuplicate}
          aria-label={`Duplicate ${field.label || 'field'}`}
          title="Duplicate field"
          className="-mt-1 inline-flex items-center justify-center min-h-10 min-w-10 rounded-md text-gray-300 dark:text-slate-600 hover:text-primary-600 dark:hover:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-500/10 motion-safe:transition-all cursor-pointer focus:outline-none focus-visible:text-primary-600 dark:focus-visible:text-primary-400 focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <Copy className="h-4 w-4" />
        </button>

        <button
          onClick={handleDelete}
          aria-label={`Delete ${field.label || 'field'}`}
          title="Delete field"
          className="-mt-1 inline-flex items-center justify-center min-h-10 min-w-10 rounded-md text-gray-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 motion-safe:transition-all cursor-pointer focus:outline-none focus-visible:text-red-500 dark:focus-visible:text-red-400 focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
});
