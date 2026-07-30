import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { LinkedRecordChips } from '../components/responses/recordDisplay';
import { renderEditField } from '../components/responses/renderEditField';
import {
  asResolvedList, formatValue, linkedText,
  STATUS_OPTIONS, type ResolvedLink,
} from '../components/responses/recordFormat';
import { useAccountTimezone, formatDateTimeInZone } from '../lib/timezone';
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
} from 'lucide-react';
import { Lock } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Modal } from '../components/ui/Modal';
import { Skeleton, ListRowSkeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadFailure } from '../components/ui/LoadFailure';
import { VaultUnlockDialog } from '../components/vault/VaultUnlockDialog';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { api } from '../lib/api';
import { isEncryptedEnvelope } from '../lib/crypto/envelope';
import { useDecryptedResponses, useResetOnVaultGenerationChange, CORRUPT_ROW_CODE } from '../lib/crypto/useDecryptedResponses';
import { sealResponseForUpdate, openResponsesForForm, getFormPrivacyState } from '../lib/crypto/formCrypto';
import { exportPrivateFormCsv } from '../lib/crypto/privateExport';
import { useFittedColumns } from '../hooks/useFittedColumns';
import { toast } from '../stores/toastStore';
import { cn, sanitizeFilename, statusBadgeVariant, formatStatusLabel, parseServerDate } from '../lib/utils';
import { Badge } from '../components/ui/Badge';
import { EmbedModal } from '../components/builder/EmbedModal';
import { CsvImportWizard } from '../components/builder';
import type { Form, LocalFormResponse } from '../types/form';
import { publicUnfillableFieldLabels } from '../lib/publicForm';

const ITEMS_PER_PAGE = 10;

interface ResponseWithStatus extends LocalFormResponse {
  status?: string;
  tags?: string[];
  computed?: Record<string, unknown>;
  // Server-injected labels for linked_record fields, keyed by field id.
  _resolved?: Record<string, ResolvedLink | ResolvedLink[]>;
}

// Private forms decrypt in the browser (E2EE plan SS10): the list view fetches +
// decrypts at most this many rows, with a visible banner - never a silent
// partial. The decrypted CSV export has NO cap (full paged fetch).
const PRIVATE_LIST_CAP = 5000;

// Fetch EVERY response for a form. The API caps each page (default 100, max
// 1000), so a single request silently truncates large forms — corrupting stats,
// search, sort, and CSV export. Loop until exhausted so the page reflects the
// full set. Also normalizes completionTime, which the server nests under
// metadata.completionTime but the UI reads at the top level.
// Privacy is the SERVER-AUTHORITATIVE tri-state (never row-shape inference,
// review 2026-07-22): 'private' applies the PRIVATE_LIST_CAP; 'unknown' falls
// back to first-page envelope detection. ANY failed page aborts loudly — a
// mid-loop failure must never look like a clean final page (silent partial).
async function fetchAllApiResponses(
  formId: string,
  privacy: 'unknown' | 'plain' | 'private' = 'unknown'
): Promise<{ responses: ResponseWithStatus[]; truncated: boolean; privateCap: { shown: number; total: number } | null }> {
  const PAGE = 1000;
  const MAX_PAGES = 100; // 100k safety cap, mirrors the server-side export cap
  const all: ResponseWithStatus[] = [];
  let truncated = false;
  let isPrivate = privacy === 'private';
  let totalCount: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await api.getResponses(formId, { limit: PAGE, offset: page * PAGE });
    const batch = result.data?.responses;
    if (!batch || !Array.isArray(batch)) {
      throw new Error(result.error || `Failed to load responses (page ${page + 1})`);
    }
    if (typeof result.data?.count === 'number') totalCount = result.data.count;
    for (const r of batch) {
      const rr = r as unknown as ResponseWithStatus & { metadata?: { completionTime?: number } };
      all.push({ ...rr, completionTime: rr.completionTime ?? rr.metadata?.completionTime ?? 0 });
    }
    if (page === 0 && privacy === 'unknown') {
      // Transient fallback only: the authoritative state was unavailable.
      isPrivate = batch.some((r) => isEncryptedEnvelope((r as { answers?: unknown }).answers));
    }
    if (isPrivate && all.length >= PRIVATE_LIST_CAP) {
      const total = totalCount ?? all.length;
      return {
        responses: all.slice(0, PRIVATE_LIST_CAP),
        truncated: false,
        privateCap: total > PRIVATE_LIST_CAP ? { shown: PRIVATE_LIST_CAP, total } : null,
      };
    }
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      // Reached the cap on a full page — probe one more page to avoid a false
      // "truncated" when the total is an exact multiple of MAX_PAGES*PAGE.
      const probe = await api.getResponses(formId, { limit: 1, offset: MAX_PAGES * PAGE });
      truncated = !!probe.data?.responses && probe.data.responses.length > 0;
    }
  }
  return { responses: all, truncated, privateCap: null };
}


// Status pills render via the shared <Badge> (statusBadgeVariant in lib/utils),
// so the responses table, response detail, and members list stay in one palette.

/** Row-level text for a record that failed to decrypt or is corrupt (E2EE). */
function rowErrorText(code: string | undefined): string {
  return code === CORRUPT_ROW_CODE
    ? '⚠ Corrupt record: stored without encryption'
    : '⚠ Could not decrypt this record';
}

// Stats card component for consistency
// StatCard is the shared component (imported) — same metric tiles as Dashboard/Analytics.

function FormResponses() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Platform-chrome page: the owner's account timezone, else their browser's.
  const displayTz = useAccountTimezone();
  const storageMode = useFormStore((state) => state.storageMode);
  const getForm = useFormStore((state) => state.getForm);
  const refreshForms = useFormStore((state) => state.refreshForms);
  const localResponses = useResponseStore((state) => state.getResponsesByFormId);
  const deleteLocalResponse = useResponseStore((state) => state.deleteResponse);
  const updateLocalResponse = useResponseStore((state) => state.updateResponse);

  const [form, setForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<ResponseWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Distinguish "no responses" from "couldn't read them" — see LoadFailure.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedResponse, setSelectedResponse] = useState<ResponseWithStatus | null>(null);
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
  // E2EE private-form state: 5000-row list cap info, unlock dialog, decrypted export progress.
  const [privateCapInfo, setPrivateCapInfo] = useState<{ shown: number; total: number } | null>(null);
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const [privateExportProgress, setPrivateExportProgress] = useState<{ fetched: number; decrypted: number; total: number | null; confirmCancel: boolean } | null>(null);
  const privateExportCancelRef = useRef(false);

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

      // Load responses. Privacy comes from the server-authoritative state first
      // (cached), so a private form's list cap never depends on row shapes.
      if (storageMode === 'api') {
        try {
          const privacy = await getFormPrivacyState(formId).catch(() => 'unknown' as const);
          const { responses: all, truncated, privateCap } = await fetchAllApiResponses(formId, privacy);
          if (cancelled) return;
          setResponses(all);
          setPrivateCapInfo(privateCap);
          setLoadError(null);
          if (truncated) {
            toast.error('Showing first 100,000 responses', 'This form has more responses than can be displayed at once.');
          }
        } catch (e) {
          if (cancelled) return;
          // A toast that scrolls away is not a state. Without this the table below fell
          // through to "No responses yet — share your form", telling an owner with 300
          // records that nobody had replied.
          setLoadError(e instanceof Error ? e.message : 'Unknown error');
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
  // Mirrored so reloadResponses can tell "retry of a failed first load" (nothing on
  // screen — surface the failure) from "background refresh" (keep what we have).
  const responsesRef = useRef(responses);
  responsesRef.current = responses;
  const reloadResponses = useCallback(async () => {
    if (!formId || storageMode !== 'api') return;
    const fid = formId;
    setIsRefreshing(true);
    try {
      const privacy = await getFormPrivacyState(fid).catch(() => 'unknown' as const);
      const { responses: all, privateCap } = await fetchAllApiResponses(fid, privacy);
      if (formIdRef.current === fid) {
        setResponses(all); // drop stale result if navigated away
        setPrivateCapInfo(privateCap);
        setLoadError(null);
      }
    } catch (e) {
      // A background refresh keeps the current data and stays quiet. But this is also
      // the explicit Retry behind the load-failure panel, so record the failure —
      // otherwise a failed retry cleared the panel and fell through to "No responses
      // yet", which is the lie the panel exists to prevent.
      if (formIdRef.current === fid && responsesRef.current.length === 0) {
        setLoadError(e instanceof Error ? e.message : 'Unknown error');
      }
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

  // E2EE: for a private form the loaded rows carry ciphertext envelopes. Decrypt
  // them in the browser (vault must be unlocked) and drive every derived view off
  // the DECRYPTED rows. Plain forms pass straight through (isPrivate=false).
  const decrypted = useDecryptedResponses(formId, responses);
  const viewResponses = decrypted.rows as ResponseWithStatus[];
  const isPrivateForm = decrypted.isPrivate;
  const vaultLocked = decrypted.locked;
  const corruptRowCount = useMemo(
    () => Object.values(decrypted.errors).filter((c) => c === CORRUPT_ROW_CODE).length,
    [decrypted.errors],
  );

  // Plaintext boundary (review 2026-07-22): the edit modal holds DECRYPTED answers
  // in local state, so a vault generation change (lock / re-unlock) must close it
  // and wipe the draft IMMEDIATELY — never let decrypted state outlive the vault.
  useResetOnVaultGenerationChange(useCallback(() => {
    setIsEditModalOpen(false);
    setSelectedResponse(null);
    setEditedAnswers({});
  }, []));

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
  // Recent Responses rows) — redirect to the record's own page (replace, so
  // back returns to wherever the caller came from, not this transient URL).
  const openParamHandled = useRef(false);
  useEffect(() => {
    if (openParamHandled.current || !formId) return;
    const openId = searchParams.get('open');
    if (!openId) return;
    openParamHandled.current = true;
    navigate(`/responses/${formId}/${openId}`, { replace: true });
  }, [formId, searchParams, navigate]);

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
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const today = new Date().toDateString();

    let thisWeek = 0;
    let lastWeek = 0;
    let todayCount = 0;
    for (const r of viewResponses) {
      const d = parseServerDate(r.submittedAt);
      const t = d.getTime();
      if (t > weekAgo) thisWeek++;
      else if (t > twoWeeksAgo) lastWeek++;
      if (d.toDateString() === today) todayCount++;
    }
    const avgTime = viewResponses.length > 0
      ? viewResponses.reduce((acc, r) => acc + (r.completionTime || 0), 0) / viewResponses.length
      : 0;

    return {
      total: viewResponses.length,
      thisWeek,
      todayCount,
      avgTime,
      // null = no prior week to compare against
      weeklyPct: lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null,
    };
  }, [viewResponses]);

  // Precompute a lowercased search haystack per response ONCE (keyed on the
  // DECRYPTED rows for private forms), so typing in the search box is a cheap
  // substring scan instead of re-serializing every response's answers on every keystroke.
  const searchIndex = useMemo(
    () => viewResponses.map((r) => {
      // Also index the resolved linked-record labels so a search for "Ada Lovelace" matches a
      // Deal that links to her — the raw answers only hold the target UUID.
      const linkText = r._resolved
        ? Object.values(r._resolved).flatMap((v) => asResolvedList(v).map((x) => x.display)).join(' ')
        : '';
      // Index what the table SHOWS, not only what is stored. Choice fields store
      // `option_2` while displaying "Needs a callback", and dates store an ISO string
      // while displaying "28 Jul 2026" — so searching for the words on screen found
      // nothing. Every field is indexed, not just the columns that happen to fit.
      const displayText = (form?.fields ?? [])
        .map((f) => formatValue(r.answers[f.id], f.type, f.properties?.options, displayTz))
        .join(' ');
      // The raw JSON stays appended so pasting a stored value still matches.
      return {
        r,
        hay: (displayText + ' ' + JSON.stringify(r.answers) + ' ' + r.id + ' ' + linkText).toLowerCase(),
      };
    }),
    [viewResponses, form, displayTz]
  );

  // Filter and sort responses
  const filteredResponses = useMemo(() => {
    let filtered = viewResponses;

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
  }, [viewResponses, searchIndex, searchQuery, statusFilter, sortField, sortDirection]);

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

  // Open the record's own page (the view modal is retired — records are full pages now).
  const handleView = (response: ResponseWithStatus) => {
    navigate(`/responses/${formId}/${response.id}`);
  };

  // Handle edit response
  const handleEdit = (response: ResponseWithStatus) => {
    // Never open the editor on a record that failed to decrypt / is corrupt —
    // its answers are empty placeholders and saving would destroy the record.
    if ((response as { _decryptError?: string })._decryptError) return;
    setSelectedResponse(response);
    setEditedAnswers({ ...response.answers });
    setIsEditModalOpen(true);
  };

  // Handle save edit
  const handleSaveEdit = async () => {
    if (!selectedResponse || !formId) return;

    setIsSaving(true);
    try {
      // PRIVATE form: re-seal the COMPLETE record (rev+1) and CAS on expectedRev.
      const enc = selectedResponse as unknown as { _encrypted?: boolean; _rev?: number; _encMeta?: { completionTime?: number; language?: string; clientAt?: string } };
      if (isPrivateForm && enc._encrypted) {
        const expectedRev = enc._rev ?? 1;
        const { envelope } = await sealResponseForUpdate(formId, selectedResponse.id, expectedRev, {
          v: 1,
          answers: editedAnswers,
          ...(enc._encMeta ? { meta: enc._encMeta } : {}),
        });
        const res = await api.updateEncryptedResponse(formId, selectedResponse.id, envelope, expectedRev);
        if (!res.ok) {
          const body = (res.body ?? {}) as { code?: string; message?: string };
          toast.error(
            body.code === 'revision_conflict' ? 'This record changed elsewhere' : 'Failed to update response',
            body.code === 'revision_conflict' ? 'Reload the page and re-apply your edit.' : (body.message ?? 'Please try again.'),
          );
          return;
        }
        // Swap the stored envelope so the row re-decrypts at the new rev.
        setResponses((prev) => prev.map((r) => (r.id === selectedResponse.id ? { ...r, answers: envelope as unknown as Record<string, unknown> } : r)));
        toast.success('Response updated', 'Changes saved successfully');
        setIsEditModalOpen(false);
        return;
      }
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
      formatDateTimeInZone(r.submittedAt, displayTz),
      r.status ?? 'submitted',
      ...allExportFields.map((f) =>
        f.type === 'linked_record'
          ? linkedText(linksFor(r, f.id))
          : formatValue(r.answers[f.id], f.type, f.properties?.options, displayTz)
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

  // PRIVATE forms: the server only holds ciphertext, so a full CSV export is a
  // full paged fetch + browser decrypt (plan SS10) - no search cap, cancel names
  // the file '-partial'.
  const handleExportPrivateCsv = async () => {
    if (!form) return;
    setExportMenuOpen(false);
    privateExportCancelRef.current = false;
    setPrivateExportProgress({ fetched: 0, decrypted: 0, total: null, confirmCancel: false });
    try {
      const result = await exportPrivateFormCsv(
        {
          fetchPage: async (offset, limit) => {
            const r = await api.getResponses(form.id, { limit, offset });
            // Failure integrity (review 2026-07-22): a failed or misshapen page
            // ABORTS the export — it must never pass for an empty final page.
            if (r.error || !Array.isArray(r.data?.responses)) {
              throw new Error(`Could not fetch a page of responses (${r.error ?? `server error ${r.status ?? ''}`}). The export was aborted — no file was produced.`);
            }
            const rows = (r.data?.responses ?? []).map((x) => {
              const row = x as unknown as { id: string; answers: Record<string, unknown>; submittedAt: string; status?: string };
              return { id: row.id, answers: row.answers, submittedAt: row.submittedAt, status: row.status };
            });
            return { rows, count: r.data?.count ?? null };
          },
          decryptRows: (rows) => openResponsesForForm(form.id, rows),
          formatDate: (iso) => formatDateTimeInZone(iso, displayTz),
        },
        {
          fields: form.fields,
          displayTz,
          onProgress: (p) => setPrivateExportProgress((prev) => ({ ...p, confirmCancel: prev?.confirmCancel ?? false })),
          shouldCancel: () => privateExportCancelRef.current,
        },
      );
      const suffix = result.partial ? '-partial' : '';
      const blob = new Blob(['\ufeff' + result.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename(form.title)}-responses${suffix}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(result.partial ? 'Partial export ready' : 'Export ready', `${result.rowCount} record${result.rowCount === 1 ? '' : 's'} decrypted.`);
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : 'Could not export responses.');
    } finally {
      setPrivateExportProgress(null);
    }
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
    asResolvedList(response._resolved?.[fieldId]);  // Format date (server timestamps are UTC) in the viewer's display timezone.
  const formatDate = (dateStr: string) => {
    const date = parseServerDate(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: displayTz,
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
          // Labels and the secondary actions are gated on the HEADER's own width
          // (@…/header), never the viewport: `main` is inset by the sidebar and the
          // docked chat, so `lg:` revealed the labels at exactly the widths where the
          // header had least room and the account menu was silently clipped away.
          // Share and Import both need a desktop (an embed target, a file to pick), so
          // a phone-width header drops them rather than crowding the primary actions.
          <div className="flex gap-1.5 sm:gap-2">
            {storageMode === 'api' && (
              <Button variant="outline" size="sm" onClick={reloadResponses} disabled={isRefreshing} title="Refresh responses">
                <RefreshCw className={`h-4 w-4${isRefreshing ? ' animate-spin' : ''}`} />
                <span className="ml-2 hidden @4xl/header:inline">Refresh</span>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowEmbedModal(true)} title="Share & Embed" className="hidden @lg/header:flex">
              <Share2 className="h-4 w-4" />
              <span className="ml-2 hidden @4xl/header:inline">Share</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCsvImport(true)} title="Import CSV" className="hidden @lg/header:flex">
              <Upload className="h-4 w-4" />
              <span className="ml-2 hidden @4xl/header:inline">Import</span>
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
                <span className="ml-2 hidden @4xl/header:inline">Export</span>
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
              {exportMenuOpen && (
                <div role="menu" aria-label="Export options" className="absolute right-0 mt-1.5 w-72 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-800 py-1 z-50">
                  {/* Private forms: server exports are ciphertext (§9.2 refuses the
                      answer-bearing ones). Offer a full-decrypt CSV instead; SQLite
                      (ciphertext bundle) stays available. */}
                  {storageMode === 'api' && isPrivateForm && (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={handleExportPrivateCsv}
                      disabled={vaultLocked}
                      title={vaultLocked ? 'Unlock your vault to export' : 'Fetch and decrypt every record, then export CSV'}
                      className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <Download className="h-4 w-4 text-purple-500 dark:text-purple-400" />
                      Spreadsheet (.csv) — every record, decrypted
                    </button>
                  )}
                  {storageMode === 'api' && !isPrivateForm && (
                    <>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportServerCsv}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <Download className="h-4 w-4 text-purple-500 dark:text-purple-400" />
                        Spreadsheet (.csv) — opens in Excel or Sheets
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={handleExportJson}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                      >
                        <FileJson className="h-4 w-4 text-green-500 dark:text-green-400" />
                        Data file (.json) — for developers
                      </button>
                    </>
                  )}
                  {storageMode === 'api' && (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={handleExportSqlite}
                      className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer"
                    >
                      <Database className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                      Database file (.sqlite){isPrivateForm ? ' — still encrypted' : ''}
                    </button>
                  )}
                  <button
                    role="menuitem"
                    type="button"
                    onClick={handleExportFilteredCsv}
                    disabled={filteredResponses.length === 0 || vaultLocked}
                    title={vaultLocked ? 'Unlock your vault to export' : filteredResponses.length === 0 ? 'No responses match the current search and status filters' : 'Export only the rows matching the current filters'}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-700 dark:text-slate-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <Filter className="h-4 w-4 text-amber-500 dark:text-amber-400" />
                    Spreadsheet (.csv) — only what your filters show
                  </button>
                  {/* Only the last option respects the search/status filters. That was
                      never stated, so an owner who had filtered to 12 rows could get all
                      300 and not notice. */}
                  <p className="border-t border-gray-100 px-3 py-2 text-[11px] text-gray-500 dark:border-slate-800 dark:text-slate-400">
                    Everything above downloads all records, ignoring your current filters.
                  </p>
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

        {/* E2EE: locked vault - private data is hidden until unlocked. */}
        {isPrivateForm && vaultLocked && (
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4">
            <Lock className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
              🔒 This form is end-to-end encrypted. Unlock your vault to view and search its responses.
            </p>
            <Button size="sm" onClick={() => setShowUnlockDialog(true)}>Unlock vault</Button>
          </div>
        )}

        {/* E2EE: progressive-fetch cap banner (plan SS10) - never a silent partial. */}
        {isPrivateForm && !vaultLocked && privateCapInfo && (
          <div className="mb-6 rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 p-3 text-sm text-blue-800 dark:text-blue-200">
            Searched the first {privateCapInfo.shown.toLocaleString()} of {privateCapInfo.total.toLocaleString()} records. Use the decrypted spreadsheet export for the complete set.
          </div>
        )}

        {/* E2EE corruption banner: a private form must hold ONLY envelopes — any
            plaintext-shaped row is server-side corruption/tampering, surfaced loudly
            (never rendered as plaintext, never silently skipped). */}
        {isPrivateForm && !vaultLocked && corruptRowCount > 0 && (
          <div className="mb-6 rounded-xl border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200" role="alert">
            {corruptRowCount} record{corruptRowCount === 1 ? '' : 's'} in this encrypted form {corruptRowCount === 1 ? 'is' : 'are'} stored WITHOUT encryption — this should be impossible and indicates corruption or tampering. {corruptRowCount === 1 ? 'It was' : 'They were'} not displayed.
          </div>
        )}

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
            trend={{ pct: stats.weeklyPct, label: 'vs last week' }}
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <input
                placeholder="Search responses..."
                aria-label="Search responses"
                value={searchQuery}
                disabled={isPrivateForm && vaultLocked}
                title={isPrivateForm && vaultLocked ? 'Unlock your vault to search' : undefined}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
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
        {loadError ? (
          <LoadFailure
            title="We couldn't load this form's responses"
            message={loadError}
            onRetry={() => { setLoadError(null); reloadResponses(); }}
          />
        ) : responses.length === 0 ? (
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
                      {displayFields.slice(0, 4).map((field, fieldIndex) => (
                        <p key={field.id} className="mt-1 text-sm text-gray-600 dark:text-slate-300 truncate">
                          <span className="text-gray-400 dark:text-slate-500">{field.label}: </span>
                          {/* Locked vault: rows render the lock text, never decrypted bytes. */}
                          {isPrivateForm && vaultLocked
                            ? (fieldIndex === 0 ? '🔒 Encrypted — unlock to view' : '—')
                            : (response as { _decryptError?: string })._decryptError
                              ? (fieldIndex === 0
                                ? <span className="text-red-600 dark:text-red-400">{rowErrorText((response as { _decryptError?: string })._decryptError)}</span>
                                : '—')
                              : field.type === 'linked_record'
                                ? linkedText(linksFor(response, field.id))
                                : formatValue(response.answers[field.id], field.type, field.properties?.options, displayTz)}
                        </p>
                      ))}
                      <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">{formatDuration(response.completionTime || 0)}</p>
                    </button>
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => handleView(response)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-primary-50 hover:text-primary-600 cursor-pointer dark:hover:bg-primary-500/10" aria-label="View response details">
                        <Eye className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleEdit(response)}
                        disabled={isPrivateForm && vaultLocked}
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:hover:bg-blue-500/10"
                        aria-label="Edit response"
                        title={isPrivateForm && vaultLocked ? 'Unlock your vault to edit' : 'Edit response'}
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button onClick={() => handleDeleteConfirm(response)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 cursor-pointer dark:hover:bg-red-500/10" aria-label="Delete response">
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
                    <tr
                      key={response.id}
                      onClick={() => handleView(response)}
                      title="Open this response"
                      className="even:bg-gray-50/60 dark:even:bg-slate-800/20 hover:bg-gray-100/80 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
                    >
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
                      {visibleFields.map((field, fieldIndex) => {
                        const isLinked = field.type === 'linked_record';
                        const decryptError = (response as { _decryptError?: string })._decryptError;
                        // Locked vault: the first answer column carries the lock text
                        // (never decrypted bytes, never a spinner pretending to load).
                        const locked = isPrivateForm && vaultLocked;
                        const plain = locked
                          ? (fieldIndex === 0 ? '🔒 Encrypted — unlock to view' : '-')
                          : decryptError
                            ? (fieldIndex === 0 ? rowErrorText(decryptError) : '-')
                            : isLinked
                              ? linkedText(linksFor(response, field.id))
                              : formatValue(response.answers[field.id], field.type, field.properties?.options, displayTz);
                        const isEmpty = plain === '-';
                        return (
                          <td
                            key={field.id}
                            className={cn(
                              'px-4 py-4 text-sm',
                              // The first answer column is the row's de-facto title — give it primary ink.
                              fieldIndex === 0 && !isEmpty ? 'font-medium text-gray-900 dark:text-white' : 'text-gray-600 dark:text-slate-300',
                              isLinked ? 'align-middle overflow-hidden' : 'truncate'
                            )}
                            title={plain}
                          >
                            {isLinked
                              ? <LinkedRecordChips
                                  items={linksFor(response, field.id)}
                                  onOpen={(it) => it.targetFormId && navigate(`/responses/${it.targetFormId}/${it.id}`)}
                                />
                              : isEmpty
                                ? <span className="text-gray-300 dark:text-slate-600">—</span>
                                : plain}
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
                        {/* The row itself opens the record — the buttons stop propagation so
                            edit/delete never ALSO trigger the row's view handler. */}
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleView(response); }}
                            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-primary-50 hover:text-primary-600 cursor-pointer dark:hover:bg-primary-500/10"
                            title="View details"
                            aria-label="View response details"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleEdit(response); }}
                            disabled={isPrivateForm && vaultLocked}
                            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:hover:bg-blue-500/10"
                            title={isPrivateForm && vaultLocked ? 'Unlock your vault to edit' : 'Edit response'}
                            aria-label="Edit response"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteConfirm(response); }}
                            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 cursor-pointer dark:hover:bg-red-500/10"
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

      {/* Delete Confirmation Modal — named for assistive tech (audit FL-27): the
          dialog renders its own heading, so the accessible name rides ariaLabel. */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        size="sm"
        showCloseButton={false}
        ariaLabel="Delete response"
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
        publicUnfillableFields={publicUnfillableFieldLabels(form.fields)}
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
              const { responses: all, privateCap } = await fetchAllApiResponses(formId);
              setResponses(all);
              setPrivateCapInfo(privateCap);
            } catch {
              // Responses will refresh on next page load
            }
            // Refresh forms list so response counts are updated
            refreshForms();
          }
        }}
      />

      {/* E2EE: unlock dialog for the locked-state banner. */}
      <VaultUnlockDialog isOpen={showUnlockDialog} onClose={() => setShowUnlockDialog(false)} />

      {/* E2EE: full-decrypt CSV export progress (plan SS10). */}
      <Modal
        isOpen={privateExportProgress !== null}
        onClose={() => {
          if (privateExportProgress && !privateExportProgress.confirmCancel) {
            setPrivateExportProgress({ ...privateExportProgress, confirmCancel: true });
          }
        }}
        title="Decrypting and exporting"
        size="sm"
      >
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Fetched {privateExportProgress?.fetched ?? 0}
            {privateExportProgress?.total != null ? ` of ${privateExportProgress.total}` : ''} records; decrypted {privateExportProgress?.decrypted ?? 0}.
          </p>
          {privateExportProgress?.confirmCancel ? (
            <div className="space-y-3">
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Cancel now? The file will be saved with a <span className="font-mono">-partial</span> suffix.
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => privateExportProgress && setPrivateExportProgress({ ...privateExportProgress, confirmCancel: false })}>
                  Keep exporting
                </Button>
                <Button size="sm" variant="danger" onClick={() => { privateExportCancelRef.current = true; }}>
                  Cancel export
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => privateExportProgress && setPrivateExportProgress({ ...privateExportProgress, confirmCancel: true })}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export default FormResponses;
