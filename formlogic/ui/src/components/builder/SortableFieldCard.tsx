import { memo, useCallback } from 'react';
import { GripVertical, Trash2, Copy, HelpCircle } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '../../lib/utils';
import { FIELD_TYPE_INFO, type FormField } from '../../types/form';
import { ICON_MAP } from './fieldIcons';

// A row's own buttons: 32 px for a mouse, a finger's 44 px below md (where the builder is a
// phone layout and the row has the whole width).
const ROW_BUTTON = 'inline-flex flex-none items-center justify-center motion-safe:transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset';
const ROW_ACTION = cn(ROW_BUTTON, 'h-8 w-8 cursor-pointer self-center rounded-lg max-md:h-11 max-md:w-11');
const ROW_MARK = 'flex-none rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-gray-200/70 text-gray-500 dark:bg-slate-700/70 dark:text-slate-400';

/**
 * One field of the form, as a row of the builder's list: the handle that drags it, what kind
 * of field it is, its label, and its two actions. A row is 56 px, so a form of thirty fields is
 * three screens and not seven.
 */
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
  const hasLogic = !!field.conditionalLogic?.expression?.trim();

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
        // The keyboard's place is drawn round the whole row, outside its border, so it reads on
        // the selected row too (whose border is already the accent).
        'group relative flex min-h-14 items-stretch rounded-xl border motion-safe:transition-colors',
        'has-[[data-field-select]:focus-visible]:outline has-[[data-field-select]:focus-visible]:outline-2 has-[[data-field-select]:focus-visible]:outline-offset-2 has-[[data-field-select]:focus-visible]:outline-primary-500',
        isSelected
          ? 'border-primary-500 bg-primary-50 ring-1 ring-primary-500 dark:bg-primary-500/10'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60',
        isDragging && 'z-10 opacity-60 shadow-lg'
      )}
    >
      <button
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        // The handle is the row's whole left end, top to bottom: easy to catch with a finger.
        className={cn(ROW_BUTTON, 'w-8 cursor-grab touch-none rounded-l-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-primary-500 active:cursor-grabbing dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300 max-md:w-11')}
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
        data-field-select=""
        onClick={handleSelect}
        aria-pressed={isSelected}
        aria-label={`Edit field: ${field.label || fieldInfo.label}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2 pl-1 pr-2 text-left focus:outline-none"
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-8 w-8 flex-none items-center justify-center rounded-lg',
            isSelected
              ? 'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
              : 'bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-slate-400',
          )}
        >
          <IconComponent className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-1">
            {/* With room the label is one line. On a phone it takes the lines it needs and is
                not cut: there the mark follows its last word, where a mark of its own beside a
                label of two lines stood alone at the row's far end. */}
            <span className="min-w-0 break-words text-sm font-medium leading-5 text-gray-900 dark:text-white md:line-clamp-1">
              {field.label || fieldInfo.label}
              {field.required && (
                <span className="font-semibold text-red-500 dark:text-red-400 md:hidden" title="Required field"> *</span>
              )}
            </span>
            {field.required && (
              <span className="flex-none text-sm font-semibold leading-5 text-red-500 dark:text-red-400 max-md:hidden" title="Required field">*</span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-gray-500 dark:text-slate-400">
            <span className="flex-none">{fieldInfo.label}</span>
            {field.description && (
              <>
                <span aria-hidden="true" className="flex-none text-gray-300 dark:text-slate-600">·</span>
                <span className="min-w-0 truncate">{field.description}</span>
              </>
            )}
          </span>
        </span>
        {field.type === 'hidden' && <span className={ROW_MARK}>Not shown</span>}
        {hasLogic && <span className={cn(ROW_MARK, 'max-sm:hidden')} title="This field has a logic rule">Logic</span>}
      </button>

      <button
        onClick={handleDuplicate}
        aria-label={`Duplicate ${field.label || 'field'}`}
        title="Duplicate field"
        className={cn(ROW_ACTION, 'text-gray-400 hover:bg-primary-50 hover:text-primary-600 focus-visible:text-primary-600 focus-visible:ring-primary-500 dark:text-slate-500 dark:hover:bg-primary-500/10 dark:hover:text-primary-400 dark:focus-visible:text-primary-400')}
      >
        <Copy className="h-4 w-4" />
      </button>

      <button
        onClick={handleDelete}
        aria-label={`Delete ${field.label || 'field'}`}
        title="Delete field"
        className={cn(ROW_ACTION, 'mr-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 focus-visible:text-red-500 focus-visible:ring-red-500 dark:text-slate-500 dark:hover:bg-red-500/10 dark:hover:text-red-400 dark:focus-visible:text-red-400 max-md:mr-0.5')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
});
