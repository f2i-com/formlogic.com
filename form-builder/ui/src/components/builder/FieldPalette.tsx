import { HelpCircle } from 'lucide-react';
import { FIELD_TYPE_INFO, type FieldType } from '../../types/form';
import { ICON_MAP } from './fieldIcons';

export function FieldPalette({ onAddField }: { onAddField: (type: FieldType) => void }) {
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
          <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-2">
            {title}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {fieldsByCategory[category]?.map((field) => {
              const IconComponent = ICON_MAP[field.icon] || HelpCircle;
              return (
                <button
                  key={field.type}
                  onClick={() => onAddField(field.type)}
                  className="flex items-center gap-2 p-3 sm:p-2 text-left text-sm rounded-lg border border-gray-200 dark:border-slate-700 hover:border-primary-500/50 hover:bg-primary-50 dark:hover:bg-primary-500/10 active:scale-95 transition-all"
                >
                  <IconComponent className="h-4 w-4 text-gray-500 dark:text-slate-500" />
                  <span className="text-gray-700 dark:text-slate-300 truncate">{field.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
