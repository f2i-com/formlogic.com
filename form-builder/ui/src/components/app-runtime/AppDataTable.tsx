import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2, ChevronRight, ChevronLeft, Inbox } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { DataTable, type Column } from '../ui/DataTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn } from '../../lib/utils';

const MOBILE_PAGE_SIZE = 15;

function MobileCardList({
  responses,
  fields,
  appSlug,
  formId,
  navigate,
}: {
  responses: Record<string, unknown>[];
  fields: Array<{ id: string; label: string; type: string }>;
  appSlug?: string;
  formId?: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.ceil(responses.length / MOBILE_PAGE_SIZE);
  const paged = useMemo(() => {
    const start = (page - 1) * MOBILE_PAGE_SIZE;
    return responses.slice(start, start + MOBILE_PAGE_SIZE);
  }, [responses, page]);

  if (responses.length === 0) {
    return (
      <div className="md:hidden text-center py-16">
        <Inbox className="h-10 w-10 mx-auto text-gray-400 dark:text-slate-500 mb-3" />
        <p className="text-gray-500 dark:text-slate-400 text-sm">No responses yet</p>
      </div>
    );
  }

  return (
    <div className="md:hidden space-y-2">
      {paged.map((r) => {
        const status = String(r.status ?? 'submitted');
        return (
          <button
            key={String(r.id)}
            onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses/${r.id}`)}
            className="w-full text-left bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-4 active:bg-gray-50 dark:active:bg-slate-800 cursor-pointer transition-all duration-200 hover:shadow-md hover:shadow-gray-900/[0.04] dark:hover:shadow-black/10 hover:border-gray-300 dark:hover:border-slate-600 group"
          >
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs text-gray-400 dark:text-slate-500">
                {r.submittedAt ? new Date(String(r.submittedAt)).toLocaleString() : '-'}
              </span>
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-xs px-2 py-0.5 rounded-full font-medium',
                  status === 'submitted' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
                )}>
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
                <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500 transition-colors" />
              </div>
            </div>
            {fields.slice(0, 3).map((field) => {
              if (field.type === 'linked_record') {
                const resolved = r._resolved as Record<string, unknown> | undefined;
                const rv = resolved?.[field.id] as { display?: string } | Array<{ display?: string }> | undefined;
                if (!rv) return null;
                const displayText = Array.isArray(rv)
                  ? rv.map((v) => v.display || '?').join(', ')
                  : (rv as { display?: string }).display;
                if (!displayText) return null;
                return (
                  <div key={field.id} className="text-sm mb-1 last:mb-0">
                    <span className="text-gray-400 dark:text-slate-500">{field.label}: </span>
                    <span className="text-gray-700 dark:text-slate-300">{displayText.length > 60 ? displayText.substring(0, 60) + '\u2026' : displayText}</span>
                  </div>
                );
              }
              const answers = r.answers as Record<string, unknown> | undefined;
              const val = answers?.[field.id];
              if (val == null) return null;
              const display = Array.isArray(val) ? val.join(', ') : String(val);
              return (
                <div key={field.id} className="text-sm mb-1 last:mb-0">
                  <span className="text-gray-400 dark:text-slate-500">{field.label}: </span>
                  <span className="text-gray-700 dark:text-slate-300">{display.length > 60 ? display.substring(0, 60) + '\u2026' : display}</span>
                </div>
              );
            })}
          </button>
        );
      })}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="p-2.5 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-gray-500 dark:text-slate-400">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="p-2.5 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export function AppDataTable() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, fetchResponses, deleteResponse, canDelete, canViewOwn, canViewAll } = useAppRuntimeStore();
  const [responses, setResponses] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const fields = (runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string }>;

  // Check if form has any linked_record fields
  const hasLinkedFields = fields.some((f) => f.type === 'linked_record');

  useEffect(() => {
    if (formId && config) {
      setLoading(true);
      setError(null);
      fetchResponses(formId, { resolve: hasLinkedFields }).then((data) => {
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
  }, [formId, config, hasLinkedFields, fetchResponses]);

  const handleDelete = async () => {
    if (!formId || !deleteId) return;
    setDeleting(true);
    const success = await deleteResponse(formId, deleteId);
    if (success) {
      setResponses(responses.filter((r) => r.id !== deleteId));
    }
    setDeleting(false);
    setDeleteId(null);
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
        // For linked_record fields, use resolved display values
        if (field.type === 'linked_record') {
          const resolved = r._resolved as Record<string, unknown> | undefined;
          if (resolved?.[field.id]) {
            const resolvedVal = resolved[field.id] as { display?: string } | Array<{ display?: string }>;
            if (Array.isArray(resolvedVal)) {
              const joined = resolvedVal.map((rv) => rv.display || '?').join(', ');
              return joined.length > 50 ? joined.substring(0, 50) + '\u2026' : joined;
            }
            return (resolvedVal as { display?: string }).display || '-';
          }
        }
        const answers = r.answers as Record<string, unknown> | undefined;
        const val = answers?.[field.id];
        if (val == null) return '-';
        if (Array.isArray(val)) {
          const joined = val.join(', ');
          return joined.length > 50 ? joined.substring(0, 50) + '\u2026' : joined;
        }
        const str = String(val);
        return str.length > 50 ? str.substring(0, 50) + '\u2026' : str;
      },
    })),
    { key: 'status', label: 'Status', sortable: true, render: (r) => {
      const s = String(r.status ?? 'submitted');
      return (
        <span className={cn(
          'px-2 py-0.5 rounded-full text-xs font-medium',
          s === 'submitted' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
        )}>
          {s.charAt(0).toUpperCase() + s.slice(1)}
        </span>
      );
    }},
  ];

  if (formId && !canViewOwn(formId) && !canViewAll(formId)) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-slate-400">You don&apos;t have permission to view responses for this form.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(`/app/${appSlug}`)}
          aria-label="Back to dashboard"
          className="p-2.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">{runtimeForm?.displayName || 'Responses'}</h1>
        </div>
        <span className="text-sm font-medium text-gray-400 dark:text-slate-500 tabular-nums">
          {responses.length} {responses.length === 1 ? 'response' : 'responses'}
        </span>
      </div>

      {error ? (
        <div className="text-center py-12">
          <p className="text-red-600 dark:text-red-400">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading responses" />
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
                <button
                  onClick={(e) => { e.stopPropagation(); setDeleteId(String(r.id)); }}
                  aria-label="Delete response"
                  className="p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : undefined}
            />
          </div>

          {/* Mobile card layout */}
          <MobileCardList
            responses={responses}
            fields={fields}
            appSlug={appSlug}
            formId={formId}
            navigate={navigate}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={deleteId !== null}
        onClose={() => setDeleteId(null)}
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
