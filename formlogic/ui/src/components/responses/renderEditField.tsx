// Edit-input renderer for a single field value, by type — used by the responses table's
// edit modal and the full-page record view's edit mode.
import type { FormField } from '../../types/form';

// Render an edit input for a field value, by type. Used by the responses table's edit
// modal and the full-page record view's edit mode.
export function renderEditField(
  field: FormField,
  value: unknown,
  onChange: (value: unknown) => void
) {
  const currentValue = value ?? '';
  const inputClasses = "w-full px-3 py-2.5 bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-gray-900 dark:text-white";
  const disabledClasses = "w-full px-3 py-2.5 bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-gray-500 dark:text-slate-400 cursor-not-allowed";

  // Read-only for calculated + hidden fields (values are computed/script-set, not user-edited)
  if (field.type === 'calculated' || field.type === 'hidden') {
    return (
      <input
        type="text"
        value={String(currentValue)}
        disabled
        className={disabledClasses}
      />
    );
  }

  switch (field.type) {
    case 'short_text':
    case 'email':
    case 'phone':
    case 'url':
      return (
        <input
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'long_text':
      return (
        <textarea
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={inputClasses}
        />
      );

    case 'number':
    case 'rating':
    case 'scale':
      return (
        <input
          type="number"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          className={inputClasses}
        />
      );

    case 'date':
      return (
        <input
          type="date"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'time':
      return (
        <input
          type="time"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'dropdown':
    case 'multiple_choice':
      return (
        <select
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        >
          <option value="">Select...</option>
          {field.properties.options?.map((opt) => (
            <option key={opt.id} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case 'checkboxes': {
      const selectedValues = Array.isArray(currentValue) ? currentValue : [];
      return (
        <div className="space-y-2">
          {field.properties.options?.map((opt) => (
            <label key={opt.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={selectedValues.includes(opt.value)}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...selectedValues, opt.value]);
                  } else {
                    onChange(selectedValues.filter((v: string) => v !== opt.value));
                  }
                }}
                className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
              />
              <span className="text-gray-700 dark:text-slate-300">{opt.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'file_upload':
      // File uploads are not editable inline — show read-only summary
      if (Array.isArray(currentValue) && currentValue.length > 0) {
        return (
          <div className="text-sm text-gray-600 dark:text-slate-400 space-y-1">
            {currentValue.map((f: Record<string, unknown>, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span>{String(f.originalFilename || 'File')}</span>
              </div>
            ))}
          </div>
        );
      }
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No files uploaded</p>;

    case 'location':
      if (currentValue && typeof currentValue === 'object' && 'latitude' in (currentValue as Record<string, unknown>)) {
        const loc = currentValue as Record<string, number>;
        return (
          <p className="text-sm text-gray-600 dark:text-slate-400">
            {loc.latitude?.toFixed(6)}, {loc.longitude?.toFixed(6)}
            {loc.accuracy ? ` (~${loc.accuracy}m)` : ''}
          </p>
        );
      }
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No location captured</p>;

    case 'signature':
      // A signature is a data-URL — editing it as text would corrupt it. Show a
      // read-only preview; the value is preserved untouched on save.
      if (typeof currentValue === 'string' && currentValue.startsWith('data:image')) {
        return (
          <div className="space-y-1">
            <img src={currentValue} alt="Signature" className="max-h-24 rounded-lg border border-gray-200 dark:border-slate-700 bg-white" />
            <p className="text-xs text-gray-400 dark:text-slate-500 italic">Signatures can't be edited here — value preserved.</p>
          </div>
        );
      }
      if (typeof currentValue === 'string' && currentValue.startsWith('typed:')) {
        const typedName = currentValue.slice(6).trim();
        if (typedName) {
          return (
            <div className="space-y-1">
              <p className="text-base text-gray-900 dark:text-white" style={{ fontFamily: 'cursive' }}>{typedName}</p>
              <p className="text-xs text-gray-400 dark:text-slate-500 italic">Typed signature — value preserved.</p>
            </div>
          );
        }
      }
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No signature captured</p>;

    case 'linked_record':
      // Linked records reference other responses and are only editable in the
      // app runtime. Preserve the value rather than clobbering it as text.
      return (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          {currentValue ? String(Array.isArray(currentValue) ? currentValue.join(', ') : currentValue) : '—'}
          <span className="block text-xs text-gray-400 dark:text-slate-500 italic mt-0.5">Linked records can't be edited here — value preserved.</span>
        </p>
      );

    default:
      return (
        <input
          type="text"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );
  }
}
