import { useState, useEffect } from 'react';
import { Link2, AlertCircle } from 'lucide-react';
import { Switch } from '../ui/Switch';
import { api } from '../../lib/api';
import type { FieldProperties } from '../../types/form';

// A picker of this panel. On a phone it is a finger tall with text of 16 px (smaller, and iOS
// zooms the page in when it opens).
const SELECT = 'w-full min-w-0 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50 max-sm:min-h-11 max-sm:text-base';
// One field to tick in a list of them.
const TICK_ROW = 'flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer text-sm max-sm:min-h-11';
const TICK_BOX = 'rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500';

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
  ownFields: ownFieldsProp,
}: {
  properties: FieldProperties;
  onChange: (props: FieldProperties) => void;
  appId: string | null;
  currentFormId?: string;
  /** THIS form's own data fields, passed straight from the builder. */
  ownFields?: Array<{ id: string; label: string; type: string }>;
}) {
  const [appForms, setAppForms] = useState<AppForm[]>([]);
  const [targetFields, setTargetFields] = useState<Array<{ id: string; label: string; type: string }>>([]);
  const [loading, setLoading] = useState(false);

  const targetFormId = properties.targetFormId || '';
  const displayFieldIds = properties.displayFieldIds || [];
  const searchFieldIds = properties.searchFieldIds || [];
  const allowMultiple = properties.allowMultiple || false;
  // This form's own data fields (for the match-by-field join key picker).
  //
  // Previously derived by matching `currentFormId` inside the fetched app-forms list,
  // where currentFormId came from a `?formId=` query parameter the builder route never
  // sets — so this was ALWAYS empty and the two settings gated on it (the join-key
  // picker and the grid column config) could never render at all. The caller passes the
  // live field list; keep the old derivation only as a fallback for any other caller.
  const ownFields = (
    ownFieldsProp ?? appForms.find((f) => f.formId === currentFormId)?.fields ?? []
  ).filter((f) => !['statement', 'welcome_screen', 'thank_you', 'linked_record'].includes(f.type));

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
      <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
        <div className="flex gap-2.5">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Open this form from its app</p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
              A linked record points at another form of the same app, so it can only be set up
              when the form is opened from the app&apos;s form manager.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t border-gray-200 pt-4 dark:border-slate-800">
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">
        <Link2 className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400" />
        Linked record
      </h4>

      {/* Target Form Selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
          Target form
        </label>
        {loading ? (
          <div className="text-sm text-gray-500 dark:text-slate-400">Loading forms…</div>
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
            aria-label="Target form"
            className={SELECT}
          >
            <option value="">Select a form…</option>
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
            Display fields
          </label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
            The fields that are shown as the record's label
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {targetFields.map((field) => (
              <label
                key={field.id}
                className={TICK_ROW}
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
                  className={TICK_BOX}
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
            Search fields
          </label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
            The fields searched as a person types (the display fields when none is ticked)
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {targetFields.filter((f) => ['short_text', 'long_text', 'email', 'phone', 'number', 'url'].includes(f.type)).map((field) => (
              <label
                key={field.id}
                className={TICK_ROW}
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
                  className={TICK_BOX}
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
          label="Allow multiple"
          description="Let people choose more than one record"
        />
      )}

      {/* Match-based relation: join by a shared key instead of (only) the picker value. */}
      {targetFormId && ownFields.length > 0 && (
        <div className="pt-3 border-t border-gray-100 dark:border-slate-800 space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300">
            Match by field <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
          </label>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Also relate records automatically when a field on this form equals a field on the
            target — useful when records are created by flows or app logic that never set the
            link. Leave blank for picker-only linking.
          </p>
          <div className="flex items-center gap-2">
            <select
              value={properties.matchField ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v
                  ? { ...properties, matchField: v }
                  : { ...properties, matchField: undefined, targetMatchField: undefined });
              }}
              aria-label="Field on this form"
              className={SELECT}
            >
              <option value="">No match field</option>
              {ownFields.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
            <span className="shrink-0 text-xs text-gray-400 dark:text-slate-500">equals</span>
            <select
              value={properties.targetMatchField ?? properties.matchField ?? ''}
              onChange={(e) => onChange({ ...properties, targetMatchField: e.target.value || undefined })}
              disabled={!properties.matchField}
              aria-label="Field on the target form"
              className={SELECT}
            >
              <option value="">Same field key</option>
              {targetFields.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Related records grid — how these records appear on the TARGET record's page. */}
      {targetFormId && (
        <div className="pt-3 border-t border-gray-100 dark:border-slate-800 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">On the linked record</p>
          <Switch
            checked={!(properties.relatedHidden ?? false)}
            onChange={(checked) => onChange({ ...properties, relatedHidden: !checked })}
            label="Show as a related grid"
            description="List these records on the linked record's page (the display fields above become the columns)"
          />
          {!(properties.relatedHidden ?? false) && (
            <>
              {ownFields.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                    Grid columns
                  </label>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
                    Which of THIS form&apos;s fields show as columns in the related grid (defaults to
                    the first few simple fields)
                  </p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {ownFields.map((field) => {
                      const cols = properties.relatedColumnFieldIds || [];
                      return (
                        <label
                          key={field.id}
                          className={TICK_ROW}
                        >
                          <input
                            type="checkbox"
                            checked={cols.includes(field.id)}
                            onChange={(e) => {
                              const next = e.target.checked ? [...cols, field.id] : cols.filter((id) => id !== field.id);
                              onChange({ ...properties, relatedColumnFieldIds: next.length ? next : undefined });
                            }}
                            className={TICK_BOX}
                          />
                          <span className="text-gray-700 dark:text-slate-300">{field.label}</span>
                          <span className="text-xs text-gray-400 dark:text-slate-500">({field.type})</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
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
