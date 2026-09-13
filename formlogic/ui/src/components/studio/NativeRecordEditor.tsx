import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { NativeRecordDetail, NativeRecordField } from '../../lib/nativeHosting';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

export function NativeRecordEditor({ appId, table, recordKey, fields: initialFields, onClose, onSaved }: {
  appId: string; table: string; recordKey?: Record<string, string>; fields: NativeRecordField[];
  onClose(): void; onSaved(message: string): void;
}) {
  const [detail, setDetail] = useState<NativeRecordDetail | null>(null);
  const [initialValues] = useState<Record<string, string | null>>(() => Object.fromEntries(initialFields.filter(field => field.required && field.defaultValue === null && !field.auto && !field.readOnly).map(field => [field.name, ''])));
  const [values, setValues] = useState<Record<string, string | null>>(recordKey ? {} : initialValues);
  const [loading, setLoading] = useState(!!recordKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [confirm, setConfirm] = useState<'delete' | 'discard' | null>(null);
  const fields = detail?.fields ?? initialFields;
  const changed = Object.entries(values).filter(([name, value]) => value !== (recordKey ? detail?.values[name] : initialValues[name]));
  const dirty = changed.length > 0;
  useEffect(() => {
    if (!recordKey) return;
    let cancelled = false;
    void api.manageNativeRecord(appId, { table, action: 'read', key: recordKey }).then(result => {
      if (cancelled) return;
      if (result.error || !result.data?.record) setError(result.error || 'Could not load the full record.');
      else { setDetail(result.data.record); setValues(result.data.record.values); }
    }).catch(() => { if (!cancelled) setError('Could not load the full record. Please try again.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [appId, table, recordKey, retry]);
  const close = () => { if (!busy) { if (dirty) setConfirm('discard'); else onClose(); } };
  const save = async (action: 'create' | 'update' | 'delete') => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.manageNativeRecord(appId, { table, action, key: recordKey, revision: detail?.revision, values: action === 'create' ? values : Object.fromEntries(changed) });
      if (result.error) { setError(result.error); setConfirm(null); }
      else onSaved(action === 'delete' ? 'Record deleted.' : action === 'create' ? 'Record created.' : 'Record updated.');
    } catch { setError('The request could not be completed. Refresh the records before retrying.'); setConfirm(null); }
    finally { setBusy(false); }
  };
  const control = 'min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-950 dark:text-white';
  return <>
    <Modal isOpen title={recordKey ? 'Edit database record' : 'Create database record'} onClose={close} size="2xl" footer={<div className="flex flex-wrap items-center justify-end gap-2">
      {recordKey && <Button variant="danger" className="mr-auto min-h-11" disabled={busy || loading || !detail} onClick={() => setConfirm('delete')}>Delete record</Button>}
      <Button variant="secondary" className="min-h-11" disabled={busy} onClick={close}>Cancel</Button>
      <Button className="min-h-11" isLoading={busy} disabled={loading || (!!recordKey && (!detail || !dirty))} onClick={() => void save(recordKey ? 'update' : 'create')}>{recordKey ? 'Save record' : 'Create record'}</Button>
    </div>}>
      <div className="space-y-5 p-4 sm:p-6">
        <div><p className="break-all font-semibold text-slate-900 dark:text-white">{table}</p><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">Changes save directly to the app database and run connected record automations. Database rules apply; the app’s backend functions are not called.</p></div>
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}{!detail && recordKey && <Button variant="secondary" onClick={() => { setLoading(true); setError(''); setRetry(n => n + 1); }}>Retry loading</Button>}</div>}
        {loading ? <p role="status">Loading full record…</p> : (!recordKey || detail) && <div className="grid min-w-0 gap-4 sm:grid-cols-2">{fields.map(field => {
          const locked = field.readOnly || (!!recordKey && field.primary);
          const disabled = busy || locked;
          const mode = !(field.name in values) ? 'default' : values[field.name] === null ? 'null' : 'value';
          const numeric = /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(field.type);
          return <div key={field.name} className={`min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700 ${!numeric ? 'sm:col-span-2' : ''}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><label htmlFor={`record-field-${field.name}`} className="break-all text-sm font-medium text-slate-900 dark:text-white">{field.name}</label><span className="text-xs text-slate-500 dark:text-slate-400">{field.type || 'Any type'}{field.primary ? ' · Primary key' : ''}{field.required ? ' · Required' : ''}</span></div>
            {!locked && (!field.required || (!recordKey && (field.auto || field.defaultValue !== null))) && <select disabled={busy} aria-label={`${field.name} value mode`} className={`${control} mb-2`} value={mode} onChange={event => setValues(current => {
              const next = { ...current };
              if (event.target.value === 'default') delete next[field.name];
              else next[field.name] = event.target.value === 'null' ? null : (detail?.values[field.name] ?? '');
              return next;
            })}>
              {!recordKey && <option value="default">{field.auto ? 'Generate automatically' : field.defaultValue !== null ? `Use default: ${field.defaultValue}` : 'Leave unset'}</option>}
              <option value="value">Enter a value</option>{!field.required && <option value="null">No value (NULL)</option>}
            </select>}
            {!recordKey && mode === 'default' ? <p className="text-sm text-slate-500 dark:text-slate-400">{field.auto ? 'Assigned when the record is created.' : 'The database supplies this value.'}</p> : field.readOnly ? <p className="text-sm text-slate-500 dark:text-slate-400">Managed by the database, binary, or too large for this editor.</p> : numeric ? <input id={`record-field-${field.name}`} aria-label={field.name} className={control} inputMode="decimal" disabled={disabled || mode !== 'value'} value={values[field.name] ?? ''} onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} /> : <textarea id={`record-field-${field.name}`} aria-label={field.name} rows={3} className={`${control} resize-y`} disabled={disabled || mode !== 'value'} value={values[field.name] ?? ''} onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} />}
          </div>;
        })}</div>}
      </div>
    </Modal>
    <ConfirmDialog isOpen={confirm !== null} title={confirm === 'delete' ? 'Delete this record?' : 'Discard record changes?'} message={confirm === 'delete' ? 'This permanently deletes the record. Database relationships may also delete dependent records. Connected delete automations will run.' : 'Your unsaved field changes will be lost.'} variant="danger" confirmLabel={confirm === 'delete' ? 'Delete permanently' : 'Discard changes'} isLoading={busy} onClose={() => { if (!busy) setConfirm(null); }} onConfirm={() => { if (confirm === 'delete') void save('delete'); else onClose(); }} />
  </>;
}
