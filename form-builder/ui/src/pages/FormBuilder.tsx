import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Eye,
  Settings,
  Plus,
  Code2,
  Share2,
  Package,
  Sparkles,
  Palette,
  Keyboard,
  History,
  MoreVertical,
  Layers,
  Cloud,
  Check,
  Loader2,
  HardDrive,
  X,
  SlidersHorizontal,
  Undo2,
  Redo2,
  MonitorPlay,
  LayoutDashboard,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { IconPicker } from '../components/ui/IconPicker';
import { ScriptEditor, FieldPalette, SortableFieldCard, FieldSettingsPanel } from '../components/builder';
import { EmbedModal } from '../components/builder/EmbedModal';
import { ScreenModal } from '../components/custom-screen/ScreenModal';
import { AIFormGenerator, type AIGenerateResult } from '../components/builder/AIFormGenerator';
import { ThemeEditor } from '../components/builder/ThemeEditor';
import { PublishPackDialog } from '../components/builder/PublishPackDialog';
import { type PackData } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { FormSettingsModal } from '../components/builder/FormSettingsPanel';
import { FormVersionHistory } from '../components/builder/FormVersionHistory';
import { KeyboardShortcutsHelp } from '../components/builder/KeyboardShortcutsHelp';
import { useFormStore } from '../stores/formStore';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../hooks/useKeyboardShortcuts';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAiAvailable } from '../hooks/useAiAvailable';
import { useUIStore } from '../stores/uiStore';
import { FIELD_TYPE_INFO, type FormField, type FieldType, type CustomScreen } from '../types/form';

type ModalType = 'script' | 'embed' | 'ai' | 'theme' | 'settings' | 'shortcuts' | 'versions' | 'publishPack' | 'screen' | null;

/**
 * Serialize the current form into a single-form PackData so it can be published to the
 * marketplace via PublishPackDialog — resolving the "no way to author a pack from your own
 * forms" gap. Per-form notification recipients are stripped so they aren't shared.
 *
 * Parity with the app exporter (PackService::exportApp): carries the form's customScreen, and strips
 * a linked_record's targetFormId — a single-form pack has no in-pack target, so keeping the real id
 * would leak a form UUID and create a dangling import.
 */
function buildFormPack(
  form: { title?: string; description?: string; icon?: string; settings?: unknown; theme?: unknown; logicScript?: string; customScreen?: CustomScreen; fields?: FormField[] },
  author: string,
): PackData {
  const slug = (form.title || 'form').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'form';
  const settings: Record<string, unknown> = { ...((form.settings as Record<string, unknown>) || {}) };
  delete settings.notifications;
  return {
    formatVersion: 1,
    packMeta: {
      name: form.title || 'Untitled Form',
      description: form.description || '',
      version: '1.0.0',
      author: author || 'Unknown',
      tags: [],
    },
    forms: [{
      packFormId: slug,
      title: form.title || 'Untitled Form',
      description: form.description || '',
      icon: form.icon,
      settings,
      theme: { ...((form.theme as Record<string, unknown>) || {}) },
      logicScript: form.logicScript || undefined,
      customScreen: form.customScreen?.enabled ? form.customScreen : undefined,
      fields: (form.fields || []).map((f) => {
        let properties = (f.properties || {}) as Record<string, unknown>;
        if (f.type === 'linked_record' && 'targetFormId' in properties) {
          properties = { ...properties };
          delete properties.targetFormId;
        }
        return {
          id: f.id,
          type: f.type,
          label: f.label,
          description: f.description,
          placeholder: f.placeholder,
          required: !!f.required,
          properties,
          conditionalLogic: f.conditionalLogic,
          validation: f.validation,
        };
      }),
    }],
    apps: [],
  };
}

// Main Form Builder Component
export default function FormBuilder() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Whether the built-in AI is available (AI_ENABLED + configured). Hides the "Generate with AI"
  // entry points when off — users can still bring their own AI via the MCP "Connect an AI" flow.
  const aiAvailable = useAiAvailable();
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  // Snapshot of the form serialized to a pack, captured when "Publish as pack" opens (so
  // it stays stable while the publish dialog is open rather than rebuilding on each edit).
  const [packToPublish, setPackToPublish] = useState<PackData | null>(null);
  const authorName = useAuthStore((s) => s.user?.name) || 'Unknown';
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  // Toolbar dock toggles — focus returns here when a panel is collapsed via its X,
  // so keyboard/SR users land on the control that reopens it.
  const addFieldToggleRef = useRef<HTMLButtonElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  // Desktop dockable panels: the Fields palette is hidden until "Add Field"; the
  // field-settings panel auto-opens when a field is selected (collapsible via X).
  // The canvas takes the freed space when either is collapsed.
  // On a wide screen there's room for the full 3-pane layout, so open the Fields
  // palette by default (paired with auto-selecting the first field below, so the
  // settings dock shows too). Both stay collapsible.
  const WIDE_BUILDER = typeof window !== 'undefined' && window.innerWidth >= 1280;
  const [paletteOpen, setPaletteOpen] = useState(WIDE_BUILDER);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);

  const {
    getForm,
    loadFullForm,
    updateForm,
    addField,
    addFields,
    setFields,
    updateField,
    deleteField,
    reorderFields,
    selectedFieldId,
    setSelectedField,
    duplicateField,
    undoFields,
    redoFields,
  } = useFormStore();
  const isSaving = useFormStore((s) => formId ? !!s.savingFormIds[formId] : false);
  const storageMode = useFormStore((s) => s.storageMode);
  // Subscribe to this form's history so the undo/redo buttons re-render as it changes.
  const fieldHistory = useFormStore((s) => (formId ? s.fieldHistory[formId] : undefined));
  const canUndo = (fieldHistory?.past.length ?? 0) > 0;
  const canRedo = (fieldHistory?.future.length ?? 0) > 0;

  const { isMobile, setIsMobile, mobilePanel, setMobilePanel } = useUIStore();

  // Keep isMobile in sync with window size (FormBuilder is outside AppShell)
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile]);

  // Load full form data (with fields) from API when entering the builder.
  // Track completion so a fresh/direct navigation (empty store) shows a loader
  // and only redirects on a genuine miss — not during the in-flight fetch.
  // Track WHICH formId finished loading, not a bare boolean: a boolean stays true
  // across a formId change and is wrongly read as "finished" for the new id,
  // bouncing a valid still-loading form to /forms. Gating on the id makes
  // loadFinished false for any id whose load hasn't resolved yet.
  const [loadedFor, setLoadedFor] = useState<string>();
  useEffect(() => {
    if (!formId) return;
    let cancelled = false;
    loadFullForm(formId).finally(() => {
      if (!cancelled) setLoadedFor(formId);
    });
    return () => { cancelled = true; };
  }, [formId, loadFullForm]);
  const loadFinished = loadedFor === formId;

  // First-run onboarding routes "Generate with AI" here as ?ai=1 — open the AI generator once the
  // form has loaded, then strip the param so it doesn't re-open on refresh/navigation.
  const aiAutoOpened = useRef(false);
  useEffect(() => {
    if (loadFinished && !aiAutoOpened.current && searchParams.get('ai') !== null) {
      aiAutoOpened.current = true;
      // Only auto-open the generator if the in-app AI is actually available; otherwise just
      // strip the param (a stale/hand-typed ?ai=1 shouldn't surface a dead modal).
      if (aiAvailable) setActiveModal('ai');
      setSearchParams((p) => { p.delete('ai'); return p; }, { replace: true });
    }
  }, [loadFinished, searchParams, setSearchParams, aiAvailable]);

  // On a wide screen, open the builder with both docks: select the first editable
  // field once the form loads so the settings dock appears alongside the (default-open)
  // palette. Runs once per form; the user can still collapse/deselect freely.
  const autoSelectedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!loadFinished || !formId || isMobile) return;
    if (autoSelectedFor.current === formId) return;
    autoSelectedFor.current = formId;
    if (typeof window === 'undefined' || window.innerWidth < 1280) return;
    const f = getForm(formId);
    if (!f || f.fields.length === 0) return;
    if (useFormStore.getState().selectedFieldId) return; // respect an existing selection
    const first = f.fields.find((ff) => !['welcome_screen', 'thank_you', 'statement'].includes(ff.type)) || f.fields[0];
    setSelectedField(first.id);
  }, [loadFinished, formId, isMobile, getForm, setSelectedField]);

  const form = formId ? getForm(formId) : undefined;
  useDocumentTitle(form ? `${form.title} — Builder` : 'Form Builder');

  // Local title state to avoid calling updateForm on every keystroke
  const [localTitle, setLocalTitle] = useState(form?.title ?? '');
  const titleSyncedFromForm = useRef(form?.title);
  // Sync local title when form title changes externally (e.g., AI generation, undo)
  // eslint-disable-next-line react-hooks/refs -- official "adjust state during render" pattern: titleSyncedFromForm tracks the last-synced title to gate the re-seed, not read for render output
  if (form && form.title !== titleSyncedFromForm.current) {
    // eslint-disable-next-line react-hooks/refs -- record the title we just synced so this block re-runs only on the next external title change
    titleSyncedFromForm.current = form.title;
    setLocalTitle(form.title);
  }

  const flushTitle = useCallback(() => {
    if (!form) return;
    const trimmed = localTitle.trim();
    const finalTitle = trimmed || 'Untitled Form';
    if (finalTitle !== form.title) {
      updateForm(form.id, { title: finalTitle });
    }
    if (!trimmed) setLocalTitle(finalTitle);
  }, [form, localTitle, updateForm]);

  // Flush title to store on unmount
  const flushRef = useRef(flushTitle);
  // eslint-disable-next-line react-hooks/refs -- mirror ref for latest flushTitle read only by the unmount effect below; not read during render output
  flushRef.current = flushTitle;
  useEffect(() => () => { flushRef.current(); }, []);

  // Track latest form for cleanup ref (avoids stale closure in unmount effect)
  const formRef = useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);

  // Note: empty forms are intentionally kept as drafts rather than deleted on
  // unmount — deleting caused data loss when users briefly navigated away.

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const selectedField = form?.fields.find((f) => f.id === selectedFieldId);
  const selectedFieldIndex = form?.fields.findIndex((f) => f.id === selectedFieldId) ?? -1;
  const formFields = useMemo(() => form?.fields ?? [], [form]);

  // Selecting a field opens its settings: the settings tab on mobile, or the docked
  // settings panel on desktop (un-collapse it).
  const handleSelectField = useCallback((fieldId: string) => {
    setSelectedField(fieldId);
    if (isMobile) {
      setMobilePanel('settings');
    } else {
      setSettingsCollapsed(false);
      // Avoid a 3-column crush on a narrow desktop (<lg): give settings the room.
      if (window.innerWidth < 1024) setPaletteOpen(false);
    }
  }, [setSelectedField, isMobile, setMobilePanel]);

  // Open the Fields palette (the mobile tab, or the desktop dock). On a narrow
  // desktop (<lg) collapse the settings dock so we never show 3 columns at once.
  const openPalette = useCallback(() => {
    if (isMobile) {
      setMobilePanel('palette');
      return;
    }
    setPaletteOpen(true);
    if (window.innerWidth < 1024) setSettingsCollapsed(true);
  }, [isMobile, setMobilePanel]);

  // Toolbar dock toggles — flip a panel and, on a narrow desktop, keep at most two
  // columns so the canvas stays usable (768–1023px would otherwise crush it).
  const toggleDock = useCallback((which: 'palette' | 'settings') => {
    const narrow = window.innerWidth < 1024;
    if (which === 'palette') {
      const opening = !paletteOpen;
      setPaletteOpen(opening);
      if (opening && narrow) setSettingsCollapsed(true);
    } else {
      const opening = settingsCollapsed;
      setSettingsCollapsed(!settingsCollapsed);
      if (opening && narrow) setPaletteOpen(false);
    }
  }, [paletteOpen, settingsCollapsed]);

  // Add field handler (defined first for use in shortcuts)
  const handleAddField = useCallback((type: FieldType) => {
    if (!form) return;

    const defaultLabels: Partial<Record<FieldType, string>> = {
      short_text: 'Your answer',
      long_text: 'Your thoughts',
      email: 'Email address',
      phone: 'Phone number',
      number: 'Number',
      url: 'Website URL',
      date: 'Select a date',
      time: 'Select a time',
      datetime: 'Select date and time',
      dropdown: 'Select an option',
      multiple_choice: 'Choose one',
      checkboxes: 'Select all that apply',
      rating: 'Rate your experience',
      scale: 'Rate on a scale',
      file_upload: 'Upload a file',
      signature: 'Your signature',
      statement: 'Information',
      welcome_screen: 'Welcome',
      thank_you: 'Thank you!',
      calculated: 'Calculated value',
      linked_record: 'Linked record',
      location: 'Your location',
      hidden: 'Hidden value',
    };

    const genId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);

    const defaultOptions = ['dropdown', 'multiple_choice', 'checkboxes'].includes(type)
      ? [
        { id: genId(), label: 'Option 1', value: 'option_1' },
        { id: genId(), label: 'Option 2', value: 'option_2' },
        { id: genId(), label: 'Option 3', value: 'option_3' },
      ]
      : undefined;

    const field = addField(form.id, {
      type,
      label: defaultLabels[type] || 'New Field',
      required: false,
      properties: {
        options: defaultOptions,
        maxStars: type === 'rating' ? 5 : undefined,
        scaleStart: type === 'scale' ? 1 : undefined,
        scaleEnd: type === 'scale' ? 10 : undefined,
        // File upload defaults (maxFileSize is in BYTES; acceptedFileTypes is the
        // key the runtime reads — 'allowedTypes' was a dead key and `10` was 10 bytes)
        ...(type === 'file_upload' ? { maxFileSize: 10 * 1024 * 1024, acceptedFileTypes: [], allowMultiple: false } : {}),
        // Linked record defaults
        ...(type === 'linked_record' ? { targetFormId: '', displayFieldIds: [], searchFieldIds: [], allowMultiple: false } : {}),
      },
    });

    setSelectedField(field.id);

    // On mobile, switch to canvas to show the newly added field; on desktop, open
    // its settings (the new field is selected) so it's ready to edit.
    if (isMobile) {
      setMobilePanel('canvas');
    } else {
      setSettingsCollapsed(false);
      if (window.innerWidth < 1024) setPaletteOpen(false);
    }
  }, [form, addField, setSelectedField, isMobile, setMobilePanel]);

  // Keyboard shortcuts
  const handleSave = useCallback(() => {
    if (!form) return;
    updateForm(form.id, { status: form.status });
    toast.success('Saved', 'Form saved successfully');
  }, [form, updateForm]);

  const handlePreview = useCallback(() => {
    if (!form) return;
    navigate(`/preview/${form.id}`);
  }, [form, navigate]);

  // Deletion is destructive (it also strips conditional logic / calculations on other
  // fields that reference this one) and there's no in-session undo, so confirm first.
  const handleDeleteSelected = useCallback(() => {
    if (!form || !selectedFieldId) return;
    setPendingDeleteId(selectedFieldId);
  }, [form, selectedFieldId]);

  const handleDuplicateFieldById = useCallback((id: string) => {
    if (!form || !duplicateField) return;
    duplicateField(form.id, id);
    toast.success('Duplicated', 'Field duplicated');
  }, [form, duplicateField]);

  const handleDuplicateSelected = useCallback(() => {
    if (!form || !selectedFieldId || !duplicateField) return;
    duplicateField(form.id, selectedFieldId);
    toast.success('Duplicated', 'Field duplicated');
  }, [form, selectedFieldId, duplicateField]);

  // After undo/redo the focused field card may unmount — move focus to the (possibly
  // new) selected card so keyboard focus isn't stranded on document.body.
  const refocusSelection = useCallback(() => {
    requestAnimationFrame(() => {
      const sel = useFormStore.getState().selectedFieldId;
      if (sel) document.getElementById(`field-select-${sel}`)?.focus();
    });
  }, []);
  const handleUndo = useCallback(() => { if (form) { undoFields(form.id); refocusSelection(); } }, [form, undoFields, refocusSelection]);
  const handleRedo = useCallback(() => { if (form) { redoFields(form.id); refocusSelection(); } }, [form, redoFields, refocusSelection]);

  const handleNavigateFields = useCallback((direction: 'up' | 'down') => {
    if (formFields.length === 0) return;

    // Route through handleSelectField so keyboard navigation also opens the settings
    // dock (raw setSelectedField left it collapsed).
    const targetId = !selectedFieldId
      ? formFields[0].id
      : formFields[direction === 'up'
          ? Math.max(0, selectedFieldIndex - 1)
          : Math.min(formFields.length - 1, selectedFieldIndex + 1)].id;

    handleSelectField(targetId);
    // Move DOM focus with the selection so the focus ring tracks the highlight and
    // screen readers announce the newly-selected field.
    requestAnimationFrame(() => document.getElementById(`field-select-${targetId}`)?.focus());
  }, [formFields, selectedFieldId, selectedFieldIndex, handleSelectField]);

  const handleMoveField = useCallback((direction: 'up' | 'down') => {
    if (!form || !selectedFieldId || formFields.length < 2) return;

    const newIndex = direction === 'up'
      ? Math.max(0, selectedFieldIndex - 1)
      : Math.min(formFields.length - 1, selectedFieldIndex + 1);

    if (newIndex !== selectedFieldIndex) {
      const newOrder = [...formFields.map(f => f.id)];
      [newOrder[selectedFieldIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[selectedFieldIndex]];
      reorderFields(form.id, newOrder);
    }
  }, [form, formFields, selectedFieldId, selectedFieldIndex, reorderFields]);

  const shortcuts: KeyboardShortcut[] = useMemo(() => [
    { key: 's', ctrl: true, description: 'Save form', action: handleSave },
    { key: 'p', ctrl: true, description: 'Preview form', action: handlePreview },
    { key: '/', ctrl: true, description: 'Show keyboard shortcuts', action: () => setActiveModal('shortcuts') },
    { key: '?', ctrl: true, shift: true, description: 'Show keyboard shortcuts', action: () => setActiveModal('shortcuts') },
    { key: 'Escape', description: 'Deselect field', action: () => setSelectedField(null) },
    { key: 'd', ctrl: true, description: 'Duplicate selected field', action: handleDuplicateSelected },
    { key: 'z', ctrl: true, description: 'Undo', action: handleUndo, suppressInInput: true },
    { key: 'z', ctrl: true, shift: true, description: 'Redo', action: handleRedo, suppressInInput: true },
    { key: 'y', ctrl: true, description: 'Redo', action: handleRedo, suppressInInput: true },
    { key: 'Delete', description: 'Delete selected field', action: handleDeleteSelected },
    { key: 'Backspace', description: 'Delete selected field', action: handleDeleteSelected },
    { key: 'ArrowUp', description: 'Select previous field', action: () => handleNavigateFields('up') },
    { key: 'ArrowDown', description: 'Select next field', action: () => handleNavigateFields('down') },
    { key: 'ArrowUp', ctrl: true, description: 'Move field up', action: () => handleMoveField('up') },
    { key: 'ArrowDown', ctrl: true, description: 'Move field down', action: () => handleMoveField('down') },
    { key: 't', description: 'Add text field', action: () => handleAddField('short_text') },
    { key: 'e', description: 'Add email field', action: () => handleAddField('email') },
    { key: 'n', description: 'Add number field', action: () => handleAddField('number') },
    { key: 'r', description: 'Add rating field', action: () => handleAddField('rating') },
  ], [handleSave, handlePreview, handleDuplicateSelected, handleDeleteSelected, handleUndo, handleRedo, handleNavigateFields, handleMoveField, handleAddField, setSelectedField]);

  useKeyboardShortcuts({ shortcuts });

  // Close mobile menu on outside click or Escape
  useEffect(() => {
    if (!showMobileMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileMenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowMobileMenu(false); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showMobileMenu]);

  useEffect(() => {
    // Only redirect once the load attempt has finished and the form is genuinely
    // absent (a real 404 / no access) — not while the fetch is still in flight,
    // which previously bounced direct/bookmarked builder links to /forms.
    if (loadFinished && !form && formId) {
      navigate('/forms');
    }
  }, [loadFinished, form, formId, navigate]);

  // These must stay above the early return below so hook order is stable when
  // `form` transitions null -> loaded (or back, e.g. on delete). (Rules of Hooks)
  const handleUpdateField = useCallback((updates: Partial<FormField>) => {
    if (!form || !selectedFieldId) return;
    updateField(form.id, selectedFieldId, updates);
  }, [form, selectedFieldId, updateField]);

  const handleDeleteFieldById = useCallback((fieldId: string) => {
    if (!form) return;
    setPendingDeleteId(fieldId);
  }, [form]);

  const confirmDeleteField = useCallback(() => {
    if (!form || !pendingDeleteId) return;
    deleteField(form.id, pendingDeleteId);
    setPendingDeleteId(null);
    toast.success('Deleted', 'Field deleted');
  }, [form, pendingDeleteId, deleteField]);

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        {loadFinished ? (
          <p className="text-slate-500">Form not found</p>
        ) : (
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400" aria-label="Loading form" />
        )}
      </div>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = form.fields.findIndex((f) => f.id === active.id);
      const newIndex = form.fields.findIndex((f) => f.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = arrayMove(
        form.fields.map((f) => f.id),
        oldIndex,
        newIndex
      );
      reorderFields(form.id, newOrder);
    }
  };

  const handleAIGenerate = (r: AIGenerateResult) => {
    // Edit mode (replaceFields): the AI saw the existing form, so its script is a MODIFICATION →
    // apply it. Create mode: don't clobber a script the user already wrote.
    const applyScript = !!r.logicScript && (r.replaceFields || !form.logicScript);
    updateForm(form.id, {
      title: r.title || form.title,
      description: r.description || form.description,
      ...(applyScript ? { logicScript: r.logicScript } : {}),
      logicPrompt: (applyScript ? r.logicPrompt : undefined) ?? r.prompt,
    });

    if (r.replaceFields) {
      // Edit: replace the whole field set as one undo step (the AI returned the full modified list,
      // preserving ids for fields it kept so responses/logic stay valid).
      setFields(form.id, r.fields);
      if (r.fields.length > 0) setSelectedField(r.fields[0].id);
    } else {
      // Create/append: add generated fields as ONE undo step (not one per field).
      const created = addFields(form.id, r.fields.map((field) => ({
        type: field.type,
        label: field.label,
        description: field.description,
        placeholder: field.placeholder,
        required: field.required,
        properties: field.properties || {},
      })));
      if (created.length > 0) setSelectedField(created[0].id);
    }
  };

  const closeModal = () => setActiveModal(null);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="relative z-30 h-14 bg-white/95 dark:bg-slate-900/80 backdrop-blur-xl border-b border-gray-200/80 dark:border-slate-800 flex items-center justify-between px-2 sm:px-4 flex-shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 overflow-hidden">
          <Button variant="ghost" size="sm" onClick={() => navigate('/forms')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {/* Hidden on phones so the title input keeps usable width (the header is
              a single tight row on mobile). */}
          <div className="hidden sm:block flex-shrink-0">
            <IconPicker
              value={form.icon}
              onChange={(icon) => updateForm(form.id, { icon: icon ?? undefined })}
            />
          </div>
          <Input
            value={localTitle}
            onChange={(e) => setLocalTitle(e.target.value)}
            onBlur={flushTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            aria-label="Form title"
            className="border-none bg-transparent font-semibold text-base sm:text-lg focus:ring-0 p-0 min-w-0 w-full sm:w-48 md:w-auto"
          />
          {/* Save indicator — reflects the real storage mode (cloud vs local) and
              is announced to screen readers. Shown only on wide screens so it never
              crowds the action buttons; the left group also clips (overflow-hidden)
              so it can never overlap the right group on a tight header. */}
          <span role="status" aria-live="polite" className="hidden lg:flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500 flex-shrink-0">
            {isSaving ? (
              <><Loader2 className="h-3 w-3 animate-spin" />Saving</>
            ) : storageMode === 'api' ? (
              <><Cloud className="h-3 w-3" /><Check className="h-3 w-3" /><span className="sr-only">Saved to cloud</span></>
            ) : (
              <><HardDrive className="h-3 w-3" /><Check className="h-3 w-3" /><span className="sr-only">Saved locally</span></>
            )}
          </span>
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
          {/* AI Generator — hidden when the in-app AI is off (AI_ENABLED=false) or unconfigured. */}
          {aiAvailable && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveModal('ai')}
            title="Generate with AI"
            aria-label="Generate with AI"
            className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 border-purple-500/30 hover:border-purple-400"
          >
            <Sparkles className="h-4 w-4 text-purple-400" />
            <span className="hidden xl:inline ml-2 text-purple-600 dark:text-purple-300">AI</span>
          </Button>
          )}

          {/* Settings - hidden on smallest screens */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveModal('settings')}
            title="Form Settings"
            aria-label="Form Settings"
            className="hidden sm:flex"
          >
            <Settings className="h-4 w-4" />
            <span className="hidden xl:inline ml-2">Settings</span>
          </Button>

          {/* Theme - hidden on small screens */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveModal('theme')}
            title="Theme Customization"
            aria-label="Theme Customization"
            className="hidden md:flex"
          >
            <Palette className="h-4 w-4" />
            <span className="hidden xl:inline ml-2">Theme</span>
          </Button>

          {/* Script - hidden on small screens */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveModal('script')}
            title="Backend Logic Script"
            aria-label="Backend Logic Script"
            className="hidden md:flex"
          >
            <Code2 className="h-4 w-4" />
            <span className="hidden xl:inline ml-2">Script</span>
            {form.logicScript && <span className="ml-1 h-2 w-2 rounded-full bg-green-500" />}
          </Button>

          {/* Preview */}
          <Button variant="outline" size="sm" onClick={() => navigate(`/preview/${form.id}`)} title="Preview" aria-label="Preview form">
            <Eye className="h-4 w-4" />
            <span className="hidden xl:inline ml-2">Preview</span>
          </Button>

          {/* Custom Screen (Beta) — AI-built sandboxed frontend over this form's data */}
          <Button variant="outline" size="sm" onClick={() => navigate(`/forms/${form.id}/screen/edit`)} title="Custom screen (Beta)" aria-label="Custom screen">
            <MonitorPlay className="h-4 w-4" />
            <span className="hidden xl:inline ml-2">Screen</span>
          </Button>

          {/* View the custom screen as a flexible popup dashboard (only when one is enabled) */}
          {form.customScreen?.enabled && (
            <Button variant="outline" size="sm" onClick={() => setActiveModal('screen')} title="View dashboard" aria-label="View dashboard">
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden xl:inline ml-2">Dashboard</span>
            </Button>
          )}

          {/* Share - hidden on smallest screens */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveModal('embed')}
            title="Share & Embed"
            aria-label="Share & Embed"
            className="hidden sm:flex"
          >
            <Share2 className="h-4 w-4" />
            <span className="hidden xl:inline ml-2">Share</span>
          </Button>

          {/* Version history - hidden on smallest screens */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveModal('versions')}
            title="Version History"
            aria-label="Version History"
            className="hidden sm:flex"
          >
            <History className="h-4 w-4" />
          </Button>

          {/* Keyboard shortcuts - hidden on mobile */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveModal('shortcuts')}
            title="Keyboard Shortcuts (Ctrl+?)"
            aria-label="Keyboard Shortcuts"
            className="hidden sm:flex"
          >
            <Keyboard className="h-4 w-4" />
          </Button>

          {/* Mobile overflow menu */}
          <div className="relative sm:hidden" ref={mobileMenuRef}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={showMobileMenu}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
            {showMobileMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-700/60 py-1 z-50 animate-scale-in origin-top-right">
                {[
                  { label: 'Form Settings', icon: Settings, modal: 'settings' as ModalType },
                  { label: 'Theme', icon: Palette, modal: 'theme' as ModalType },
                  { label: 'Script', icon: Code2, modal: 'script' as ModalType, badge: !!form?.logicScript },
                  { label: 'Share & Embed', icon: Share2, modal: 'embed' as ModalType },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => { setActiveModal(item.modal); setShowMobileMenu(false); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    <item.icon className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                    {item.label}
                    {item.badge && <span className="ml-auto h-2 w-2 rounded-full bg-green-500" />}
                  </button>
                ))}
                <button
                  onClick={() => {
                    if ((form.fields?.length ?? 0) === 0) {
                      toast.warning('Add a field first', 'Build your form before publishing it as a pack.');
                      return;
                    }
                    setPackToPublish(buildFormPack(form, authorName));
                    setActiveModal('publishPack');
                    setShowMobileMenu(false);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <Package className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                  Publish as pack
                </button>
              </div>
            )}
          </div>

          {/* Publish — make it a real activation moment: confirm + surface the
              live link so first-time users know it worked and where it lives. */}
          <Button
            size="sm"
            onClick={async () => {
              if ((form.fields?.length ?? 0) === 0) {
                toast.warning('Add a field first', 'Your form needs at least one field before publishing.');
                return;
              }
              const alreadyLive = form.status === 'published';
              await updateForm(form.id, { status: 'published' });
              // Only cloud-stored forms have a public link / embed; a local form
              // isn't on the server, so don't claim a shareable link for it.
              if (storageMode === 'api') {
                toast.success(
                  alreadyLive ? 'Changes published' : 'Your form is live',
                  'Share the link or embed it anywhere.'
                );
                // Heads-up on first publish if it collects files: standalone public-form uploads
                // are link-accessible to anyone (see the file-upload field settings note).
                if (!alreadyLive && (form.fields ?? []).some((f) => f.type === 'file_upload')) {
                  toast.info(
                    'Public file access',
                    'Files uploaded to this public form can be opened by anyone with the link — use an app form for member-only access.'
                  );
                }
                setActiveModal('embed');
              } else {
                toast.success(
                  alreadyLive ? 'Changes published' : 'Form published',
                  'Switch to Cloud storage (top-right menu) to share it with a public link.'
                );
              }
            }}
          >
            <span>{form.status === 'published' ? 'Published' : 'Publish'}</span>
          </Button>
        </div>
      </header>

      {/* Mobile Tabs */}
      {isMobile && (
        <div className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 px-3 py-2 flex-shrink-0 flex items-center gap-2">
          <div className="flex-1 flex bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
            {([
              { key: 'palette' as const, label: 'Fields', icon: Plus },
              { key: 'canvas' as const, label: 'Canvas', icon: Layers, badge: formFields.length || undefined },
              { key: 'settings' as const, label: 'Settings', icon: Settings, disabled: !selectedField },
            ]).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setMobilePanel(tab.key)}
                disabled={tab.disabled}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-sm font-medium rounded-md transition-all ${
                  mobilePanel === tab.key
                    ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-slate-400'
                } ${tab.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
                {tab.badge && (
                  <span className={`text-xs rounded-full px-1.5 min-w-[1.25rem] text-center ${
                    mobilePanel === tab.key
                      ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300'
                      : 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400'
                  }`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button onClick={handleUndo} disabled={!canUndo} aria-label="Undo" className="inline-flex items-center justify-center min-h-10 min-w-10 rounded-lg text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
              <Undo2 className="h-4 w-4" />
            </button>
            <button onClick={handleRedo} disabled={!canRedo} aria-label="Redo" className="inline-flex items-center justify-center min-h-10 min-w-10 rounded-lg text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Field Palette — mobile tab, or desktop dock (opened via "Add Field").
            Hidden by default on desktop so the canvas gets the room. */}
        {(isMobile ? mobilePanel === 'palette' : paletteOpen) && (
          <aside className="w-full md:w-72 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 flex flex-col flex-shrink-0 md:animate-scale-in md:origin-left">
            <div className="flex items-center justify-between gap-2 p-4 border-b border-gray-200 dark:border-slate-800 flex-shrink-0">
              <h2 className="font-semibold text-gray-900 dark:text-white">Add a field</h2>
              <button
                onClick={() => { setPaletteOpen(false); addFieldToggleRef.current?.focus(); }}
                className="hidden md:inline-flex items-center justify-center min-h-8 min-w-8 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label="Collapse fields panel"
                title="Collapse"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Own scroll, independent of the canvas */}
            <div className="flex-1 overflow-y-auto">
              <FieldPalette onAddField={handleAddField} />
            </div>
          </aside>
        )}

        {/* Canvas — always on desktop; the active tab on mobile */}
        {(isMobile ? mobilePanel === 'canvas' : true) && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Desktop builder toolbar: dock toggles + field count (always reachable) */}
            <div className="hidden md:flex items-center justify-between gap-3 px-6 py-2.5 border-b border-gray-200/80 dark:border-slate-800 bg-white/70 dark:bg-slate-900/50 backdrop-blur flex-shrink-0">
              <div className="flex items-center gap-2">
                <Button
                  ref={addFieldToggleRef}
                  size="sm"
                  variant={paletteOpen ? 'secondary' : 'outline'}
                  onClick={() => toggleDock('palette')}
                  leftIcon={<Plus className="h-4 w-4" />}
                  aria-pressed={paletteOpen}
                >
                  Add Field
                </Button>
                <div className="flex items-center gap-0.5 border-l border-gray-200 dark:border-slate-700 pl-2">
                  <Button size="sm" variant="ghost" onClick={handleUndo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
                    <Undo2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleRedo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
                    <Redo2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <span className="text-xs text-gray-400 dark:text-slate-500">
                {formFields.length} field{formFields.length === 1 ? '' : 's'}
              </span>
              <Button
                ref={settingsToggleRef}
                size="sm"
                variant={selectedField && !settingsCollapsed ? 'secondary' : 'ghost'}
                onClick={() => { if (selectedField) toggleDock('settings'); }}
                disabled={!selectedField}
                aria-pressed={!!selectedField && !settingsCollapsed}
                aria-label="Toggle field settings"
                title={selectedField ? 'Toggle field settings' : 'Select a field to edit its settings'}
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden lg:inline ml-2">Settings</span>
              </Button>
            </div>

            {/* Own scroll, independent of the side panels */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              <div className="max-w-2xl mx-auto">
                {form.fields.length === 0 ? (
                  <div className="text-center py-12 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl">
                    <Plus className="h-12 w-12 text-gray-300 dark:text-slate-600 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                      Add your first field
                    </h3>
                    <p className="text-gray-500 dark:text-slate-400 mb-4">
                      {isMobile ? 'Tap the Fields tab above to get started' : 'Click “Add Field” to choose a field type.'}
                    </p>
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <Button onClick={openPalette} variant="outline" leftIcon={<Plus className="h-4 w-4" />}>
                        Add Field
                      </Button>
                      {aiAvailable && (
                        <>
                          <span className="text-gray-400 dark:text-slate-500">or</span>
                          <Button
                            onClick={() => setActiveModal('ai')}
                            className="bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600"
                          >
                            <Sparkles className="h-4 w-4 mr-2" />
                            Generate with AI
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={form.fields.map((f) => f.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-3">
                        {form.fields.map((field) => (
                          <SortableFieldCard
                            key={field.id}
                            field={field}
                            isSelected={field.id === selectedFieldId}
                            onSelect={handleSelectField}
                            onDelete={handleDeleteFieldById}
                            onDuplicate={handleDuplicateFieldById}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}

                {form.fields.length > 0 && (
                  <button
                    onClick={openPalette}
                    className="mt-4 w-full py-3 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl text-gray-500 dark:text-slate-400 hover:border-primary-300 hover:text-primary-600 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                    Add Field
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Settings Panel — mobile tab, or desktop dock (auto-opens on field select) */}
        {(isMobile ? mobilePanel === 'settings' : (!!selectedField && !settingsCollapsed)) && (
          <aside className="w-full md:w-80 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-800 flex flex-col flex-shrink-0 md:animate-scale-in md:origin-right">
            <div className="flex items-center justify-between gap-2 p-4 border-b border-gray-200 dark:border-slate-800 flex-shrink-0">
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-900 dark:text-white">Field settings</h2>
                {selectedField && (
                  <p className="text-sm text-gray-500 dark:text-slate-500 truncate">{FIELD_TYPE_INFO[selectedField.type]?.label}</p>
                )}
              </div>
              <button
                onClick={() => { setSettingsCollapsed(true); settingsToggleRef.current?.focus(); }}
                className="hidden md:inline-flex items-center justify-center min-h-8 min-w-8 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label="Collapse settings panel"
                title="Collapse"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Own scroll, independent of the canvas */}
            <div className="flex-1 overflow-y-auto">
              {selectedField ? (
                <FieldSettingsPanel
                  key={selectedField.id}
                  field={selectedField}
                  allFields={form.fields}
                  onUpdate={handleUpdateField}
                />
              ) : (
                <div className="p-6 text-center text-gray-500">
                  <Settings className="h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                  <p>Select a field to edit its settings</p>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Script Editor Modal */}
      <ScriptEditor
        isOpen={activeModal === 'script'}
        onClose={closeModal}
        script={form.logicScript || ''}
        onSave={(script) => {
          updateForm(form.id, { logicScript: script });
          toast.success('Script Saved', 'Your backend logic script has been saved');
        }}
        formFields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
        formId={form.id}
      />

      {/* Embed Modal */}
      <EmbedModal
        isOpen={activeModal === 'embed'}
        onClose={closeModal}
        formId={form.id}
        formTitle={form.title}
      />

      {activeModal === 'screen' && form.customScreen?.enabled && (
        <ScreenModal
          isOpen
          onClose={closeModal}
          screen={form.customScreen}
          formId={form.id}
          formTitle={form.title}
          fields={(form.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type }))}
        />
      )}

      {/* AI Form Generator Modal */}
      <AIFormGenerator
        isOpen={activeModal === 'ai'}
        onClose={closeModal}
        onGenerate={handleAIGenerate}
        existingFields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, required: f.required }))}
        existingScript={form.logicScript || ''}
      />

      {/* Theme Editor Modal */}
      <ThemeEditor
        isOpen={activeModal === 'theme'}
        onClose={closeModal}
        theme={form.theme}
        onSave={(theme) => updateForm(form.id, { theme })}
      />

      {/* Publish-as-pack: serialize this form into a pack and publish it to the marketplace */}
      <PublishPackDialog
        isOpen={activeModal === 'publishPack'}
        onClose={closeModal}
        initialPack={packToPublish}
        onPublished={closeModal}
      />

      {/* Form Settings Modal */}
      <FormSettingsModal
        isOpen={activeModal === 'settings'}
        onClose={closeModal}
        settings={form.settings}
        formId={form.id}
        onSave={(settings) => updateForm(form.id, { settings })}
      />

      {/* Version History */}
      <FormVersionHistory
        isOpen={activeModal === 'versions'}
        onClose={closeModal}
        formId={form.id}
        onRestored={() => loadFullForm(form.id, { force: true })}
      />

      {/* Keyboard Shortcuts Help */}
      <KeyboardShortcutsHelp
        isOpen={activeModal === 'shortcuts'}
        onClose={closeModal}
      />

      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        onConfirm={confirmDeleteField}
        title="Delete this field?"
        message={`Delete "${form.fields.find((f) => f.id === pendingDeleteId)?.label || 'this field'}"? Any conditional logic or calculations on other fields that reference it are removed too. This can't be undone.`}
        confirmLabel="Delete field"
        variant="danger"
      />
    </div>
  );
}
