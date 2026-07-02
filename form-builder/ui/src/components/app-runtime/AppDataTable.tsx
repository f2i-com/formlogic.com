import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Trash2, Columns3, Download, Inbox, Lock, Plus } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { DataTable, type Column } from '../ui/DataTable';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn, parseServerDate } from '../../lib/utils';
import { api } from '../../lib/api';
import { guessRecordLabel, resolveLinkedDisplays } from '../../lib/recordLabel';
import { toast } from '../../stores/toastStore';

// Exclude non-data field types from columns
const EXCLUDED_FIELD_TYPES = new Set(['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload']);
const SERVER_PAGE = 10; // rows per page in server mode — small pages keep queries fast and pagination visible

/** Flatten answers + resolved linked-record display onto each row so columns can render/sort by key. */
function flattenResponses(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map((r) => {
    const flat: Record<string, unknown> = { ...r };
    const answers = r.answers as Record<string, unknown> | undefined;
    if (answers) {
      for (const [key, value] of Object.entries(answers)) flat[`answer_${key}`] = value;
    }
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
}

export function AppDataTable() {
  const { appSlug, formId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, fetchResponses, fetchResponsePage, deleteResponse, canSubmit, canDelete, canViewOwn, canViewAll, canExport } = useAppRuntimeStore();
  // Demo keeps a browser-local overlay of records, so it fetches everything and searches/paginates
  // client-side. Real apps use fast server-side pagination + search (limited rows per query).
  const serverMode = !api.isDemoMode();
  const [exporting, setExporting] = useState(false);
  const [responses, setResponses] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [colDropdownOpen, setColDropdownOpen] = useState(false);
  const colDropdownRef = useRef<HTMLDivElement>(null);

  // Debounce the search box so we fetch a few times/sec, not per keystroke (server mode).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  const fields = useMemo(() =>
    ((runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string; properties?: { options?: Array<{ value: string; label?: string }>; targetFormId?: string; displayFieldIds?: string[] } }>)
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop->local-state sync: reset column visibility when the viewed form (formId) changes externally
    setVisibleColumns(initial);
    // Reset paging + search when switching forms.
    setPage(0);
    setSearchInput('');
    setDebouncedSearch('');
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
    if (!formId || !config || !hasViewPermission) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: loading/error reset must be synchronous when deps change
    setLoading(true);
    setError(null);
    let cancelled = false;

    const run = async () => {
      if (serverMode) {
        // One limited page from the server, with server-side search across all rows.
        const { rows, total: t } = await fetchResponsePage(formId, {
          limit: SERVER_PAGE,
          offset: page * SERVER_PAGE,
          search: debouncedSearch || undefined,
          resolve: hasLinkedFields,
        });
        return { data: rows as Record<string, unknown>[], total: t };
      }
      // Demo: fetch every page (browser overlay is merged in), search/paginate client-side.
      const PAGE = 1000;
      const MAX_PAGES = 100; // 100k safety cap
      const all: Record<string, unknown>[] = [];
      for (let p = 0; p < MAX_PAGES; p++) {
        const batch = (await fetchResponses(formId, { resolve: hasLinkedFields, limit: PAGE, offset: p * PAGE })) as Record<string, unknown>[];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      return { data: all, total: all.length };
    };

    // Rows the server didn't resolve (demo-local submissions live only in this browser; the server
    // never sees them) get their linked-record displays resolved client-side from the target form's
    // records. No-permission targets stay unresolved — the renderer shows "Linked record", never a
    // raw id.
    const resolveMissingLinks = async (rows: Record<string, unknown>[]) => {
      const linked = fields.filter((f) => f.type === 'linked_record' && f.properties?.targetFormId);
      if (!linked.length || !appSlug || !config) return rows;
      const needed = new Map<string, Set<string>>();
      for (const r of rows) {
        const resolved = (r._resolved as Record<string, unknown> | undefined) || {};
        const answers = (r.answers as Record<string, unknown> | undefined) || {};
        for (const f of linked) {
          if (resolved[f.id]) continue;
          const v = answers[f.id];
          if (v == null || v === '') continue;
          const t = f.properties!.targetFormId!;
          let set = needed.get(t);
          if (!set) { set = new Set(); needed.set(t, set); }
          (Array.isArray(v) ? v : [v]).forEach((id) => { if (typeof id === 'string') set!.add(id); });
        }
      }
      if (!needed.size) return rows;
      const labelByTarget = new Map<string, Map<string, string>>();
      await Promise.all([...needed.keys()].map(async (t) => {
        try {
          const res = await api.getAppResponses(appSlug, t, { limit: 500 });
          const targetRows = ((res.data?.responses || []) as Array<{ id: string; answers?: Record<string, unknown> }>);
          const tFields = ((config.forms.find((x) => x.formId === t)?.fields || []) as Array<{ id: string; label?: string; type: string }>);
          const displayIds = linked.find((f) => f.properties?.targetFormId === t)?.properties?.displayFieldIds;
          const map = new Map<string, string>();
          for (const tr of targetRows) map.set(tr.id, guessRecordLabel(tFields, tr.answers || {}, displayIds));
          labelByTarget.set(t, map);
        } catch { /* target not viewable — leave unresolved */ }
      }));
      return resolveLinkedDisplays(rows, linked, labelByTarget);
    };

    run().then(async ({ data, total: t }) => {
      const withLinks = hasLinkedFields ? await resolveMissingLinks(data) : data;
      return { data: withLinks, total: t };
    }).then(({ data, total: t }) => {
      if (cancelled) return;
      setResponses(flattenResponses(data));
      setTotal(t);
      setLoading(false);
      setLoadedOnce(true);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load responses');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [formId, config, hasLinkedFields, hasViewPermission, fetchResponses, fetchResponsePage, reloadKey, serverMode, page, debouncedSearch, appSlug, fields]);

  const handleDelete = async () => {
    if (!formId || !deleteId) return;
    setDeleting(true);
    const success = await deleteResponse(formId, deleteId);
    if (success) {
      setResponses((prev) => prev.filter((r) => r.id !== deleteId));
      setTotal((t) => Math.max(0, t - 1));
      // Server mode: refetch so the page backfills from the next page and the count stays exact.
      if (serverMode) setReloadKey((k) => k + 1);
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
      // For linked_record fields, use resolved display values \u2014 and NEVER fall back to the raw
      // response id (a UUID in a data table reads as a bug and leaks nothing useful).
      if (field.type === 'linked_record') {
        const resolved = r._resolved as Record<string, unknown> | undefined;
        if (resolved?.[field.id]) {
          const resolvedVal = resolved[field.id] as { display?: string } | Array<{ display?: string }>;
          if (Array.isArray(resolvedVal)) {
            const joined = resolvedVal.map((rv) => rv.display || 'Linked record').join(', ');
            return joined.length > 50 ? joined.substring(0, 50) + '\u2026' : joined;
          }
          return (resolvedVal as { display?: string }).display || 'Linked record';
        }
        const answers = r.answers as Record<string, unknown> | undefined;
        const raw = answers?.[field.id];
        if (raw == null || raw === '') return '-';
        return <span className="text-gray-400 dark:text-slate-500 italic">Linked record</span>;
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

  const handleExport = async () => {
    if (!appSlug || !formId || exporting) return;
    setExporting(true);
    try {
      await api.exportAppResponses(appSlug, formId, runtimeForm?.displayName || 'form');
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : 'Could not export responses.');
    }
    setExporting(false);
  };

  // Only members granted the export_responses permission see the Export button (the
  // server re-checks it too).
  const exportButton = (formId && canExport(formId)) ? (
    <button
      type="button"
      onClick={handleExport}
      disabled={exporting || responses.length === 0}
      className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      aria-label="Export responses as CSV"
    >
      <Download className="h-4 w-4" />
      <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'Export'}</span>
    </button>
  ) : null;

  // Visible fields for mobile cards
  const columnVisibilityDropdown = (
    <div className="relative" ref={colDropdownRef}>
      <button
        onClick={() => setColDropdownOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
        aria-label="Toggle columns"
        aria-controls="col-vis-panel"
        aria-expanded={colDropdownOpen}
      >
        <Columns3 className="h-4 w-4" />
        <span className="hidden sm:inline">Columns</span>
      </button>
      {colDropdownOpen && (
        <div id="col-vis-panel" role="group" aria-label="Toggle columns" className="absolute right-0 top-full mt-1 z-50 w-56 max-h-72 overflow-y-auto bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl shadow-lg py-1">
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

  // History-aware back: return to wherever the user came from (records hub, dashboard, …);
  // fall back to the records hub on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/app/${appSlug}/records`);
  };

  const canSubmitThis = formId ? canSubmit(formId) : false;

  // No records at all (not a filtered-out search) — show a real empty state with a CTA
  // instead of an empty table. `!loading` avoids a flash while a refetch is in flight.
  const showEmpty = loadedOnce && !loading && !error && total === 0 && !searchInput && !debouncedSearch;

  if (formId && !canViewOwn(formId) && !canViewAll(formId)) {
    return (
      <div>
        <PageHeader
          title={runtimeForm?.displayName || 'Responses'}
          subtitle="Submitted records"
          onBack={goBack}
          backLabel="Back to records"
        />
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50">
          <EmptyState
            icon={Lock}
            title="No access to these records"
            description="You don't have permission to view responses for this form. Ask the app owner to grant you view access."
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={runtimeForm?.displayName || 'Responses'}
        subtitle={loadedOnce && !error
          ? <span className="tabular-nums">{total} {total === 1 ? 'record' : 'records'}</span>
          : 'Submitted records'}
        onBack={goBack}
        backLabel="Back to records"
      />

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
      ) : showEmpty ? (
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50">
          <EmptyState
            icon={Inbox}
            title="No records yet"
            description={canSubmitThis
              ? 'Submit the first record and it will show up here.'
              : 'Records submitted to this form will appear here.'}
            action={canSubmitThis ? (
              <button
                type="button"
                onClick={() => navigate(`/app/${appSlug}/form/${formId}`)}
                className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium cursor-pointer"
              >
                <Plus className="h-4 w-4" /> Submit the first record
              </button>
            ) : undefined}
          />
        </div>
      ) : (
        /* The shared DataTable fits columns to the available width and collapses to
           stacked cards on narrow screens, so no separate mobile layout is needed.
           Server mode: paging + search are controlled here and run against the backend.
           isLoading renders the table's own layout-mirroring shimmer rows (initial load
           included); the true zero-records case is handled by the EmptyState above, so
           the in-table empty message only appears for searches with no matches. */
        <DataTable
          data={responses}
          columns={columns}
          searchable
          searchPlaceholder="Search records…"
          pageSize={SERVER_PAGE}
          totalCount={total}
          isLoading={loading}
          emptyMessage="No records match your search"
          serverMode={serverMode}
          page={serverMode ? page : undefined}
          onPageChange={serverMode ? setPage : undefined}
          searchValue={serverMode ? searchInput : undefined}
          onSearchChange={serverMode ? ((v) => { setSearchInput(v); setPage(0); }) : undefined}
          searchBarExtra={<>{exportButton}{columnVisibilityDropdown}</>}
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
