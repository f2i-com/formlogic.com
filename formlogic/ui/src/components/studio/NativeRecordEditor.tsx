import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { NativeRecordDetail, NativeRecordField } from '../../lib/nativeHosting';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { rowTitle } from '../data/format';

/** What a save in the row editor did. */
export type RowSaved = 'created' | 'updated' | 'deleted';

/**
 * One row of an app's table, added or changed as a whole (the data manager's Add row and Edit): a
 * box for each column, with how it starts (numbered by the database, its default, empty) where it
 * may be left to that. `onSaved` says what was done, and for a row added, its key where the server
 * said it (the data manager then opens it).
 */
export function NativeRecordEditor({ appId, table, recordKey, fields: initialFields, onClose, onSaved }: {
  appId: string; table: string; recordKey?: Record<string, string>; fields: NativeRecordField[];
  onClose(): void; onSaved(outcome: RowSaved, key?: Record<string, string>): void;
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
      if (result.error || !result.data?.record) setError(result.error || 'This row could not be read.');
      else { setDetail(result.data.record); setValues(result.data.record.values); }
    }).catch(() => { if (!cancelled) setError('This row could not be read. Try again.'); })
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
      else onSaved(action === 'delete' ? 'deleted' : action === 'create' ? 'created' : 'updated', action === 'create' ? result.data?.key : undefined);
    } catch { setError('The change could not be saved. Check the rows are as you left them, then try again.'); setConfirm(null); }
    finally { setBusy(false); }
  };
  const control = 'min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-950 dark:text-white';
  return <>
    <Modal isOpen title={recordKey ? 'Edit row' : 'Add row'} onClose={close} size="2xl" footer={<div className="flex flex-wrap items-center justify-end gap-2">
      {recordKey && <Button variant="danger" className="mr-auto min-h-11" disabled={busy || loading || !detail} onClick={() => setConfirm('delete')}>Delete row</Button>}
      <Button variant="secondary" className="min-h-11" disabled={busy} onClick={close}>Cancel</Button>
      <Button className="min-h-11" isLoading={busy} disabled={loading || (!!recordKey && (!detail || !dirty))} onClick={() => void save(recordKey ? 'update' : 'create')}>{recordKey ? 'Save changes' : 'Add row'}</Button>
    </div>}>
      <div className="space-y-5 p-4 sm:p-6">
        <div>
          <p className="break-all font-mono font-semibold text-slate-900 dark:text-white">{table}{recordKey ? <span className="font-normal text-slate-500 dark:text-slate-400"> · {rowTitle(recordKey)}</span> : null}</p>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">Saved straight to the app’s database, where the app sees it at once. The database’s own rules apply and the app’s record automations run; the app’s backend code is not called.</p>
        </div>
        {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"><span className="min-w-0 flex-1">{error}</span>{!detail && recordKey && <Button variant="secondary" onClick={() => { setLoading(true); setError(''); setRetry(n => n + 1); }}>Try again</Button>}</div>}
        {loading ? <p role="status">Reading the row…</p> : (!recordKey || detail) && <div className="grid min-w-0 gap-4 sm:grid-cols-2">{fields.map(field => {
          const locked = field.readOnly || (!!recordKey && field.primary);
          const disabled = busy || locked;
          const mode = !(field.name in values) ? 'default' : values[field.name] === null ? 'null' : 'value';
          const numeric = /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(field.type);
          return <div key={field.name} className={`min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700 ${!numeric ? 'sm:col-span-2' : ''}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><label htmlFor={`record-field-${field.name}`} className="break-all font-mono text-sm font-medium text-slate-900 dark:text-white">{field.name}</label><span className="text-xs text-slate-500 dark:text-slate-400">{field.type || 'Any type'}{field.primary ? ' · Key' : ''}{field.required ? ' · Required' : ''}</span></div>
            {!locked && (!field.required || (!recordKey && (field.auto || field.defaultValue !== null))) && <select disabled={busy} aria-label={`${field.name} value mode`} className={`${control} mb-2`} value={mode} onChange={event => setValues(current => {
              const next = { ...current };
              if (event.target.value === 'default') delete next[field.name];
              else next[field.name] = event.target.value === 'null' ? null : (detail?.values[field.name] ?? '');
              return next;
            })}>
              {/* Left to the database: numbered, its default, or (a column with neither) no value at all. */}
              {!recordKey && <option value="default">{field.auto ? 'Numbered by the database' : field.defaultValue !== null ? `Its default: ${field.defaultValue}` : 'Leave it empty (NULL)'}</option>}
              <option value="value">Enter a value</option>{!field.required && <option value="null">No value (NULL)</option>}
            </select>}
            {!recordKey && mode === 'default' ? <p className="text-sm text-slate-500 dark:text-slate-400">{field.auto ? 'The database gives the row the next number when it is added.' : field.defaultValue !== null ? 'The database fills it in when the row is added.' : 'The row holds no value here (NULL).'}</p> : field.readOnly ? <p className="text-sm text-slate-500 dark:text-slate-400">Worked out by the database, binary, or too long to change here.</p> : numeric ? <input id={`record-field-${field.name}`} aria-label={field.name} className={control} inputMode="decimal" disabled={disabled || mode !== 'value'} value={values[field.name] ?? ''} onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} /> : <textarea id={`record-field-${field.name}`} aria-label={field.name} rows={3} className={`${control} resize-y`} disabled={disabled || mode !== 'value'} value={values[field.name] ?? ''} onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))} />}
          </div>;
        })}</div>}
      </div>
    </Modal>
    <ConfirmDialog isOpen={confirm !== null} title={confirm === 'delete' ? 'Delete this row?' : 'Discard your changes?'}
      message={confirm === 'delete' ? `The row is removed from ${table} for good, and the app sees it at once. Rows in other tables that depend on it may be deleted too, and the app’s delete automations run.` : 'What you changed in this row has not been saved, and is lost if you close it.'}
      variant="danger" confirmLabel={confirm === 'delete' ? 'Delete the row' : 'Discard changes'} isLoading={busy} onClose={() => { if (!busy) setConfirm(null); }} onConfirm={() => { if (confirm === 'delete') void save('delete'); else onClose(); }} />
  </>;
}
