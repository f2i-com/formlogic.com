import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronRight,
  Database,
  ExternalLink,
  GitFork,
  Link2,
  PencilRuler,
  Plus,
  RotateCcw,
  ShieldCheck,
  Share2,
  Table2,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Modal } from '../../ui/Modal';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useFormStore } from '../../../stores/formStore';
import { useVaultStore } from '../../../stores/vaultStore';
import { cn } from '../../../lib/utils';
import { returnToState } from '../../../hooks/useReturnTo';
import { VaultSetupWizard } from '../../vault/VaultSetupWizard';
import { VaultUnlockDialog } from '../../vault/VaultUnlockDialog';
import { RelationFormModal } from '../../../pages/apps/RelationFormModal';
import { trackStudioSave } from '../studioSaveState';
import { ExportDataMenu } from '../../apps/ExportDataMenu';
import { useAdminActing } from '../../admin/AdminActingContext';
import { saveFormFields } from '../../../lib/formFields';
import type { App, AppForm } from '../../../types/app';
import type { FieldType, Form, FormField } from '../../../types/form';

const FIELD_TYPE_LABELS: Record<string, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  url: 'Link',
  date: 'Date',
  time: 'Time',
  datetime: 'Date & time',
  dropdown: 'Dropdown',
  multiple_choice: 'Multiple choice',
  checkboxes: 'Checkboxes',
  rating: 'Rating',
  scale: 'Scale',
  file_upload: 'File upload',
  signature: 'Signature',
  statement: 'Statement',
  welcome_screen: 'Welcome screen',
  thank_you: 'Thank you',
  calculated: 'Calculated',
  linked_record: 'Linked record',
  location: 'Location',
  hidden: 'Hidden',
};

const QUICK_ADD_TYPES: Array<{ type: FieldType; label: string }> = [
  { type: 'short_text', label: 'Short text' },
  { type: 'long_text', label: 'Long text' },
  { type: 'email', label: 'Email' },
  { type: 'phone', label: 'Phone' },
  { type: 'number', label: 'Number' },
  { type: 'date', label: 'Date' },
  { type: 'file_upload', label: 'File upload' },
];

/** Field kinds whose settings dock should stay shut in the builder. */
const LAYOUT_FIELD_TYPES = new Set<string>(['statement', 'welcome_screen', 'thank_you']);

/** Slug-style field id from a label (mirrors the builder's convention). */
function fieldIdFromLabel(label: string, existing: string[]): string {
  let base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'field';
  if (/^\d/.test(base)) base = `_${base}`;
  let id = base;
  let n = 1;
  while (existing.includes(id)) {
    n += 1;
    id = `${base}_${n}`;
  }
  return id;
}

/**
 * Data & forms: the app's data types (attached forms), their fields and
 * relationships. Quick edits happen inline through the real form APIs; deep
 * editing opens the form builder on the field that was clicked.
 */
export function DataStep({
  app,
  appForms,
  formsById,
  unreadableFormIds,
  formsResolving,
  formsFailed = false,
  onReloadForms,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  /** Attached forms whose record could not be read — shown as an error, never as "none". */
  unreadableFormIds: string[];
  /** True while the per-form records are still resolving. */
  formsResolving: boolean;
  /** True when the attachment list itself failed to load — unknown, not zero. */
  formsFailed?: boolean;
  onReloadForms: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const acting = useAdminActing();
  // Deep surfaces opened from this section return here via their Back buttons.
  const studioReturn = returnToState(`/apps/${app.id}/studio/data`, 'App Studio');
  const fetchFormAppUsage = useAppStore((s) => s.fetchFormAppUsage);
  const addFormToApp = useAppStore((s) => s.addFormToApp);
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const isPrivateDefault = app.settings?.defaultFormPrivacy === 'private';
  const [selectedFormId, setSelectedFormId] = useState<string | null>(null);
  const [sharedWith, setSharedWith] = useState<Record<string, string[]>>({});
  const [tab, setTab] = useState<'fields' | 'relationships'>('fields');
  const [showAddType, setShowAddType] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [creatingType, setCreatingType] = useState(false);
  const [addingField, setAddingField] = useState(false);
  const [newFieldLabel, setNewFieldLabel] = useState('');
  const [newFieldType, setNewFieldType] = useState<FieldType>('short_text');
  const [savingField, setSavingField] = useState(false);
  // `null` = not editing, so the heading always shows the stored name.
  const [typeNameDraft, setTypeNameDraft] = useState<string | null>(null);
  const [showRelation, setShowRelation] = useState(false);
  const [vaultAction, setVaultAction] = useState<'create-type' | 'add-field' | null>(null);
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const fieldLabelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchFormAppUsage(app.id).then(setSharedWith);
  }, [app.id, fetchFormAppUsage]);

  const selected = useMemo(() => {
    // A selection that no longer matches an attachment (form detached elsewhere)
    // falls back to the first one rather than rendering an empty panel.
    const attached = appForms.some((af) => af.formId === selectedFormId);
    const id = (attached ? selectedFormId : null) ?? appForms[0]?.formId ?? null;
    return id ? { attachment: appForms.find((af) => af.formId === id) ?? null, form: formsById[id] ?? null, id } : null;
  }, [selectedFormId, appForms, formsById]);

  useEffect(() => {
    if (selected?.form?.isPrivate && newFieldType === 'file_upload') {
      setNewFieldType('short_text');
    }
  }, [selected?.form?.isPrivate, newFieldType]);

  const formNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const af of appForms) map[af.formId] = af.displayName || formsById[af.formId]?.title || 'Untitled';
    return map;
  }, [appForms, formsById]);

  const relationForms = useMemo(
    () => appForms.map((af) => ({ formId: af.formId, displayName: formNameById[af.formId] })),
    [appForms, formNameById]
  );

  /**
   * Private forms need an unlocked vault. The vault dialogs are themselves modal, so
   * the "Add a data type" dialog is closed first — two stacked aria-modal dialogs
   * meant one Escape dismissed both and the half-typed data type vanished.
   */
  const ensurePrivateReady = async (action: 'create-type' | 'add-field'): Promise<boolean> => {
    if (isDemo) {
      toast.info('Private forms need a workspace', 'This demo app stays in IndexedDB. Sign up to create end-to-end encrypted forms.');
      return false;
    }
    let status = useVaultStore.getState().status;
    if (status === 'unknown') {
      await useVaultStore.getState().refreshStatus();
      status = useVaultStore.getState().status;
    }
    if (status === 'unlocked') return true;
    setVaultAction(action);
    setShowAddType(false);
    if (status === 'none') setShowVaultSetup(true);
    else setShowVaultUnlock(true);
    return false;
  };

  const createDataType = async () => {
    const name = newTypeName.trim();
    if (!name || creatingType) return;
    if (isPrivateDefault && !(await ensurePrivateReady('create-type'))) return;
    setCreatingType(true);
    try {
      // The store's createForm applies the user's default form settings and the
      // demo-local path; addFormToApp then syncs + attaches it to this app.
      const form = await trackStudioSave(`${name} created`, useFormStore.getState().createForm(name), (f) => !!f);
      if (!form) {
        toast.error('Could not create the data type');
        return;
      }
      if (isPrivateDefault) {
        try {
          const { enableFormEncryption, markFormPrivate } = await import('../../../lib/crypto/formCrypto');
          await enableFormEncryption(form.id, JSON.stringify(form.fields ?? []));
          markFormPrivate(form.id);
        } catch (e) {
          // Never leave a form behind that the user believes is private.
          let removed = true;
          try {
            await useFormStore.getState().deleteForm(form.id);
          } catch {
            removed = false;
          }
          const message = e instanceof Error ? e.message : 'Encryption setup failed.';
          toast.error(
            removed ? 'Private data type was not created' : 'Encryption failed — delete this form',
            removed
              ? `${message} The draft was removed rather than left unencrypted.`
              : `${message} The draft could not be removed automatically and is NOT encrypted.`
          );
          return;
        }
      }
      const attached = await trackStudioSave(`${name} attached`, addFormToApp(app.id, form.id, name), (ok) => !!ok);
      if (!attached) return;
      toast.success(
        isPrivateDefault ? 'Private data type created' : 'Data type created',
        isPrivateDefault
          ? `"${name}" was added with end-to-end encryption enabled.`
          : `"${name}" was added to ${app.name}.`
      );
      setShowAddType(false);
      setNewTypeName('');
      await onReloadForms();
      setSelectedFormId(form.id);
    } finally {
      setCreatingType(false);
    }
  };

  /**
   * The one field write in this section. Quick-add and the Required toggle both go
   * through it, so the private-form signing rule and the store re-seed can never be
   * implemented once and forgotten the second time.
   */
  const writeFields = async (nextFields: FormField[], label: string) => {
    const form = selected?.form;
    if (!form) return false;
    const res = await trackStudioSave(
      label,
      async () => {
        const result = await saveFormFields(form.id, nextFields, { isPrivate: form.isPrivate });
        if (result.ok) await onReloadForms();
        return result;
      },
      (r) => r.ok
    );
    if (!res.ok) {
      if (res.needsVault) void ensurePrivateReady('add-field');
      else toast.error('Could not save the change', res.error);
      return false;
    }
    return true;
  };

  /** Required is the one field property worth finishing inline — it is reversible
   *  and carries no data contract. Deletion stays in the builder, which runs the
   *  usage lookup and the keep-data-vs-purge dialog. */
  const toggleRequired = async (field: FormField, required: boolean) => {
    if (!selected?.form || savingField) return;
    if (selected.form.isPrivate && !(await ensurePrivateReady('add-field'))) return;
    setSavingField(true);
    try {
      const nextFields = selected.form.fields.map((f) => (f.id === field.id ? { ...f, required } : f));
      await writeFields(nextFields, `${formNameById[selected.form.id]} fields`);
    } finally {
      setSavingField(false);
    }
  };

  /** Rename the data type. `displayName` is this app's label for the attachment and is
   *  always safe to write. The underlying `forms.title` is respondent-facing and GLOBAL,
   *  so it is only renamed when no other app shows this form. */
  const renameDataType = async (nextName: string) => {
    const form = selected?.form;
    const attachment = selected?.attachment;
    if (!form || !attachment) return;
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === (attachment.displayName || form.title)) return;
    const alsoUsed = (sharedWith[form.id]?.length ?? 0) > 0;
    const ok = await trackStudioSave(
      'Data type name',
      async () => {
        const res = await api.updateAppForm(app.id, form.id, { displayName: trimmed });
        if (res.error) return res;
        if (!alsoUsed) await api.updateForm(form.id, { title: trimmed });
        await onReloadForms();
        return res;
      },
      (r) => !r.error
    );
    if (ok.error) toast.error('Could not rename', typeof ok.error === 'string' ? ok.error : undefined);
  };

  const addField = async () => {
    if (!selected?.form || savingField) return;
    const label = newFieldLabel.trim();
    if (!label) return;
    if (selected.form.isPrivate && !(await ensurePrivateReady('add-field'))) return;
    if (selected.form.isPrivate && newFieldType === 'file_upload') {
      toast.warning('Not supported on private forms', 'File uploads are not yet available on end-to-end encrypted forms.');
      return;
    }
    setSavingField(true);
    try {
      const existingIds = selected.form.fields.map((f) => f.id);
      const field: FormField = {
        id: fieldIdFromLabel(label, existingIds),
        type: newFieldType,
        label,
        required: false,
        properties: {},
        order: selected.form.fields.length,
      };
      const nextFields = [...selected.form.fields, field];
      // saveFormFields signs private schemas AND re-seeds useFormStore. Writing the
      // array straight through api.updateForm left the builder holding the pre-edit
      // copy, which its next debounced save then wrote back — deleting this field.
      const res = await trackStudioSave(
        `${formNameById[selected.form.id]} fields`,
        async () => {
          const result = await saveFormFields(selected.form!.id, nextFields, { isPrivate: selected.form!.isPrivate });
          if (result.ok) {
            // The row STAYS open: adding fields is a run of small edits, and
            // re-opening it per field made a six-field form six extra clicks.
            setNewFieldLabel('');
            await onReloadForms();
            fieldLabelRef.current?.focus();
          }
          return result;
        },
        (r) => r.ok
      );
      if (!res.ok) {
        toast.error('Could not add the field', res.error);
        return;
      }
      toast.success('Field added', `"${label}" was added to ${formNameById[selected.form.id]}.`);
    } catch (e) {
      toast.error('Could not add the field', e instanceof Error ? e.message : undefined);
    } finally {
      setSavingField(false);
    }
  };

  const resumeVaultAction = () => {
    const action = vaultAction;
    setVaultAction(null);
    if (action === 'create-type') { setShowAddType(true); void createDataType(); }
    if (action === 'add-field') void addField();
  };

  /** Open the builder with the clicked field already selected, not the first one. */
  const openFieldInBuilder = (formId: string, field?: FormField) => {
    if (field && !LAYOUT_FIELD_TYPES.has(field.type)) {
      useFormStore.getState().setSelectedField(field.id);
    }
    navigate(`/builder/${formId}`, { state: studioReturn });
  };

  const unreadable = unreadableFormIds.length > 0;

  return (
    <div className="grid gap-4 @2xl/studio:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] @2xl/studio:gap-5 @5xl/studio:grid-cols-[minmax(0,20.5rem)_minmax(0,1fr)]">
      {/* Data types rail */}
      <section className="h-fit overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
        <div className="flex items-center justify-between border-b border-gray-200/80 p-4 dark:border-white/[0.06]">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Data types</h3>
          <div className="flex items-center gap-1">
            {/* The section that owns the app's data is where an owner looks for the
                data itself. Exporting it was four hops away, under App settings →
                Manage → Records. Acting admins keep their own export gate on that
                page and do not get it here. */}
            {!acting && <ExportDataMenu appId={app.id} appSlug={app.slug} />}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/apps/${app.id}/records`, { state: studioReturn })}
              title="Record counts, per-form responses and analytics"
            >
              Records
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/apps/${app.id}/forms`, { state: studioReturn })}
              title="Attach existing forms, reorder and set visibility"
            >
              Attach
            </Button>
          </div>
        </div>
        <div className="scrollbar-thin grid max-h-none @2xl/studio:max-h-[560px] grid-cols-1 gap-1 overflow-y-auto p-2 @xl/studio:grid-cols-2 @2xl/studio:grid-cols-1">
          {appForms.map((af) => {
            const form = formsById[af.formId];
            const isSelected = selected?.id === af.formId;
            const shared = sharedWith[af.formId];
            const broken = unreadableFormIds.includes(af.formId);
            return (
              <button
                key={af.formId}
                type="button"
                onClick={() => { setSelectedFormId(af.formId); setTab('fields'); }}
                aria-current={isSelected ? 'true' : undefined}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all',
                  isSelected
                    ? 'bg-primary-50 ring-1 ring-inset ring-primary-200 dark:bg-primary-500/[0.09] dark:ring-primary-500/20'
                    : 'hover:bg-gray-50 dark:hover:bg-white/[0.035]'
                )}
              >
                <span className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                  isSelected
                    ? 'bg-white text-primary-600 shadow-sm dark:bg-slate-900 dark:text-primary-400'
                    : 'bg-gray-100 text-gray-500 dark:bg-white/[0.05] dark:text-slate-400'
                )}>
                  {broken ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <Database className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('truncate text-xs font-semibold', isSelected ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-slate-300')}>
                      {af.displayName || form?.title || 'Untitled'}
                    </span>
                    {shared && shared.length > 0 && <Share2 className="h-3 w-3 shrink-0 text-sky-500" aria-label={`Also used by ${shared.join(', ')}`} />}
                  </span>
                  <span className="mt-1 block text-[10px] text-gray-500 dark:text-slate-400">
                    {broken
                      ? "Couldn't load"
                      : form
                        ? `${form.fields.length} ${form.fields.length === 1 ? 'field' : 'fields'} · ${form.responseCount ?? 0} ${(form.responseCount ?? 0) === 1 ? 'record' : 'records'}`
                        : 'Loading…'}
                  </span>
                </span>
                <ChevronRight className={cn('h-4 w-4', isSelected ? 'text-primary-500' : 'text-gray-400 dark:text-slate-500')} />
              </button>
            );
          })}
          {appForms.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAddType(true)}
              className="mt-1 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 text-xs font-semibold text-gray-600 transition hover:border-primary-400 hover:bg-primary-50 hover:text-primary-700 dark:border-white/15 dark:text-slate-300 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/[0.06] dark:hover:text-primary-300"
            >
              <Plus className="h-4 w-4" /> Add data type
            </button>
          )}
        </div>
      </section>

      {/* Selected data type */}
      {formsFailed && appForms.length === 0 ? (
        <section className="flex flex-col items-center justify-center rounded-xl border border-dashed border-amber-300 px-6 py-16 text-center dark:border-amber-400/30">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">Couldn't load this app's data types</p>
          <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
            The request for the app's forms failed. This does not mean the app has none.
          </p>
          <Button className="mt-4" onClick={() => void onReloadForms()} leftIcon={<RotateCcw className="h-4 w-4" />}>
            Try again
          </Button>
        </section>
      ) : appForms.length === 0 ? (
        <section className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 px-6 py-16 text-center dark:border-white/15">
          <Database className="h-8 w-8 text-gray-400 dark:text-slate-500" />
          <p className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">No data types yet</p>
          <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
            Every app is built on forms. Create your first data type, or sketch the whole app in Plan.
          </p>
          <Button className="mt-4" onClick={() => setShowAddType(true)} leftIcon={<Plus className="h-4 w-4" />}>
            Add data type
          </Button>
        </section>
      ) : selected?.form ? (
        <section className="overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
          <div className="flex flex-col gap-4 border-b border-gray-200/80 p-5 @xl/studio:flex-row @xl/studio:items-start @xl/studio:justify-between dark:border-white/[0.06]">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
                <Database className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Renaming a data type used to be impossible from the studio, and
                      renaming its form in the builder appeared to do nothing (the app
                      shows `displayName`). Editing the title here writes the name the
                      app actually renders. */}
                  <label htmlFor="studio-type-name" className="sr-only">Data type name</label>
                  <input
                    id="studio-type-name"
                    value={typeNameDraft ?? (selected.attachment?.displayName || selected.form.title)}
                    onChange={(e) => setTypeNameDraft(e.target.value)}
                    onBlur={() => { const v = typeNameDraft; setTypeNameDraft(null); if (v !== null) void renameDataType(v); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                      if (e.key === 'Escape') { setTypeNameDraft(null); e.currentTarget.blur(); }
                    }}
                    className="-mx-2 min-w-0 max-w-full flex-1 rounded-lg border border-transparent bg-transparent px-2 py-0.5 text-lg font-semibold text-gray-900 outline-none transition hover:border-gray-200 focus:border-primary-400 focus:bg-white focus:ring-2 focus:ring-primary-500/15 dark:text-white dark:hover:border-white/10 dark:focus:border-primary-500/50 dark:focus:bg-slate-950/60"
                  />
                  {sharedWith[selected.form.id]?.length > 0 && (
                    <Badge variant="info" size="sm">
                      <Share2 className="mr-1 inline h-3 w-3" /> Shared
                    </Badge>
                  )}
                  {selected.form.isPrivate && (
                    <Badge variant="success" size="sm">
                      <ShieldCheck className="mr-1 inline h-3 w-3" /> E2EE
                    </Badge>
                  )}
                </div>
                {selected.form.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-slate-400">{selected.form.description}</p>
                )}
                {sharedWith[selected.form.id]?.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-sky-600 dark:text-sky-300">
                    Also used by {sharedWith[selected.form.id].join(', ')} — data stays in sync.
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <Badge size="sm">
                {selected.form.responseCount ?? 0} {(selected.form.responseCount ?? 0) === 1 ? 'record' : 'records'}
              </Badge>
              <Button variant="secondary" size="sm" onClick={() => openFieldInBuilder(selected.form!.id)} leftIcon={<PencilRuler className="h-4 w-4" />}>
                Open builder
              </Button>
            </div>
          </div>

          <div className="border-b border-gray-200/70 px-5 dark:border-white/[0.06]">
            <div className="flex gap-5" role="tablist" aria-label="Data type sections">
              {([
                { id: 'fields', label: 'Fields' },
                { id: 'relationships', label: 'Relationships' },
              ] as const).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`data-tab-${item.id}`}
                  aria-selected={tab === item.id}
                  aria-controls={`data-panel-${item.id}`}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'relative min-h-11 cursor-pointer text-xs font-semibold',
                    tab === item.id
                      ? 'text-primary-600 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary-600 dark:text-primary-400 dark:after:bg-primary-400'
                      : 'text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white'
                  )}
                >
                  {item.label}
                </button>
              ))}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => navigate(`/responses/${selected.form!.id}`, { state: studioReturn })}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white"
              >
                <Table2 className="h-3.5 w-3.5" /> Records
              </button>
            </div>
          </div>

          {tab === 'fields' && (
            <div id="data-panel-fields" role="tabpanel" aria-labelledby="data-tab-fields" className="p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Screens update automatically. Open the builder for validation, logic and reordering.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setAddingField((v) => !v)}
                  aria-expanded={addingField}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Add field
                </Button>
              </div>

              {addingField && (
                <div className="mb-3 flex flex-col gap-2 rounded-xl border border-primary-200 bg-primary-50/50 p-3 dark:border-primary-500/25 dark:bg-primary-500/[0.06] sm:flex-row sm:items-center">
                  <Input
                    ref={fieldLabelRef}
                    value={newFieldLabel}
                    onChange={(e) => setNewFieldLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addField();
                      if (e.key === 'Escape') setAddingField(false);
                    }}
                    placeholder="Field label"
                    aria-label="New field label"
                    className="flex-1"
                    autoFocus
                  />
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as FieldType)}
                    aria-label="New field type"
                    className="h-10 min-w-0 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                  >
                    {QUICK_ADD_TYPES.filter((t) => !selected.form!.isPrivate || t.type !== 'file_upload').map((t) => (
                      <option key={t.type} value={t.type}>{t.label}</option>
                    ))}
                  </select>
                  <Button size="sm" onClick={addField} isLoading={savingField} disabled={!newFieldLabel.trim()}>
                    Add
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setAddingField(false)}>
                    Done
                  </Button>
                </div>
              )}

              {selected.form.fields.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500 dark:border-white/15 dark:text-slate-400">
                  No fields yet — add one above or open the builder.
                </div>
              ) : (
                /* @container/fields, not a viewport tier: this panel is NARROWEST when
                   the studio is widest (the 17rem data-type rail appears at @2xl), so a
                   `sm:` grid switched the four columns on exactly when there was no room
                   and the overflow-hidden panel silently ate Type and Required. */
                <div className="@container/fields overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
                  <div className="hidden grid-cols-[minmax(160px,1fr)_140px_104px] bg-gray-50 px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:bg-white/[0.03] dark:text-slate-400 @lg/fields:grid">
                    <span>Field</span>
                    <span>Type</span>
                    <span>Required</span>
                  </div>
                  <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
                    {selected.form.fields.map((field) => (
                      <div
                        key={field.id}
                        className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 transition hover:bg-gray-50 dark:hover:bg-white/[0.025] @lg/fields:grid-cols-[minmax(160px,1fr)_140px_104px] @lg/fields:gap-0"
                      >
                        {/* Only the label/type cells navigate, so the Required cell can
                            hold a real control instead of a read-only badge. */}
                        <button
                          type="button"
                          onClick={() => openFieldInBuilder(selected.form!.id, field)}
                          title={`Edit ${field.label} in the form builder`}
                          className="flex min-w-0 cursor-pointer items-center gap-1.5 py-2 text-left"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-semibold text-gray-800 dark:text-slate-200">{field.label}</span>
                            <span className="mt-0.5 block text-[10px] text-gray-500 dark:text-slate-400 @lg/fields:hidden">
                              {FIELD_TYPE_LABELS[field.type] ?? field.type}
                            </span>
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-slate-500" aria-hidden="true" />
                        </button>
                        <span className="hidden text-xs text-gray-600 dark:text-slate-300 @lg/fields:block">
                          {FIELD_TYPE_LABELS[field.type] ?? field.type}
                        </span>
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 justify-self-end @lg/fields:justify-self-start">
                          <input
                            type="checkbox"
                            checked={field.required === true}
                            disabled={savingField}
                            onChange={(e) => void toggleRequired(field, e.target.checked)}
                            className="h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800"
                          />
                          <span className="text-[11px] font-medium text-gray-600 dark:text-slate-300">Required</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 grid gap-3 @xl/studio:grid-cols-2">
                <MiniSummary
                  icon={Link2}
                  label={(() => {
                    const n = selected.form.fields.filter((f) => f.type === 'linked_record').length;
                    return `${n} ${n === 1 ? 'relationship' : 'relationships'}`;
                  })()}
                  detail="Linked-record fields"
                  onClick={() => setTab('relationships')}
                />
                <MiniSummary
                  icon={ExternalLink}
                  label="Preview form"
                  detail="Open the live form"
                  onClick={() => navigate(`/preview/${selected.form!.id}`, { state: studioReturn })}
                />
              </div>
            </div>
          )}

          {tab === 'relationships' && (
            <div id="data-panel-relationships" role="tabpanel" aria-labelledby="data-tab-relationships" className="p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Linked-record fields connect this data type to others in the app.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setShowRelation(true)} leftIcon={<Plus className="h-4 w-4" />}>
                    Add relationship
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/apps/${app.id}/relations`, { state: studioReturn })}
                    leftIcon={<GitFork className="h-4 w-4" />}
                  >
                    All relations
                  </Button>
                </div>
              </div>
              {selected.form.fields.filter((f) => f.type === 'linked_record').length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center dark:border-white/15">
                  <p className="text-sm text-gray-500 dark:text-slate-400">
                    No relationships yet. Link this data type to another so records can reference each other.
                  </p>
                  <Button className="mt-3" size="sm" onClick={() => setShowRelation(true)} leftIcon={<Plus className="h-4 w-4" />}>
                    Add relationship
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {selected.form.fields.filter((f) => f.type === 'linked_record').map((field) => {
                    const targetId = (field.properties as { targetFormId?: string } | undefined)?.targetFormId;
                    const targetName = targetId ? formNameById[targetId] ?? 'a form outside this app' : 'not configured';
                    return (
                      <button
                        key={field.id}
                        type="button"
                        onClick={() => openFieldInBuilder(selected.form!.id, field)}
                        className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-gray-50 px-3 py-2.5 text-left transition hover:bg-gray-100 dark:bg-white/[0.035] dark:hover:bg-white/[0.06]"
                      >
                        <Link2 className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-gray-800 dark:text-slate-200">{field.label}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-gray-500 dark:text-slate-400">Links to {targetName}</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      ) : unreadable && selected && unreadableFormIds.includes(selected.id) ? (
        <section className="flex flex-col items-center justify-center rounded-xl border border-dashed border-amber-300 px-6 py-16 text-center dark:border-amber-400/30">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">
            Couldn't load {formNameById[selected.id] ?? 'this data type'}
          </p>
          <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
            It is still attached to the app — the request for its fields failed.
          </p>
          <Button className="mt-4" onClick={() => void onReloadForms()} leftIcon={<RotateCcw className="h-4 w-4" />}>
            Try again
          </Button>
        </section>
      ) : (
        /* Attachments are known but their records are still in flight — a skeleton,
           never the "no data types yet" empty state the rail plainly contradicts. */
        <section
          className="rounded-xl border border-gray-200/80 bg-white p-5 shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50"
          role="status"
          aria-label="Loading data type"
        >
          <div className="animate-pulse space-y-3">
            <div className="h-11 w-1/3 rounded-xl bg-gray-100 dark:bg-white/[0.06]" />
            <div className="h-3 w-2/3 rounded bg-gray-100 dark:bg-white/[0.06]" />
            <div className="h-40 rounded-xl bg-gray-100 dark:bg-white/[0.06]" />
          </div>
          <span className="sr-only">{formsResolving ? 'Loading this data type' : 'Preparing this data type'}</span>
        </section>
      )}

      <Modal isOpen={showAddType} onClose={() => setShowAddType(false)} title="Add a data type" size="sm">
        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-sm text-gray-500 dark:text-slate-400">
            A data type is a form: it defines the fields, powers the generated screens, and stores the records.
          </p>
          {isPrivateDefault && (
            <div className="flex gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs leading-5 text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/[0.08] dark:text-emerald-200">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                <span className="font-semibold">End-to-end encrypted by default.</span>{' '}
                This data type will be made private before it is attached to the app.
              </p>
            </div>
          )}
          <Input
            value={newTypeName}
            onChange={(e) => setNewTypeName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createDataType(); }}
            placeholder="e.g. Customer, Job, Invoice"
            aria-label="Data type name"
            autoFocus
          />
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setShowAddType(false); navigate(`/apps/${app.id}/forms`, { state: studioReturn }); }}>
              Attach an existing form instead
            </Button>
            <Button onClick={createDataType} isLoading={creatingType} disabled={!newTypeName.trim()}>
              Create
            </Button>
          </div>
        </div>
      </Modal>
      <RelationFormModal
        isOpen={showRelation}
        onClose={() => setShowRelation(false)}
        onSave={() => { setShowRelation(false); void onReloadForms(); }}
        appForms={relationForms}
        defaultSourceFormId={selected?.id}
      />
      <VaultSetupWizard
        isOpen={showVaultSetup}
        onClose={() => setShowVaultSetup(false)}
        onComplete={resumeVaultAction}
      />
      <VaultUnlockDialog
        isOpen={showVaultUnlock}
        onClose={() => setShowVaultUnlock(false)}
        onUnlocked={resumeVaultAction}
        title="Unlock your vault to continue"
      />
    </div>
  );
}

function MiniSummary({ icon: Icon, label, detail, onClick }: { icon: typeof Link2; label: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl bg-gray-50 px-3 text-left transition hover:bg-gray-100 dark:bg-white/[0.035] dark:hover:bg-white/[0.06]"
    >
      <Icon className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-gray-800 dark:text-slate-200">{label}</span>
        <span className="mt-0.5 block truncate text-[10px] text-gray-500 dark:text-slate-400">{detail}</span>
      </span>
    </button>
  );
}
