// Full-page owner record view (linked-records feature): replaces the responses
// table's view MODAL. Shows every answer, computed values, metadata, status and
// tags, plus the related-records grids — and edits inline. Route:
// /responses/:formId/:responseId (owner-scoped; local-storage forms supported).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { CalendarDays, Check, ChevronLeft, ChevronRight, CircleDot, Edit2, Lock, RefreshCw, Timer, Trash2, User, X } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { PageBody } from '../components/layout/PageBody';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
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
import { deferEffect } from '../lib/deferredEffect';
import { isDemoLocalId } from '../lib/demoLocal';
import { toast } from '../stores/toastStore';
import { cn, statusBadgeVariant, formatStatusLabel } from '../lib/utils';
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

  useEffect(() => deferEffect(() => {
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
  }), [formId, responseId, storageMode, getStoredForm, getLocalResponses, reloadTick]);

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

  // The responses a list handed over when it opened this one (router state `responseIds`, in
  // the list's own order): with them the page can step to the one before and the one after.
  // Opened any other way (a link, a reload of a shared address) there are none and no arrows.
  const siblingIds = (location.state as { responseIds?: unknown } | null)?.responseIds;
  const siblings = Array.isArray(siblingIds) ? siblingIds.filter((id): id is string => typeof id === 'string') : [];
  const position = responseId ? siblings.indexOf(responseId) : -1;
  // Stepping replaces this page in history, so Back still returns to the list it came from.
  const step = (to: number) => navigate(`/responses/${formId}/${siblings[to]}`, { replace: true, state: location.state });

  const shown = viewRecord ?? record;
  const title = !record ? 'Record' : isPrivateRecord && vaultLocked ? 'Encrypted record' : recordTitle(form, (shown ?? record).answers);
  const status = record?.status || 'submitted';
  // The record's facts, as the strip of facts over the list of responses (FormResponses).
  const submittedBy = record?.metadata?.submittedByUserId
    ? (authUser?.id === record.metadata.submittedByUserId
      ? (authUser?.name || authUser?.email || 'You')
      : `User ${record.metadata.submittedByUserId.slice(0, 8)}`)
    : null;
  // One answer, or one detail, as a row: its name beside its value where the box has room
  // for two columns, over it where it does not.
  const ROW = 'grid gap-x-4 gap-y-0.5 border-b border-gray-100 py-2 last:border-b-0 last:pb-0 first:pt-0 dark:border-slate-800';
  const ROW_NAME = 'min-w-0 text-[13px] font-medium leading-5 text-gray-500 [overflow-wrap:anywhere] dark:text-slate-400';

  return (
    <div className="min-h-screen transition-colors">
      <Header
        title="Record"
        actions={
          record && !loading ? (
            // The words give way to the icons by the header's own width (the sidebar and a
            // docked chat take their share of the window), never by the screen's.
            <div className="flex gap-1.5 sm:gap-2">
              {editing ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving} title="Cancel">
                    <X className="h-4 w-4" />
                    <span className="ml-2 hidden @2xl/header:inline">Cancel</span>
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
                      <span className="ml-2 hidden @3xl/header:inline">Re-run logic</span>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={startEdit} disabled={vaultLocked || !!decRow?._decryptError} title={vaultLocked ? 'Unlock your vault to edit' : decRow?._decryptError ? 'This record could not be decrypted' : 'Edit'}>
                    <Edit2 className="h-4 w-4" />
                    <span className="ml-2 hidden @2xl/header:inline">Edit</span>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDelete(true)} title="Delete" className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
                    <Trash2 className="h-4 w-4" />
                    <span className="ml-2 hidden @2xl/header:inline">Delete</span>
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      {/* The page frame every workspace page has: the header's gutter, the window's width. */}
      <PageBody className="@container/record">
        {/* History-aware back: return to wherever the user came from (the records table,
            another record via a linked chip or related row, Analytics, a dashboard…),
            falling back to this form's records list on a direct load. A separate quiet
            link always offers the list, since "back" may lead somewhere else entirely. */}
        <PageHeader
          title={loading ? 'Record' : title}
          subtitle={
            <button
              type="button"
              onClick={() => navigate(`/responses/${formId}`)}
              className="max-w-full cursor-pointer truncate rounded text-left align-top transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:text-white max-sm:min-h-11"
            >
              {form?.title ? `${form.title} — all records` : 'All records'}
            </button>
          }
          onBack={() => { if (location.key !== 'default') navigate(-1); else navigate(`/responses/${formId}`); }}
          backLabel="Back"
          actions={position >= 0 && siblings.length > 1 ? (
            <div className="flex items-center gap-1" role="group" aria-label="Other records of this list">
              <Button variant="outline" size="sm" className="px-2 max-sm:min-w-11" onClick={() => step(position - 1)} disabled={position === 0 || editing} aria-label="Previous record" title="Previous record">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="hidden px-1 text-xs tabular-nums text-gray-500 dark:text-slate-400 @md/record:inline">{position + 1} of {siblings.length}</span>
              <Button variant="outline" size="sm" className="px-2 max-sm:min-w-11" onClick={() => step(position + 1)} disabled={position === siblings.length - 1 || editing} aria-label="Next record" title="Next record">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          ) : undefined}
        />

        {loading ? (
          <div className="space-y-3" role="status" aria-label="Loading record">
            <Skeleton className="h-14 w-full rounded-xl" />
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
            {/* The record's facts as one strip, as the counts stand over the list of responses:
                its status (which the owner sets here), when it came, how long it took, from whom. */}
            <dl className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 dark:border-slate-800 dark:bg-slate-800 @3xl/record:grid-cols-4">
              <div className="flex min-w-0 items-center gap-3 bg-white px-3 py-2 dark:bg-slate-900">
                <CircleDot className="h-4 w-4 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <dt className="truncate text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-slate-400">Status</dt>
                  <dd className="mt-0.5">
                    {storageMode === 'api' ? (
                      <select
                        value={status}
                        onChange={(e) => changeStatus(e.target.value)}
                        aria-label="Record status"
                        className="max-w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white max-sm:min-h-11"
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{formatStatusLabel(s)}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant={statusBadgeVariant(status)} className="rounded-full">
                        {formatStatusLabel(status)}
                      </Badge>
                    )}
                  </dd>
                </div>
              </div>
              {([
                [CalendarDays, 'Submitted', formatDateTimeInZone(record.submittedAt, displayTz)],
                [Timer, 'Completion time', formatDuration(completionTime)],
                [User, 'Submitted by', submittedBy ?? '—'],
              ] as const).map(([Icon, label, value]) => (
                <div key={label} className="flex min-w-0 items-center gap-3 bg-white px-3 py-2 dark:bg-slate-900">
                  <Icon className="h-4 w-4 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
                  <div className="min-w-0">
                    <dt className="truncate text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-slate-400">{label}</dt>
                    <dd className="text-sm font-semibold leading-6 tabular-nums text-gray-900 [overflow-wrap:anywhere] dark:text-white">{value}</dd>
                  </div>
                </div>
              ))}
            </dl>

            {isPrivateRecord && vaultLocked && (
              <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4">
                <Lock className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
                  🔒 This record is end-to-end encrypted. Unlock your vault to view or edit it.
                </p>
                <Button size="sm" onClick={() => setShowUnlock(true)}>Unlock vault</Button>
              </div>
            )}

            {/* The answers take the width; the trail of the submission stands beside them where
                there is room and under them where there is not. */}
            <div className="grid grid-cols-1 items-start gap-4 @4xl/record:grid-cols-[minmax(0,1fr)_20rem]">
              {/* Answers */}
              <div className="min-w-0 space-y-4">
                <Panel title="Answers" className="@container/answers">
                  {isPrivateRecord && vaultLocked ? (
                    <p className="text-sm text-gray-500 dark:text-slate-400">Unlock your vault to view this record's answers.</p>
                  ) : decRow?._decryptError ? (
                    <div className="rounded-lg border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-4" role="alert">
                      <p className="text-sm font-medium text-red-800 dark:text-red-200">
                        {decRow._decryptError === CORRUPT_ROW_CODE
                          ? '⚠ Corrupt record: stored WITHOUT encryption inside an encrypted form — this indicates server-side corruption or tampering. Its content was not displayed.'
                          : '⚠ This record could not be decrypted. Its content was not displayed.'}
                      </p>
                    </div>
                  ) : fields.map((field) => (
                    <div key={field.id} className={cn(ROW, '@lg/answers:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]')}>
                      <p className={cn(ROW_NAME, editing && '@lg/answers:pt-2.5')}>{field.label}</p>
                      {editing ? (
                        <div className="min-w-0 max-w-3xl">
                          {renderEditField(field, draft[field.id], (value) => setDraft((prev) => ({ ...prev, [field.id]: value })))}
                        </div>
                      ) : (
                        <div className="min-w-0 max-w-[80ch] whitespace-pre-line text-sm leading-5 text-gray-900 break-words dark:text-white">
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
                              <span className="text-gray-500 dark:text-slate-400">No answer</span>
                            ) : (
                              formatValue((viewRecord ?? record).answers[field.id], field.type, field.properties?.options, displayTz)
                            )
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {fields.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-slate-400">This form has no displayable fields.</p>
                  )}
                </Panel>

                {/* Related records (owner-scoped) — hidden while editing so a stale grid
                    never sits under half-changed answers. */}
                {formId && responseId && storageMode === 'api' && !isDemoLocalId(formId) && !editing && (
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

              {/* Details: the rest of the submission's trail (its status, moment, duration and
                  sender stand in the strip above), each as a name beside its value. */}
              <div className="min-w-0 space-y-4">
                <Panel title="Details">
                  <dl>
                    <div className={cn(ROW, 'grid-cols-[6.5rem_minmax(0,1fr)]')}>
                      <dt className={ROW_NAME}>Record ID</dt>
                      <dd className="font-mono text-xs leading-5 text-gray-700 break-all dark:text-slate-300">{record.id}</dd>
                    </div>
                    {record.tags && record.tags.length > 0 && (
                      <div className={cn(ROW, 'grid-cols-[6.5rem_minmax(0,1fr)]')}>
                        <dt className={ROW_NAME}>Tags</dt>
                        <dd className="flex flex-wrap gap-1.5">
                          {record.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                        </dd>
                      </div>
                    )}
                    {/* Submission trail — who/where/what the submission came from (owner-only view). */}
                    {record.metadata?.ipAddress && (
                      <div className={cn(ROW, 'grid-cols-[6.5rem_minmax(0,1fr)]')}>
                        <dt className={ROW_NAME}>IP address</dt>
                        <dd className="font-mono text-xs leading-5 text-gray-700 break-all dark:text-slate-300">{record.metadata.ipAddress}</dd>
                      </div>
                    )}
                    {record.metadata?.userAgent && (
                      <div className={cn(ROW, 'grid-cols-[6.5rem_minmax(0,1fr)]')}>
                        <dt className={ROW_NAME}>Browser</dt>
                        <dd className="text-[13px] leading-5 text-gray-700 [overflow-wrap:anywhere] dark:text-slate-300" title={record.metadata.userAgent}>
                          {describeUserAgent(record.metadata.userAgent) ?? record.metadata.userAgent}
                        </dd>
                      </div>
                    )}
                    {primaryLanguage(record.metadata?.language) && (
                      <div className={cn(ROW, 'grid-cols-[6.5rem_minmax(0,1fr)]')}>
                        <dt className={ROW_NAME}>Language</dt>
                        <dd className="text-[13px] leading-5 text-gray-700 dark:text-slate-300" title={record.metadata?.language}>{primaryLanguage(record.metadata?.language)}</dd>
                      </div>
                    )}
                    {record.metadata?.referrer && (
                      <div className={cn(ROW, 'grid-cols-[6.5rem_minmax(0,1fr)]')}>
                        <dt className={ROW_NAME}>Referrer</dt>
                        <dd className="text-[13px] leading-5 text-gray-700 [overflow-wrap:anywhere] dark:text-slate-300">{record.metadata.referrer}</dd>
                      </div>
                    )}
                  </dl>
                </Panel>

                {record.computed && Object.keys(record.computed).length > 0 && (
                  <Panel title="Computed">
                    <dl>
                      {Object.entries(record.computed).map(([key, value]) => (
                        <div key={key} className={cn(ROW, 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)]')}>
                          <dt className={cn(ROW_NAME, 'font-mono text-xs')}>{key}</dt>
                          <dd className="min-w-0 text-[13px] leading-5 text-gray-900 break-words dark:text-white">
                            {value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Panel>
                )}
              </div>
            </div>
          </>
        )}
      </PageBody>

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
