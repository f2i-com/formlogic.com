import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { api } from '../../lib/api';

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
      <div className="text-center py-12">
        <p className="text-gray-500">You don't have permission to view this response.</p>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{fetchError}</p>
      </div>
    );
  }

  if (loading || !response || !formId) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" /></div>;
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
    if (!formId || !responseId || !confirm('Delete this response?')) return;
    const success = await deleteResponse(formId, responseId);
    if (success) navigate(`/app/${appSlug}/form/${formId}/responses`);
  };

  const answers = (editing ? editedAnswers : (response.answers as Record<string, unknown>)) ?? {};

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)} className="text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-xl font-bold flex-1">Response Detail</h1>
        <div className="flex gap-2">
          {canEdit(formId) && !editing && (
            <button onClick={() => setEditing(true)} className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Edit</button>
          )}
          {editing && (
            <>
              <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 text-sm text-white rounded-lg app-btn-primary disabled:opacity-50">
                <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
          {canDelete(formId) && (
            <button onClick={handleDelete} className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {saveError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-4">{saveError}</p>}

      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        <div className="px-4 py-3 text-sm text-gray-500">
          Submitted: {response.submittedAt ? new Date(String(response.submittedAt)).toLocaleString() : '-'}
          <span className="ml-4">Status: {String(response.status)}</span>
        </div>

        {fields.map((field) => (
          <div key={field.id} className="px-4 py-3">
            <label className="block text-xs font-medium text-gray-400 mb-1">{field.label}</label>
            {editing ? (
              <input
                type="text"
                value={String(editedAnswers[field.id] ?? '')}
                onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })}
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
              />
            ) : (
              <div className="text-sm text-gray-800">
                {answers[field.id] != null
                  ? (Array.isArray(answers[field.id]) ? (answers[field.id] as unknown[]).join(', ') : String(answers[field.id]))
                  : <span className="text-gray-300">-</span>
                }
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
