import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, Clock, CheckCircle2, Pencil, X, Link2, AlertTriangle } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { LinkedRecordInput } from './LinkedRecordInput';
import { RelatedRecordsPanel } from './RelatedRecordsPanel';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

export function AppResponseDetail() {
  const { appSlug, formId, responseId } = useParams();
  const navigate = useNavigate();
  const { config, canEdit, canDelete, canViewOwn, canViewAll, updateResponse, deleteResponse } = useAppRuntimeStore();
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [editedAnswers, setEditedAnswers] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const fields = (runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string; properties?: Record<string, unknown> }>;
  const hasLinkedFields = fields.some((f) => f.type === 'linked_record');

  useEffect(() => {
    if (appSlug && formId && responseId && config) {
      setLoading(true);
      setFetchError(null);
      let cancelled = false;
      const fetchFn = hasLinkedFields
        ? api.getAppResponseByIdResolved(appSlug, formId, responseId)
        : api.getAppResponseById(appSlug, formId, responseId);
      fetchFn.then((result) => {
        if (cancelled) return;
        if (result.data?.response) {
          const r = result.data.response as Record<string, unknown>;
          setResponse(r);
          setEditedAnswers((r.answers as Record<string, unknown>) ?? {});
        } else if (result.error) {
          setFetchError(result.error);
        }
        setLoading(false);
      }).catch((err) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : 'Failed to load response');
        setLoading(false);
      });
      return () => { cancelled = true; };
    }
  }, [appSlug, formId, responseId, config, hasLinkedFields]);

  if (formId && !canViewOwn(formId) && !canViewAll(formId)) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <p className="text-gray-500 dark:text-slate-400">You don&apos;t have permission to view this response.</p>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-center">
          <p className="text-red-600 dark:text-red-400 mb-4">{fetchError}</p>
          <button onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)} className="text-sm app-text-primary hover:underline">
            Back to Responses
          </button>
        </div>
      </div>
    );
  }

  if (loading || !response || !formId) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading response" />
      </div>
    );
  }

  const handleSave = async () => {
    if (!formId || !responseId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateResponse(formId, responseId, { answers: editedAnswers });
      setResponse((prev) => prev ? { ...prev, answers: editedAnswers } : prev);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!formId || !responseId) return;
    setDeleting(true);
    try {
      const success = await deleteResponse(formId, responseId);
      setDeleting(false);
      if (success) {
        setShowDeleteConfirm(false);
        navigate(`/app/${appSlug}/form/${formId}/responses`);
      } else {
        setShowDeleteConfirm(false);
      }
    } catch {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const answers = (editing ? editedAnswers : (response.answers as Record<string, unknown>)) ?? {};
  const status = String(response.status ?? 'submitted');

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)}
          aria-label="Back to responses"
          className="p-2.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">{runtimeForm?.displayName || 'Response'}</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit(formId) && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200/80 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-300 transition-all duration-200 cursor-pointer"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={() => { setEditing(false); setEditedAnswers((response.answers as Record<string, unknown>) ?? {}); setSaveError(null); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200/80 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-300 transition-all duration-200 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded-lg app-btn-primary disabled:opacity-50 transition-all duration-200 cursor-pointer"
              >
                <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
          {canDelete(formId) && !editing && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              aria-label="Delete response"
              className="p-2.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-4 py-3 rounded-lg mb-4 border border-red-100 dark:border-red-500/20">
          <span>{saveError}</span>
          <button type="button" onClick={() => setSaveError(null)} aria-label="Dismiss error" className="ml-2 text-red-400 hover:text-red-600 dark:hover:text-red-300 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Metadata card */}
      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4 mb-4 flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-5 text-sm">
        <div className="flex items-center gap-2 text-gray-500 dark:text-slate-400">
          <Clock className="h-4 w-4 flex-shrink-0" />
          {response.submittedAt ? new Date(String(response.submittedAt)).toLocaleString() : '-'}
        </div>
        <div className="flex items-center gap-2">
          <CheckCircle2 className={cn('h-4 w-4 flex-shrink-0', status === 'submitted' ? 'text-green-500' : 'text-gray-400 dark:text-slate-500')} />
          <span className={cn(
            'px-2.5 py-0.5 rounded-full text-xs font-medium',
            status === 'submitted' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
          )}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </span>
        </div>
      </div>

      {/* Answers */}
      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 divide-y divide-gray-100 dark:divide-slate-700/40">
        {fields.map((field) => {
          const isLinked = field.type === 'linked_record';
          const resolved = response._resolved as Record<string, unknown> | undefined;
          const targetFormId = field.properties?.targetFormId as string | undefined;

          return (
            <div key={field.id} className="px-5 py-4">
              <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 mb-1.5">
                {isLinked && <Link2 className="inline h-3 w-3 mr-1" />}
                {field.label}
              </label>
              {editing && !isLinked ? (
                (() => {
                  const editInputClass = "w-full px-3.5 py-2.5 border border-gray-200 dark:border-slate-600 rounded-xl text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200";
                  const editVal = editedAnswers[field.id];

                  if (field.type === 'number') {
                    return (
                      <input
                        type="number"
                        step="any"
                        value={editVal != null ? String(editVal) : ''}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setEditedAnswers({ ...editedAnswers, [field.id]: isNaN(v) ? undefined : v });
                        }}
                        className={editInputClass}
                      />
                    );
                  }
                  if (field.type === 'date') {
                    return <input type="date" value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass} />;
                  }
                  if (field.type === 'time') {
                    return <input type="time" value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass} />;
                  }
                  if (field.type === 'datetime') {
                    return <input type="datetime-local" value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass} />;
                  }
                  if (field.type === 'long_text') {
                    return <textarea value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} rows={4} className={cn(editInputClass, 'resize-none')} />;
                  }
                  if (field.type === 'dropdown') {
                    const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
                    return (
                      <select value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass}>
                        <option value="">Select...</option>
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    );
                  }
                  if (field.type === 'multiple_choice') {
                    const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
                    return (
                      <div className="space-y-1.5">
                        {options.map((o) => (
                          <label key={o.value} className="flex items-center gap-2 text-sm text-gray-900 dark:text-slate-200 cursor-pointer">
                            <input type="radio" name={field.id} checked={editVal === o.value} onChange={() => setEditedAnswers({ ...editedAnswers, [field.id]: o.value })} className="accent-primary-500" />
                            {o.label}
                          </label>
                        ))}
                      </div>
                    );
                  }
                  if (field.type === 'checkboxes') {
                    const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
                    const selected = Array.isArray(editVal) ? (editVal as string[]) : [];
                    return (
                      <div className="space-y-1.5">
                        {options.map((o) => (
                          <label key={o.value} className="flex items-center gap-2 text-sm text-gray-900 dark:text-slate-200 cursor-pointer">
                            <input type="checkbox" checked={selected.includes(o.value)} onChange={(e) => {
                              const newVals = e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value);
                              setEditedAnswers({ ...editedAnswers, [field.id]: newVals });
                            }} className="accent-primary-500" />
                            {o.label}
                          </label>
                        ))}
                      </div>
                    );
                  }
                  // Default: text input for short_text, email, phone, url, etc.
                  return (
                    <input
                      type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'url' ? 'url' : 'text'}
                      value={String(editVal ?? '')}
                      onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })}
                      className={editInputClass}
                    />
                  );
                })()
              ) : editing && isLinked ? (
                (() => {
                  const linkedTargetFormId = field.properties?.targetFormId as string | undefined;
                  const displayFieldIds = field.properties?.displayFieldIds as string[] | undefined;
                  const searchFieldIds = field.properties?.searchFieldIds as string[] | undefined;
                  const allowMultiple = field.properties?.allowMultiple as boolean | undefined;
                  if (!linkedTargetFormId || !formId) {
                    return <p className="text-sm text-gray-400 dark:text-slate-500 italic">Linked record field not configured</p>;
                  }
                  return (
                    <LinkedRecordInput
                      formId={formId}
                      targetFormId={linkedTargetFormId}
                      displayFieldIds={displayFieldIds}
                      searchFieldIds={searchFieldIds}
                      allowMultiple={allowMultiple}
                      value={editedAnswers[field.id]}
                      onChange={(val) => setEditedAnswers({ ...editedAnswers, [field.id]: val })}
                      primaryColor="var(--app-primary, #6366f1)"
                    />
                  );
                })()
              ) : isLinked && resolved?.[field.id] ? (
                <div className="text-sm">
                  {(() => {
                    const rv = resolved[field.id] as { id?: string; display?: string } | Array<{ id?: string; display?: string }>;
                    const items = Array.isArray(rv) ? rv : [rv];

                    const renderLinkedItem = (item: { id?: string; display?: string }) => {
                      const isBroken = !item.display || item.display === 'Record not found';
                      if (isBroken) {
                        return (
                          <span
                            key={item.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Record not found
                          </span>
                        );
                      }
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => targetFormId && navigate(`/app/${appSlug}/form/${targetFormId}/responses/${item.id}`)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors cursor-pointer"
                        >
                          <Link2 className="h-3 w-3" />
                          {item.display}
                        </button>
                      );
                    };

                    return (
                      <div className="flex flex-wrap gap-2">
                        {items.map((item) => renderLinkedItem(item))}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="text-sm text-gray-800 dark:text-slate-200">
                  {answers[field.id] != null
                    ? (() => {
                        const val = answers[field.id];
                        // Boolean yes/no chip
                        if (val === 'yes' || val === 'no') {
                          return (
                            <span className={cn(
                              'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                              val === 'yes' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
                            )}>
                              {val === 'yes' ? 'Yes' : 'No'}
                            </span>
                          );
                        }
                        // Date formatting
                        if (field.type === 'date' && typeof val === 'string' && val) {
                          try { return new Date(val + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return String(val); }
                        }
                        // Time formatting
                        if (field.type === 'time' && typeof val === 'string' && val) {
                          try {
                            const [h, m] = val.split(':').map(Number);
                            return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                          } catch { return String(val); }
                        }
                        // Datetime formatting
                        if (field.type === 'datetime' && typeof val === 'string' && val) {
                          try { return new Date(val).toLocaleString(); } catch { return String(val); }
                        }
                        // Long text: preserve whitespace
                        if (field.type === 'long_text' && typeof val === 'string') {
                          return <span className="whitespace-pre-wrap">{val}</span>;
                        }
                        // Arrays (checkboxes, etc.)
                        if (Array.isArray(val)) return (val as unknown[]).join(', ');
                        return String(val);
                      })()
                    : <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Related records (inverse relations) */}
      {appSlug && formId && responseId && !editing && (
        <RelatedRecordsPanel
          appSlug={appSlug}
          formId={formId}
          responseId={responseId}
        />
      )}

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Response"
        message="Are you sure you want to delete this response? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleting}
      />
    </div>
  );
}
