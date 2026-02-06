import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, CheckCircle } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { api } from '../../lib/api';

export function AppFormView() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, createResponse, canSubmit } = useAppRuntimeStore();
  const [form, setForm] = useState<Record<string, unknown> | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (appSlug && formId) {
      setLoading(true);
      setFetchError(null);
      api.getAppForm(appSlug, formId).then((result) => {
        if (result.data?.form) {
          setForm(result.data.form as Record<string, unknown>);
        } else if (result.error) {
          setFetchError(result.error);
        }
        setLoading(false);
      }).catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load form');
        setLoading(false);
      });
    }
  }, [appSlug, formId]);

  if (!formId || !config) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" />
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

  if (!canSubmit(formId)) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">You don't have permission to submit responses to this form.</p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="text-center py-12 max-w-md mx-auto">
        <CheckCircle className="h-16 w-16 mx-auto app-text-primary mb-4" />
        <h2 className="text-xl font-semibold mb-2">Response Submitted</h2>
        <p className="text-gray-500 mb-6">Your response has been recorded successfully.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => { setSubmitted(false); setAnswers({}); }}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
            Submit Another
          </button>
          <button onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white app-btn-primary">
            View Responses
          </button>
        </div>
      </div>
    );
  }

  const fields = (form?.fields ?? []) as Array<{ id: string; type: string; label: string; required: boolean; placeholder?: string; description?: string; properties?: Record<string, unknown> }>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createResponse(formId, answers);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    }
    setSubmitting(false);
  };

  const runtimeForm = config.forms.find((f) => f.formId === formId);

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={() => navigate(`/app/${appSlug}`)} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 mb-4 text-sm">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <h1 className="text-xl font-bold mb-6">{runtimeForm?.displayName || 'Form'}</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {fields.map((field) => (
          <div key={field.id}>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {field.label}
              {field.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            {field.description && <p className="text-xs text-gray-500 mb-1">{field.description}</p>}

            {(field.type === 'short_text' || field.type === 'email' || field.type === 'phone' || field.type === 'url') && (
              <input
                type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'url' ? 'url' : 'text'}
                value={String(answers[field.id] ?? '')}
                onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                placeholder={field.placeholder}
                required={field.required}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            )}

            {field.type === 'long_text' && (
              <textarea
                value={String(answers[field.id] ?? '')}
                onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                placeholder={field.placeholder}
                required={field.required}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            )}

            {field.type === 'number' && (
              <input
                type="number"
                value={String(answers[field.id] ?? '')}
                onChange={(e) => {
                  const val = e.target.valueAsNumber;
                  setAnswers({ ...answers, [field.id]: isNaN(val) ? '' : val });
                }}
                placeholder={field.placeholder}
                required={field.required}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            )}

            {(field.type === 'date' || field.type === 'time' || field.type === 'datetime') && (
              <input
                type={field.type === 'datetime' ? 'datetime-local' : field.type}
                value={String(answers[field.id] ?? '')}
                onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                required={field.required}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            )}

            {(field.type === 'dropdown' || field.type === 'multiple_choice') && (
              <select
                value={String(answers[field.id] ?? '')}
                onChange={(e) => setAnswers({ ...answers, [field.id]: e.target.value })}
                required={field.required}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Select...</option>
                {((field.properties?.options as Array<{ value: string; label: string }>) ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            )}

            {field.type === 'checkboxes' && (
              <div className="space-y-2">
                {((field.properties?.options as Array<{ value: string; label: string }>) ?? []).map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={((answers[field.id] as string[]) ?? []).includes(opt.value)}
                      onChange={(e) => {
                        const current = (answers[field.id] as string[]) ?? [];
                        setAnswers({ ...answers, [field.id]: e.target.checked ? [...current, opt.value] : current.filter((v) => v !== opt.value) });
                      }}
                      className="rounded border-gray-300"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            )}

            {field.type === 'rating' && (
              <div className="flex gap-1">
                {Array.from({ length: (field.properties?.maxStars as number) ?? 5 }, (_, i) => (
                  <button key={i} type="button" onClick={() => setAnswers({ ...answers, [field.id]: i + 1 })}
                    className={`text-2xl ${(answers[field.id] as number) > i ? 'text-yellow-400' : 'text-gray-300'}`}>
                    ★
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

        <button type="submit" disabled={submitting}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium text-white app-btn-primary disabled:opacity-50">
          <Send className="h-4 w-4" />
          {submitting ? 'Submitting...' : 'Submit Response'}
        </button>
      </form>
    </div>
  );
}
