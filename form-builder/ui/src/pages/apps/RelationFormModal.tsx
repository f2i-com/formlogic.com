import { useState, useEffect } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Switch } from '../../components/ui/Switch';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { Form, FormField } from '../../types/form';

interface RelationFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  appForms: Array<{ formId: string; displayName: string }>;
  existing?: null;
}

const EXCLUDED_TYPES = new Set(['statement', 'welcome_screen', 'thank_you', 'linked_record']);

export function RelationFormModal({ isOpen, onClose, onSave, appForms }: RelationFormModalProps) {
  const [sourceFormId, setSourceFormId] = useState('');
  const [targetFormId, setTargetFormId] = useState('');
  const [label, setLabel] = useState('');
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [displayFieldIds, setDisplayFieldIds] = useState<string[]>([]);
  const [targetFields, setTargetFields] = useState<FormField[]>([]);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset form when opening
  useEffect(() => {
    if (isOpen) {
      setSourceFormId('');
      setTargetFormId('');
      setLabel('');
      setAllowMultiple(false);
      setDisplayFieldIds([]);
      setTargetFields([]);
    }
  }, [isOpen]);

  // Load target form fields when target changes
  useEffect(() => {
    if (!targetFormId) {
      setTargetFields([]);
      return;
    }
    setLoadingTarget(true);
    api.getForm(targetFormId).then((res) => {
      if (res.data?.form) {
        const fields = (res.data.form as Form).fields.filter((f) => !EXCLUDED_TYPES.has(f.type));
        setTargetFields(fields);
      }
      setLoadingTarget(false);
    }).catch(() => {
      setTargetFields([]);
      setLoadingTarget(false);
      toast.error('Load failed', 'Could not load target form fields.');
    });
  }, [targetFormId]);

  const handleSave = async () => {
    if (!sourceFormId || !targetFormId || !label.trim()) return;
    setSaving(true);

    try {
      const sourceRes = await api.getForm(sourceFormId);
      if (!sourceRes.data?.form) {
        toast.error('Load failed', 'Could not load the source form.');
        setSaving(false);
        return;
      }
      const sourceForm = sourceRes.data.form as Form;

      const newField: FormField = {
        id: crypto.randomUUID(),
        type: 'linked_record',
        label: label.trim(),
        required: false,
        properties: {
          targetFormId,
          displayFieldIds,
          allowMultiple,
        },
        order: sourceForm.fields.length,
      };

      await api.updateForm(sourceFormId, { fields: [...sourceForm.fields, newField] });
      setSaving(false);
      onSave();
    } catch {
      toast.error('Save failed', 'Could not create the relation. Please try again.');
      setSaving(false);
    }
  };

  const availableTargets = appForms.filter((f) => f.formId !== sourceFormId);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Relation" size="md">
      <div className="p-6 space-y-5">
        {/* Source Form */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Source Form</label>
          <select
            value={sourceFormId}
            onChange={(e) => { setSourceFormId(e.target.value); setTargetFormId(''); }}
            className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900/50 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Select a form...</option>
            {appForms.map((f) => (
              <option key={f.formId} value={f.formId}>{f.displayName}</option>
            ))}
          </select>
        </div>

        {/* Target Form */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Target Form</label>
          <select
            value={targetFormId}
            onChange={(e) => { setTargetFormId(e.target.value); setDisplayFieldIds([]); }}
            disabled={!sourceFormId}
            className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900/50 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Select a form...</option>
            {availableTargets.map((f) => (
              <option key={f.formId} value={f.formId}>{f.displayName}</option>
            ))}
          </select>
        </div>

        {/* Relation Label */}
        <Input
          label="Relation Label"
          placeholder='e.g. "Customer", "Assigned Project"'
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />

        {/* Display Fields */}
        {targetFormId && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Display Fields</label>
            {loadingTarget ? (
              <div className="flex items-center gap-2 py-2 text-sm text-gray-400 dark:text-slate-500">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary-600 border-t-transparent" />
                Loading fields...
              </div>
            ) : targetFields.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-slate-500 py-2">No data fields found on target form.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto border border-gray-200 dark:border-slate-700 rounded-lg p-3">
                {targetFields.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={displayFieldIds.includes(f.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setDisplayFieldIds([...displayFieldIds, f.id]);
                        } else {
                          setDisplayFieldIds(displayFieldIds.filter((id) => id !== f.id));
                        }
                      }}
                      className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
                    />
                    <span className="text-sm text-gray-700 dark:text-slate-300">{f.label}</span>
                    <span className="text-xs text-gray-400 dark:text-slate-500">({f.type.replace('_', ' ')})</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Allow Multiple */}
        <Switch
          checked={allowMultiple}
          onChange={setAllowMultiple}
          label="Allow Multiple"
          description="Allow linking to multiple records"
        />

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-200 dark:border-slate-700">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!sourceFormId || !targetFormId || !label.trim() || saving}
            isLoading={saving}
          >
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
