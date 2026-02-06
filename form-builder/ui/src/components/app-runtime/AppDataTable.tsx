import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { DataTable, type Column } from '../ui/DataTable';

export function AppDataTable() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, fetchResponses, deleteResponse, canDelete, canViewOwn, canViewAll } = useAppRuntimeStore();
  const [responses, setResponses] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const fields = (runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string }>;

  useEffect(() => {
    if (formId) {
      setLoading(true);
      setError(null);
      fetchResponses(formId).then((data) => {
        const flattenedData = (data as Record<string, unknown>[]).map((r: Record<string, unknown>) => {
          const flat: Record<string, unknown> = { ...r };
          const answers = r.answers as Record<string, unknown> | undefined;
          if (answers) {
            for (const [key, value] of Object.entries(answers)) {
              flat[`answer_${key}`] = value;
            }
          }
          return flat;
        });
        setResponses(flattenedData);
        setLoading(false);
      }).catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load responses');
        setLoading(false);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  const handleDelete = async (responseId: string) => {
    if (!formId || !confirm('Delete this response?')) return;
    const success = await deleteResponse(formId, responseId);
    if (success) {
      setResponses(responses.filter((r) => r.id !== responseId));
    }
  };

  // Build columns from form fields
  const columns: Column<Record<string, unknown>>[] = [
    { key: 'submittedAt', label: 'Submitted', sortable: true, render: (r) => {
      const date = r.submittedAt as string;
      return date ? new Date(date).toLocaleString() : '-';
    }},
    ...fields.slice(0, 4).map((field) => ({
      key: `answer_${field.id}`,
      label: field.label,
      sortable: true,
      render: (r: Record<string, unknown>) => {
        const answers = r.answers as Record<string, unknown> | undefined;
        const val = answers?.[field.id];
        if (val == null) return '-';
        if (Array.isArray(val)) return val.join(', ');
        return String(val).substring(0, 50);
      },
    })),
    { key: 'status', label: 'Status', sortable: true },
  ];

  if (formId && !canViewOwn(formId) && !canViewAll(formId)) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">You don't have permission to view responses for this form.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => navigate(`/app/${appSlug}`)} className="text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-xl font-bold flex-1">{runtimeForm?.displayName || 'Responses'}</h1>
        <span className="text-sm text-gray-500">{responses.length} responses</span>
      </div>

      {error ? (
        <div className="text-center py-12">
          <p className="text-red-600">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <DataTable
              data={responses}
              columns={columns}
              searchable
              pageSize={15}
              onRowClick={(r) => navigate(`/app/${appSlug}/form/${formId}/responses/${r.id}`)}
              actions={formId && canDelete(formId) ? (r) => (
                <button onClick={(e) => { e.stopPropagation(); handleDelete(String(r.id)); }}
                  className="p-1 text-gray-400 hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : undefined}
            />
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-3">
            {responses.length === 0 ? (
              <p className="text-center text-gray-400 py-8">No responses yet</p>
            ) : (
              responses.map((r) => (
                <div
                  key={String(r.id)}
                  onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses/${r.id}`)}
                  className="bg-white rounded-lg border border-gray-200 p-4 active:bg-gray-50"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">
                      {r.submittedAt ? new Date(String(r.submittedAt)).toLocaleString() : '-'}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{String(r.status)}</span>
                  </div>
                  {fields.slice(0, 3).map((field) => {
                    const answers = r.answers as Record<string, unknown> | undefined;
                    const val = answers?.[field.id];
                    if (val == null) return null;
                    return (
                      <div key={field.id} className="text-sm mb-1">
                        <span className="text-gray-400">{field.label}: </span>
                        <span className="text-gray-700">{Array.isArray(val) ? val.join(', ') : String(val).substring(0, 60)}</span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
