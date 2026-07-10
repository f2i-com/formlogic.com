import { useState, useEffect } from 'react';
import { Link2, AlertCircle } from 'lucide-react';
import { Switch } from '../ui/Switch';
import { api } from '../../lib/api';
import type { FieldProperties } from '../../types/form';

interface AppForm {
  formId: string;
  displayName: string;
  fields?: Array<{ id: string; label: string; type: string }>;
}

export function LinkedRecordSettings({
  properties,
  onChange,
  appId,
  currentFormId,
}: {
  properties: FieldProperties;
  onChange: (props: FieldProperties) => void;
  appId: string | null;
  currentFormId?: string;
}) {
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [targetFields, setTargetFields] = useState<Array<{ id: string; label: string; type: string }>>([]);
  const [loading, setLoading] = useState(false);

  const targetFormId = properties.targetFormId || '';
  const displayFieldIds = properties.displayFieldIds || [];
  const searchFieldIds = properties.searchFieldIds || [];
  const allowMultiple = properties.allowMultiple || false;

  // Load app forms list
  useEffect(() => {
    if (!appId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: loading spinner must show synchronously when appId/currentFormId change
    setLoading(true);
    api.getAppForms(appId).then((result) => {
      if (result.data?.forms) {
        // Allow all forms including the current form (self-referential links
        // like Employee -> Manager or Task -> Parent Task are valid)
        setAppForms(result.data.forms as AppForm[]);
      }
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, [appId, currentFormId]);

  // Load target form fields when target changes
  useEffect(() => {
    if (!targetFormId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: must clear stale target fields synchronously when targetFormId is cleared
      setTargetFields([]);
      return;
    }
    // Cancellation guard so a slow fetch for a previously-selected target form
    // can't resolve last and show the wrong form's fields (last-resolved wins),
    // which would let the user pick field IDs that belong to a different form.
    let cancelled = false;
    api.getForm(targetFormId).then((result) => {
      if (cancelled) return;
      if (result.data?.form) {
        const form = result.data.form as { fields: Array<{ id: string; label: string; type: string }> };
        // Only show data fields (exclude layout types)
        const dataFields = form.fields.filter(
          (f) => !['statement', 'welcome_screen', 'thank_you', 'linked_record'].includes(f.type)
        );
        setTargetFields(dataFields);
      }
    }).catch(() => {
      if (!cancelled) setTargetFields([]);
    });
    return () => { cancelled = true; };
  }, [targetFormId]);

  if (!appId) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4">
        <div className="flex gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">App Context Required</p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              Linked Record fields can only be configured when the form belongs to an app.
              Open this form from the app&apos;s form manager to configure linked records.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <Link2 className="h-4 w-4 text-primary-500 dark:text-primary-400" />
        <h4 className="font-medium text-gray-900 dark:text-white">Linked Record Settings</h4>
      </div>

      {/* Target Form Selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
          Target Form
        </label>
        {loading ? (
          <div className="text-sm text-gray-400 dark:text-slate-500">Loading forms...</div>
        ) : (
          <select
            value={targetFormId}
            onChange={(e) => {
              onChange({
                ...properties,
                targetFormId: e.target.value,
                displayFieldIds: [],
                searchFieldIds: [],
              });
            }}
            className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          >
            <option value="">Select a form...</option>
            {appForms.map((form) => (
              <option key={form.formId} value={form.formId}>
                {form.displayName}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Display Fields Picker */}
      {targetFormId && targetFields.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
            Display Fields
          </label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
            Choose which fields to show as the record label
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {targetFields.map((field) => (
              <label
                key={field.id}
                className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={displayFieldIds.includes(field.id)}
                  onChange={(e) => {
                    const newIds = e.target.checked
                      ? [...displayFieldIds, field.id]
                      : displayFieldIds.filter((id) => id !== field.id);
                    onChange({ ...properties, displayFieldIds: newIds });
                  }}
                  className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-gray-700 dark:text-slate-300">{field.label}</span>
                <span className="text-xs text-gray-400 dark:text-slate-500">({field.type})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Search Fields Picker */}
      {targetFormId && targetFields.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
            Search Fields
          </label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
            Which fields to search when typing (defaults to display fields)
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {targetFields.filter((f) => ['short_text', 'long_text', 'email', 'phone', 'number', 'url'].includes(f.type)).map((field) => (
              <label
                key={field.id}
                className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={searchFieldIds.includes(field.id)}
                  onChange={(e) => {
                    const newIds = e.target.checked
                      ? [...searchFieldIds, field.id]
                      : searchFieldIds.filter((id) => id !== field.id);
                    onChange({ ...properties, searchFieldIds: newIds });
                  }}
                  className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-gray-700 dark:text-slate-300">{field.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Allow Multiple Toggle */}
      {targetFormId && (
        <Switch
          checked={allowMultiple}
          onChange={(checked) => onChange({ ...properties, allowMultiple: checked })}
          label="Allow Multiple"
          description="Let users select more than one record"
        />
      )}

      {/* Related records grid — how these records appear on the TARGET record's page. */}
      {targetFormId && (
        <div className="pt-3 border-t border-gray-100 dark:border-slate-800 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">On the linked record</p>
          <Switch
            checked={!(properties.relatedHidden ?? false)}
            onChange={(checked) => onChange({ ...properties, relatedHidden: !checked })}
            label="Show as a related grid"
            description="List these records on the linked record's page (the Display Fields above become the columns)"
          />
          {!(properties.relatedHidden ?? false) && (
            <>
              <Switch
                checked={properties.relatedAllowAdd ?? true}
                onChange={(checked) => onChange({ ...properties, relatedAllowAdd: checked })}
                label="Allow adding"
                description="Show an Add button that pre-links the new record here"
              />
              <Switch
                checked={properties.relatedAllowDelete ?? true}
                onChange={(checked) => onChange({ ...properties, relatedAllowDelete: checked })}
                label="Allow deleting"
                description="Show a delete action on each related row"
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                  Rows shown initially
                </label>
                <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
                  Newest first; more collapse behind a &ldquo;Show all&rdquo; button (default 8)
                </p>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={properties.relatedPageSize ?? 8}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    onChange({ ...properties, relatedPageSize: Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 50) : undefined });
                  }}
                  className="w-28 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
