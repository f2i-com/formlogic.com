import { useEffect, useState, useMemo, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  Check,
  Loader2,
  Save,
  Rocket,
  X,
  SlidersHorizontal,
  Undo2,
  Redo2,
  MonitorPlay,
  LayoutDashboard,
  Workflow,
  type LucideIcon,
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
import { cn } from '../lib/utils';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { IconPicker } from '../components/ui/IconPicker';
import { BottomSheet } from '../components/ui/BottomSheet';
import { ScriptEditor, FieldPalette, SortableFieldCard, FieldSettingsPanel, FormFlowsPanel, useFormPreview } from '../components/builder';
import { EmbedModal } from '../components/builder/EmbedModal';
import { ScreenModal } from '../components/custom-screen/ScreenModal';
import { AIFormGenerator, type AIGenerateResult } from '../components/builder/AIFormGenerator';
import { ThemeEditor } from '../components/builder/ThemeEditor';
import { PublishPackDialog } from '../components/builder/PublishPackDialog';
import { api, type PackData } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { FormSettingsModal } from '../components/builder/FormSettingsPanel';
import { FormVersionHistory } from '../components/builder/FormVersionHistory';
import { KeyboardShortcutsHelp } from '../components/builder/KeyboardShortcutsHelp';
import { resolveBuilderChrome, type BuilderChromeTier } from '../components/builder/builderChrome';
import { BUILDER_FLOWS_W, BUILDER_SETTINGS_W, resolveBuilderLayout, sameResolvedBuilderLayout, type ResolvedBuilderLayout } from '../components/builder/builderLayout';
import { FORM_SUBMITTED_EVENT } from '../components/builder/formFlowBindingsSerialize';
import { demoApplyFormBindingOverlay } from '../lib/demoLocal';
import { useFormStore } from '../stores/formStore';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../hooks/useKeyboardShortcuts';
import { usePersistentBoolean } from '../hooks/usePersistentBoolean';
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

interface BuilderHeaderAction {
  id: string;
  label: string;
  title?: string;
  icon: LucideIcon;
  onSelect: () => void;
  badgeDot?: boolean;
  countBadge?: number;
  disabled?: boolean;
  domId?: string;
}

function BuilderToolbarDivider() {
  return <div className="hidden h-4 w-px flex-none bg-gray-200 dark:bg-slate-700 sm:block" aria-hidden="true" />;
}

function BuilderSaveIndicator({ isSaving, storageMode, compact = false }: { isSaving: boolean; storageMode: string; compact?: boolean }) {
  const savedToCloud = storageMode === 'api';
  const label = isSaving ? 'Saving' : savedToCloud ? 'Saved to cloud' : 'Saved locally';
  // The floppy disk IS the save glyph (user request) — the title still says where it went.
  const icon = isSaving
    ? <Loader2 className="h-3 w-3 animate-spin" />
    : (
      <>
        <Save className="h-3 w-3" />
        <Check className="h-3 w-3" />
      </>
    );

  if (compact) {
    return (
      <span
        role="status"
        aria-live="polite"
        aria-label={label}
        title={label}
        className="flex h-8 w-8 flex-none items-center justify-center gap-0.5 text-gray-400 dark:text-slate-500"
      >
        {icon}
      </span>
    );
  }

  return (
    <span role="status" aria-live="polite" aria-label={label} title={label} className="flex flex-none items-center gap-1 text-xs text-gray-400 dark:text-slate-500">
      {icon}
      {isSaving && <span>Saving</span>}
    </span>
  );
}

function BuilderHeaderButton({
  action,
  showLabel,
  variant = 'outline',
}: {
  action: BuilderHeaderAction;
  showLabel: boolean;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
}) {
  const Icon = action.icon;
  return (
    <Button
      id={action.domId}
      variant={variant}
      size="sm"
      onClick={action.onSelect}
      disabled={action.disabled}
      title={action.title ?? action.label}
      // The descriptive title IS the accessible name (pre-redesign behavior — e2e and SR
      // users rely on names like "Backend Logic Script", not the short visual label).
      aria-label={action.title ?? action.label}
      className="whitespace-nowrap"
    >
      <Icon className="h-4 w-4" />
      {showLabel && <span>{action.label}</span>}
      {action.badgeDot && <span className="h-2 w-2 rounded-full bg-green-500" aria-label="Configured" />}
      {typeof action.countBadge === 'number' && (
        <span className="ml-0.5 min-w-[1.1rem] rounded-full bg-primary-100 px-1.5 py-0.5 text-center text-[10px] font-semibold text-primary-700 dark:bg-primary-500/20 dark:text-primary-200">
          {action.countBadge}
        </span>
      )}
    </Button>
  );
}

function BuilderAiButton({ showLabel, onClick }: { showLabel: boolean; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      title="Generate with AI"
      aria-label="Generate with AI"
      className="whitespace-nowrap border-primary-200 bg-primary-50 text-primary-700 hover:border-primary-300 hover:bg-primary-100 hover:text-primary-800 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200 dark:hover:border-primary-400/50 dark:hover:bg-primary-500/15"
    >
      <Sparkles className="h-4 w-4 text-primary-500 dark:text-primary-300" />
      {showLabel && <span>AI</span>}
    </Button>
  );
}

const BUILDER_BELOW_MD_QUERY = '(max-width: 767.98px)';

function mediaMatches(query: string, fallback: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback;
  return window.matchMedia(query).matches;
}

async function countFlowBindingsForForm(formId: string): Promise<number> {
  const demoMode = api.isDemoMode();
  const [workspaceRes, contextsRes] = await Promise.all([
    api.listFormFlowBindings(formId),
    api.getFormAppContexts(formId),
  ]);
  const serverWorkspaceBindings = workspaceRes.data?.bindings.filter((binding) => binding.event === FORM_SUBMITTED_EVENT) ?? [];
  const workspaceBindings = demoMode
    ? await demoApplyFormBindingOverlay(formId, serverWorkspaceBindings)
    : serverWorkspaceBindings;
  const workspaceCount = workspaceBindings.length;
  const contexts = contextsRes.data?.contexts ?? [];
  const appCounts = await Promise.all(contexts.map(async (context) => {
    const res = await api.listFlowBindings(context.appId);
    return res.data?.bindings.filter((binding) => (
      binding.event === FORM_SUBMITTED_EVENT && binding.formId === formId
    )).length ?? 0;
  }));
  return workspaceCount + appCounts.reduce((sum, count) => sum + count, 0);
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
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const headerWidthRef = useRef<number | null>(null);
  const [builderChrome, setBuilderChrome] = useState<BuilderChromeTier>(() => resolveBuilderChrome(null));
  const builderChromeRef = useRef(builderChrome);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  // Toolbar dock toggles — focus returns here when a panel is collapsed via its X,
  // so keyboard/SR users land on the control that reopens it.
  const addFieldToggleRef = useRef<HTMLButtonElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  // User dock preferences are persisted, then layered under measured-width forced
  // states by resolveBuilderLayout. Collapsing a dock changes preference; resize
  // pressure only changes the derived layout tier.
  const [paletteOpenPref, setPaletteOpenPref] = usePersistentBoolean('builder.paletteOpen', true);
  const [settingsCollapsed, setSettingsCollapsed] = usePersistentBoolean('builder.settingsCollapsed', false);
  const [paletteSheetOpen, setPaletteSheetOpen] = useState(false);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [flowBindingCount, setFlowBindingCount] = useState(0);
  const builderBodyRef = useRef<HTMLDivElement | null>(null);
  const builderWidthRef = useRef<number | null>(null);
  const builderLayoutObserverRef = useRef<ResizeObserver | null>(null);
  const [belowMd, setBelowMd] = useState(() => mediaMatches(BUILDER_BELOW_MD_QUERY, false));
  const [builderLayout, setBuilderLayout] = useState<ResolvedBuilderLayout>(() => resolveBuilderLayout({
    builderWidth: null,
    belowMd: mediaMatches(BUILDER_BELOW_MD_QUERY, false),
    paletteOpenPref,
    settingsWanted: false,
  }));
  const builderLayoutRef = useRef(builderLayout);

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

  const { setIsMobile } = useUIStore();
  const isMobile = belowMd;

  // Keep isMobile in sync with the same below-md media query the measured layout uses.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(BUILDER_BELOW_MD_QUERY);
    const apply = () => {
      const next = query.matches;
      setBelowMd((current) => (current === next ? current : next));
      setIsMobile(next);
    };
    void (async () => {
      await Promise.resolve();
      apply();
    })();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [setIsMobile]);

  const applyBuilderChrome = useCallback((width: number | null = headerWidthRef.current) => {
    const next = resolveBuilderChrome(width);
    if (builderChromeRef.current === next) return;
    builderChromeRef.current = next;
    setBuilderChrome(next);
  }, []);

  // Attach the observer via a CALLBACK ref, not a mount effect: the `if (!form)` loader renders
  // before the header exists, so a mount-time effect sees a null ref and never observes — the
  // chrome tier would freeze at its initial window-width guess (user-reported).
  const chromeObserverRef = useRef<ResizeObserver | null>(null);
  const observeHeader = useCallback((el: HTMLElement | null) => {
    chromeObserverRef.current?.disconnect();
    chromeObserverRef.current = null;
    headerRef.current = el;
    if (!el) return;
    headerWidthRef.current = el.getBoundingClientRect().width;
    applyBuilderChrome(headerWidthRef.current);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width !== 'number') return;
      headerWidthRef.current = width;
      applyBuilderChrome(width);
    });
    observer.observe(el);
    chromeObserverRef.current = observer;
  }, [applyBuilderChrome]);

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
    if (builderWidthRef.current === null) return;
    const spacious = resolveBuilderLayout({
      builderWidth: builderWidthRef.current,
      belowMd,
      paletteOpenPref,
      settingsWanted: true,
    });
    if (spacious.palette !== 'inline' || spacious.settings !== 'inline') return;
    autoSelectedFor.current = formId;
    const f = getForm(formId);
    if (!f || f.fields.length === 0) return;
    if (useFormStore.getState().selectedFieldId) return; // respect an existing selection
    const first = f.fields.find((ff) => !['welcome_screen', 'thank_you', 'statement'].includes(ff.type)) || f.fields[0];
    setSelectedField(first.id);
  }, [belowMd, builderLayout, loadFinished, formId, isMobile, getForm, paletteOpenPref, setSelectedField]);

  const form = formId ? getForm(formId) : undefined;
  useDocumentTitle(form ? `${form.title} — Builder` : 'Form Builder');

  // Local title state to avoid calling updateForm on every keystroke
  const [localTitle, setLocalTitle] = useState(form?.title ?? '');
  const titleSyncedFromForm = useRef(form?.title);
  // Sync local title when form title changes externally (e.g., AI generation, undo)
  if (form && form.title !== titleSyncedFromForm.current) {
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
  const currentFormId = form?.id;
  // Flows work for ANY saved cloud form — draft or published (the binding routes gate on
  // ownership only). The disabled title must name the REAL blocker: a generic "save first"
  // message on a local-mode draft read as "flows need a published form" (user-reported).
  const formFlowsDisabledReason = !form
    ? 'Save the form first to add flows'
    : storageMode !== 'api'
        ? 'Switch to Cloud storage to use flows (drafts work too)'
        : null;
  const canUseFormFlows = formFlowsDisabledReason === null;
  const fieldSettingsWanted = !!selectedField && !settingsCollapsed && !flowsOpen;
  const rightDockWanted = flowsOpen || fieldSettingsWanted;

  const applyBuilderLayout = useCallback((width: number | null = builderWidthRef.current) => {
    const next = resolveBuilderLayout({
      builderWidth: width,
      belowMd,
      paletteOpenPref,
      settingsWanted: rightDockWanted,
      rightDockWidth: flowsOpen ? BUILDER_FLOWS_W : BUILDER_SETTINGS_W,
    });
    if (sameResolvedBuilderLayout(builderLayoutRef.current, next)) return;
    builderLayoutRef.current = next;
    setBuilderLayout(next);
  }, [belowMd, paletteOpenPref, rightDockWanted, flowsOpen]);

  const observeBuilderBody = useCallback((el: HTMLDivElement | null) => {
    builderLayoutObserverRef.current?.disconnect();
    builderLayoutObserverRef.current = null;
    builderBodyRef.current = el;
    if (!el) return;
    builderWidthRef.current = el.getBoundingClientRect().width;
    applyBuilderLayout(builderWidthRef.current);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width !== 'number') return;
      builderWidthRef.current = width;
      applyBuilderLayout(width);
    });
    observer.observe(el);
    builderLayoutObserverRef.current = observer;
  }, [applyBuilderLayout]);

  useEffect(() => {
    applyBuilderLayout();
  }, [applyBuilderLayout]);

  useEffect(() => {
    if (builderLayout.palette !== 'inline' || !paletteSheetOpen) return;
    void (async () => {
      await Promise.resolve();
      setPaletteSheetOpen(false);
    })();
  }, [builderLayout.palette, paletteSheetOpen]);

  useEffect(() => {
    if (!currentFormId || !canUseFormFlows) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      const count = await countFlowBindingsForForm(currentFormId);
      if (!cancelled) setFlowBindingCount(count);
    })();
    return () => { cancelled = true; };
  }, [canUseFormFlows, currentFormId]);

  // Selecting a field opens its settings through the measured layout resolver.
  const handleSelectField = useCallback((fieldId: string) => {
    setSelectedField(fieldId);
    setFlowsOpen(false);
    setPaletteSheetOpen(false);
    setSettingsCollapsed(false);
  }, [setSelectedField, setSettingsCollapsed]);

  // Open the Fields palette inline when the measured width allows it, otherwise as a sheet.
  const openPalette = useCallback(() => {
    setPaletteOpenPref(true);
    if (builderLayout.palette === 'hidden') setPaletteSheetOpen(true);
  }, [builderLayout.palette, setPaletteOpenPref]);

  // Toolbar dock toggles — flip a panel and, on a narrow desktop, keep at most two
  // columns so the canvas stays usable (768–1023px would otherwise crush it).
  const toggleDock = useCallback((which: 'palette' | 'settings') => {
    if (which === 'palette') {
      const opening = !paletteOpenPref;
      setPaletteOpenPref(opening);
      setPaletteSheetOpen(opening && builderLayout.palette === 'hidden');
    } else {
      const opening = settingsCollapsed;
      setSettingsCollapsed(!settingsCollapsed);
      if (opening) {
        setFlowsOpen(false);
        setPaletteSheetOpen(false);
      }
    }
  }, [builderLayout.palette, paletteOpenPref, setPaletteOpenPref, setSettingsCollapsed, settingsCollapsed]);

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

    // Close the add-field sheet; the selected field's settings reopen through the resolver.
    setPaletteSheetOpen(false);
    setFlowsOpen(false);
    setSettingsCollapsed(false);
  }, [form, addField, setSelectedField, setSettingsCollapsed]);

  // Keyboard shortcuts
  const handleSave = useCallback(() => {
    if (!form) return;
    updateForm(form.id, { status: form.status });
    toast.success('Saved', 'Form saved successfully');
  }, [form, updateForm]);

  // Open Preview in a NEW TAB, in context: a fresh app-context lookup on each click (shared
  // mechanism) — one published app opens the app runtime at this form, several ask which,
  // otherwise (or on any fetch failure) the standalone fillable form.
  const { openPreview, previewChooser } = useFormPreview();
  const handlePreview = useCallback(() => {
    if (!form) return;
    openPreview(form.id);
  }, [form, openPreview]);

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

  const closeOverflowMenu = useCallback((restoreFocus = true) => {
    setShowOverflowMenu(false);
    if (restoreFocus) requestAnimationFrame(() => overflowButtonRef.current?.focus());
  }, []);

  const overflowMenuItems = useCallback(() => (
    Array.from(overflowMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
  ), []);

  const focusOverflowItem = useCallback((index: number) => {
    const items = overflowMenuItems();
    if (items.length === 0) return;
    const next = ((index % items.length) + items.length) % items.length;
    items[next]?.focus();
  }, [overflowMenuItems]);

  const handleOverflowMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = overflowMenuItems();
    const current = items.findIndex((item) => item === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusOverflowItem(current < 0 ? 0 : current + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusOverflowItem(current < 0 ? items.length - 1 : current - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusOverflowItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusOverflowItem(items.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeOverflowMenu();
    }
  }, [closeOverflowMenu, focusOverflowItem, overflowMenuItems]);

  // Close the all-width overflow menu on outside click or Escape.
  useEffect(() => {
    if (!showOverflowMenu) return;
    requestAnimationFrame(() => focusOverflowItem(0));
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        closeOverflowMenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') closeOverflowMenu(); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeOverflowMenu, focusOverflowItem, showOverflowMenu]);

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

  const handlePublishPack = useCallback(() => {
    if (!form) return;
    if ((form.fields?.length ?? 0) === 0) {
      toast.warning('Add a field first', 'Build your form before publishing it as a pack.');
      return;
    }
    setPackToPublish(buildFormPack(form, authorName));
    setActiveModal('publishPack');
  }, [authorName, form]);

  const handleFlowsSelect = useCallback(() => {
    if (!canUseFormFlows) return;
    setPaletteSheetOpen(false);
    setFlowsOpen((open) => {
      const next = !open;
      return next;
    });
  }, [canUseFormFlows]);

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
  const showHeaderLabels = builderChrome === 'full';
  const foldMiddleClusters = builderChrome === 'tiny';
  const designActions: BuilderHeaderAction[] = [
    { id: 'theme', label: 'Theme', title: 'Theme Customization', icon: Palette, onSelect: () => setActiveModal('theme') },
    { id: 'screen', label: 'Screen', title: 'Custom screen (Beta)', icon: MonitorPlay, onSelect: () => navigate(`/forms/${form.id}/screen/edit`) },
    ...(form.customScreen?.enabled ? [{ id: 'dashboard', label: 'Dashboard', title: 'View dashboard', icon: LayoutDashboard, onSelect: () => setActiveModal('screen') }] : []),
  ];
  const dataActions: BuilderHeaderAction[] = [
    { id: 'settings', label: 'Settings', title: 'Form Settings', icon: Settings, onSelect: () => setActiveModal('settings') },
    { id: 'script', label: 'Script', title: 'Backend Logic Script', icon: Code2, onSelect: () => setActiveModal('script'), badgeDot: !!form.logicScript },
    {
      id: 'flows',
      label: 'Flows',
      title: canUseFormFlows ? 'Flows for this form' : 'Save the form first to add flows',
      icon: Workflow,
      onSelect: handleFlowsSelect,
      countBadge: canUseFormFlows ? flowBindingCount : 0,
      disabled: !canUseFormFlows,
      domId: 'builder-flows-button',
    },
  ];
  const previewActions: BuilderHeaderAction[] = [
    { id: 'preview', label: 'Preview', title: 'Preview (opens in a new tab)', icon: Eye, onSelect: handlePreview },
    { id: 'share', label: 'Share', title: 'Share & Embed', icon: Share2, onSelect: () => setActiveModal('embed') },
  ];
  const overflowActions: BuilderHeaderAction[] = [
    ...(foldMiddleClusters ? [...designActions, ...dataActions] : []),
    { id: 'versions', label: 'Versions', title: 'Version History', icon: History, onSelect: () => setActiveModal('versions') },
    { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard Shortcuts (Ctrl+?)', icon: Keyboard, onSelect: () => setActiveModal('shortcuts') },
    { id: 'publish-pack', label: 'Publish as pack', icon: Package, onSelect: handlePublishPack },
  ];
  const chooseOverflowAction = (action: BuilderHeaderAction) => {
    setShowOverflowMenu(false);
    action.onSelect();
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header ref={observeHeader} className="relative z-30 h-14 bg-white/95 dark:bg-slate-900/80 backdrop-blur-xl border-b border-gray-200/80 dark:border-slate-800 flex items-center justify-between px-2 sm:px-4 flex-shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <Button variant="ghost" size="sm" onClick={() => navigate('/forms')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {/* Hidden on phones so the title input keeps usable width (the header is
              a single tight row on mobile). OUTSIDE the clipped block: its popover is
              absolute-positioned and an overflow-hidden ancestor would clip the whole
              icon grid invisible (user-reported). */}
          <div className="hidden sm:block flex-shrink-0">
            <IconPicker
              value={form.icon}
              onChange={(icon) => updateForm(form.id, { icon: icon ?? undefined })}
            />
          </div>
          {/* Only the title + save indicator are clipped — they're what can collide with
              the right-side clusters when the header is squeezed. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 overflow-hidden">
            <Input
              value={localTitle}
              onChange={(e) => setLocalTitle(e.target.value)}
              onBlur={flushTitle}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              aria-label="Form title"
              className="border-none bg-transparent font-semibold text-base sm:text-lg focus:ring-0 p-0 min-w-0 w-full sm:w-48 md:w-auto"
            />
            {/* Save indicator — reflects the real storage mode (cloud vs local) and
                is announced to screen readers. Full at lg+, compact below, and clipped
                with the title so it can never overlap the right group. */}
            <div className="hidden flex-none lg:flex">
              <BuilderSaveIndicator isSaving={isSaving} storageMode={storageMode} />
            </div>
            <div className="flex flex-none lg:hidden">
              <BuilderSaveIndicator isSaving={isSaving} storageMode={storageMode} compact />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
          {aiAvailable && <BuilderAiButton showLabel={showHeaderLabels} onClick={() => setActiveModal('ai')} />}
          {aiAvailable && <BuilderToolbarDivider />}

          {!foldMiddleClusters && (
            <>
              <div className="flex flex-none items-center gap-1 whitespace-nowrap">
                {designActions.map((action) => <BuilderHeaderButton key={action.id} action={action} showLabel={showHeaderLabels} />)}
              </div>
              <BuilderToolbarDivider />
              <div className="flex flex-none items-center gap-1 whitespace-nowrap">
                {dataActions.map((action) => <BuilderHeaderButton key={action.id} action={action} showLabel={showHeaderLabels} />)}
              </div>
              <BuilderToolbarDivider />
            </>
          )}

          <div className="flex flex-none items-center gap-1 whitespace-nowrap">
            {previewActions.map((action) => <BuilderHeaderButton key={action.id} action={action} showLabel={showHeaderLabels} />)}
          </div>

          <div className="relative flex-none" ref={overflowMenuRef}>
            <Button
              ref={overflowButtonRef}
              variant="ghost"
              size="sm"
              onClick={() => setShowOverflowMenu((open) => !open)}
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={showOverflowMenu}
              title="More options"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
            {showOverflowMenu && (
              <div
                role="menu"
                aria-label="More builder actions"
                onKeyDown={handleOverflowMenuKeyDown}
                className="absolute right-0 top-full z-50 mt-1.5 w-56 origin-top-right animate-scale-in rounded-xl border border-gray-200/80 bg-white py-1 shadow-xl shadow-gray-900/10 dark:border-slate-700/60 dark:bg-slate-900 dark:shadow-black/30"
              >
                {overflowActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      disabled={action.disabled}
                      onClick={() => chooseOverflowAction(action)}
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 focus:bg-gray-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
                    >
                      <Icon className="h-4 w-4 flex-none text-gray-400 dark:text-slate-500" />
                      <span className="min-w-0 flex-1 truncate">{action.label}</span>
                      {action.badgeDot && <span className="h-2 w-2 rounded-full bg-green-500" aria-label="Configured" />}
                      {typeof action.countBadge === 'number' && (
                        <span className="rounded-full bg-primary-100 px-1.5 py-0.5 text-[10px] font-semibold text-primary-700 dark:bg-primary-500/20 dark:text-primary-200">
                          {action.countBadge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Publish — make it a real activation moment: confirm + surface the
              live link so first-time users know it worked and where it lives. */}
          <Button
            size="sm"
            title={form.status === 'published' ? 'Published' : 'Publish'}
            aria-label={form.status === 'published' ? 'Published' : 'Publish'}
            leftIcon={<Rocket className="h-4 w-4" />}
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
            {showHeaderLabels && <span>{form.status === 'published' ? 'Published' : 'Publish'}</span>}
          </Button>
        </div>
      </header>

      {/* Mobile controls */}
      {isMobile && (
        <div className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 px-3 py-2 flex-shrink-0 flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={openPalette} leftIcon={<Plus className="h-4 w-4" />} className="flex-shrink-0">
            Add Field
          </Button>
          <span className="min-w-0 flex-1 text-center text-xs text-gray-400 dark:text-slate-500">
            {formFields.length} field{formFields.length === 1 ? '' : 's'}
          </span>
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
      <div ref={observeBuilderBody} className="flex-1 flex overflow-hidden">
        {/* Field Palette — inline when there is room, otherwise opened as a sheet. */}
        {builderLayout.palette === 'inline' && (
          <aside className="w-full md:w-72 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 flex flex-col flex-shrink-0 md:animate-scale-in md:origin-left motion-safe:transition-[width] motion-safe:duration-200">
            <div className="flex items-center justify-between gap-2 p-4 border-b border-gray-200 dark:border-slate-800 flex-shrink-0">
              <h2 className="font-semibold text-gray-900 dark:text-white">Add a field</h2>
              <button
                onClick={() => {
                  setPaletteOpenPref(false);
                  // The Add Field toggle only renders once the palette is closed — focus it on
                  // the next frame, after React has put it back in the toolbar.
                  requestAnimationFrame(() => addFieldToggleRef.current?.focus());
                }}
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

        {/* Canvas */}
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Desktop builder toolbar: dock toggles + field count (always reachable) */}
            <div className="hidden md:flex items-center justify-between gap-3 px-6 py-2.5 border-b border-gray-200/80 dark:border-slate-800 bg-white/70 dark:bg-slate-900/50 backdrop-blur flex-shrink-0">
              <div className="flex items-center gap-2">
                {/* Redundant while the palette sidebar is showing (it has its own X) — the
                    button reappears the moment the palette closes. Mobile keeps its own
                    always-visible Add Field button since the sidebar can't show there. */}
                {builderLayout.palette !== 'inline' && (
                  <Button
                    ref={addFieldToggleRef}
                    size="sm"
                    variant="outline"
                    onClick={() => toggleDock('palette')}
                    leftIcon={<Plus className="h-4 w-4" />}
                  >
                    Add Field
                  </Button>
                )}
                <div className={cn('flex items-center gap-0.5', builderLayout.palette !== 'inline' && 'border-l border-gray-200 dark:border-slate-700 pl-2')}>
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
                variant={fieldSettingsWanted && builderLayout.settings === 'inline' ? 'secondary' : 'ghost'}
                onClick={() => {
                  if (!selectedField) return;
                  if (flowsOpen) {
                    setFlowsOpen(false);
                    setSettingsCollapsed(false);
                    return;
                  }
                  toggleDock('settings');
                }}
                disabled={!selectedField}
                aria-pressed={fieldSettingsWanted && builderLayout.settings === 'inline'}
                aria-label="Toggle field settings"
                title={selectedField ? 'Toggle field settings' : 'Select a field to edit its settings'}
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden lg:inline ml-2">Settings</span>
              </Button>
            </div>

            {/* Own scroll, independent of the side panels */}
            <div className="flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:p-6">
              <div className="max-w-2xl mx-auto">
                {form.fields.length === 0 ? (
                  <div className="text-center py-12 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl">
                    <Plus className="h-12 w-12 text-gray-300 dark:text-slate-600 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                      Add your first field
                    </h3>
                    <p className="text-gray-500 dark:text-slate-400 mb-4">
                      {isMobile ? 'Tap Add Field to get started' : 'Click "Add Field" to choose a field type.'}
                    </p>
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <Button onClick={openPalette} variant="outline" leftIcon={<Plus className="h-4 w-4" />}>
                        Add Field
                      </Button>
                      {aiAvailable && (
                        <>
                          <span className="text-gray-400 dark:text-slate-500">or</span>
                          <Button onClick={() => setActiveModal('ai')}>
                            <Sparkles className="mr-2 h-4 w-4 text-primary-foreground/90" />
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

        {/* Settings Panel — inline when there is room, otherwise opened as a sheet. */}
        {fieldSettingsWanted && builderLayout.settings === 'inline' && (
          <aside className="w-full md:w-80 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-800 flex flex-col flex-shrink-0 md:animate-scale-in md:origin-right motion-safe:transition-[width] motion-safe:duration-200">
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

        {canUseFormFlows && flowsOpen && builderLayout.settings === 'inline' && (
          <FormFlowsPanel
            formId={form.id}
            formTitle={form.title}
            fields={form.fields}
            onCountChange={setFlowBindingCount}
            onClose={() => {
              setFlowsOpen(false);
              document.getElementById('builder-flows-button')?.focus();
            }}
          />
        )}
      </div>

      <BottomSheet title="Add a field" open={paletteSheetOpen} onClose={() => setPaletteSheetOpen(false)}>
        <div className="h-full min-h-0 overflow-y-auto pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <FieldPalette onAddField={handleAddField} />
        </div>
      </BottomSheet>

      {selectedField && (
        <BottomSheet
          title="Field settings"
          open={fieldSettingsWanted && builderLayout.settings === 'sheet' && !paletteSheetOpen}
          onClose={() => {
            setSettingsCollapsed(true);
            settingsToggleRef.current?.focus();
          }}
        >
          <div className="h-full min-h-0 overflow-y-auto pb-[calc(1rem+env(safe-area-inset-bottom))] [&_[role=tabpanel]]:pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <FieldSettingsPanel
              key={selectedField.id}
              field={selectedField}
              allFields={form.fields}
              onUpdate={handleUpdateField}
            />
          </div>
        </BottomSheet>
      )}

      {canUseFormFlows && (
        <BottomSheet
          title="Flows"
          open={flowsOpen && builderLayout.settings === 'sheet' && !paletteSheetOpen}
          onClose={() => {
            setFlowsOpen(false);
            document.getElementById('builder-flows-button')?.focus();
          }}
        >
          <FormFlowsPanel
            formId={form.id}
            formTitle={form.title}
            fields={form.fields}
            onCountChange={setFlowBindingCount}
            onClose={() => setFlowsOpen(false)}
            variant="sheet"
          />
        </BottomSheet>
      )}

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
        formStatus={form.status}
      />

      {activeModal === 'screen' && form.customScreen?.enabled && (
        <ScreenModal
          isOpen
          onClose={closeModal}
          screen={form.customScreen}
          formId={form.id}
          formTitle={form.title}
          fields={(form.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type }))}
          accent={form.theme?.primaryColor}
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

      {/* Preview chooser — shown when this form is published in 2+ apps */}
      {previewChooser}
    </div>
  );
}
