import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  Search,
  Trash2,
  Eye,
  Edit2,
  Download,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Calendar,
  Database,
  FileJson,
  Filter,
  Inbox,
  Loader2,
  Share2,
  Users,
  CalendarDays,
  Timer,
  Upload,
  RefreshCw,
  Link2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Modal } from '../components/ui/Modal';
import { Skeleton, ListRowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { api, resolveFileUrl } from '../lib/api';
import { useFittedColumns } from '../hooks/useFittedColumns';
import { toast } from '../stores/toastStore';
import { cn, sanitizeFilename, statusBadgeVariant, formatStatusLabel, parseServerDate } from '../lib/utils';
import { Badge } from '../components/ui/Badge';
import { EmbedModal } from '../components/builder/EmbedModal';
import { CsvImportWizard } from '../components/builder';
import type { Form, FormField, LocalFormResponse } from '../types/form';

const ITEMS_PER_PAGE = 10;

// A linked_record value resolved server-side into a human label. `targetFormId` lets the
// UI open the referenced record on demand (the owner owns it, so it's fetchable directly).
type ResolvedLink = { id: string; display: string; targetFormId?: string };

interface ResponseWithStatus extends LocalFormResponse {
  status?: string;
  tags?: string[];
  computed?: Record<string, unknown>;
  // Server-injected labels for linked_record fields, keyed by field id.
  _resolved?: Record<string, ResolvedLink | ResolvedLink[]>;
}

// Fetch EVERY response for a form. The API caps each page (default 100, max
// 1000), so a single request silently truncates large forms — corrupting stats,
// search, sort, and CSV export. Loop until exhausted so the page reflects the
// full set. Also normalizes completionTime, which the server nests under
// metadata.completionTime but the UI reads at the top level.
async function fetchAllApiResponses(
  formId: string
): Promise<{ responses: ResponseWithStatus[]; truncated: boolean }> {
  const PAGE = 1000;
  const MAX_PAGES = 100; // 100k safety cap, mirrors the server-side export cap
  const all: ResponseWithStatus[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await api.getResponses(formId, { limit: PAGE, offset: page * PAGE });
    const batch = result.data?.responses;
    if (!batch) {
      if (page === 0) throw new Error(result.error || 'Failed to load responses');
      break;
    }
    for (const r of batch) {
      const rr = r as unknown as ResponseWithStatus & { metadata?: { completionTime?: number } };
      all.push({ ...rr, completionTime: rr.completionTime ?? rr.metadata?.completionTime ?? 0 });
    }
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      // Reached the cap on a full page — probe one more page to avoid a false
      // "truncated" when the total is an exact multiple of MAX_PAGES*PAGE.
      const probe = await api.getResponses(formId, { limit: 1, offset: MAX_PAGES * PAGE });
      truncated = !!probe.data?.responses && probe.data.responses.length > 0;
    }
  }
  return { responses: all, truncated };
}

// Format a single answer for display. Pure over its args (no component state) so it's shared
// by the table, the CSV export, the detail drawer, and the linked-record peek.
function formatValue(value: unknown, fieldType?: string, options?: Array<{ value: string; label?: string }>): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // File upload: show filenames
  if (fieldType === 'file_upload' && Array.isArray(value)) {
    return value.map((f: unknown) => (f && typeof f === 'object' && 'originalFilename' in f) ? (f as Record<string, unknown>).originalFilename : 'File').join(', ') || '-';
  }
  // Signature: a typed signature is stored as "typed:<name>" — show the name; a drawn
  // signature is a data:image URL — show a marker, never the raw base64.
  if (fieldType === 'signature') {
    if (typeof value === 'string' && value.startsWith('typed:')) {
      const name = value.slice(6).trim();
      return name || '-';
    }
    return value ? '[signature]' : '-';
  }
  // Linked record: stored as the target response id(s). Prefer resolved labels at the call
  // site (see linkedText); this fallback only fires when nothing was resolved.
  if (fieldType === 'linked_record') {
    const n = Array.isArray(value) ? value.length : (value ? 1 : 0);
    return n === 0 ? '-' : n === 1 ? '[linked record]' : `[${n} linked records]`;
  }
  // Choice fields: map stored option values (e.g. "option_2") to their human labels.
  if (options && options.length && (fieldType === 'dropdown' || fieldType === 'multiple_choice' || fieldType === 'checkboxes')) {
    const labelFor = (v: unknown) => options.find((o) => o.value === v)?.label ?? String(v);
    return Array.isArray(value) ? value.map(labelFor).join(', ') : labelFor(value);
  }
  // Location: show coordinates
  if (fieldType === 'location' && value && typeof value === 'object' && 'latitude' in (value as Record<string, unknown>)) {
    const loc = value as Record<string, number>;
    return `${loc.latitude?.toFixed(6)}, ${loc.longitude?.toFixed(6)}`;
  }
  // Date/time locale formatting (guard against Invalid Date rather than swallowing it)
  if (typeof value === 'string' && value) {
    if (fieldType === 'date') {
      const d = new Date(value + 'T00:00:00');
      return isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } else if (fieldType === 'time') {
      const [h, m] = value.split(':').map(Number);
      const d = new Date(2000, 0, 1, h, m);
      return isNaN(d.getTime()) ? value : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } else if (fieldType === 'datetime') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? value : d.toLocaleString();
    }
  }
  if (Array.isArray(value)) return value.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Normalize the server's _resolved value (single object or array) into a list.
function asResolvedList(v: ResolvedLink | ResolvedLink[] | undefined): ResolvedLink[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Plain-text join of resolved linked-record labels — for tooltips, CSV, and non-interactive rows.
function linkedText(items: ResolvedLink[]): string {
  return items.length ? items.map((i) => i.display).join(', ') : '-';
}

// Target-form definitions are cached so the peek doesn't refetch field labels for every chip.
const linkedFormCache = new Map<string, Form>();

// Renders resolved linked records as chips. Each real record is clickable and opens a peek
// with the referenced record's details. Used where the row is NOT already a button.
function LinkedRecordChips({ items }: { items: ResolvedLink[] }) {
  const [peek, setPeek] = useState<ResolvedLink | null>(null);
  if (!items.length) return <span className="text-gray-400 dark:text-slate-500">-</span>;
  return (
    <>
      <span className="flex flex-wrap items-center gap-1 max-w-full min-w-0">
        {items.map((it, i) => {
          const clickable = !!it.targetFormId && it.display !== 'Record not found';
          return (
            <button
              key={it.id + i}
              type="button"
              disabled={!clickable}
              onClick={(e) => { e.stopPropagation(); if (clickable) setPeek(it); }}
              title={clickable ? `${it.display} — click to view` : it.display}
              className={cn(
                'inline-flex items-center gap-1 max-w-full min-w-0 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 transition-colors',
                clickable
                  ? 'border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 cursor-pointer'
                  : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 cursor-default'
              )}
            >
              <Link2 className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{it.display}</span>
            </button>
          );
        })}
      </span>
      {peek && <LinkedRecordPeek item={peek} onClose={() => setPeek(null)} />}
    </>
  );
}

// A modal that lazily loads and displays a single linked record (the owner owns the target
// form, so it's fetched directly). Kept lightweight — a read-only peek, not the full editor.
function LinkedRecordPeek({ item, onClose }: { item: ResolvedLink; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [resolved, setResolved] = useState<Record<string, ResolvedLink | ResolvedLink[]>>({});

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const tfid = item.targetFormId ?? '';
        let f = linkedFormCache.get(tfid) ?? null;
        if (!f) {
          const fr = await api.getForm(tfid);
          f = fr.data?.form ?? null;
          if (f) linkedFormCache.set(tfid, f);
        }
        const rr = await api.getResponse(tfid, item.id);
        if (cancelled) return;
        setForm(f);
        setAnswers((rr.data?.response?.answers as Record<string, unknown>) ?? {});
        setResolved((rr.data?.response as { _resolved?: Record<string, ResolvedLink | ResolvedLink[]> })?._resolved ?? {});
      } catch {
        if (!cancelled) setError('Could not load this record.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [item]);

  const fields = (form?.fields ?? []).filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type));

  return (
    <Modal isOpen onClose={onClose} title={form?.title || 'Linked record'} description={item.display} size="md">
      <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : fields.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">This record has no displayable fields.</p>
        ) : (
          fields.map((field) => {
            let content: ReactNode;
            if (field.type === 'linked_record') {
              content = linkedText(asResolvedList(resolved[field.id]));
            } else if (field.type === 'file_upload' && Array.isArray(answers[field.id]) && (answers[field.id] as unknown[]).length > 0) {
              content = (
                <span className="inline-flex flex-wrap gap-2">
                  {(answers[field.id] as Array<{ originalFilename?: string; url?: string }>).map((f, i) => (
                    f && f.url
                      ? <a key={i} href={resolveFileUrl(f.url)} target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline">{f.originalFilename || 'File'}</a>
                      : <span key={i}>{(f && f.originalFilename) || 'File'}</span>
                  ))}
                </span>
              );
            } else {
              content = formatValue(answers[field.id], field.type, field.properties?.options);
            }
            const empty = content === '' || content === '-' || content == null;
            return (
              <div key={field.id} className="border-b border-gray-100 dark:border-slate-800 pb-3 last:border-0 last:pb-0">
                <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">{field.label}</p>
                <div className="text-sm text-gray-900 dark:text-white break-words">
                  {empty ? <span className="text-gray-400 dark:text-slate-500 italic">No answer</span> : content}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

const STATUS_OPTIONS = ['submitted', 'reviewed', 'approved', 'rejected', 'archived'] as const;

// Status pills render via the shared <Badge> (statusBadgeVariant in lib/utils),
// so the responses table, response detail, and members list stay in one palette.

// Stats card component for consistency
// StatCard is the shared component (imported) — same metric tiles as Dashboard/Analytics.

function FormResponses() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const storageMode = useFormStore((state) => state.storageMode);
  const getForm = useFormStore((state) => state.getForm);
  const refreshForms = useFormStore((state) => state.refreshForms);
  const localResponses = useResponseStore((state) => state.getResponsesByFormId);
  const deleteLocalResponse = useResponseStore((state) => state.deleteResponse);
  const updateLocalResponse = useResponseStore((state) => state.updateResponse);

  const [form, setForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<ResponseWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedResponse, setSelectedResponse] = useState<ResponseWithStatus | null>(null);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [editedAnswers, setEditedAnswers] = useState<Record<string, unknown>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [sortField, setSortField] = useState<'submittedAt' | 'completionTime'>('submittedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Load form and responses
  useEffect(() => {
    if (!formId) return;
    // Guard against out-of-order responses when formId/storageMode changes mid-load.
    let cancelled = false;

    const loadData = async () => {
      setIsLoading(true);

      // Load form — prefer API to get full form with fields
      if (storageMode === 'api') {
        const result = await api.getForm(formId);
        if (cancelled) return;
        if (result.data?.form) {
          setForm(result.data.form);
        } else {
          const localForm = getForm(formId);
          if (localForm) setForm(localForm);
        }
      } else {
        const localForm = getForm(formId);
        if (localForm) setForm(localForm);
      }

      // Load responses
      if (storageMode === 'api') {
        try {
          const { responses: all, truncated } = await fetchAllApiResponses(formId);
          if (cancelled) return;
          setResponses(all);
          if (truncated) {
            toast.error('Showing first 100,000 responses', 'This form has more responses than can be displayed at once.');
          }
        } catch (e) {
          if (cancelled) return;
          toast.error('Failed to load responses', e instanceof Error ? e.message : 'Unknown error');
        }
      } else {
        const localResps = localResponses(formId);
        setResponses(localResps as ResponseWithStatus[]);
      }

      if (cancelled) return;
      setIsLoading(false);
    };

    loadData();
    return () => { cancelled = true; };
  }, [formId, storageMode, getForm, localResponses]);

  // Keep the list fresh: silently refetch responses when the tab regains focus or
  // becomes visible, so a response submitted while this page was open (or in another
  // tab) appears without a manual reload. API mode only; no loading skeleton.
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Track the form currently shown so a slow refetch started for a previous form
  // can't clobber the new form's data when it resolves late — /responses/:formId
  // has no route key, so this component instance is reused across formId changes.
  const formIdRef = useRef(formId);
  formIdRef.current = formId;
  const reloadResponses = useCallback(async () => {
    if (!formId || storageMode !== 'api') return;
    const fid = formId;
    setIsRefreshing(true);
    try {
      const { responses: all } = await fetchAllApiResponses(fid);
      if (formIdRef.current === fid) setResponses(all); // drop stale result if navigated away
    } catch {
      // Keep the current data on a transient refresh failure.
    } finally {
      setIsRefreshing(false);
    }
  }, [formId, storageMode]);

  useEffect(() => {
    if (storageMode !== 'api') return;
    const onFocus = () => reloadResponses();
    const onVisible = () => { if (document.visibilityState === 'visible') reloadResponses(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [storageMode, reloadResponses]);

  // Close the export menu on outside click / Escape (mirrors the Analytics export menu).
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exportMenuOpen]);

  // Deep-link support: /responses/:formId?open=<responseId> (e.g. from Analytics'
  // Recent Responses rows) opens that record's view modal once loaded, then clears
  // the param so refresh/back doesn't re-open it.
  const openParamHandled = useRef(false);
  useEffect(() => {
    if (openParamHandled.current || isLoading) return;
    const openId = searchParams.get('open');
    if (!openId) return;
    openParamHandled.current = true;
    const target = responses.find((r) => r.id === openId);
    if (target) {
      setSelectedResponse(target);
      setIsViewModalOpen(true);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('open');
        return next;
      },
      { replace: true }
    );
  }, [isLoading, responses, searchParams, setSearchParams]);

  // Get display fields (first few meaningful fields)
  const displayFields = useMemo(() => {
    if (!form) return [];
    return form.fields
      .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
      .slice(0, 12);
  }, [form]);

  // Show as many field columns as actually fit the table's width (no horizontal scroll);
  // collapse to stacked cards once it's phone-sized. Reserved px ≈ Date+Time+Status+Actions.
  const { ref: tableRef, count: visibleFieldCount, cards: cardMode } = useFittedColumns<HTMLDivElement>({
    itemCount: displayFields.length,
    itemMinPx: 170,
    reservedPx: 470,
    cardBelowPx: 640,
  });
  const visibleFields = displayFields.slice(0, visibleFieldCount);

  // Calculate stats
  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const today = new Date().toDateString();

    const thisWeek = responses.filter((r) => parseServerDate(r.submittedAt).getTime() > weekAgo).length;
    const todayCount = responses.filter((r) => parseServerDate(r.submittedAt).toDateString() === today).length;
    const avgTime = responses.length > 0
      ? responses.reduce((acc, r) => acc + (r.completionTime || 0), 0) / responses.length
      : 0;

    return { total: responses.length, thisWeek, todayCount, avgTime };
  }, [responses]);

  // Precompute a lowercased search haystack per response ONCE (keyed on responses), so
  // typing in the search box is a cheap substring scan instead of re-serializing every
  // response's answers on every keystroke.
  const searchIndex = useMemo(
    () => responses.map((r) => {
      // Also index the resolved linked-record labels so a search for "Ada Lovelace" matches a
      // Deal that links to her — the raw answers only hold the target UUID.
      const linkText = r._resolved
        ? Object.values(r._resolved).flatMap((v) => asResolvedList(v).map((x) => x.display)).join(' ')
        : '';
      return { r, hay: (JSON.stringify(r.answers) + ' ' + r.id + ' ' + linkText).toLowerCase() };
    }),
    [responses]
  );

  // Filter and sort responses
  const filteredResponses = useMemo(() => {
    let filtered = responses;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = searchIndex.filter((x) => x.hay.includes(query)).map((x) => x.r);
    }

    // Status filter (review queue)
    if (statusFilter !== 'all') {
      filtered = filtered.filter((r) => (r.status || 'submitted') === statusFilter);
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let aVal: number;
      let bVal: number;

      if (sortField === 'submittedAt') {
        // Use parseServerDate (not raw new Date): the backend's offset-less
        // 'YYYY-MM-DD HH:MM:SS' is Invalid Date in Safari/iOS, which would collapse
        // every row to 0 and make the Date sort a no-op there.
        aVal = parseServerDate(a.submittedAt).getTime() || 0;
        bVal = parseServerDate(b.submittedAt).getTime() || 0;
      } else {
        aVal = a.completionTime || 0;
        bVal = b.completionTime || 0;
      }

      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return filtered;
  }, [responses, searchIndex, searchQuery, statusFilter, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredResponses.length / ITEMS_PER_PAGE);
  const paginatedResponses = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredResponses.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredResponses, currentPage]);

  // Clamp the current page when the result set shrinks (e.g. deleting the only
  // row on the last page) so the user isn't stranded on an empty page.
  useEffect(() => {
    const tp = Math.max(1, Math.ceil(filteredResponses.length / ITEMS_PER_PAGE));
    if (currentPage > tp) setCurrentPage(tp);
  }, [filteredResponses.length, currentPage]);

  // Handle view response
  const handleView = (response: ResponseWithStatus) => {
    setSelectedResponse(response);
    setIsViewModalOpen(true);
  };

  // Handle edit response
  const handleEdit = (response: ResponseWithStatus) => {
    setSelectedResponse(response);
    setEditedAnswers({ ...response.answers });
    setIsEditModalOpen(true);
  };

  // Handle save edit
  const handleSaveEdit = async () => {
    if (!selectedResponse || !formId) return;

    setIsSaving(true);
    try {
      if (storageMode === 'api') {
        const result = await api.updateResponse(formId, selectedResponse.id, {
          answers: editedAnswers,
        });
        if (result.error) {
          toast.error('Failed to update response', result.error);
          return;
        }
        setResponses((prev) =>
          prev.map((r) =>
            r.id === selectedResponse.id ? { ...r, answers: editedAnswers } : r
          )
        );
      } else {
        updateLocalResponse(selectedResponse.id, editedAnswers);
        setResponses((prev) =>
          prev.map((r) =>
            r.id === selectedResponse.id ? { ...r, answers: editedAnswers } : r
          )
        );
      }
      toast.success('Response updated', 'Changes saved successfully');
      setIsEditModalOpen(false);
    } catch {
      toast.error('Failed to save', 'An error occurred while saving');
    } finally {
      setIsSaving(false);
    }
  };

  // Handle delete confirmation
  const handleDeleteConfirm = (response: ResponseWithStatus) => {
    setSelectedResponse(response);
    setIsDeleteModalOpen(true);
  };

  // Handle delete
  const handleDelete = async () => {
    if (!selectedResponse || !formId || isDeleting) return;
    setIsDeleting(true);
    try {
      if (storageMode === 'api') {
        const result = await api.deleteResponse(formId, selectedResponse.id);
        if (result.error) {
          toast.error('Failed to delete', result.error);
          return;
        }
      } else {
        deleteLocalResponse(selectedResponse.id);
      }

      setResponses((prev) => prev.filter((r) => r.id !== selectedResponse.id));
      toast.success('Response deleted', 'The response has been removed');
      setIsDeleteModalOpen(false);
    } catch {
      toast.error('Failed to delete', 'An error occurred');
    } finally {
      setIsDeleting(false);
    }
  };

  // Change a response's review status (submitted/reviewed/approved/rejected/archived).
  // Persisted server-side in API mode; in-memory only for local-storage forms.
  const handleStatusChange = async (responseId: string, newStatus: string) => {
    const prevStatus = responses.find((r) => r.id === responseId)?.status ?? 'submitted';
    setResponses((prev) => prev.map((r) => (r.id === responseId ? { ...r, status: newStatus } : r)));
    setSelectedResponse((prev) => (prev && prev.id === responseId ? { ...prev, status: newStatus } : prev));
    if (storageMode === 'api' && formId) {
      const result = await api.updateResponse(formId, responseId, { status: newStatus } as Parameters<typeof api.updateResponse>[2]);
      if (result.error) {
        toast.error('Failed to update status', result.error);
        // Roll the optimistic change back in both the list and the open modal.
        setResponses((prev) => prev.map((r) => (r.id === responseId ? { ...r, status: prevStatus } : r)));
        setSelectedResponse((prev) => (prev && prev.id === responseId ? { ...prev, status: prevStatus } : prev));
      }
    }
  };

  // Re-run the form's logic script against a stored response (owner/API mode).
  const handleRecompute = async (responseId: string) => {
    if (!formId) return;
    const result = await api.recomputeResponse(formId, responseId);
    // The endpoint returns 200 with {success:false, error} when the script
    // itself fails — surface that instead of a misleading success toast.
    if (result.error || result.data?.success === false) {
      toast.error('Re-run failed', result.error || result.data?.error || 'Script error');
      return;
    }
    toast.success('Logic re-run', 'The response was recomputed with the latest script.');
    try {
      const { responses: all } = await fetchAllApiResponses(formId);
      setResponses(all);
    } catch { /* will refresh on next load */ }
    setIsViewModalOpen(false);
  };

  // Client-side export of exactly what's shown (the search + status filter).
  const handleExportFilteredCsv = () => {
    setExportMenuOpen(false);
    if (!form || filteredResponses.length === 0) return;

    // Export all fields, not just displayFields (which is limited to 6 for the table UI)
    const allExportFields = form.fields.filter(
      (f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type)
    );
    const escapeCell = (val: unknown) => {
      let str = String(val ?? '').replace(/"/g, '""');
      // Prevent CSV formula injection. Match the hardened backend export
      // (ResponseService::exportResponsesStreaming): also catch leading whitespace
      // and TAB/CR before a formula trigger, which spreadsheets still evaluate.
      if (/^\s*[=+\-@\t\r]/.test(str)) str = "'" + str;
      return `"${str}"`;
    };
    const headers = ['ID', 'Submitted At', 'Status', ...allExportFields.map((f) => f.label)];
    const rows = filteredResponses.map((r) => [
      r.id,
      parseServerDate(r.submittedAt).toLocaleString(),
      r.status ?? 'submitted',
      ...allExportFields.map((f) =>
        f.type === 'linked_record'
          ? linkedText(linksFor(r, f.id))
          : formatValue(r.answers[f.id], f.type, f.properties?.options)
      ),
    ]);

    const csv = [headers.map(escapeCell).join(','), ...rows.map((row) => row.map(escapeCell).join(','))].join('\n');

    // Prepend a UTF-8 BOM so Excel reads non-ASCII correctly (matches backend export).
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(form.title)}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Export ready', 'Your CSV download has started.');
  };

  // Server-side exports of the FULL dataset \u2014 the same endpoints Analytics uses.
  const handleExportServerCsv = async () => {
    if (!form) return;
    setExportMenuOpen(false);
    setIsExporting(true);
    try {
      const csv = await api.exportResponses(form.id);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename(form.title)}-responses.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Export ready', 'Your CSV download has started.');
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Could not export responses.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportJson = async () => {
    if (!form) return;
    setExportMenuOpen(false);
    setIsExporting(true);
    try {
      await api.downloadJson(form.id, form.title);
      toast.success('Export ready', 'Your JSON download has started.');
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Could not export JSON.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportSqlite = async () => {
    if (!form) return;
    setExportMenuOpen(false);
    setIsExporting(true);
    try {
      await api.downloadSqlite(form.id, form.title);
      toast.success('Export ready', 'Your SQLite download has started.');
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Could not export SQLite database.');
    } finally {
      setIsExporting(false);
    }
  };

  // History-aware back: return to wherever the user came from; fall back to this
  // form's analytics page on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/analytics/${formId}`);
  };

  // Resolved linked-record labels for a field on a given response (empty if none/unresolved).
  const linksFor = (response: ResponseWithStatus, fieldId: string): ResolvedLink[] =>
    asResolvedList(response._resolved?.[fieldId]);

  // Format date (server timestamps are UTC — parse them as such)
  const formatDate = (dateStr: string) => {
    const date = parseServerDate(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Format duration
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  // Toggle sort
  const toggleSort = (field: 'submittedAt' | 'completionTime') => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
    setCurrentPage(1);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen transition-colors">
        <Header title="Responses" />
        <div className="flex-1 w-full p-4 sm:p-6 lg:p-8" aria-busy="true" aria-label="Loading responses">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-4 flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg flex-shrink-0" />
                <div className="space-y-2 flex-1"><Skeleton className="h-5 w-12" /><Skeleton className="h-3 w-20" /></div>
              </div>
            ))}
          </div>
          <Skeleton className="h-11 w-full rounded-lg mb-6" />
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <ListRowSkeleton key={i} />)}
          </div>
        </div>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center transition-colors">
        <EmptyState
          icon={Inbox}
          title="Form not found"
          description="The form you're looking for doesn't exist or has been deleted."
          action={<Button onClick={() => navigate('/')}>Go to Dashboard</Button>}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen transition-colors">
      <Header
        title="Responses"
        actions={
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            {storageMode === 'api' && (
              <Button variant="outline" size="sm" onClick={reloadResponses} disabled={isRefreshing} title="Refresh responses">
                <RefreshCw className={`h-4 w-4${isRefreshing ? ' animate-spin' : ''}`} />
                <span className="hidden lg:inline ml-2">Refresh</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowEmbedModal(true)} title="Share & Embed" className="hidden sm:flex">
              <Share2 className="h-4 w-4" />
              <span className="hidden lg:inline ml-2">Share</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCsvImport(true)} title="Import CSV">
              <Upload className="h-4 w-4" />
              <span className="hidden lg:inline ml-2">Import</span>
            </Button>
            <div className="relative" ref={exportRef}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExportMenuOpen((open) => !open)}
                disabled={isExporting || responses.length === 0}
                title={responses.length === 0 ? 'No responses to export' : 'Export responses'}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
              >
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span className="hidden lg:inline ml-2">Export</span>
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
              {exportMenuOpen && (
                <div role="menu" aria-label="Export options" className="absolute right-0 mt-1.5 w-56 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 z-50">
                  {storageMode === 'api' && (
                    <>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportServerCsv}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <Download className="h-4 w-4 text-purple-500 dark:text-purple-400" />
                        Export CSV
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportJson}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <FileJson className="h-4 w-4 text-green-500 dark:text-green-400" />
                        Export JSON
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportSqlite}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <Database className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                        Download SQLite
                      </button>
                    </>
                  )}
                  <button
                    role="menuitem"
                    type="button"
                    onClick={handleExportFilteredCsv}
                    disabled={filteredResponses.length === 0}
                    title={filteredResponses.length === 0 ? 'No responses match the current search and status filters' : 'Export only the rows matching the current filters'}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <Filter className="h-4 w-4 text-amber-500 dark:text-amber-400" />
                    CSV (filtered view)
                  </button>
                </div>
              )}
            </div>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        <PageHeader
          title={form.title}
          subtitle={`Responses · ${stats.total} ${stats.total === 1 ? 'record' : 'records'}`}
          onBack={goBack}
          backLabel="Back"
        />

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={Users}
            label="Total Responses"
            value={stats.total}
            iconBg="bg-primary-500/10"
            iconColor="text-primary-500"
          />
          <StatCard
            icon={CalendarDays}
            label="This Week"
            value={stats.thisWeek}
            iconBg="bg-green-500/10"
            iconColor="text-green-500"
          />
          <StatCard
            icon={Calendar}
            label="Today"
            value={stats.todayCount}
            iconBg="bg-blue-500/10"
            iconColor="text-blue-500"
          />
          <StatCard
            icon={Timer}
            label="Avg. Time"
            value={formatDuration(stats.avgTime)}
            iconBg="bg-amber-500/10"
            iconColor="text-amber-500"
          />
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                placeholder="Search responses..."
                aria-label="Search responses"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
              aria-label="Filter by status"
              className="px-3 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 text-gray-600 dark:text-slate-300 font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            {/* Desktop sorts from the Date/Time table headers; the card view has no
                headers, so keep a compact sort control here for that mode only. */}
            {cardMode && (
              <select
                value={`${sortField}-${sortDirection}`}
                onChange={(e) => {
                  const [field, direction] = e.target.value.split('-') as ['submittedAt' | 'completionTime', 'asc' | 'desc'];
                  setSortField(field);
                  setSortDirection(direction);
                  setCurrentPage(1);
                }}
                aria-label="Sort responses"
                className="px-3 py-2.5 text-sm rounded-lg border bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 text-gray-600 dark:text-slate-300 font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="submittedAt-desc">Newest first</option>
                <option value="submittedAt-asc">Oldest first</option>
                <option value="completionTime-desc">Longest time</option>
                <option value="completionTime-asc">Shortest time</option>
              </select>
            )}
          </div>
        </div>

        {/* Responses Table */}
        {responses.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Inbox}
                title="No responses yet"
                description="Share your form to start collecting responses"
                action={<Button onClick={() => setShowEmbedModal(true)}>Share form</Button>}
              />
            </CardContent>
          </Card>
        ) : filteredResponses.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Search}
                title="No responses match your filters"
                description="Try a different search term or status filter."
                action={<Button variant="outline" onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}>Clear filters</Button>}
              />
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden bg-white dark:bg-slate-900/50 border-gray-200 dark:border-slate-800">
           <div ref={tableRef}>
            {/* Stacked cards once the table is too narrow for even one field column. */}
            {cardMode ? (
            <ul className="divide-y divide-gray-200 dark:divide-slate-800">
              {paginatedResponses.map((response) => (
                <li key={response.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => handleView(response)}
                      className="min-w-0 flex-1 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{formatDate(response.submittedAt)}</p>
                        <Badge variant={statusBadgeVariant(response.status || 'submitted')} className="rounded-full">
                          {formatStatusLabel(response.status || 'submitted')}
                        </Badge>
                      </div>
                      {response.tags && response.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {response.tags.map((tag) => (
                            <Badge key={tag} className="max-w-full"><span className="truncate">{tag}</span></Badge>
                          ))}
                        </div>
                      )}
                      {displayFields.slice(0, 4).map((field) => (
                        <p key={field.id} className="mt-1 text-sm text-gray-600 dark:text-slate-300 truncate">
                          <span className="text-gray-400 dark:text-slate-500">{field.label}: </span>
                          {/* This row is itself a button, so linked records render as plain text (no nested buttons). */}
                          {field.type === 'linked_record'
                            ? linkedText(linksFor(response, field.id))
                            : formatValue(response.answers[field.id], field.type, field.properties?.options)}
                        </p>
                      ))}
                      <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">{formatDuration(response.completionTime || 0)}</p>
                    </button>
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => handleView(response)} className="p-2 text-gray-500 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-500/10 rounded-lg transition-colors cursor-pointer" aria-label="View response details">
                        <Eye className="h-4 w-4" />
                      </button>
                      <button onClick={() => handleEdit(response)} className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors cursor-pointer" aria-label="Edit response">
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button onClick={() => handleDeleteConfirm(response)} className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer" aria-label="Delete response">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            ) : (
            <div>
              <table className="w-full table-fixed">
                <thead className="bg-gray-50/50 dark:bg-slate-900/50 border-b border-gray-200 dark:border-slate-800">
                  <tr>
                    <th
                      aria-sort={sortField === 'submittedAt' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
                      className="px-4 py-3 text-left w-44"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort('submittedAt')}
                        className="group inline-flex items-center gap-1 rounded text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider hover:text-gray-700 dark:hover:text-slate-300 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      >
                        Date
                        {sortField === 'submittedAt' ? (
                          sortDirection === 'asc' ? <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-40 group-hover:opacity-70 transition-opacity" aria-hidden="true" />
                        )}
                      </button>
                    </th>
                    {visibleFields.map((field) => (
                      <th
                        key={field.id}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider"
                        title={field.label}
                      >
                        <span className="truncate block">{field.label}</span>
                      </th>
                    ))}
                    <th
                      aria-sort={sortField === 'completionTime' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
                      className="px-4 py-3 text-left w-20"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort('completionTime')}
                        className="group inline-flex items-center gap-1 rounded text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider hover:text-gray-700 dark:hover:text-slate-300 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      >
                        Time
                        {sortField === 'completionTime' ? (
                          sortDirection === 'asc' ? <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-40 group-hover:opacity-70 transition-opacity" aria-hidden="true" />
                        )}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider w-28">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider w-28">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-800 bg-white dark:bg-slate-900/20">
                  {paginatedResponses.map((response) => (
                    <tr key={response.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-4 text-sm text-gray-900 dark:text-white">
                        <span className="whitespace-nowrap">{formatDate(response.submittedAt)}</span>
                        {response.tags && response.tags.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {response.tags.map((tag) => (
                              <Badge key={tag} className="max-w-full"><span className="truncate">{tag}</span></Badge>
                            ))}
                          </span>
                        )}
                      </td>
                      {visibleFields.map((field) => {
                        const isLinked = field.type === 'linked_record';
                        const plain = isLinked
                          ? linkedText(linksFor(response, field.id))
                          : formatValue(response.answers[field.id], field.type, field.properties?.options);
                        return (
                          <td
                            key={field.id}
                            className={cn('px-4 py-4 text-sm text-gray-600 dark:text-slate-300', isLinked ? 'align-middle overflow-hidden' : 'truncate')}
                            title={plain}
                          >
                            {isLinked ? <LinkedRecordChips items={linksFor(response, field.id)} /> : plain}
                          </td>
                        );
                      })}
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-slate-500">
                        {formatDuration(response.completionTime || 0)}
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <Badge variant={statusBadgeVariant(response.status || 'submitted')} className="rounded-full">
                          {formatStatusLabel(response.status || 'submitted')}
                        </Badge>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => handleView(response)}
                            className="p-2 text-gray-500 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-500/10 rounded-lg transition-colors cursor-pointer"
                            title="View details"
                            aria-label="View response details"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleEdit(response)}
                            className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors cursor-pointer"
                            title="Edit response"
                            aria-label="Edit response"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteConfirm(response)}
                            className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                            title="Delete response"
                            aria-label="Delete response"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
           </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Showing <span className="font-medium text-gray-900 dark:text-white">{(currentPage - 1) * ITEMS_PER_PAGE + 1}</span> to{' '}
                  <span className="font-medium text-gray-900 dark:text-white">{Math.min(currentPage * ITEMS_PER_PAGE, filteredResponses.length)}</span> of{' '}
                  <span className="font-medium text-gray-900 dark:text-white">{filteredResponses.length}</span> responses
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 font-medium bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* View Modal */}
      <Modal
        isOpen={isViewModalOpen}
        onClose={() => setIsViewModalOpen(false)}
        title="Response Details"
        description={selectedResponse ? `Submitted ${formatDate(selectedResponse.submittedAt)}` : undefined}
        size="lg"
      >
        {selectedResponse && (
          <>
            <div className="p-6 space-y-4">
              {form.fields
                .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
                .map((field) => (
                  <div key={field.id} className="border-b border-gray-100 dark:border-slate-800 pb-4 last:border-0 last:pb-0">
                    <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">{field.label}</p>
                    <div className="text-gray-900 dark:text-white">
                      {field.type === 'linked_record' ? (
                        <LinkedRecordChips items={linksFor(selectedResponse, field.id)} />
                      ) : field.type === 'file_upload' && Array.isArray(selectedResponse.answers[field.id]) && (selectedResponse.answers[field.id] as unknown[]).length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {(selectedResponse.answers[field.id] as Array<{ originalFilename?: string; url?: string }>).map((f, i) => (
                            f && f.url
                              ? <a key={i} href={resolveFileUrl(f.url)} target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline">{f.originalFilename || 'File'}</a>
                              : <span key={i}>{(f && f.originalFilename) || 'File'}</span>
                          ))}
                        </div>
                      ) : (
                        formatValue(selectedResponse.answers[field.id], field.type, field.properties?.options) || (
                          <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>
                        )
                      )}
                    </div>
                  </div>
                ))}
              {/* Computed values (set by the form's logic script) */}
              {selectedResponse.computed && Object.keys(selectedResponse.computed).length > 0 && (
                <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
                  <h3 className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-3">Computed</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    {Object.entries(selectedResponse.computed).map(([key, value]) => (
                      <div key={key} className="min-w-0">
                        <p className="text-xs text-gray-500 dark:text-slate-400 truncate" title={key}>{key}</p>
                        <p className="text-gray-900 dark:text-white break-words mt-0.5">
                          {value === null || value === undefined
                            ? '—'
                            : typeof value === 'object'
                              ? JSON.stringify(value)
                              : String(value)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Metadata */}
              <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
                <h3 className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-3">Metadata</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500 dark:text-slate-400">Response ID</p>
                    <p className="text-gray-700 dark:text-slate-300 font-mono text-xs bg-gray-100 dark:bg-slate-800 px-2 py-1 rounded mt-1">
                      {selectedResponse.id}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500 dark:text-slate-400">Completion Time</p>
                    <p className="text-gray-900 dark:text-white mt-1">
                      {formatDuration(selectedResponse.completionTime || 0)}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-gray-500 dark:text-slate-400 mb-1">Status</p>
                    {storageMode === 'api' ? (
                      <select
                        value={selectedResponse.status || 'submitted'}
                        onChange={(e) => handleStatusChange(selectedResponse.id, e.target.value)}
                        aria-label="Response status"
                        className="px-2.5 py-1 rounded-lg text-sm border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:ring-2 focus:ring-primary-500 focus:outline-none cursor-pointer"
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant={statusBadgeVariant(selectedResponse.status || 'submitted')} className="rounded-full">
                        {formatStatusLabel(selectedResponse.status || 'submitted')}
                      </Badge>
                    )}
                  </div>
                  {selectedResponse.tags && selectedResponse.tags.length > 0 && (
                    <div className="col-span-2">
                      <p className="text-gray-500 dark:text-slate-400 mb-1">Tags</p>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedResponse.tags.map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedResponse.metadata?.userAgent && (
                    <div className="col-span-2">
                      <p className="text-gray-500 dark:text-slate-400">User Agent</p>
                      <p className="text-gray-900 dark:text-white text-xs truncate mt-1">
                        {selectedResponse.metadata.userAgent}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsViewModalOpen(false)}>
                Close
              </Button>
              {storageMode === 'api' && form.logicScript && (
                <Button variant="outline" onClick={() => handleRecompute(selectedResponse.id)}>
                  Re-run logic
                </Button>
              )}
              <Button
                onClick={() => {
                  setIsViewModalOpen(false);
                  handleEdit(selectedResponse);
                }}
              >
                <Edit2 className="h-4 w-4 mr-2" />
                Edit
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Edit Modal */}
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Edit Response"
        description="Modify the response data"
        size="lg"
      >
        {selectedResponse && (
          <>
            <div className="p-6 space-y-4">
              {form.fields
                .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
                .map((field) => (
                  <div key={field.id}>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                      {field.label}
                    </label>
                    {renderEditField(field, editedAnswers[field.id], (value) =>
                      setEditedAnswers((prev) => ({ ...prev, [field.id]: value }))
                    )}
                  </div>
                ))}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEdit} isLoading={isSaving}>
                <Check className="h-4 w-4 mr-2" />
                Save Changes
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        size="sm"
        showCloseButton={false}
      >
        <div className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-red-100 dark:bg-red-500/10 rounded-full">
              <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white tracking-tight">Delete Response</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">This action cannot be undone</p>
            </div>
          </div>
          <p className="text-gray-600 dark:text-slate-400 mb-6">
            Are you sure you want to delete this response? All data associated with this
            submission will be permanently removed.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={isDeleting} leftIcon={<Trash2 className="h-4 w-4" />}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      {/* Embed Modal */}
      <EmbedModal
        isOpen={showEmbedModal}
        onClose={() => setShowEmbedModal(false)}
        formId={form.id}
        formTitle={form.title}
        formStatus={form.status}
      />

      {/* CSV Import Wizard */}
      <CsvImportWizard
        isOpen={showCsvImport}
        onClose={() => setShowCsvImport(false)}
        formId={form.id}
        fields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
        onImportComplete={async () => {
          // Reload responses and refresh form list counts after import
          if (storageMode === 'api' && formId) {
            try {
              const { responses: all } = await fetchAllApiResponses(formId);
              setResponses(all);
            } catch {
              // Responses will refresh on next page load
            }
            // Refresh forms list so response counts are updated
            refreshForms();
          }
        }}
      />
    </div>
  );
}

// Helper function to render edit field based on type
function renderEditField(
  field: FormField,
  value: unknown,
  onChange: (value: unknown) => void
) {
  const currentValue = value ?? '';
  const inputClasses = "w-full px-3 py-2.5 bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-gray-900 dark:text-white";
  const disabledClasses = "w-full px-3 py-2.5 bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-gray-500 dark:text-slate-400 cursor-not-allowed";

  // Read-only for calculated + hidden fields (values are computed/script-set, not user-edited)
  if (field.type === 'calculated' || field.type === 'hidden') {
    return (
      <input
        type="text"
        value={String(currentValue)}
        disabled
        className={disabledClasses}
      />
    );
  }

  switch (field.type) {
    case 'short_text':
    case 'email':
    case 'phone':
    case 'url':
      return (
        <input
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'long_text':
      return (
        <textarea
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={inputClasses}
        />
      );

    case 'number':
    case 'rating':
    case 'scale':
      return (
        <input
          type="number"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          className={inputClasses}
        />
      );

    case 'date':
      return (
        <input
          type="date"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'time':
      return (
        <input
          type="time"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'dropdown':
    case 'multiple_choice':
      return (
        <select
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        >
          <option value="">Select...</option>
          {field.properties.options?.map((opt) => (
            <option key={opt.id} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case 'checkboxes': {
      const selectedValues = Array.isArray(currentValue) ? currentValue : [];
      return (
        <div className="space-y-2">
          {field.properties.options?.map((opt) => (
            <label key={opt.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={selectedValues.includes(opt.value)}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...selectedValues, opt.value]);
                  } else {
                    onChange(selectedValues.filter((v: string) => v !== opt.value));
                  }
                }}
                className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
              />
              <span className="text-gray-700 dark:text-slate-300">{opt.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'file_upload':
      // File uploads are not editable inline — show read-only summary
      if (Array.isArray(currentValue) && currentValue.length > 0) {
        return (
          <div className="text-sm text-gray-600 dark:text-slate-400 space-y-1">
            {currentValue.map((f: Record<string, unknown>, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span>{String(f.originalFilename || 'File')}</span>
              </div>
            ))}
          </div>
        );
      }
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No files uploaded</p>;

    case 'location':
      if (currentValue && typeof currentValue === 'object' && 'latitude' in (currentValue as Record<string, unknown>)) {
        const loc = currentValue as Record<string, number>;
        return (
          <p className="text-sm text-gray-600 dark:text-slate-400">
            {loc.latitude?.toFixed(6)}, {loc.longitude?.toFixed(6)}
            {loc.accuracy ? ` (~${loc.accuracy}m)` : ''}
          </p>
        );
      }
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No location captured</p>;

    case 'signature':
      // A signature is a data-URL — editing it as text would corrupt it. Show a
      // read-only preview; the value is preserved untouched on save.
      if (typeof currentValue === 'string' && currentValue.startsWith('data:image')) {
        return (
          <div className="space-y-1">
            <img src={currentValue} alt="Signature" className="max-h-24 rounded-lg border border-gray-200 dark:border-slate-700 bg-white" />
            <p className="text-xs text-gray-400 dark:text-slate-500 italic">Signatures can't be edited here — value preserved.</p>
          </div>
        );
      }
      if (typeof currentValue === 'string' && currentValue.startsWith('typed:')) {
        const typedName = currentValue.slice(6).trim();
        if (typedName) {
          return (
            <div className="space-y-1">
              <p className="text-base text-gray-900 dark:text-white" style={{ fontFamily: 'cursive' }}>{typedName}</p>
              <p className="text-xs text-gray-400 dark:text-slate-500 italic">Typed signature — value preserved.</p>
            </div>
          );
        }
      }
      return <p className="text-sm text-gray-400 dark:text-slate-500 italic">No signature captured</p>;

    case 'linked_record':
      // Linked records reference other responses and are only editable in the
      // app runtime. Preserve the value rather than clobbering it as text.
      return (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          {currentValue ? String(Array.isArray(currentValue) ? currentValue.join(', ') : currentValue) : '—'}
          <span className="block text-xs text-gray-400 dark:text-slate-500 italic mt-0.5">Linked records can't be edited here — value preserved.</span>
        </p>
      );

    default:
      return (
        <input
          type="text"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );
  }
}

export default FormResponses;
