import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Search,
  Trash2,
  Eye,
  Edit2,
  Download,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
  Calendar,
  Clock,
  Inbox,
  Share2,
  Users,
  CalendarDays,
  Timer,
  Upload,
  RefreshCw,
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Skeleton, ListRowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { api } from '../lib/api';
import { toast } from '../stores/toastStore';
import { cn, sanitizeFilename, statusBadgeVariant, formatStatusLabel, parseServerDate } from '../lib/utils';
import { Badge } from '../components/ui/Badge';
import { EmbedModal } from '../components/builder/EmbedModal';
import { CsvImportWizard } from '../components/builder';
import type { Form, FormField, LocalFormResponse } from '../types/form';

const ITEMS_PER_PAGE = 10;

interface ResponseWithStatus extends LocalFormResponse {
  status?: string;
  tags?: string[];
  computed?: Record<string, unknown>;
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

const STATUS_OPTIONS = ['submitted', 'reviewed', 'approved', 'rejected', 'archived'] as const;

// Status pills render via the shared <Badge> (statusBadgeVariant in lib/utils),
// so the responses table, response detail, and members list stay in one palette.

// Stats card component for consistency
function StatCard({
  icon: Icon,
  label,
  value,
  iconBg,
  iconColor,
  textColor,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  iconBg: string;
  iconColor: string;
  textColor?: string;
}) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={cn('p-2.5 rounded-lg', iconBg)}>
            <Icon className={cn('h-5 w-5', iconColor)} />
          </div>
          <div>
            <p className={cn("text-2xl font-bold tracking-tight tabular-nums", textColor || "text-gray-900 dark:text-white")}>{value}</p>
            <p className="text-sm text-gray-500 dark:text-slate-400">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FormResponses() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
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
  const [sortField, setSortField] = useState<'submittedAt' | 'completionTime'>('submittedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);

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
  const reloadResponses = useCallback(async () => {
    if (!formId || storageMode !== 'api') return;
    setIsRefreshing(true);
    try {
      const { responses: all } = await fetchAllApiResponses(formId);
      setResponses(all);
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

  // Get display fields (first few meaningful fields)
  const displayFields = useMemo(() => {
    if (!form) return [];
    return form.fields
      .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
      .slice(0, 6);
  }, [form]);

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

  // Filter and sort responses
  const filteredResponses = useMemo(() => {
    let filtered = responses;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((response) => {
        const answersStr = JSON.stringify(response.answers).toLowerCase();
        if (answersStr.includes(query)) return true;
        if (response.id.toLowerCase().includes(query)) return true;
        return false;
      });
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
  }, [responses, searchQuery, statusFilter, sortField, sortDirection]);

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
    if (!selectedResponse || !formId) return;

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

  // Handle export
  const handleExportCsv = () => {
    // Export exactly what's shown (the search + status filter), not the full set.
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
      ...allExportFields.map((f) => formatValue(r.answers[f.id], f.type)),
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
  };

  // Format value for display
  const formatValue = (value: unknown, fieldType?: string): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    // File upload: show filenames
    if (fieldType === 'file_upload' && Array.isArray(value)) {
      return value.map((f: unknown) => (f && typeof f === 'object' && 'originalFilename' in f) ? (f as Record<string, unknown>).originalFilename : 'File').join(', ') || '-';
    }
    // Location: show coordinates
    if (fieldType === 'location' && value && typeof value === 'object' && 'latitude' in (value as Record<string, unknown>)) {
      const loc = value as Record<string, number>;
      return `${loc.latitude?.toFixed(6)}, ${loc.longitude?.toFixed(6)}`;
    }
    // Date/time locale formatting
    if (typeof value === 'string' && value) {
      if (fieldType === 'date') {
        try { return new Date(value + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { /* fall through */ }
      } else if (fieldType === 'time') {
        try { const [h, m] = value.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch { /* fall through */ }
      } else if (fieldType === 'datetime') {
        try { return new Date(value).toLocaleString(); } catch { /* fall through */ }
      }
    }
    if (Array.isArray(value)) return value.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
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
        title={`${form.title} - Responses`}
        actions={
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate(`/analytics/${formId}`)} title="Back to Analytics">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Analytics</span>
            </Button>
            {storageMode === 'api' && (
              <Button variant="outline" size="sm" onClick={reloadResponses} disabled={isRefreshing} title="Refresh responses">
                <RefreshCw className={`h-4 w-4${isRefreshing ? ' animate-spin' : ''}`} />
                <span className="hidden md:inline ml-2">Refresh</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowEmbedModal(true)} title="Share & Embed" className="hidden sm:flex">
              <Share2 className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Share</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCsvImport(true)} title="Import CSV">
              <Upload className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Import</span>
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={responses.length === 0} title="Export CSV">
              <Download className="h-4 w-4" />
              <span className="hidden md:inline ml-2">Export</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={Users}
            label="Total Responses"
            value={stats.total}
            iconBg="bg-indigo-500/10"
            iconColor="text-indigo-500"
            textColor="text-gray-900 dark:text-white"
          />
          <StatCard
            icon={CalendarDays}
            label="This Week"
            value={stats.thisWeek}
            iconBg="bg-green-500/10"
            iconColor="text-green-500"
            textColor="text-gray-900 dark:text-white"
          />
          <StatCard
            icon={Calendar}
            label="Today"
            value={stats.todayCount}
            iconBg="bg-blue-500/10"
            iconColor="text-blue-500"
            textColor="text-gray-900 dark:text-white"
          />
          <StatCard
            icon={Timer}
            label="Avg. Time"
            value={formatDuration(stats.avgTime)}
            iconBg="bg-amber-500/10"
            iconColor="text-amber-500"
            textColor="text-gray-900 dark:text-white"
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
            <button
              onClick={() => toggleSort('submittedAt')}
              className={cn(
                'px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center gap-2 font-medium cursor-pointer',
                sortField === 'submittedAt'
                  ? 'bg-primary-50 dark:bg-primary-500/10 border-primary-200 dark:border-primary-500/50 text-primary-700 dark:text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'
              )}
            >
              <Calendar className="h-4 w-4" />
              Date {sortField === 'submittedAt' && (sortDirection === 'desc' ? '↓' : '↑')}
            </button>
            <button
              onClick={() => toggleSort('completionTime')}
              className={cn(
                'px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center gap-2 font-medium cursor-pointer',
                sortField === 'completionTime'
                  ? 'bg-primary-50 dark:bg-primary-500/10 border-primary-200 dark:border-primary-500/50 text-primary-700 dark:text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'
              )}
            >
              <Clock className="h-4 w-4" />
              Time {sortField === 'completionTime' && (sortDirection === 'desc' ? '↓' : '↑')}
            </button>
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
            {/* Mobile card list (below sm) — the table hides field columns on phones,
                so render a stacked card showing the date, first answers, and actions. */}
            <ul className="sm:hidden divide-y divide-gray-200 dark:divide-slate-800">
              {paginatedResponses.map((response) => (
                <li key={response.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => handleView(response)}
                      className="min-w-0 flex-1 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{formatDate(response.submittedAt)}</p>
                      {displayFields.slice(0, 2).map((field) => (
                        <p key={field.id} className="mt-1 text-sm text-gray-600 dark:text-slate-300 truncate">
                          <span className="text-gray-400 dark:text-slate-500">{field.label}: </span>
                          {formatValue(response.answers[field.id], field.type)}
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

            <div className="overflow-x-auto hidden sm:block">
              <table className="w-full">
                <thead className="bg-gray-50/50 dark:bg-slate-900/50 border-b border-gray-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Date
                    </th>
                    {displayFields.map((field) => (
                      <th
                        key={field.id}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider hidden sm:table-cell"
                        title={field.label}
                      >
                        <span className="truncate block max-w-[150px]">{field.label}</span>
                      </th>
                    ))}
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Time
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-800 bg-white dark:bg-slate-900/20">
                  {paginatedResponses.map((response) => (
                    <tr key={response.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                        {formatDate(response.submittedAt)}
                      </td>
                      {displayFields.map((field) => (
                        <td
                          key={field.id}
                          className="px-4 py-4 text-sm text-gray-600 dark:text-slate-300 max-w-[200px] truncate hidden sm:table-cell"
                          title={formatValue(response.answers[field.id], field.type)}
                        >
                          {formatValue(response.answers[field.id], field.type)}
                        </td>
                      ))}
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
                    <p className="text-gray-900 dark:text-white">
                      {formatValue(selectedResponse.answers[field.id], field.type) || (
                        <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>
                      )}
                    </p>
                  </div>
                ))}
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
            <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 className="h-4 w-4 mr-2" />
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

  // Read-only for calculated fields
  if (field.type === 'calculated') {
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
