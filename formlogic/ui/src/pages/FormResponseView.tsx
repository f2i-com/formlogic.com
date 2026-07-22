// Full-page owner record view (linked-records feature): replaces the responses
// table's view MODAL. Shows every answer, computed values, metadata, status and
// tags, plus the related-records grids — and edits inline. Route:
// /responses/:formId/:responseId (owner-scoped; local-storage forms supported).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Check, Edit2, Lock, RefreshCw, Trash2, X } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { FileAnswerValue } from '../components/ui/FileAnswerValue';
import { SignatureValue } from '../components/ui/SignatureValue';
import { RelatedRecordsPanel } from '../components/app-runtime/RelatedRecordsPanel';
import { LinkedRecordChips } from '../components/responses/recordDisplay';
import { renderEditField } from '../components/responses/renderEditField';
import {
  asResolvedList, formatValue,
  STATUS_OPTIONS, type ResolvedLink,
} from '../components/responses/recordFormat';
import { VaultUnlockDialog } from '../components/vault/VaultUnlockDialog';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { useAuthStore } from '../stores/authStore';
import { api } from '../lib/api';
import { toast } from '../stores/toastStore';
import { statusBadgeVariant, formatStatusLabel } from '../lib/utils';
import { useAccountTimezone, formatDateTimeInZone } from '../lib/timezone';
import { describeUserAgent, primaryLanguage } from '../lib/userAgent';
import { useDecryptedResponses, useResetOnVaultGenerationChange, CORRUPT_ROW_CODE } from '../lib/crypto/useDecryptedResponses';
import { sealResponseForUpdate } from '../lib/crypto/formCrypto';
import type { Form } from '../types/form';

interface RecordData {
  id: string;
  answers: Record<string, unknown>;
  submittedAt: string;
  status?: string;
  tags?: string[];
  computed?: Record<string, unknown>;
  metadata?: {
    completionTime?: number;
    userAgent?: string;
    ipAddress?: string;
    referrer?: string;
    language?: string;
    submittedByUserId?: string;
  };
  _resolved?: Record<string, ResolvedLink | ResolvedLink[]>;
}

/** A human title for the record: its first non-empty simple answer. */
function recordTitle(form: Form | null, answers: Record<string, unknown>): string {
  for (const f of form?.fields ?? []) {
    if (!['short_text', 'email', 'phone', 'url', 'dropdown', 'number'].includes(f.type)) continue;
    const v = answers[f.id];
    if (v != null && v !== '' && typeof v !== 'object') return String(v);
  }
  return 'Record';
}

// completionTime is stored in MILLISECONDS (Date.now() - startTime) — every other
// surface divides by 1000 before display.
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function FormResponseView() {
  const { formId, responseId } = useParams<{ formId: string; responseId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Platform-chrome page: the signed-in user's account timezone, else their browser's.
  const displayTz = useAccountTimezone();
  const authUser = useAuthStore((s) => s.user);
  const storageMode = useFormStore((s) => s.storageMode);
  const getStoredForm = useFormStore((s) => s.getForm);
  const getLocalResponses = useResponseStore((s) => s.getResponsesByFormId);
  const updateLocalResponse = useResponseStore((s) => s.updateResponse);
  const deleteLocalResponse = useResponseStore((s) => s.deleteResponse);

  const [form, setForm] = useState<Form | null>(null);
  const [record, setRecord] = useState<RecordData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!formId || !responseId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const run = async () => {
      try {
        if (storageMode === 'api') {
          const [fr, rr] = await Promise.all([api.getForm(formId), api.getResponse(formId, responseId)]);
          if (cancelled) return;
          if (!fr.data?.form) { setLoadError(fr.error || 'Form not found'); return; }
          if (!rr.data?.response) { setLoadError(rr.error || 'Record not found'); return; }
          const raw = rr.data.response as unknown as RecordData & { completionTime?: number };
          setForm(fr.data.form);
          setRecord(raw);
        } else {
          const f = getStoredForm(formId) ?? null;
          const local = getLocalResponses(formId).find((r) => r.id === responseId);
          if (cancelled) return;
          if (!f) { setLoadError('Form not found'); return; }
          if (!local) { setLoadError('Record not found'); return; }
          setForm(f);
          const localCt = (local as { completionTime?: number }).completionTime;
          setRecord({ id: local.id, answers: local.answers ?? {}, submittedAt: local.submittedAt, metadata: { completionTime: localCt } });
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load this record');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [formId, responseId, storageMode, getStoredForm, getLocalResponses, reloadTick]);

  // E2EE: a private-form record's `answers` is the stored envelope. Decrypt it in
  // the browser (vault unlocked) and drive the whole view off the decrypted copy.
  const [showUnlock, setShowUnlock] = useState(false);
  const encRows = useMemo(() => (record ? [{ id: record.id, answers: record.answers }] : []), [record]);
  const decrypted = useDecryptedResponses(formId, encRows);
  const isPrivateRecord = decrypted.isPrivate;
  const vaultLocked = decrypted.locked;
  const decRow = decrypted.rows[0] as (typeof decrypted.rows)[0] & { _rev?: number; _encMeta?: { completionTime?: number; language?: string; clientAt?: string }; _encrypted?: boolean; _decryptError?: string } | undefined;

  // Plaintext boundary (review 2026-07-22): an in-progress edit holds DECRYPTED
  // answers in `draft` — a vault generation change (lock / re-unlock) closes the
  // editor and wipes the draft immediately.
  useResetOnVaultGenerationChange(useCallback(() => {
    setEditing(false);
    setDraft({});
  }, []));
  // The record used for display/edit: decrypted answers merged over the raw row.
  const viewRecord = useMemo(() => {
    if (!record) return null;
    if (isPrivateRecord && decRow) return { ...record, answers: decRow.answers };
    return record;
  }, [record, isPrivateRecord, decRow]);

  const startEdit = useCallback(() => {
    if (!viewRecord) return;
    setDraft({ ...viewRecord.answers });
    setEditing(true);
  }, [viewRecord]);

  const saveEdit = useCallback(async () => {
    if (!formId || !record) return;
    setSaving(true);
    try {
      // PRIVATE record: re-seal the COMPLETE record (rev+1) with an expectedRev CAS.
      if (isPrivateRecord && decRow?._encrypted) {
        const expectedRev = decRow._rev ?? 1;
        const { envelope } = await sealResponseForUpdate(formId, record.id, expectedRev, {
          v: 1,
          answers: draft,
          ...(decRow._encMeta ? { meta: decRow._encMeta } : {}),
        });
        const res = await api.updateEncryptedResponse(formId, record.id, envelope, expectedRev);
        if (!res.ok) {
          const body = (res.body ?? {}) as { code?: string; message?: string };
          toast.error(
            body.code === 'revision_conflict' ? 'This record changed elsewhere' : 'Failed to update record',
            body.code === 'revision_conflict' ? 'Reload the page and re-apply your edit.' : (body.message ?? 'Please try again.'),
          );
          return;
        }
        // Swap the stored envelope so the record re-decrypts at the new rev.
        setRecord((prev) => (prev ? { ...prev, answers: envelope as unknown as Record<string, unknown> } : prev));
        setEditing(false);
        toast.success('Record updated', 'Changes saved successfully');
        return;
      }
      if (storageMode === 'api') {
        const result = await api.updateResponse(formId, record.id, { answers: draft });
        if (result.error) { toast.error('Failed to update record', result.error); return; }
      } else {
        updateLocalResponse(record.id, draft);
      }
      setRecord((prev) => (prev ? { ...prev, answers: draft } : prev));
      setEditing(false);
      toast.success('Record updated', 'Changes saved successfully');
    } catch (e) {
      toast.error('Failed to save', e instanceof Error ? e.message : 'An error occurred while saving');
    } finally {
      setSaving(false);
    }
  }, [formId, record, draft, storageMode, updateLocalResponse, isPrivateRecord, decRow]);

  const changeStatus = useCallback(async (newStatus: string) => {
    if (!formId || !record) return;
    const prevStatus = record.status ?? 'submitted';
    setRecord((prev) => (prev ? { ...prev, status: newStatus } : prev));
    if (storageMode === 'api') {
      const result = await api.updateResponse(formId, record.id, { status: newStatus } as Parameters<typeof api.updateResponse>[2]);
      if (result.error) {
        toast.error('Failed to update status', result.error);
        setRecord((prev) => (prev ? { ...prev, status: prevStatus } : prev));
      }
    }
  }, [formId, record, storageMode]);

  const recompute = useCallback(async () => {
    if (!formId || !record) return;
    setRecomputing(true);
    const result = await api.recomputeResponse(formId, record.id);
    setRecomputing(false);
    if (result.error || result.data?.success === false) {
      toast.error('Re-run failed', result.error || result.data?.error || 'Script error');
      return;
    }
    toast.success('Logic re-run', 'The record was recomputed with the latest script.');
    setReloadTick((t) => t + 1);
  }, [formId, record]);

  const confirmDelete = useCallback(async () => {
    if (!formId || !record) return;
    setDeleting(true);
    try {
      if (storageMode === 'api') {
        const result = await api.deleteResponse(formId, record.id);
        if (result.error) { toast.error('Failed to delete', result.error); return; }
      } else {
        deleteLocalResponse(record.id);
      }
      toast.success('Record deleted', 'The record has been removed');
      navigate(`/responses/${formId}`);
    } catch {
      toast.error('Failed to delete', 'An error occurred');
    } finally {
      setDeleting(false);
    }
  }, [formId, record, storageMode, deleteLocalResponse, navigate]);

  // Stable callbacks for the related-records panel — inline closures would give it a
  // new identity every render and force it to refetch (formId/responseId are fixed for
  // this mount, since the route remounts per record).
  const fetchRelated = useCallback(
    () => api.getOwnerRelatedRecords(formId ?? '', responseId ?? '', { limit: 2000, offset: 0 })
      .then((r) => ({ related: r.data?.related, error: typeof r.error === 'string' ? r.error : undefined })),
    [formId, responseId]
  );
  const deleteRelated = useCallback(async (fid: string, rid: string) => { const r = await api.deleteResponse(fid, rid); return !r.error; }, []);
  const openRelated = useCallback((fid: string, rid: string) => navigate(`/responses/${fid}/${rid}`), [navigate]);
  const denyAdd = useCallback(() => false, []);
  const allowDelete = useCallback(() => true, []);

  const fields = (form?.fields ?? []).filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type));
  const completionTime = record?.metadata?.completionTime ?? 0;

  return (
    <div className="min-h-screen transition-colors">
      <Header
        title="Record"
        actions={
          record && !loading ? (
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {editing ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                    <X className="h-4 w-4" />
                    <span className="hidden lg:inline ml-2">Cancel</span>
                  </Button>
                  <Button size="sm" onClick={saveEdit} isLoading={saving}>
                    <Check className="h-4 w-4" />
                    <span className="ml-2">Save</span>
                  </Button>
                </>
              ) : (
                <>
                  {storageMode === 'api' && form?.logicScript && !isPrivateRecord && (
                    <Button variant="outline" size="sm" onClick={recompute} isLoading={recomputing} title="Re-run the form's logic script on this record">
                      <RefreshCw className="h-4 w-4" />
                      <span className="hidden lg:inline ml-2">Re-run logic</span>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={startEdit} disabled={vaultLocked || !!decRow?._decryptError} title={vaultLocked ? 'Unlock your vault to edit' : decRow?._decryptError ? 'This record could not be decrypted' : undefined}>
                    <Edit2 className="h-4 w-4" />
                    <span className="hidden lg:inline ml-2">Edit</span>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDelete(true)} className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden lg:inline ml-2">Delete</span>
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        {/* History-aware back: return to wherever the user came from (the records table,
            another record via a linked chip or related row, Analytics, a dashboard…),
            falling back to this form's records list on a direct load. A separate quiet
            link always offers the list, since "back" may lead somewhere else entirely. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
          <button
            type="button"
            onClick={() => { if (location.key !== 'default') navigate(-1); else navigate(`/responses/${formId}`); }}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <span className="text-gray-300 dark:text-slate-700" aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => navigate(`/responses/${formId}`)}
            className="text-sm text-gray-400 hover:text-gray-700 dark:text-slate-500 dark:hover:text-slate-300 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded truncate max-w-[60vw]"
          >
            {form?.title ? `${form.title} — all records` : 'All records'}
          </button>
        </div>

        {loading ? (
          <div className="space-y-3" role="status" aria-label="Loading record">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : loadError || !record ? (
          <EmptyState
            title="Record not found"
            description={loadError || 'This record may have been deleted.'}
            action={<Button variant="outline" onClick={() => navigate(`/responses/${formId}`)}>Back to records</Button>}
          />
        ) : (
          <>
            {/* Title row: title on the left (truncating), status + timestamp anchored
                to the RIGHT so they don't jump around as record titles change length.
                On phones the controls wrap onto their own line, left-aligned. */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-x-4 gap-y-2 mb-6">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight truncate min-w-0 sm:flex-1">
                {isPrivateRecord && vaultLocked ? 'Encrypted record' : recordTitle(form, (viewRecord ?? record).answers)}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:flex-shrink-0 sm:justify-end">
                {storageMode === 'api' ? (
                  <select
                    value={record.status || 'submitted'}
                    onChange={(e) => changeStatus(e.target.value)}
                    aria-label="Record status"
                    className="px-2.5 py-1 rounded-lg text-sm border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:ring-2 focus:ring-primary-500 focus:outline-none cursor-pointer"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{formatStatusLabel(s)}</option>
                    ))}
                  </select>
                ) : (
                  <Badge variant={statusBadgeVariant(record.status || 'submitted')} className="rounded-full">
                    {formatStatusLabel(record.status || 'submitted')}
                  </Badge>
                )}
                <span className="text-sm text-gray-400 dark:text-slate-500 whitespace-nowrap">
                  Submitted {formatDateTimeInZone(record.submittedAt, displayTz)}
                </span>
              </div>
            </div>

            {isPrivateRecord && vaultLocked && (
              <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4">
                <Lock className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
                  🔒 This record is end-to-end encrypted. Unlock your vault to view or edit it.
                </p>
                <Button size="sm" onClick={() => setShowUnlock(true)}>Unlock vault</Button>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
              {/* Answers */}
              <div className="lg:col-span-2 min-w-0">
                <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5 sm:p-6 space-y-4">
                  {isPrivateRecord && vaultLocked ? (
                    <p className="text-sm text-gray-400 dark:text-slate-500 italic">Unlock your vault to view this record's answers.</p>
                  ) : decRow?._decryptError ? (
                    <div className="rounded-lg border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-4" role="alert">
                      <p className="text-sm font-medium text-red-800 dark:text-red-200">
                        {decRow._decryptError === CORRUPT_ROW_CODE
                          ? '⚠ Corrupt record: stored WITHOUT encryption inside an encrypted form — this indicates server-side corruption or tampering. Its content was not displayed.'
                          : '⚠ This record could not be decrypted. Its content was not displayed.'}
                      </p>
                    </div>
                  ) : fields.map((field) => (
                    <div key={field.id} className="border-b border-gray-100 dark:border-slate-800 pb-4 last:border-0 last:pb-0">
                      <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">{field.label}</p>
                      {editing ? (
                        renderEditField(field, draft[field.id], (value) => setDraft((prev) => ({ ...prev, [field.id]: value })))
                      ) : (
                        <div className="text-gray-900 dark:text-white break-words">
                          {field.type === 'linked_record' ? (
                            <LinkedRecordChips
                              items={asResolvedList(record._resolved?.[field.id])}
                              onOpen={(it) => it.targetFormId && navigate(`/responses/${it.targetFormId}/${it.id}`)}
                            />
                          ) : field.type === 'file_upload' && Array.isArray((viewRecord ?? record).answers[field.id]) && ((viewRecord ?? record).answers[field.id] as unknown[]).length > 0 ? (
                            <FileAnswerValue
                              files={(viewRecord ?? record).answers[field.id] as import('../components/ui/FileAnswerValue').FileAnswerItem[]}
                              linkClassName="text-primary-600 dark:text-primary-400 hover:underline"
                            />
                          ) : field.type === 'signature' ? (
                            // Drawn signatures render as the actual image (typed ones as the
                            // name) so the owner can verify the record was signed at a glance.
                            <SignatureValue value={(viewRecord ?? record).answers[field.id]} />
                          ) : (
                            formatValue((viewRecord ?? record).answers[field.id], field.type, field.properties?.options, displayTz) === '-' ? (
                              <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>
                            ) : (
                              formatValue((viewRecord ?? record).answers[field.id], field.type, field.properties?.options, displayTz)
                            )
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {fields.length === 0 && (
                    <p className="text-sm text-gray-400 dark:text-slate-500 italic">This form has no displayable fields.</p>
                  )}
                </div>

                {/* Related records (owner-scoped) — hidden while editing so a stale grid
                    never sits under half-changed answers. */}
                {formId && responseId && storageMode === 'api' && !editing && (
                  <RelatedRecordsPanel
                    appSlug=""
                    formId={formId}
                    responseId={responseId}
                    fetchRelated={fetchRelated}
                    deleteRecord={deleteRelated}
                    canAddFn={denyAdd}
                    canDeleteFn={allowDelete}
                    onOpenRecord={openRelated}
                  />
                )}
              </div>

              {/* Details sidebar */}
              <div className="space-y-4 min-w-0">
                <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-tight mb-3">Details</h3>
                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="text-gray-500 dark:text-slate-400">Record ID</dt>
                      <dd className="text-gray-700 dark:text-slate-300 font-mono text-xs bg-gray-100 dark:bg-slate-800 px-2 py-1 rounded mt-1 break-all">{record.id}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-500 dark:text-slate-400">Completion time</dt>
                      <dd className="text-gray-900 dark:text-white mt-0.5">{formatDuration(completionTime)}</dd>
                    </div>
                    {record.tags && record.tags.length > 0 && (
                      <div>
                        <dt className="text-gray-500 dark:text-slate-400 mb-1">Tags</dt>
                        <dd className="flex flex-wrap gap-1.5">
                          {record.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                        </dd>
                      </div>
                    )}
                    {/* Submission trail — who/where/what the submission came from (owner-only view). */}
                    {record.metadata?.submittedByUserId && (
                      <div>
                        <dt className="text-gray-500 dark:text-slate-400">Submitted by</dt>
                        <dd className="text-gray-700 dark:text-slate-300 mt-0.5 break-all">
                          {authUser?.id === record.metadata.submittedByUserId
                            ? (authUser?.name || authUser?.email || 'You')
                            : `User ${record.metadata.submittedByUserId.slice(0, 8)}`}
                        </dd>
                      </div>
                    )}
                    {record.metadata?.ipAddress && (
                      <div>
                        <dt className="text-gray-500 dark:text-slate-400">IP address</dt>
                        <dd className="text-gray-700 dark:text-slate-300 font-mono text-xs mt-0.5 break-all">{record.metadata.ipAddress}</dd>
                      </div>
                    )}
                    {record.metadata?.userAgent && (
                      <div>
                        <dt className="text-gray-500 dark:text-slate-400">Browser</dt>
                        <dd className="text-gray-700 dark:text-slate-300 text-xs truncate mt-0.5" title={record.metadata.userAgent}>
                          {describeUserAgent(record.metadata.userAgent) ?? record.metadata.userAgent}
                        </dd>
                      </div>
                    )}
                    {primaryLanguage(record.metadata?.language) && (
                      <div>
                        <dt className="text-gray-500 dark:text-slate-400">Language</dt>
                        <dd className="text-gray-700 dark:text-slate-300 mt-0.5" title={record.metadata?.language}>{primaryLanguage(record.metadata?.language)}</dd>
                      </div>
                    )}
                    {record.metadata?.referrer && (
                      <div>
                        <dt className="text-gray-500 dark:text-slate-400">Referrer</dt>
                        <dd className="text-gray-700 dark:text-slate-300 text-xs truncate mt-0.5" title={record.metadata.referrer}>{record.metadata.referrer}</dd>
                      </div>
                    )}
                  </dl>
                </div>

                {record.computed && Object.keys(record.computed).length > 0 && (
                  <div className="bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-tight mb-3">Computed</h3>
                    <dl className="space-y-3 text-sm">
                      {Object.entries(record.computed).map(([key, value]) => (
                        <div key={key} className="min-w-0">
                          <dt className="text-xs text-gray-500 dark:text-slate-400 truncate" title={key}>{key}</dt>
                          <dd className="text-gray-900 dark:text-white break-words mt-0.5">
                            {value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <ConfirmDialog
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={confirmDelete}
        title="Delete record"
        message="Are you sure you want to delete this record? All data associated with this submission will be permanently removed."
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleting}
      />

      {/* E2EE: unlock dialog for the locked-record banner. */}
      <VaultUnlockDialog isOpen={showUnlock} onClose={() => setShowUnlock(false)} />
    </div>
  );
}

// Remount on every record change so edit state (editing/draft) can NEVER leak from
// one record onto another — navigating record→record (via a chip or a related row)
// reuses this route's component instance, and a stale `draft` saved onto a freshly
// loaded record would overwrite it (potentially wiping fields across forms).
export default function FormResponseViewRoute() {
  const { formId, responseId } = useParams<{ formId: string; responseId: string }>();
  return <FormResponseView key={`${formId}/${responseId}`} />;
}
