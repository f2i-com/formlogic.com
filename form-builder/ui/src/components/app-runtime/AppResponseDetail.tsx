import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Save, Trash2, Pencil, X, Link2, AlertTriangle, Lock } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useAuthStore } from '../../stores/authStore';
import { LinkedRecordInput } from './LinkedRecordInput';
import { RelatedRecordsPanel } from './RelatedRecordsPanel';
import { RecordScreenPanel } from './RecordScreenPanel';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { FileAnswerValue, type FileAnswerItem } from '../ui/FileAnswerValue';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { api } from '../../lib/api';
import { guessRecordLabel, resolveLinkedDisplays } from '../../lib/recordLabel';
import { cn, statusBadgeVariant, formatStatusLabel } from '../../lib/utils';
import { useDisplayTimezone, formatDateTimeInZone, formatDateInZone, formatDateOnly, isIsoDateTime } from '../../lib/timezone';
import { describeUserAgent, primaryLanguage } from '../../lib/userAgent';
import { Badge } from '../ui/Badge';

// Long/wide answer types span both columns of the detail grid.
const FULL_WIDTH_TYPES = ['long_text', 'signature', 'file_upload'];

export function AppResponseDetail() {
  const { appSlug, formId, responseId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const authUser = useAuthStore((s) => s.user);
  const tz = useDisplayTimezone();
  const { config, canEdit, canDelete, canViewOwn, canViewAll, updateResponse, deleteResponse } = useAppRuntimeStore();
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [editedAnswers, setEditedAnswers] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const runtimeForm = config?.forms.find((f) => f.formId === formId);
  // Optional per-record widget (e.g. the call transcript) — rendered above the related panel.
  const recordScreen = runtimeForm?.customScreen?.recordScreen;

  // ?edit=1 deep-links straight into edit mode (singleton settings-style forms land here from
  // the form view). Applied once the record is loaded; view-only roles just see the record.
  const wantEdit = new URLSearchParams(location.search).get('edit') === '1';
  useEffect(() => {
    if (wantEdit && response && formId && canEdit(formId)) setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canEdit is a stable store action
  }, [wantEdit, response, formId]);
  // Exclude layout-only screens (they carry no answer) so they don't render as empty
  // "No answer" rows — or, in edit mode, as bogus editable inputs the backend discards.
  const fields = ((runtimeForm?.fields ?? []) as Array<{ id: string; label: string; type: string; properties?: Record<string, unknown> }>)
    .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type));
  const hasLinkedFields = fields.some((f) => f.type === 'linked_record');

  useEffect(() => {
    if (appSlug && formId && responseId && config) {
       
      setLoading(true);
      setFetchError(null);
      let cancelled = false;
      const fetchFn = hasLinkedFields
        ? api.getAppResponseByIdResolved(appSlug, formId, responseId)
        : api.getAppResponseById(appSlug, formId, responseId);
      // Rows the server never resolved (demo-local records exist only in this browser) get their
      // linked displays labelled client-side from the target forms' records.
      const withClientResolution = async (r: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const linked = fields.filter((f) => f.type === 'linked_record' && (f.properties as { targetFormId?: string } | undefined)?.targetFormId) as Array<{ id: string; properties?: { targetFormId?: string; displayFieldIds?: string[] } }>;
        const answers = (r.answers as Record<string, unknown> | undefined) || {};
        const already = (r._resolved as Record<string, unknown> | undefined) || {};
        const targets = [...new Set(linked.filter((f) => !already[f.id] && answers[f.id] != null && answers[f.id] !== '').map((f) => f.properties!.targetFormId!))];
        if (!targets.length) return r;
        const labelByTarget = new Map<string, Map<string, string>>();
        await Promise.all(targets.map(async (t) => {
          try {
            const res = await api.getAppResponses(appSlug, t, { limit: 500 });
            const targetRows = ((res.data?.responses || []) as Array<{ id: string; answers?: Record<string, unknown> }>);
            const tFields = ((config?.forms.find((x) => x.formId === t)?.fields || []) as Array<{ id: string; label?: string; type: string }>);
            const displayIds = linked.find((f) => f.properties?.targetFormId === t)?.properties?.displayFieldIds;
            const map = new Map<string, string>();
            for (const tr of targetRows) map.set(tr.id, guessRecordLabel(tFields, tr.answers || {}, displayIds));
            labelByTarget.set(t, map);
          } catch { /* target not viewable — leave unresolved */ }
        }));
        return resolveLinkedDisplays([r], linked, labelByTarget)[0];
      };
      fetchFn.then(async (result) => {
        if (cancelled) return;
        if (result.data?.response) {
          let r = result.data.response as Record<string, unknown>;
          if (hasLinkedFields) r = await withClientResolution(r);
          if (cancelled) return;
          setResponse(r);
          setEditedAnswers((r.answers as Record<string, unknown>) ?? {});
        } else if (result.error) {
          setFetchError(result.error);
        }
        setLoading(false);
      }).catch((err) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : 'Failed to load response');
        setLoading(false);
      });
      return () => { cancelled = true; };
    }
    // `fields` derives purely from config+formId (already deps) but is a fresh array per render —
    // listing it would refire the fetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSlug, formId, responseId, config, hasLinkedFields]);

  // History-aware back: return to wherever the user came from (table, related-records
  // panel, linked-record chip), falling back to the responses table on a direct load.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/app/${appSlug}/form/${formId}/responses`);
  };

  if (formId && !canViewOwn(formId) && !canViewAll(formId)) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <EmptyState
          icon={Lock}
          title="No access"
          description="You don't have permission to view this record."
        />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="max-w-4xl mx-auto py-8" role="alert">
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load this record"
          description={fetchError}
          action={
            <button
              type="button"
              onClick={() => navigate(`/app/${appSlug}/form/${formId}/responses`)}
              className="px-4 py-2 text-sm rounded-lg app-btn-primary transition-all duration-200 cursor-pointer"
            >
              Back to responses
            </button>
          }
        />
      </div>
    );
  }

  if (loading || !response || !formId) {
    // Skeleton mirroring the loaded layout: header, answers grid, details side card.
    return (
      <div className="max-w-4xl mx-auto" role="status" aria-label="Loading response">
        <div className="mb-6 flex items-start gap-3">
          <Skeleton className="h-9 w-9 flex-none rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <Skeleton className="h-5 w-48 max-w-full" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
          <Skeleton className="h-9 w-20 rounded-lg" />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start">
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 p-5 lg:order-2 space-y-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 p-5 sm:p-6 lg:order-1">
            <Skeleton className="h-3 w-20 mb-6" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-2 min-w-0">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    if (!formId || !responseId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateResponse(formId, responseId, { answers: editedAnswers }) as Record<string, unknown> | undefined;
      // For linked-record fields the read-only view renders from `_resolved`, not
      // `answers`, so an optimistic answers-only patch would leave stale chips
      // (and links pointing at the old record). Refetch the resolved response.
      if (hasLinkedFields && appSlug) {
        const result = await api.getAppResponseByIdResolved(appSlug, formId, responseId);
        if (result.data?.response) {
          const r = result.data.response as Record<string, unknown>;
          setResponse(r);
          setEditedAnswers((r.answers as Record<string, unknown>) ?? {});
        } else {
          setResponse((prev) => prev ? { ...prev, answers: editedAnswers } : prev);
        }
      } else if (updated) {
        // Use the server's response so recomputed calculated fields don't show stale
        // (pre-edit) values from the optimistic editedAnswers.
        setResponse(updated);
        setEditedAnswers((updated.answers as Record<string, unknown>) ?? {});
      } else {
        setResponse((prev) => prev ? { ...prev, answers: editedAnswers } : prev);
      }
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!formId || !responseId) return;
    setDeleting(true);
    try {
      const success = await deleteResponse(formId, responseId);
      setDeleting(false);
      if (success) {
        setShowDeleteConfirm(false);
        navigate(`/app/${appSlug}/form/${formId}/responses`);
      } else {
        setShowDeleteConfirm(false);
      }
    } catch {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const answers = (editing ? editedAnswers : (response.answers as Record<string, unknown>)) ?? {};
  const status = String(response.status ?? 'submitted');
  const STATUS_OPTIONS = ['submitted', 'reviewed', 'approved', 'rejected', 'archived'] as const;

  const handleStatusChange = async (newStatus: string) => {
    if (!formId || !responseId || newStatus === status) return;
    setSaveError(null);
    const prev = response;
    setResponse({ ...response, status: newStatus }); // optimistic
    try {
      const updated = await updateResponse(formId, responseId, { status: newStatus });
      // A status change doesn't touch answers and the PUT result isn't resolved
      // (no _resolved), so carry the prior resolved linked-record data forward —
      // otherwise linked-record chips revert to raw ids until a refetch.
      if (updated) {
        setResponse({
          ...(updated as Record<string, unknown>),
          _resolved: (prev as Record<string, unknown> | null)?._resolved,
        });
      }
    } catch (err) {
      setResponse(prev); // rollback
      setSaveError(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  // Record identity: first non-empty short_text/email answer (same first-text-answer
  // heuristic the tables use), falling back to a short id.
  const savedAnswers = (response.answers as Record<string, unknown>) ?? {};
  let recordTitle = '';
  for (const f of fields) {
    if (f.type !== 'short_text' && f.type !== 'email') continue;
    const v = savedAnswers[f.id];
    if (typeof v === 'string' && v.trim()) { recordTitle = v.trim(); break; }
  }
  if (!recordTitle) recordTitle = `Record #${String(responseId ?? '').slice(0, 8)}`;

  const formName = runtimeForm?.displayName || 'Response';
  const submittedAtText = response.submittedAt
    ? formatDateTimeInZone(String(response.submittedAt), tz)
    : '—';
  const updatedAtText = response.updatedAt
    ? formatDateTimeInZone(String(response.updatedAt), tz)
    : null;
  const submittedDateShort = response.submittedAt
    ? formatDateInZone(String(response.submittedAt), tz)
    : null;

  const meta = (response.metadata ?? {}) as Record<string, unknown>;
  const submittedByUserId = typeof meta.submittedByUserId === 'string' && meta.submittedByUserId ? meta.submittedByUserId : null;
  const submittedByLabel = submittedByUserId
    ? (authUser?.id === submittedByUserId
        ? (authUser?.name || authUser?.email || 'You')
        : `User ${submittedByUserId.slice(0, 8)}`)
    : null;
  // Submission trail (IP/browser/language): the server includes these ONLY for the
  // app owner — members always receive stripped metadata, so presence = permission.
  const metaIp = typeof meta.ipAddress === 'string' && meta.ipAddress ? meta.ipAddress : null;
  const metaUa = typeof meta.userAgent === 'string' && meta.userAgent ? meta.userAgent : null;
  const metaLanguage = primaryLanguage(typeof meta.language === 'string' ? meta.language : null);
  const tags = Array.isArray(response.tags) ? (response.tags as string[]) : [];

  const microLabel = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500';

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title={recordTitle}
        subtitle={submittedDateShort ? `${formName} · Submitted ${submittedDateShort}` : formName}
        onBack={goBack}
        backLabel="Back"
        actions={
          <>
            {canEdit(formId) && !editing && (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200/80 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-300 transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
            {editing && (
              <>
                <button
                  onClick={() => { setEditing(false); setEditedAnswers((response.answers as Record<string, unknown>) ?? {}); setSaveError(null); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200/80 dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-300 transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                >
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg app-btn-primary disabled:opacity-50 transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                >
                  <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save'}
                </button>
              </>
            )}
            {canDelete(formId) && !editing && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                aria-label="Delete response"
                className="p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </>
        }
      />

      {saveError && (
        <div role="alert" className="flex items-center justify-between text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 px-4 py-3 rounded-lg mb-4 border border-red-100 dark:border-red-500/20">
          <span>{saveError}</span>
          <button type="button" onClick={() => setSaveError(null)} aria-label="Dismiss error" className="ml-2 text-red-400 hover:text-red-600 dark:hover:text-red-300 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start">
        {/* Details side card: created/updated/status/submitted-by/tags */}
        <aside className="lg:order-2 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5">
          <h2 className={cn(microLabel, 'mb-4')}>Details</h2>
          <dl className="space-y-4">
            <div>
              <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">Status</dt>
              <dd>
                {formId && canViewAll(formId) && canEdit(formId) ? (
                  <select
                    value={status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    aria-label="Response status"
                    className="w-full px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:ring-2 focus:ring-[color:var(--app-primary)] focus:outline-none cursor-pointer"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                    ))}
                  </select>
                ) : (
                  <Badge variant={statusBadgeVariant(status)} className="rounded-full">
                    {formatStatusLabel(status)}
                  </Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">Created</dt>
              <dd className="text-sm text-gray-700 dark:text-slate-300 tabular-nums">{submittedAtText}</dd>
            </div>
            {updatedAtText && updatedAtText !== submittedAtText && (
              <div>
                <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">Updated</dt>
                <dd className="text-sm text-gray-700 dark:text-slate-300 tabular-nums">{updatedAtText}</dd>
              </div>
            )}
            {submittedByLabel && (
              <div>
                <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">Submitted by</dt>
                <dd className="text-sm text-gray-700 dark:text-slate-300 break-words">{submittedByLabel}</dd>
              </div>
            )}
            {metaIp && (
              <div>
                <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">IP address</dt>
                <dd className="text-sm text-gray-700 dark:text-slate-300 font-mono text-xs break-all">{metaIp}</dd>
              </div>
            )}
            {metaUa && (
              <div>
                <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">Browser</dt>
                <dd className="text-sm text-gray-700 dark:text-slate-300 break-words" title={metaUa}>
                  {describeUserAgent(metaUa) ?? metaUa}
                </dd>
              </div>
            )}
            {metaLanguage && (
              <div>
                <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1">Language</dt>
                <dd className="text-sm text-gray-700 dark:text-slate-300">{metaLanguage}</dd>
              </div>
            )}
            {tags.length > 0 && (
              <div>
                <dt className="text-xs text-gray-400 dark:text-slate-500 mb-1.5">Tags</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {tags.map((t) => <Badge key={t} variant="default">{t}</Badge>)}
                </dd>
              </div>
            )}
          </dl>
        </aside>

        {/* Answers */}
        <div className="lg:order-1 min-w-0 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5 sm:p-6">
          <h2 className={cn(microLabel, 'mb-5')}>Answers</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
            {fields.map((field) => {
              const isLinked = field.type === 'linked_record';
              const resolved = response._resolved as Record<string, unknown> | undefined;
              const targetFormId = field.properties?.targetFormId as string | undefined;
              const inputId = `resp-edit-${field.id}`;
              const spansFull = FULL_WIDTH_TYPES.includes(field.type) || (editing && isLinked);

              return (
                <div key={field.id} className={cn('min-w-0', spansFull && 'sm:col-span-2')}>
                  <label htmlFor={inputId} className={cn(microLabel, 'mb-1.5')}>
                    {isLinked && <Link2 className="inline h-3 w-3 mr-1 align-[-1px]" />}
                    {field.label}
                  </label>
                  {editing && !isLinked ? (
                    (() => {
                      const editInputClass = "w-full px-3.5 py-2.5 border border-gray-200 dark:border-slate-600 rounded-xl text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-[color:var(--app-primary)] focus:border-transparent transition-all duration-200";
                      const editVal = editedAnswers[field.id];

                      if (field.type === 'number') {
                        return (
                          <input
                            id={inputId}
                            type="number"
                            step="any"
                            value={editVal != null ? String(editVal) : ''}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value);
                              setEditedAnswers({ ...editedAnswers, [field.id]: isNaN(v) ? undefined : v });
                            }}
                            className={editInputClass}
                          />
                        );
                      }
                      if (field.type === 'date') {
                        return <input id={inputId} type="date" value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass} />;
                      }
                      if (field.type === 'time') {
                        return <input id={inputId} type="time" value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass} />;
                      }
                      if (field.type === 'datetime') {
                        return <input id={inputId} type="datetime-local" value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass} />;
                      }
                      if (field.type === 'long_text') {
                        return <textarea id={inputId} value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} rows={4} className={cn(editInputClass, 'resize-none')} />;
                      }
                      if (field.type === 'dropdown') {
                        const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
                        return (
                          <select id={inputId} value={String(editVal ?? '')} onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })} className={editInputClass}>
                            <option value="">Select...</option>
                            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        );
                      }
                      if (field.type === 'multiple_choice') {
                        const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
                        return (
                          <div className="space-y-1.5">
                            {options.map((o) => (
                              <label key={o.value} className="flex items-center gap-2 text-sm text-gray-900 dark:text-slate-200 cursor-pointer">
                                <input type="radio" name={field.id} checked={editVal === o.value} onChange={() => setEditedAnswers({ ...editedAnswers, [field.id]: o.value })} className="app-accent" />
                                {o.label}
                              </label>
                            ))}
                          </div>
                        );
                      }
                      if (field.type === 'checkboxes') {
                        const options = (field.properties?.options as Array<{ value: string; label: string }>) ?? [];
                        const selected = Array.isArray(editVal) ? (editVal as string[]) : [];
                        return (
                          <div className="space-y-1.5">
                            {options.map((o) => (
                              <label key={o.value} className="flex items-center gap-2 text-sm text-gray-900 dark:text-slate-200 cursor-pointer">
                                <input type="checkbox" checked={selected.includes(o.value)} onChange={(e) => {
                                  const newVals = e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value);
                                  setEditedAnswers({ ...editedAnswers, [field.id]: newVals });
                                }} className="app-accent" />
                                {o.label}
                              </label>
                            ))}
                          </div>
                        );
                      }
                      if (field.type === 'rating' || field.type === 'scale') {
                        return (
                          <input
                            id={inputId}
                            type="number"
                            step="1"
                            value={editVal != null ? String(editVal) : ''}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              setEditedAnswers({ ...editedAnswers, [field.id]: isNaN(v) ? undefined : v });
                            }}
                            className={editInputClass}
                          />
                        );
                      }
                      // Structured (object/array/data-URL) values can't be safely edited
                      // as text — feeding them into a text input stringifies and corrupts
                      // them. Keep them read-only; the original (seeded) value is preserved.
                      if (field.type === 'location' || field.type === 'file_upload' || field.type === 'signature' || field.type === 'calculated' || field.type === 'hidden') {
                        return (
                          <p className="text-sm text-gray-400 dark:text-slate-500 italic px-3.5 py-2.5 rounded-xl border border-dashed border-gray-200 dark:border-slate-700">
                            This field can't be edited here — its existing value is preserved on save.
                          </p>
                        );
                      }
                      // Default: text input for short_text, email, phone, url, etc.
                      return (
                        <input
                          id={inputId}
                          type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'url' ? 'url' : 'text'}
                          value={String(editVal ?? '')}
                          onChange={(e) => setEditedAnswers({ ...editedAnswers, [field.id]: e.target.value })}
                          className={editInputClass}
                        />
                      );
                    })()
                  ) : editing && isLinked ? (
                    (() => {
                      const linkedTargetFormId = field.properties?.targetFormId as string | undefined;
                      const displayFieldIds = field.properties?.displayFieldIds as string[] | undefined;
                      const searchFieldIds = field.properties?.searchFieldIds as string[] | undefined;
                      const allowMultiple = field.properties?.allowMultiple as boolean | undefined;
                      if (!linkedTargetFormId || !formId) {
                        return <p className="text-sm text-gray-400 dark:text-slate-500 italic">Linked record field not configured</p>;
                      }
                      return (
                        <LinkedRecordInput
                          formId={formId}
                          targetFormId={linkedTargetFormId}
                          displayFieldIds={displayFieldIds}
                          searchFieldIds={searchFieldIds}
                          allowMultiple={allowMultiple}
                          value={editedAnswers[field.id]}
                          onChange={(val) => setEditedAnswers({ ...editedAnswers, [field.id]: val })}
                          primaryColor="var(--app-primary, #6366f1)"
                        />
                      );
                    })()
                  ) : isLinked && resolved?.[field.id] ? (
                    <div className="text-sm">
                      {(() => {
                        const rv = resolved[field.id] as { id?: string; display?: string } | Array<{ id?: string; display?: string }>;
                        const items = Array.isArray(rv) ? rv : [rv];

                        const renderLinkedItem = (item: { id?: string; display?: string }) => {
                          const isBroken = !item.display || item.display === 'Record not found';
                          if (isBroken) {
                            return (
                              <span
                                key={item.id}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30"
                              >
                                <AlertTriangle className="h-3 w-3" />
                                Record not found
                              </span>
                            );
                          }
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => targetFormId && navigate(`/app/${appSlug}/form/${targetFormId}/responses/${item.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm app-bg-primary-light app-text-primary hover:opacity-80 transition-colors cursor-pointer"
                            >
                              <Link2 className="h-3 w-3" />
                              {item.display}
                            </button>
                          );
                        };

                        return (
                          <div className="flex flex-wrap gap-2">
                            {items.map((item) => renderLinkedItem(item))}
                          </div>
                        );
                      })()}
                    </div>
                  ) : isLinked ? (
                    // Linked answer with no resolution available — never print the raw response id.
                    <div className="text-[15px]">
                      {answers[field.id] != null && answers[field.id] !== ''
                        ? <span className="italic text-gray-400 dark:text-slate-500">Linked record</span>
                        : <span className="text-gray-300 dark:text-slate-600" aria-label="No answer">—</span>}
                    </div>
                  ) : (
                    <div className="text-[15px] text-gray-900 dark:text-slate-100 break-words">
                      {answers[field.id] !== undefined && answers[field.id] !== null && answers[field.id] !== ''
                        ? (() => {
                            const val = answers[field.id];
                            // Boolean yes/no chip
                            if (val === 'yes' || val === 'no') {
                              return (
                                <span className={cn(
                                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                                  val === 'yes' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'
                                )}>
                                  {val === 'yes' ? 'Yes' : 'No'}
                                </span>
                              );
                            }
                            // Date formatting (no timezone shift for a calendar date)
                            if (field.type === 'date' && typeof val === 'string' && val) {
                              return formatDateOnly(val);
                            }
                            // Time formatting
                            if (field.type === 'time' && typeof val === 'string' && val) {
                              try {
                                const [h, m] = val.split(':').map(Number);
                                return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                              } catch { return String(val); }
                            }
                            // Datetime formatting (in the viewer's timezone)
                            if (field.type === 'datetime' && typeof val === 'string' && val) {
                              return formatDateTimeInZone(val, tz);
                            }
                            // Long text: preserve whitespace
                            if (field.type === 'long_text' && typeof val === 'string') {
                              return <span className="whitespace-pre-wrap">{val}</span>;
                            }
                            // File uploads: image thumbnails (cookie-authed) + links for the rest
                            if (field.type === 'file_upload' && Array.isArray(val)) {
                              return (
                                <FileAnswerValue
                                  files={val as FileAnswerItem[]}
                                  linkClassName="app-text-primary hover:underline"
                                />
                              );
                            }
                            // Location: lat, lng (was "[object Object]")
                            if (field.type === 'location' && val && typeof val === 'object' && 'latitude' in (val as object)) {
                              const loc = val as { latitude: number; longitude: number };
                              return `${Number(loc.latitude).toFixed(6)}, ${Number(loc.longitude).toFixed(6)}`;
                            }
                            // Signature: render the drawn image, or show the typed name (never the raw "typed:" prefix)
                            if (field.type === 'signature' && typeof val === 'string') {
                              if (val.startsWith('data:image')) {
                                return <img src={val} alt="Signature" className="max-h-32 border border-gray-200 dark:border-slate-700 rounded-lg bg-white" />;
                              }
                              if (val.startsWith('typed:')) {
                                const n = val.slice(6).trim();
                                return n ? <span style={{ fontFamily: 'cursive' }}>{n}</span> : '—';
                              }
                            }
                            // Choice fields: map stored option values (e.g. "option_2") to
                            // their human labels.
                            if (['dropdown', 'multiple_choice', 'checkboxes'].includes(field.type)) {
                              const opts = (field.properties?.options ?? []) as Array<{ value: string; label?: string }>;
                              const labelFor = (v: unknown) => opts.find((o) => o.value === v)?.label ?? String(v);
                              return Array.isArray(val) ? (val as unknown[]).map(labelFor).join(', ') : labelFor(val);
                            }
                            // Arrays (checkboxes, etc.)
                            if (Array.isArray(val)) return (val as unknown[]).join(', ');
                            // A plain text field holding an ISO-8601 datetime (e.g. the
                            // Aokie Calls started_at/ended_at) shows in the viewer's tz too.
                            if (isIsoDateTime(val)) return formatDateTimeInZone(val, tz);
                            return String(val);
                          })()
                        : <span className="text-gray-300 dark:text-slate-600" aria-label="No answer">—</span>
                      }
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Per-record widget (customScreen.recordScreen): a trusted SDK screen or sandboxed code
          rendered with this record's context — e.g. the call transcript on a Calls row. */}
      {appSlug && formId && responseId && !editing && recordScreen && (
        <RecordScreenPanel
          screen={recordScreen}
          appSlug={appSlug}
          formId={formId}
          responseId={responseId}
          record={{ id: responseId, answers: savedAnswers, submittedAt: response.submittedAt as string | undefined, status: response.status as string | undefined }}
          fields={fields}
          accentColor={config?.app.theme?.primaryColor}
        />
      )}

      {/* Related records (inverse relations) */}
      {appSlug && formId && responseId && !editing && (
        <RelatedRecordsPanel
          appSlug={appSlug}
          formId={formId}
          responseId={responseId}
          excludeFieldIds={recordScreen?.consumesRelated}
        />
      )}

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
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
