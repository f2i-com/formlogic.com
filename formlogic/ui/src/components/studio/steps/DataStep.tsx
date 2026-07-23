import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Database,
  ExternalLink,
  FileText,
  GitFork,
  Link2,
  PencilRuler,
  Plus,
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
import { useFormStore } from '../../../stores/formStore';
import { cn } from '../../../lib/utils';
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
 * Studio step 2 — Data & forms: the app's data types (attached forms), their
 * fields, relationships and record counts. Quick edits happen inline through
 * the real form APIs; deep editing opens the form builder.
 */
export function DataStep({
  app,
  appForms,
  formsById,
  onReloadForms,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  onReloadForms: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const fetchFormAppUsage = useAppStore((s) => s.fetchFormAppUsage);
  const addFormToApp = useAppStore((s) => s.addFormToApp);
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

  useEffect(() => {
    fetchFormAppUsage(app.id).then(setSharedWith);
  }, [app.id, fetchFormAppUsage]);

  const selected = useMemo(() => {
    const id = selectedFormId ?? appForms[0]?.formId ?? null;
    return id ? { attachment: appForms.find((af) => af.formId === id) ?? null, form: formsById[id] ?? null, id } : null;
  }, [selectedFormId, appForms, formsById]);

  const formNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const af of appForms) map[af.formId] = af.displayName || formsById[af.formId]?.title || 'Untitled';
    return map;
  }, [appForms, formsById]);

  const createDataType = async () => {
    const name = newTypeName.trim();
    if (!name || creatingType) return;
    setCreatingType(true);
    try {
      // The store's createForm applies the user's default form settings and the
      // demo-local path; addFormToApp then syncs + attaches it to this app.
      const form = await useFormStore.getState().createForm(name);
      if (!form) {
        toast.error('Could not create the data type');
        return;
      }
      const attached = await addFormToApp(app.id, form.id, name);
      if (!attached) return;
      toast.success('Data type created', `"${name}" was added to ${app.name}.`);
      setShowAddType(false);
      setNewTypeName('');
      await onReloadForms();
      setSelectedFormId(form.id);
    } finally {
      setCreatingType(false);
    }
  };

  const addField = async () => {
    if (!selected?.form || savingField) return;
    const label = newFieldLabel.trim();
    if (!label) return;
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
      const res = await api.updateForm(selected.form.id, { fields: [...selected.form.fields, field] });
      if (res.error) {
        toast.error('Could not add the field', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      toast.success('Field added', `"${label}" was added to ${formNameById[selected.form.id]}.`);
      setNewFieldLabel('');
      setAddingField(false);
      await onReloadForms();
    } finally {
      setSavingField(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
      {/* Data types rail */}
      <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm h-fit">
        <div className="border-b border-gray-200/80 dark:border-white/[0.06] p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Data types</h3>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">Forms behind this app</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/apps/${app.id}/forms`)} title="Attach existing forms, reorder and set visibility">
              Manage
            </Button>
          </div>
        </div>
        <div className="max-h-[560px] space-y-1 overflow-y-auto p-2">
          {appForms.map((af) => {
            const form = formsById[af.formId];
            const isSelected = selected?.id === af.formId;
            const shared = sharedWith[af.formId];
            return (
              <button
                key={af.formId}
                type="button"
                onClick={() => { setSelectedFormId(af.formId); setTab('fields'); }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all',
                  isSelected
                    ? 'bg-primary-50 dark:bg-primary-500/[0.09] ring-1 ring-inset ring-primary-200 dark:ring-primary-500/20'
                    : 'hover:bg-gray-50 dark:hover:bg-white/[0.035]'
                )}
              >
                <span className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                  isSelected
                    ? 'bg-white dark:bg-slate-900 text-primary-600 dark:text-primary-400 shadow-sm'
                    : 'bg-gray-100 dark:bg-white/[0.05] text-gray-500 dark:text-slate-400'
                )}>
                  <Database className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('truncate text-xs font-semibold', isSelected ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-slate-300')}>
                      {af.displayName || form?.title || 'Untitled'}
                    </span>
                    {shared && shared.length > 0 && <Share2 className="h-3 w-3 shrink-0 text-sky-500" aria-label={`Also used by ${shared.join(', ')}`} />}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-slate-500">
                    <span>{form ? `${form.fields.length} fields` : '…'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{form ? `${form.responseCount ?? 0} records` : ''}</span>
                  </span>
                </span>
                <ChevronRight className={cn('h-4 w-4', isSelected ? 'text-primary-500' : 'text-gray-300 dark:text-slate-600')} />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowAddType(true)}
            className="mt-1 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 dark:border-white/15 text-xs font-semibold text-gray-500 dark:text-slate-400 transition hover:border-primary-400 hover:bg-primary-50 hover:text-primary-700 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/[0.06] dark:hover:text-primary-300"
          >
            <Plus className="h-4 w-4" /> Add data type
          </button>
        </div>
      </section>

      {/* Selected data type */}
      {selected?.form ? (
        <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
          <div className="flex flex-col gap-4 border-b border-gray-200/80 dark:border-white/[0.06] p-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3 min-w-0">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400">
                <Database className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                    {selected.attachment?.displayName || selected.form.title}
                  </h3>
                  {sharedWith[selected.form.id]?.length > 0 && (
                    <Badge variant="info" size="sm">
                      <Share2 className="h-3 w-3 mr-1 inline" /> Shared
                    </Badge>
                  )}
                </div>
                {selected.form.description && (
                  <p className="mt-1 text-sm text-gray-500 dark:text-slate-400 line-clamp-2">{selected.form.description}</p>
                )}
                {sharedWith[selected.form.id]?.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-sky-600 dark:text-sky-300">
                    Also used by {sharedWith[selected.form.id].join(', ')} — data stays in sync.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Badge size="sm">{selected.form.responseCount ?? 0} records</Badge>
              <Button variant="secondary" size="sm" onClick={() => navigate(`/builder/${selected.form!.id}`)} leftIcon={<PencilRuler className="h-4 w-4" />}>
                Open builder
              </Button>
            </div>
          </div>

          <div className="border-b border-gray-200/70 dark:border-white/[0.06] px-5">
            <nav className="flex gap-5" aria-label="Data type sections">
              {([
                { id: 'fields', label: 'Fields' },
                { id: 'relationships', label: 'Relationships' },
              ] as const).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'relative min-h-11 cursor-pointer text-xs font-semibold',
                    tab === item.id
                      ? 'text-primary-600 dark:text-primary-400 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary-600 dark:after:bg-primary-400'
                      : 'text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200'
                  )}
                >
                  {item.label}
                </button>
              ))}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => navigate(`/responses/${selected.form!.id}`)}
                className="min-h-11 cursor-pointer text-xs font-semibold text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200 inline-flex items-center gap-1"
              >
                <Table2 className="h-3.5 w-3.5" /> Records
              </button>
            </nav>
          </div>

          {tab === 'fields' && (
            <div className="p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Form fields</h4>
                  <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
                    Generated screens update automatically. Open the builder for validation, logic and reordering.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setAddingField((v) => !v)} leftIcon={<Plus className="h-4 w-4" />}>
                  Add field
                </Button>
              </div>

              {addingField && (
                <div className="mb-3 flex flex-col gap-2 rounded-xl border border-primary-200 dark:border-primary-500/25 bg-primary-50/50 dark:bg-primary-500/[0.06] p-3 sm:flex-row sm:items-center">
                  <Input
                    value={newFieldLabel}
                    onChange={(e) => setNewFieldLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void addField(); }}
                    placeholder="Field label"
                    aria-label="New field label"
                    className="flex-1"
                  />
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as FieldType)}
                    aria-label="New field type"
                    className="h-10 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 outline-none"
                  >
                    {QUICK_ADD_TYPES.map((t) => (
                      <option key={t.type} value={t.type}>{t.label}</option>
                    ))}
                  </select>
                  <Button size="sm" onClick={addField} isLoading={savingField} disabled={!newFieldLabel.trim()}>
                    Add
                  </Button>
                </div>
              )}

              {selected.form.fields.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 dark:border-white/15 px-4 py-8 text-center text-sm text-gray-500 dark:text-slate-400">
                  No fields yet — add one above or open the builder.
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
                  <div className="hidden grid-cols-[minmax(160px,1fr)_150px_90px_40px] bg-gray-50 dark:bg-white/[0.03] px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500 sm:grid">
                    <span>Field</span>
                    <span>Type</span>
                    <span>Required</span>
                    <span />
                  </div>
                  <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
                    {selected.form.fields.map((field) => (
                      <button
                        key={field.id}
                        type="button"
                        onClick={() => navigate(`/builder/${selected.form!.id}`)}
                        title="Open in the form builder"
                        className="grid min-h-12 w-full cursor-pointer grid-cols-[minmax(0,1fr)_32px] items-center gap-2 px-3 text-left transition hover:bg-gray-50 dark:hover:bg-white/[0.025] sm:grid-cols-[minmax(160px,1fr)_150px_90px_40px] sm:gap-0"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold text-gray-800 dark:text-slate-200">{field.label}</span>
                          <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500 sm:hidden">
                            {FIELD_TYPE_LABELS[field.type] ?? field.type}{field.required ? ' · Required' : ''}
                          </span>
                        </span>
                        <span className="hidden text-xs text-gray-500 dark:text-slate-400 sm:block">
                          {FIELD_TYPE_LABELS[field.type] ?? field.type}
                        </span>
                        <span className="hidden sm:block">
                          {field.required ? (
                            <Badge variant="primary" size="sm">Yes</Badge>
                          ) : (
                            <span className="text-xs text-gray-300 dark:text-slate-600">—</span>
                          )}
                        </span>
                        <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <MiniSummary
                  icon={Link2}
                  label={`${selected.form.fields.filter((f) => f.type === 'linked_record').length} relationships`}
                  detail="Linked-record fields"
                  onClick={() => setTab('relationships')}
                />
                <MiniSummary
                  icon={FileText}
                  label="Screens"
                  detail="Form, list, record view"
                  onClick={() => navigate(`/apps/${app.id}/studio/screens`)}
                />
                <MiniSummary
                  icon={ExternalLink}
                  label="Preview form"
                  detail="Open the live form"
                  onClick={() => navigate(`/preview/${selected.form!.id}`)}
                />
              </div>
            </div>
          )}

          {tab === 'relationships' && (
            <div className="p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Relationships</h4>
                  <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
                    Linked-record fields connect this data type to others in the app.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => navigate(`/apps/${app.id}/relations`)} leftIcon={<GitFork className="h-4 w-4" />}>
                  Manage relations
                </Button>
              </div>
              {selected.form.fields.filter((f) => f.type === 'linked_record').length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 dark:border-white/15 px-4 py-8 text-center text-sm text-gray-500 dark:text-slate-400">
                  No relationships yet — add one from the Relations manager.
                </div>
              ) : (
                <div className="space-y-2">
                  {selected.form.fields.filter((f) => f.type === 'linked_record').map((field) => {
                    const targetId = (field.properties as { targetFormId?: string } | undefined)?.targetFormId;
                    const targetName = targetId ? formNameById[targetId] ?? 'a form outside this app' : 'not configured';
                    return (
                      <div key={field.id} className="flex items-center gap-3 rounded-xl bg-gray-50 dark:bg-white/[0.035] px-3 py-2.5">
                        <Link2 className="h-4 w-4 text-primary-600 dark:text-primary-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-gray-800 dark:text-slate-200 truncate">{field.label}</p>
                          <p className="mt-0.5 text-[11px] text-gray-400 dark:text-slate-500 truncate">Links to {targetName}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-white/15 px-6 py-16 text-center">
          <Database className="h-8 w-8 text-gray-300 dark:text-slate-600" />
          <p className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">No data types yet</p>
          <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-slate-400">
            Every app is built on forms. Create your first data type, or sketch the whole app in the Plan step.
          </p>
          <Button className="mt-4" onClick={() => setShowAddType(true)} leftIcon={<Plus className="h-4 w-4" />}>
            Add data type
          </Button>
        </section>
      )}

      <Modal isOpen={showAddType} onClose={() => setShowAddType(false)} title="Add a data type" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-slate-400">
            A data type is a form: it defines the fields, powers the generated screens, and stores the records.
          </p>
          <Input
            value={newTypeName}
            onChange={(e) => setNewTypeName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createDataType(); }}
            placeholder="e.g. Customer, Job, Invoice"
            aria-label="Data type name"
            autoFocus
          />
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setShowAddType(false); navigate(`/apps/${app.id}/forms`); }}>
              Attach an existing form instead
            </Button>
            <Button onClick={createDataType} isLoading={creatingType} disabled={!newTypeName.trim()}>
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function MiniSummary({ icon: Icon, label, detail, onClick }: { icon: typeof Link2; label: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl bg-gray-50 dark:bg-white/[0.035] px-3 text-left transition hover:bg-gray-100 dark:hover:bg-white/[0.06]"
    >
      <Icon className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-gray-800 dark:text-slate-200 truncate">{label}</span>
        <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500 truncate">{detail}</span>
      </span>
    </button>
  );
}
