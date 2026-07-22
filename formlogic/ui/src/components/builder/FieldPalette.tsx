import { useMemo, useState } from 'react';
import { HelpCircle, Search } from 'lucide-react';
import { FIELD_TYPE_INFO, type FieldType } from '../../types/form';
import { ICON_MAP } from './fieldIcons';

const FIELD_CATEGORIES = {
  text: 'Text inputs',
  datetime: 'Date & time',
  choice: 'Choices',
  rating: 'Rating & scale',
  advanced: 'Advanced',
  layout: 'Layout',
};

/** Palette-only presets: separate cards that create a PRECONFIGURED base type
 *  (so the whole storage/export/backup pipeline stays the base type's). */
const FIELD_PRESETS: Array<{ preset: string; type: FieldType; label: string; icon: string; category: string }> = [
  { preset: 'camera', type: 'file_upload', label: 'Camera', icon: 'Camera', category: 'advanced' },
];

// Field types not yet supported on private (E2EE) forms (plan SS9.1): file/camera
// need the P4 attachment claim flow; linked_record needs server-side resolution.
const PRIVATE_BLOCKED_TYPES = new Set<FieldType>(['file_upload', 'linked_record']);
const PRIVATE_BLOCKED_PRESETS = new Set(['camera']);

export function FieldPalette({ onAddField, isPrivate = false }: { onAddField: (type: FieldType, preset?: string) => void; isPrivate?: boolean }) {
  const [query, setQuery] = useState('');

  const fieldsByCategory = useMemo(
    () => {
      const acc = Object.entries(FIELD_TYPE_INFO).reduce(
        (map, [type, info]) => {
          if (!map[info.category]) map[info.category] = [];
          map[info.category].push({ type: type as FieldType, ...info });
          return map;
        },
        {} as Record<string, Array<{ type: FieldType; label: string; icon: string; preset?: string }>>
      );
      for (const p of FIELD_PRESETS) {
        if (!acc[p.category]) acc[p.category] = [];
        acc[p.category].push({ type: p.type, label: p.label, icon: p.icon, preset: p.preset });
      }
      return acc;
    },
    [],
  );

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(FIELD_CATEGORIES).map(([category, title]) => ({
      category,
      title,
      fields: (fieldsByCategory[category] ?? []).filter((field) => (
        q === '' ||
        field.label.toLowerCase().includes(q) ||
        field.type.toLowerCase().includes(q)
      )),
    })).filter((group) => group.fields.length > 0);
  }, [fieldsByCategory, query]);

  return (
    <div className="p-4 space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fields"
          aria-label="Search field types"
          className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>
      {grouped.length === 0 && (
        <p className="text-xs text-gray-400 dark:text-slate-500">No fields match "{query}".</p>
      )}
      {grouped.map(({ category, title, fields }) => (
        <div key={category}>
          <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-2">
            {title}
          </h3>
          <div className="grid grid-cols-2 gap-1.5">
            {fields.map((field) => {
              const IconComponent = ICON_MAP[field.icon] || HelpCircle;
              const blocked = isPrivate && (PRIVATE_BLOCKED_TYPES.has(field.type) || (field.preset ? PRIVATE_BLOCKED_PRESETS.has(field.preset) : false));
              return (
                <button
                  key={field.preset ?? field.type}
                  onClick={() => { if (!blocked) onAddField(field.type, field.preset); }}
                  disabled={blocked}
                  title={blocked ? 'Not yet supported on private forms' : field.label}
                  className={blocked
                    ? 'flex min-w-0 items-center gap-2 p-2.5 sm:p-1.5 text-left text-sm rounded-lg border border-gray-200 dark:border-slate-700 opacity-40 cursor-not-allowed'
                    : 'flex min-w-0 items-center gap-2 p-2.5 sm:p-1.5 text-left text-sm rounded-lg border border-gray-200 dark:border-slate-700 hover:border-primary-500/50 hover:bg-primary-50/60 dark:hover:bg-primary-500/10 active:scale-[0.98] motion-safe:transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400"
                  >
                    <IconComponent className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 text-gray-700 dark:text-slate-300 truncate">{field.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
