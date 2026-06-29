import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2, Columns3 } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { DataTable, type Column } from '../ui/DataTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn, parseServerDate } from '../../lib/utils';

// Exclude non-data field types from columns
const EXCLUDED_FIELD_TYPES = new Set(['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload']);

export function AppDataTable() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const { config, fetchResponses, deleteResponse, canDelete, canViewOwn, canViewAll } = useAppRuntimeStore();
  const [responses, setResponses] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [colDropdownOpen, setColDropdownOpen] = useState(false);
  const colDropdownRef = useRef<HTMLDivElement>(null);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const fields = useMemo(() =>
    ((runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string; properties?: { options?: Array<{ value: string; label?: string }> } }>)
      .filter((f) => !EXCLUDED_FIELD_TYPES.has(f.type)),
    [runtimeForm?.fields]
  );

  // Column visibility: default to first 6 fields
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    const initial = new Set<string>(['submittedAt', 'status']);
    fields.slice(0, 6).forEach((f) => initial.add(f.id));
    return initial;
  });

  // Re-initialize visible columns when fields change (different form)
  useEffect(() => {
    const initial = new Set<string>(['submittedAt', 'status']);
    fields.slice(0, 6).forEach((f) => initial.add(f.id));
    setVisibleColumns(initial);
  }, [formId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown on click outside or Escape (keyboard-dismissible)
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (colDropdownRef.current && !colDropdownRef.current.contains(e.target as Node)) {
        setColDropdownOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setColDropdownOpen(false);
    }
    if (colDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [colDropdownOpen]);

  // Check if form has any linked_record fields
  const hasLinkedFields = fields.some((f) => f.type === 'linked_record');

  const hasViewPermission = formId ? (canViewOwn(formId) || canViewAll(formId)) : false;

  useEffect(() => {
    if (formId && config && hasViewPermission) {
      setLoading(true);
      setError(null);
      let cancelled = false;
      // Fetch ALL pages — the API caps each page (default 100), which would
      // otherwise silently hide records beyond the first page and misreport the
      // total count. Loop until a short page is returned.
      const loadAll = async () => {
        const PAGE = 1000;
        const MAX_PAGES = 100; // 100k safety cap
        const all: Record<string, unknown>[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const batch = (await fetchResponses(formId, {
            resolve: hasLinkedFields,
            limit: PAGE,
            offset: page * PAGE,
          })) as Record<string, unknown>[];
          all.push(...batch);
          if (batch.length < PAGE) break;
        }
        return all;
      };
      loadAll().then((data) => {
        if (cancelled) return;
        const flattenedData = data.map((r: Record<string, unknown>) => {
          const flat: Record<string, unknown> = { ...r };
          const answers = r.answers as Record<string, unknown> | undefined;
          if (answers) {
            for (const [key, value] of Object.entries(answers)) {
              flat[`answer_${key}`] = value;
            }
          }
          // Make linked_record columns searchable/sortable by their resolved
          // display text (the column renders from _resolved, not answer_*).
          const resolved = r._resolved as Record<string, unknown> | undefined;
          if (resolved) {
            for (const [fieldId, rv] of Object.entries(resolved)) {
              flat[`answer_${fieldId}`] = Array.isArray(rv)
                ? (rv as Array<{ display?: string }>).map((v) => v.display || '').join(', ')
                : ((rv as { display?: string })?.display || '');
            }
          }
          return flat;
        });
        setResponses(flattenedData);
        setLoading(false);
      }).catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load responses');
        setLoading(false);
      });
      return () => { cancelled = true; };
    }
  }, [formId, config, hasLinkedFields, hasViewPermission, fetchResponses, reloadKey]);

  const handleDelete = async () => {
    if (!formId || !deleteId) return;
    setDeleting(true);
    const success = await deleteResponse(formId, deleteId);
    if (success) {
      setResponses((prev) => prev.filter((r) => r.id !== deleteId));
    }
    setDeleting(false);
    setDeleteId(null);
  };

  const toggleColumn = (id: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Build ALL columns from form fields (no slice)
  const allFieldColumns: Column<Record<string, unknown>>[] = fields.map((field) => ({
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
      // Date/time locale formatting
      if (typeof val === 'string' && val) {
        if (field.type === 'date') {
          try { return new Date(val + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { /* fall through */ }
        } else if (field.type === 'time') {
          try { const [h, m] = val.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch { /* fall through */ }
        } else if (field.type === 'datetime') {
          try { return new Date(val).toLocaleString(); } catch { /* fall through */ }
        }
      }
      if (field.type === 'file_upload' && Array.isArray(val)) {
        const names = val.map((f: unknown) => (f && typeof f === 'object' && 'originalFilename' in f) ? (f as Record<string, unknown>).originalFilename : 'File').join(', ');
        return names.length > 50 ? names.substring(0, 50) + '\u2026' : names;
      }
      if (field.type === 'location' && val && typeof val === 'object' && 'latitude' in val) {
        const loc = val as Record<string, number>;
        return `${loc.latitude?.toFixed(4)}, ${loc.longitude?.toFixed(4)}`;
      }
      if (['dropdown', 'multiple_choice', 'checkboxes'].includes(field.type)) {
        const opts = (field.properties?.options ?? []) as Array<{ value: string; label?: string }>;
        const labelFor = (v: unknown) => opts.find((o) => o.value === v)?.label ?? String(v);
        const out = Array.isArray(val) ? val.map(labelFor).join(', ') : labelFor(val);
        return out.length > 50 ? out.substring(0, 50) + '\u2026' : out;
      }
      if (Array.isArray(val)) {
        const joined = val.map((v: unknown) => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join(', ');
        return joined.length > 50 ? joined.substring(0, 50) + '\u2026' : joined;
      }
      if (typeof val === 'object' && val !== null) {
        return JSON.stringify(val).substring(0, 50);
      }
      const str = String(val);
      return str.length > 50 ? str.substring(0, 50) + '\u2026' : str;
    },
  }));

  const submittedAtCol: Column<Record<string, unknown>> = {
    key: 'submittedAt', label: 'Submitted', sortable: true, render: (r) => {
      const date = r.submittedAt as string;
      // parseServerDate normalizes the offset-less UTC string; raw new Date() would
      // parse it in the viewer's local zone and show the wrong time (cf. line 57).
      return date ? parseServerDate(date).toLocaleString() : '-';
    },
  };

  const statusCol: Column<Record<string, unknown>> = {
    key: 'status', label: 'Status', sortable: true, render: (r) => {
      const s = String(r.status ?? 'submitted');
      return (
        <span className={cn(
          'px-2 py-0.5 rounded-full text-xs font-medium',
          s === 'submitted' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
        )}>
          {s.charAt(0).toUpperCase() + s.slice(1)}
        </span>
      );
    },
  };

  // Filter columns by visibility
  const columns: Column<Record<string, unknown>>[] = [
    ...(visibleColumns.has('submittedAt') ? [submittedAtCol] : []),
    ...allFieldColumns.filter((col) => {
      const fieldId = col.key.replace('answer_', '');
      return visibleColumns.has(fieldId);
    }),
    ...(visibleColumns.has('status') ? [statusCol] : []),
  ];

  // Visible fields for mobile cards
  const columnVisibilityDropdown = (
    <div className="relative" ref={colDropdownRef}>
      <button
        onClick={() => setColDropdownOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
        aria-label="Toggle columns"
        aria-haspopup="true"
        aria-expanded={colDropdownOpen}
      >
        <Columns3 className="h-4 w-4" />
        <span className="hidden sm:inline">Columns</span>
      </button>
      {colDropdownOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 max-h-72 overflow-y-auto bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl shadow-lg py-1">
          {/* Fixed columns */}
          <label className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-700 cursor-pointer">
            <input type="checkbox" checked={visibleColumns.has('submittedAt')} onChange={() => toggleColumn('submittedAt')} className="app-accent rounded" />
            <span className="text-gray-700 dark:text-slate-300">Submitted</span>
          </label>
          {fields.map((f) => (
            <label key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-700 cursor-pointer">
              <input type="checkbox" checked={visibleColumns.has(f.id)} onChange={() => toggleColumn(f.id)} className="app-accent rounded" />
              <span className="text-gray-700 dark:text-slate-300 truncate">{f.label}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-700 cursor-pointer">
            <input type="checkbox" checked={visibleColumns.has('status')} onChange={() => toggleColumn('status')} className="app-accent rounded" />
            <span className="text-gray-700 dark:text-slate-300">Status</span>
          </label>
        </div>
      )}
    </div>
  );

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
        {!loading && !error && (
          <span className={cn(
            'text-xs font-medium px-2.5 py-1 rounded-full tabular-nums',
            'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
          )}>
            {responses.length} {responses.length === 1 ? 'response' : 'responses'}
          </span>
        )}
      </div>

      {error ? (
        <div className="text-center py-12" role="alert">
          <p className="text-red-600 dark:text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => { setError(null); setLoading(true); setReloadKey((k) => k + 1); }}
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium app-text-primary hover:opacity-80 cursor-pointer"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading responses" />
        </div>
      ) : (
        /* The shared DataTable fits columns to the available width and collapses to
           stacked cards on narrow screens, so no separate mobile layout is needed. */
        <DataTable
          data={responses}
          columns={columns}
          searchable
          pageSize={15}
          totalCount={responses.length}
          emptyMessage="No responses yet"
          searchBarExtra={columnVisibilityDropdown}
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
