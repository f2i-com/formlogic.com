import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, Clock, CheckCircle2, Pencil, X } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
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

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const fields = (runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string }>;

  useEffect(() => {
    if (appSlug && formId && responseId) {
      setLoading(true);
      setFetchError(null);
      api.getAppResponseById(appSlug, formId, responseId).then((result) => {
        if (result.data?.response) {
          const r = result.data.response as Record<string, unknown>;
          setResponse(r);
          setEditedAnswers((r.answers as Record<string, unknown>) ?? {});
        } else if (result.error) {
          setFetchError(result.error);
        }
        setLoading(false);
      }).catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load response');
        setLoading(false);
      });
    }
  }, [appSlug, formId, responseId]);

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
      setResponse({ ...response, answers: editedAnswers });
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!formId || !responseId) return;
    const success = await deleteResponse(formId, responseId);
    if (success) navigate(`/app/${appSlug}/form/${formId}/responses`);
    setShowDeleteConfirm(false);
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
          className="p-1.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{runtimeForm?.displayName || 'Response'}</h1>
        </div>
        <div className="flex items-center gap-2">
          {canEdit(formId) && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-300 transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={() => { setEditing(false); setEditedAnswers((response.answers as Record<string, unknown>) ?? {}); setSaveError(null); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-300 transition-colors"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded-lg app-btn-primary disabled:opacity-50 transition-colors"
              >
                <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
          {canDelete(formId) && !editing && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              aria-label="Delete response"
              className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-4 py-3 rounded-lg mb-4 border border-red-100 dark:border-red-500/20">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="ml-2 text-red-400 hover:text-red-600 dark:hover:text-red-300">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Metadata card */}
      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 p-4 mb-4 flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-5 text-sm">
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
      <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 divide-y divide-gray-200 dark:divide-slate-700/50">
        {fields.map((field) => (
          <div key={field.id} className="px-5 py-4">
            <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 mb-1.5">
              {field.label}
            </label>
            {editing ? (
              <input
                type="text"
                value={String(editedAnswers[field.id] ?? '')}
                onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-colors"
              />
            ) : (
              <div className="text-sm text-gray-800 dark:text-slate-200">
                {answers[field.id] != null
                  ? (Array.isArray(answers[field.id]) ? (answers[field.id] as unknown[]).join(', ') : String(answers[field.id]))
                  : <span className="text-gray-300 dark:text-slate-600 italic">No answer</span>
                }
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Response"
        message="Are you sure you want to delete this response? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
