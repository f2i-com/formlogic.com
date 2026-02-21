import { GripVertical, Trash2, HelpCircle } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '../../lib/utils';
import { FIELD_TYPE_INFO, type FormField } from '../../types/form';
import { ICON_MAP } from './fieldIcons';

export function SortableFieldCard({
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
        'group relative bg-white dark:bg-slate-900 rounded-lg border-2 transition-all',
        isSelected ? 'border-primary-500 shadow-xl' : 'border-gray-200 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700',
        isDragging && 'opacity-50 shadow-lg'
      )}
    >
      <div className="flex items-start gap-3 p-4 cursor-pointer" onClick={onSelect}>
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 p-1 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 cursor-grab active:cursor-grabbing touch-none"
          aria-label="Drag to reorder"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <IconComponent className="h-4 w-4 text-gray-400 dark:text-slate-500" />
            <span className="text-xs text-gray-500 dark:text-slate-500">{fieldInfo.label}</span>
            {field.required && (
              <span className="text-xs text-red-500">*</span>
            )}
          </div>
          <p className="font-medium text-gray-900 dark:text-white truncate">{field.label}</p>
          {field.description && (
            <p className="text-sm text-gray-500 dark:text-slate-500 truncate mt-1">{field.description}</p>
          )}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label={`Delete ${field.label || 'field'}`}
          className={cn(
            'p-1.5 rounded-md hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all cursor-pointer',
            isSelected
              ? 'text-gray-400 dark:text-slate-500 opacity-100'
              : 'text-gray-400 dark:text-slate-500 opacity-0 group-hover:opacity-100 sm:opacity-0 max-sm:opacity-60'
          )}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
