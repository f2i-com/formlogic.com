import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Eye,
  Settings,
  Plus,
  Code2,
  Share2,
  Sparkles,
  Palette,
  Keyboard,
  History,
  MoreVertical,
  Layers,
  Cloud,
  Check,
  Loader2,
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
import { IconPicker } from '../components/ui/IconPicker';
import { ScriptEditor, FieldPalette, SortableFieldCard, FieldSettingsPanel } from '../components/builder';
import { EmbedModal } from '../components/builder/EmbedModal';
import { AIFormGenerator } from '../components/builder/AIFormGenerator';
import { ThemeEditor } from '../components/builder/ThemeEditor';
import { FormSettingsModal } from '../components/builder/FormSettingsPanel';
import { FormVersionHistory } from '../components/builder/FormVersionHistory';
import { KeyboardShortcutsHelp } from '../components/builder/KeyboardShortcutsHelp';
import { useFormStore } from '../stores/formStore';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../hooks/useKeyboardShortcuts';
import { toast } from '../stores/toastStore';
import { useUIStore } from '../stores/uiStore';
import type { FormField, FieldType } from '../types/form';

type ModalType = 'script' | 'embed' | 'ai' | 'theme' | 'settings' | 'shortcuts' | 'versions' | null;

// Main Form Builder Component
export default function FormBuilder() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  const {
    getForm,
    loadFullForm,
    updateForm,
    addField,
    updateField,
    deleteField,
    reorderFields,
    selectedFieldId,
    setSelectedField,
    duplicateField,
  } = useFormStore();
  const isSaving = useFormStore((s) => formId ? !!s.savingFormIds[formId] : false);

  const { isMobile, setIsMobile, mobilePanel, setMobilePanel } = useUIStore();

  // Keep isMobile in sync with window size (FormBuilder is outside AppShell)
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile]);

  // Load full form data (with fields) from API when entering the builder
  useEffect(() => {
    if (formId) loadFullForm(formId);
  }, [formId, loadFullForm]);

  const form = formId ? getForm(formId) : undefined;

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
  const formFields = form?.fields ?? [];

  // On mobile, switch to settings panel when a field is selected
  const handleSelectField = useCallback((fieldId: string) => {
    setSelectedField(fieldId);
    if (isMobile) {
      setMobilePanel('settings');
    }
  }, [setSelectedField, isMobile, setMobilePanel]);

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

    // On mobile, switch to canvas to show the newly added field
    if (isMobile) {
      setMobilePanel('canvas');
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

  const handleDeleteSelected = useCallback(() => {
    if (!form || !selectedFieldId) return;
    deleteField(form.id, selectedFieldId);
    toast.success('Deleted', 'Field deleted');
  }, [form, selectedFieldId, deleteField]);

  const handleDuplicateSelected = useCallback(() => {
    if (!form || !selectedFieldId || !duplicateField) return;
    duplicateField(form.id, selectedFieldId);
    toast.success('Duplicated', 'Field duplicated');
  }, [form, selectedFieldId, duplicateField]);

  const handleNavigateFields = useCallback((direction: 'up' | 'down') => {
    if (formFields.length === 0) return;

    if (!selectedFieldId) {
      setSelectedField(formFields[0].id);
      return;
    }

    const newIndex = direction === 'up'
      ? Math.max(0, selectedFieldIndex - 1)
      : Math.min(formFields.length - 1, selectedFieldIndex + 1);

    setSelectedField(formFields[newIndex].id);
  }, [formFields, selectedFieldId, selectedFieldIndex, setSelectedField]);

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
    { key: '?', ctrl: true, description: 'Show keyboard shortcuts', action: () => setActiveModal('shortcuts') },
    { key: 'Escape', description: 'Deselect field', action: () => setSelectedField(null) },
    { key: 'd', ctrl: true, description: 'Duplicate selected field', action: handleDuplicateSelected },
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
  ], [handleSave, handlePreview, handleDuplicateSelected, handleDeleteSelected, handleNavigateFields, handleMoveField, handleAddField, setSelectedField]);

  useKeyboardShortcuts({ shortcuts });

  // Close mobile menu on outside click
  useEffect(() => {
    if (!showMobileMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMobileMenu]);

  useEffect(() => {
    if (!form && formId) {
      navigate('/forms');
    }
  }, [form, formId, navigate]);

  // These must stay above the early return below so hook order is stable when
  // `form` transitions null -> loaded (or back, e.g. on delete). (Rules of Hooks)
  const handleUpdateField = useCallback((updates: Partial<FormField>) => {
    if (!form || !selectedFieldId) return;
    updateField(form.id, selectedFieldId, updates);
  }, [form, selectedFieldId, updateField]);

  const handleDeleteFieldById = useCallback((fieldId: string) => {
    if (!form) return;
    deleteField(form.id, fieldId);
  }, [form, deleteField]);

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-500">Form not found</p>
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

  const handleAIGenerate = (title: string, description: string, fields: FormField[], prompt?: string) => {
    // Update form title and description
    updateForm(form.id, {
      title: title || form.title,
      description: description || form.description,
      logicPrompt: prompt,
    });

    // Add generated fields
    let firstFieldId: string | null = null;
    fields.forEach((field) => {
      const created = addField(form.id, {
        type: field.type,
        label: field.label,
        description: field.description,
        placeholder: field.placeholder,
        required: field.required,
        properties: field.properties || {},
      });
      if (!firstFieldId) {
        firstFieldId = created.id;
      }
    });

    // Select the first generated field
    if (firstFieldId) {
      setSelectedField(firstFieldId);
    }
  };

  const closeModal = () => setActiveModal(null);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="h-14 bg-white/95 dark:bg-slate-900/80 backdrop-blur-xl border-b border-gray-200/80 dark:border-slate-800 flex items-center justify-between px-2 sm:px-4 flex-shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate('/forms')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <IconPicker
            value={form.icon}
            onChange={(icon) => updateForm(form.id, { icon: icon ?? undefined })}
          />
          <Input
            value={localTitle}
            onChange={(e) => setLocalTitle(e.target.value)}
            onBlur={flushTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            aria-label="Form title"
            className="border-none bg-transparent font-semibold text-base sm:text-lg focus:ring-0 p-0 w-32 sm:w-48 md:w-auto"
          />
          {/* Save indicator */}
          <span className="hidden sm:flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500 flex-shrink-0">
            {isSaving ? (
              <><Loader2 className="h-3 w-3 animate-spin" />Saving</>
            ) : (
              <><Cloud className="h-3 w-3" /><Check className="h-3 w-3" /></>
            )}
          </span>
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5">
          {/* AI Generator - always visible */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveModal('ai')}
            title="Generate with AI"
            aria-label="Generate with AI"
            className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 border-purple-500/30 hover:border-purple-400"
          >
            <Sparkles className="h-4 w-4 text-purple-400" />
            <span className="hidden lg:inline ml-2 text-purple-600 dark:text-purple-300">AI</span>
          </Button>

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
            <span className="hidden lg:inline ml-2">Settings</span>
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
            <span className="hidden lg:inline ml-2">Theme</span>
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
            <span className="hidden lg:inline ml-2">Script</span>
            {form.logicScript && <span className="ml-1 h-2 w-2 rounded-full bg-green-500" />}
          </Button>

          {/* Preview */}
          <Button variant="outline" size="sm" onClick={() => navigate(`/preview/${form.id}`)} title="Preview" aria-label="Preview form">
            <Eye className="h-4 w-4" />
            <span className="hidden lg:inline ml-2">Preview</span>
          </Button>

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
            <span className="hidden lg:inline ml-2">Share</span>
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
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
            {showMobileMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl shadow-gray-900/10 dark:shadow-black/30 border border-gray-200/80 dark:border-slate-700/60 py-1 z-50">
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
              </div>
            )}
          </div>

          {/* Publish */}
          <Button
            size="sm"
            onClick={() => updateForm(form.id, { status: 'published' })}
          >
            <span className="hidden sm:inline">Publish</span>
            <span className="sm:hidden">Save</span>
          </Button>
        </div>
      </header>

      {/* Mobile Tabs */}
      {isMobile && (
        <div className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 px-3 py-2 flex-shrink-0">
          <div className="flex bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
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
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Field Palette - Desktop or Mobile when selected */}
        {(!isMobile || mobilePanel === 'palette') && (
          <aside className="w-full md:w-64 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 overflow-y-auto flex-shrink-0">
            <div className="p-4 border-b border-gray-200 dark:border-slate-800">
              <h2 className="font-semibold text-gray-900 dark:text-white">Add Fields</h2>
            </div>
            <FieldPalette onAddField={handleAddField} />
          </aside>
        )}

        {/* Canvas - Desktop or Mobile when selected */}
        {(!isMobile || mobilePanel === 'canvas') && (
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            <div className="max-w-2xl mx-auto">
              {form.fields.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl">
                  <Plus className="h-12 w-12 text-gray-300 dark:text-slate-600 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                    Add your first field
                  </h3>
                  <p className="text-gray-500 mb-4">
                    {isMobile ? 'Tap the Fields tab above to get started' : 'Click a field type from the left panel to get started'}
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-gray-400">or</span>
                    <Button
                      onClick={() => setActiveModal('ai')}
                      className="bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600"
                    >
                      <Sparkles className="h-4 w-4 mr-2" />
                      Generate with AI
                    </Button>
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
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}

              {form.fields.length > 0 && (
                <button
                  onClick={() => setMobilePanel('palette')}
                  className="mt-4 w-full py-3 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl text-gray-500 dark:text-slate-400 hover:border-primary-300 hover:text-primary-600 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  Add Field
                </button>
              )}
            </div>
          </div>
        )}

        {/* Settings Panel - Desktop or Mobile when selected */}
        {(!isMobile || mobilePanel === 'settings') && (
          <aside className="w-full md:w-80 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-800 overflow-y-auto flex-shrink-0">
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
      />

      {/* Embed Modal */}
      <EmbedModal
        isOpen={activeModal === 'embed'}
        onClose={closeModal}
        formId={form.id}
        formTitle={form.title}
      />

      {/* AI Form Generator Modal */}
      <AIFormGenerator
        isOpen={activeModal === 'ai'}
        onClose={closeModal}
        onGenerate={handleAIGenerate}
      />

      {/* Theme Editor Modal */}
      <ThemeEditor
        isOpen={activeModal === 'theme'}
        onClose={closeModal}
        theme={form.theme}
        onSave={(theme) => updateForm(form.id, { theme })}
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
    </div>
  );
}
