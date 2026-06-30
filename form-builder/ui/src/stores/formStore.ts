import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Form, FormField, FormSettings, FormTheme } from '../types/form';
import { api } from '../lib/api';
import { logger } from '../lib/logger';
import { toast } from './toastStore';

// Field-id slugs must not collide with the FormLogic expression prelude's global
// names: a field id like "count"/"sum"/"format" would shadow that builtin in the
// generated expression context (let count = <value>) and break every conditional/
// calculated expression on the form. Such collisions get a numeric suffix instead.
const RESERVED_FIELD_IDS = new Set([
  '__isArr', 'validators', 'format', 'compliance', 'finance', 'safety',
  'isEmpty', 'isNotEmpty', 'contains', 'sum', 'avg', 'count', 'value',
]);

// Generate a human-friendly field ID from a label
function generateFieldId(label: string, existingIds: string[]): string {
  // Convert label to slug: lowercase, replace spaces/special chars with underscores
  let baseId = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')  // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '')       // Remove leading/trailing underscores
    .substring(0, 32);             // Limit length

  // If empty after sanitization, use a default
  if (!baseId) {
    baseId = 'field';
  }

  // The id is used as a JS identifier in logic/calculated expressions AND as a
  // sandbox context key (both require a non-digit first char), so a label like
  // "401k" must not yield an id like "401k". Mirror labelToVariableName's guard.
  if (/^\d/.test(baseId)) {
    baseId = `_${baseId}`;
  }

  // Check if ID already exists, if so append a number
  let finalId = baseId;
  let counter = 1;
  while (existingIds.includes(finalId) || RESERVED_FIELD_IDS.has(finalId)) {
    finalId = `${baseId}_${counter}`;
    counter++;
  }

  return finalId;
}

// Storage mode: 'local' for localStorage, 'api' for backend
type StorageMode = 'local' | 'api';

// A form changed BOTH offline and in the cloud (since it was last in sync) — the user must pick
// which version to keep when reconnecting.
export interface SyncConflict {
  id: string;
  title: string;
  localUpdatedAt: string;
  serverUpdatedAt: string;
}

interface FormState {
  forms: Form[];
  activeFormId: string | null;
  selectedFieldId: string | null;
  isLoading: boolean;
  error: string | null;
  storageMode: StorageMode;
  isInitialized: boolean;
  // Per-form count of in-flight saves (field/settings/theme/meta can overlap)
  savingFormIds: Record<string, number>;
  // Per-form undo/redo stacks of prior field-array states (ephemeral)
  fieldHistory: Record<string, { past: FormField[][]; future: FormField[][] }>;

  // Initialization
  initialize: () => Promise<void>;
  setStorageMode: (mode: StorageMode) => void;

  // Form actions
  createForm: (title: string, description?: string) => Promise<Form | null>;
  updateForm: (id: string, updates: Partial<Form>) => Promise<void>;
  deleteForm: (id: string) => Promise<void>;
  duplicateForm: (id: string) => Promise<Form | null>;
  getForm: (id: string) => Form | undefined;
  loadFullForm: (id: string, opts?: { force?: boolean }) => Promise<Form | undefined>;
  setActiveForm: (id: string | null) => void;
  refreshForms: () => Promise<void>;

  // Field actions
  addField: (formId: string, field: Omit<FormField, 'id' | 'order'>) => FormField;
  // Append several fields as ONE undo step (e.g. AI generation / template apply)
  addFields: (formId: string, fields: Omit<FormField, 'id' | 'order'>[]) => FormField[];
  // Replace the entire field set as ONE undo step, preserving caller-supplied ids (AI edit mode)
  setFields: (formId: string, fields: FormField[]) => void;
  updateField: (formId: string, fieldId: string, updates: Partial<FormField>) => void;
  deleteField: (formId: string, fieldId: string) => void;
  duplicateField: (formId: string, fieldId: string) => FormField | null;
  reorderFields: (formId: string, fieldIds: string[]) => void;
  setSelectedField: (fieldId: string | null) => void;
  // In-builder undo/redo of field-array mutations (per form; not persisted)
  undoFields: (formId: string) => void;
  redoFields: (formId: string) => void;

  // Settings & Theme
  updateFormSettings: (formId: string, settings: Partial<FormSettings>) => void;
  updateFormTheme: (formId: string, theme: Partial<FormTheme>) => void;

  // Sync
  syncToApi: () => Promise<{ success: boolean; synced: number; unchanged: number; conflicts: SyncConflict[]; errors: string[] }>;
  saveFormToApi: (formId: string) => Promise<boolean>;
  // Reconnect conflict resolution (set when syncToApi finds forms changed both offline + in cloud)
  syncConflicts: SyncConflict[] | null;
  syncSwitchAfter: boolean;
  setSyncConflicts: (conflicts: SyncConflict[] | null, switchAfter?: boolean) => void;
  resolveSyncConflicts: (decisions: Record<string, 'mine' | 'cloud'>) => Promise<void>;
}

const defaultSettings: FormSettings = {
  presentationMode: 'both',
  defaultPresentationMode: 'focused',
  showProgressBar: true,
  allowBackNavigation: true,
  submitButtonText: 'Submit',
  notifications: { emailNotifications: false },
  isClosed: false,
};

const defaultTheme: FormTheme = {
  primaryColor: '#4f46e5',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// Debounce helper for auto-save
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function debouncedSave(formId: string, saveFn: () => void, delay = 1000) {
  if (debounceTimers[formId]) {
    clearTimeout(debounceTimers[formId]);
  }
  debounceTimers[formId] = setTimeout(() => {
    // Drop the handle before running so `debounceTimers[key]` reflects reality: a
    // subsequent edit then correctly registers a fresh in-flight save instead of
    // assuming one is already pending.
    delete debounceTimers[formId];
    saveFn();
  }, delay);
}

function clearDebounceTimer(formId: string) {
  if (debounceTimers[formId]) {
    clearTimeout(debounceTimers[formId]);
    delete debounceTimers[formId];
  }
}

export function clearAllDebounceTimers() {
  for (const formId of Object.keys(debounceTimers)) {
    clearTimeout(debounceTimers[formId]);
    delete debounceTimers[formId];
  }
}

export const useFormStore = create<FormState>()(
  persist(
    (set, get) => {
    // Helper to sync a form field to the API with debouncing
    const markSaving = (formId: string, saving: boolean) => {
      set((s) => {
        const current = s.savingFormIds[formId] ?? 0;
        if (saving) {
          return { savingFormIds: { ...s.savingFormIds, [formId]: current + 1 } };
        }
        const next = current - 1;
        if (next > 0) {
          return { savingFormIds: { ...s.savingFormIds, [formId]: next } };
        }
        const rest = { ...s.savingFormIds };
        delete rest[formId];
        return { savingFormIds: rest };
      });
    };

    const syncFormField = (formId: string, field: 'fields' | 'settings' | 'theme') => {
      if (get().storageMode === 'api') {
        const key = `${formId}-${field}`;
        // Only count a NEW in-flight save. Rapid edits collapse into a single
        // debounced flush (the pending timer is replaced, its callback never
        // runs), so incrementing per keystroke while the flush decrements once
        // left the per-form 'Saving…' counter stuck above zero forever.
        if (!debounceTimers[key]) {
          markSaving(formId, true);
        }
        debouncedSave(key, async () => {
          try {
            const form = get().forms.find((f) => f.id === formId);
            if (form) {
              // api.updateForm returns { error } as a VALUE on HTTP/network/quota
              // failure (it doesn't throw), so a failed save must be checked here —
              // otherwise it was silent and the indicator falsely flipped to "saved"
              // while the optimistic edit (not persisted; dropped on reload in API
              // mode) was lost.
              const result = await api.updateForm(formId, { [field]: form[field] });
              if (result.error) {
                logger.error('Failed to sync form field to server:', result.error);
                toast.error('Failed to save changes', typeof result.error === 'string' ? result.error : 'Your changes may not be saved. Please try again.');
              }
            }
          } catch (error) {
            logger.error('Failed to sync form field to server:', error);
            toast.error('Failed to save changes', 'Your changes may not be saved. Please try again.');
          } finally {
            markSaving(formId, false);
          }
        });
      }
    };

    // Remove empty/untouched forms (no fields, default title, no content)
    const purgeEmptyForms = () => {
      const { forms, storageMode } = get();
      const emptyIds = forms
        .filter(f => f.fields.length === 0 && f.title === 'Untitled Form' && !f.description && !f.logicScript)
        .map(f => f.id);
      if (emptyIds.length === 0) return;
      set(s => ({ forms: s.forms.filter(f => !emptyIds.includes(f.id)) }));
      if (storageMode === 'api') {
        for (const id of emptyIds) {
          api.deleteForm(id).catch(() => {});
        }
      }
    };

    // ---- In-builder undo/redo (per form; ephemeral — never persisted) ----
    const HISTORY_CAP = 50;
    // Consecutive edits to the SAME field coalesce into one undo entry so typing a
    // label isn't one history step per keystroke. Structural ops + selection reset it.
    let historyCoalesceKey: string | null = null;
    const cloneFields = (fields: FormField[]): FormField[] => JSON.parse(JSON.stringify(fields));
    // Snapshot the current field array before a mutation so it can be undone.
    const pushHistory = (formId: string) => {
      const form = get().forms.find((f) => f.id === formId);
      if (!form) return;
      set((state) => {
        const h = state.fieldHistory[formId] ?? { past: [], future: [] };
        const past = [...h.past, cloneFields(form.fields)];
        if (past.length > HISTORY_CAP) past.shift();
        return { fieldHistory: { ...state.fieldHistory, [formId]: { past, future: [] } } };
      });
    };

    return ({
      forms: [],
      activeFormId: null,
      selectedFieldId: null,
      fieldHistory: {},
      isLoading: false,
      error: null,
      storageMode: 'local' as StorageMode,
      isInitialized: false,
      savingFormIds: {} as Record<string, number>,

      initialize: async () => {
        const state = get();
        if (state.isInitialized || state.isLoading) return;

        set({ isLoading: true, error: null });

        try {
          // Check if API is available
          const healthResult = await api.healthCheck();
          const apiAvailable = !healthResult.error && healthResult.data?.status === 'ok';

          if (apiAvailable && state.storageMode === 'api') {
            // Load forms from API
            const result = await api.getForms();
            if (!result.error && result.data) {
              set({
                forms: result.data.forms as Form[],
                isLoading: false,
                isInitialized: true,
              });
              purgeEmptyForms();
              return;
            }
          }

          // Fallback to localStorage (already loaded by persist middleware)
          set({ isLoading: false, isInitialized: true });
        } catch (error) {
          logger.error('Failed to initialize form store:', error);
          toast.error('Loading Error', 'Failed to load forms. Using local storage.');
          set({
            error: 'Failed to load forms',
            isLoading: false,
            isInitialized: true,
          });
        }
        purgeEmptyForms();
      },

      setStorageMode: (mode: StorageMode) => {
        clearAllDebounceTimers();
        set({ storageMode: mode, isInitialized: false });
        try { localStorage.setItem('formlogic_storage_mode', mode); } catch { /* private browsing */ }
        get().initialize();
      },

      refreshForms: async () => {
        const state = get();
        if (state.storageMode !== 'api') return;

        set({ isLoading: true });
        try {
          const result = await api.getForms();
          if (!result.error && result.data) {
            set({ forms: result.data.forms as Form[], isLoading: false });
          } else {
            set({ error: result.error || 'Failed to load forms', isLoading: false });
          }
        } catch (error) {
          logger.error('Failed to refresh forms:', error);
          toast.error('Refresh Failed', 'Could not refresh forms from server.');
          set({ error: 'Failed to load forms', isLoading: false });
        }
      },

      createForm: async (title, description) => {
        // Apply the user's "Default Form Settings" preferences (Settings page) to
        // new forms so those controls actually take effect.
        const prefOverrides: Partial<Form['settings']> = {};
        try {
          const stored = localStorage.getItem('formlogic_user_preferences');
          if (stored) {
            const p = JSON.parse(stored) as Record<string, unknown>;
            if (typeof p.showProgressBar === 'boolean') prefOverrides.showProgressBar = p.showProgressBar;
            if (typeof p.allowBackNavigation === 'boolean') prefOverrides.allowBackNavigation = p.allowBackNavigation;
          }
        } catch { /* ignore malformed prefs */ }

        const form: Form = {
          id: uuidv4(),
          title,
          description,
          fields: [],
          settings: { ...defaultSettings, ...prefOverrides },
          theme: { ...defaultTheme },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'draft',
          responseCount: 0,
        };

        const state = get();

        // Optimistic update
        set((s) => ({ forms: [...s.forms, form] }));

        // If using API, also create on server
        if (state.storageMode === 'api') {
          try {
            const result = await api.createForm(form);
            if (result.error) {
              // Rollback optimistic update
              set((s) => ({ forms: s.forms.filter((f) => f.id !== form.id) }));
              logger.error('Failed to create form on server:', result.error);
              toast.error('Failed to create form', typeof result.error === 'string' ? result.error : 'Please try again');
              return null;
            } else if (result.data) {
              // Update with server response (may have different ID)
              set((s) => ({
                forms: s.forms.map((f) =>
                  f.id === form.id ? (result.data!.form as Form) : f
                ),
              }));
              return result.data.form as Form;
            }
          } catch (error) {
            // Rollback optimistic update
            set((s) => ({ forms: s.forms.filter((f) => f.id !== form.id) }));
            logger.error('Failed to create form on server:', error);
            toast.error('Failed to create form', 'Please check your connection and try again');
            return null;
          }
        }

        return form;
      },

      updateForm: async (id, updates) => {
        const state = get();

        // Optimistic update
        set((s) => ({
          forms: s.forms.map((form) =>
            form.id === id
              ? { ...form, ...updates, updatedAt: new Date().toISOString() }
              : form
          ),
        }));

        // If using API, sync current form state to server (debounced)
        // Uses a separate debounce key to avoid conflicts with field/settings/theme syncs
        // Reads fresh state inside the callback to avoid stale closures dropping earlier updates
        if (state.storageMode === 'api') {
          const key = `${id}-meta`;
          // Count only a new in-flight save (see syncFormField) so the spinner
          // clears once the debounced flush completes.
          if (!debounceTimers[key]) {
            markSaving(id, true);
          }
          debouncedSave(key, async () => {
            try {
              const currentForm = get().forms.find((f) => f.id === id);
              if (currentForm) {
                // Send ALL editable meta fields, not just title/description/status/icon.
                // The Theme/Settings/Script/AI editors all route through updateForm, so
                // omitting theme/settings/logicScript/logicPrompt here silently dropped
                // them server-side (data loss + false "saved" toast). `fields` are synced
                // separately via the `-fields` debounce, so they are intentionally excluded.
                const { title, description, status, icon, theme, settings, logicScript, logicPrompt } = currentForm;
                // Errors come back as a VALUE (request() never throws on HTTP/
                // network failure), so the old catch-only handling was dead code for
                // real failures — check result.error explicitly.
                const result = await api.updateForm(id, { title, description, status, icon, theme, settings, logicScript, logicPrompt });
                if (result.error) {
                  logger.error('Failed to update form on server:', result.error);
                  toast.error('Failed to save changes', typeof result.error === 'string' ? result.error : 'Your changes may not be saved. Please try again.');
                }
              }
            } catch (error) {
              logger.error('Failed to update form on server:', error);
              toast.error('Failed to save changes', 'Your changes may not be saved. Please try again.');
            } finally {
              markSaving(id, false);
            }
          });
        }
      },

      deleteForm: async (id) => {
        const state = get();
        const formToDelete = state.forms.find((f) => f.id === id);

        // Clear any pending debounce timers for this form
        clearDebounceTimer(`${id}-fields`);
        clearDebounceTimer(`${id}-settings`);
        clearDebounceTimer(`${id}-theme`);
        clearDebounceTimer(`${id}-meta`);

        // Optimistic update (also drop any in-session undo history for the form)
        set((s) => {
          const fieldHistory = { ...s.fieldHistory };
          delete fieldHistory[id];
          return {
            forms: s.forms.filter((form) => form.id !== id),
            activeFormId: s.activeFormId === id ? null : s.activeFormId,
            fieldHistory,
          };
        });

        // If using API, also delete on server
        if (state.storageMode === 'api') {
          try {
            const result = await api.deleteForm(id);
            if (result.error && formToDelete) {
              // Rollback: restore the form
              set((s) => ({ forms: [...s.forms, formToDelete] }));
              toast.error('Failed to delete form', typeof result.error === 'string' ? result.error : 'Please try again');
            }
          } catch (error) {
            // Rollback: restore the form
            if (formToDelete) {
              set((s) => ({ forms: [...s.forms, formToDelete] }));
            }
            logger.error('Failed to delete form on server:', error);
            toast.error('Failed to delete form', 'Please try again');
          }
        }
      },

      duplicateForm: async (id) => {
        const state = get();
        const form = state.forms.find((f) => f.id === id);
        if (!form) return null;

        // Keep the same field IDs since they're human-readable and unique per form
        const newForm: Form = {
          ...form,
          id: uuidv4(),
          title: `${form.title} (Copy)`,
          settings: { ...form.settings, notifications: { ...form.settings.notifications } },
          theme: { ...form.theme },
          fields: form.fields.map((field) => ({
            ...field,
            properties: {
              ...field.properties,
              ...(field.properties.options
                ? { options: field.properties.options.map((o) => ({ ...o })) }
                : {}),
              ...(field.properties.displayFieldIds
                ? { displayFieldIds: [...field.properties.displayFieldIds] }
                : {}),
              ...(field.properties.searchFieldIds
                ? { searchFieldIds: [...field.properties.searchFieldIds] }
                : {}),
            },
            validation: field.validation?.map((v) => ({ ...v })),
            conditionalLogic: field.conditionalLogic ? { ...field.conditionalLogic } : undefined,
          })),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'draft',
          responseCount: 0,
        };

        // Optimistic update
        set((s) => ({ forms: [...s.forms, newForm] }));

        // If using API, duplicate on server
        if (state.storageMode === 'api') {
          try {
            const result = await api.duplicateForm(id);
            if (result.error) {
              set((s) => ({ forms: s.forms.filter((f) => f.id !== newForm.id) }));
              toast.error('Failed to duplicate form', typeof result.error === 'string' ? result.error : 'Please try again');
              return null;
            }
            if (result.data) {
              set((s) => ({
                forms: s.forms.map((f) =>
                  f.id === newForm.id ? (result.data!.form as Form) : f
                ),
              }));
              return result.data.form as Form;
            }
          } catch (error) {
            set((s) => ({ forms: s.forms.filter((f) => f.id !== newForm.id) }));
            logger.error('Failed to duplicate form on server:', error);
            toast.error('Failed to duplicate form', 'Please try again');
            return null;
          }
        }

        return newForm;
      },

      getForm: (id) => get().forms.find((f) => f.id === id),

      loadFullForm: async (id, opts) => {
        const state = get();
        // In local mode, the form is already fully loaded
        if (state.storageMode !== 'api') return state.forms.find((f) => f.id === id);

        // Check if the form already has fields loaded (use _fieldsLoaded flag
        // since a form with 0 fields is valid and shouldn't trigger a refetch).
        // `force` bypasses the cache so callers (e.g. after a version restore)
        // can pull the server's current state.
        const existing = state.forms.find((f) => f.id === id);
        if (!opts?.force) {
          if (existing && (existing as Form & { _fieldsLoaded?: boolean })._fieldsLoaded) return existing;
          if (existing && existing.fields.length > 0) return existing;
        }

        // Fetch full form (with fields) from API
        try {
          const result = await api.getForm(id);
          if (!result.error && result.data?.form) {
            const fullForm = { ...(result.data.form as Form), _fieldsLoaded: true } as Form;
            // Fields are wholesale-replaced from the server (incl. version restore), so
            // any in-session undo history is now incoherent — drop it (else Ctrl+Z would
            // restore pre-load fields and sync that stale state back to the server).
            set((s) => {
              const fieldHistory = { ...s.fieldHistory };
              delete fieldHistory[id];
              return {
                forms: s.forms.map((f) => (f.id === id ? { ...f, ...fullForm } : f)),
                fieldHistory,
              };
            });
            historyCoalesceKey = null;
            return fullForm;
          }
        } catch (error) {
          logger.error('Failed to load full form:', error);
        }
        return existing;
      },

      setActiveForm: (id) => { historyCoalesceKey = null; set({ activeFormId: id, selectedFieldId: null }); },

      addField: (formId, fieldData) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) throw new Error('Form not found');

        pushHistory(formId);
        historyCoalesceKey = null;

        // Generate human-friendly ID from label
        const existingIds = form.fields.map((f) => f.id);
        const fieldId = generateFieldId(fieldData.label, existingIds);

        const field: FormField = {
          ...fieldData,
          id: fieldId,
          order: form.fields.length,
        };

        set((state) => ({
          forms: state.forms.map((f) =>
            f.id === formId
              ? {
                  ...f,
                  fields: [...f.fields, field],
                  updatedAt: new Date().toISOString(),
                }
              : f
          ),
        }));

        syncFormField(formId, 'fields');

        return field;
      },

      addFields: (formId, fieldsData) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) throw new Error('Form not found');
        if (fieldsData.length === 0) return [];

        // One history snapshot for the whole batch so it undoes as a single step.
        pushHistory(formId);
        historyCoalesceKey = null;

        const existingIds = form.fields.map((f) => f.id);
        let order = form.fields.length;
        const newFields: FormField[] = fieldsData.map((fd) => {
          const fieldId = generateFieldId(fd.label, existingIds);
          existingIds.push(fieldId); // keep subsequent ids unique within the batch
          return { ...fd, id: fieldId, order: order++ };
        });

        set((state) => ({
          forms: state.forms.map((f) =>
            f.id === formId
              ? { ...f, fields: [...f.fields, ...newFields], updatedAt: new Date().toISOString() }
              : f
          ),
        }));

        syncFormField(formId, 'fields');

        return newFields;
      },

      setFields: (formId, fields) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) throw new Error('Form not found');

        // One undo step; replaces the whole field set. Used by AI edit mode — the AI returns the
        // full modified list, preserving ids for fields it kept so responses/logic stay valid.
        pushHistory(formId);
        historyCoalesceKey = null;

        const normalized = fields.map((f, i) => ({ ...f, order: i }));
        set((state) => ({
          forms: state.forms.map((f) =>
            f.id === formId ? { ...f, fields: normalized, updatedAt: new Date().toISOString() } : f
          ),
        }));

        syncFormField(formId, 'fields');
      },

      updateField: (formId, fieldId, updates) => {
        // Coalesce consecutive edits to the same field into a single undo entry.
        const key = `${formId}:${fieldId}`;
        if (historyCoalesceKey !== key) {
          pushHistory(formId);
          historyCoalesceKey = key;
        }
        set((state) => ({
          forms: state.forms.map((form) =>
            form.id === formId
              ? {
                  ...form,
                  fields: form.fields.map((field) =>
                    field.id === fieldId ? { ...field, ...updates } : field
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : form
          ),
        }));

        syncFormField(formId, 'fields');
      },

      deleteField: (formId, fieldId) => {
        pushHistory(formId);
        historyCoalesceKey = null;
        // Match the deleted field as a whole token so deleting "email" doesn't also
        // wipe conditional/calc logic that references a sibling like "email_address"
        // (a plain substring `.includes` did exactly that).
        const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const refsDeletedField = (expr: string) => new RegExp(`\\b${escaped}\\b`).test(expr);
        set((state) => ({
          forms: state.forms.map((form) => {
            if (form.id !== formId) return form;
            return {
              ...form,
              fields: form.fields
                .filter((field) => field.id !== fieldId)
                .map((field, index) => {
                  let updated = { ...field, order: index };
                  // Clear conditional logic that references the deleted field
                  if (updated.conditionalLogic?.expression &&
                      refsDeletedField(updated.conditionalLogic.expression)) {
                    updated = { ...updated, conditionalLogic: undefined };
                  }
                  // Clear calculation expressions that reference the deleted field
                  if (updated.properties?.calculationExpression &&
                      refsDeletedField(updated.properties.calculationExpression)) {
                    updated = { ...updated, properties: { ...updated.properties, calculationExpression: undefined } };
                  }
                  return updated;
                }),
              updatedAt: new Date().toISOString(),
            };
          }),
          selectedFieldId:
            state.selectedFieldId === fieldId ? null : state.selectedFieldId,
        }));

        syncFormField(formId, 'fields');
      },

      duplicateField: (formId, fieldId) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) return null;

        const field = form.fields.find((f) => f.id === fieldId);
        if (!field) return null;

        pushHistory(formId);
        historyCoalesceKey = null;

        // Generate new ID for duplicated field
        const existingIds = form.fields.map((f) => f.id);
        const newFieldId = generateFieldId(`${field.label} copy`, existingIds);
        const fieldIndex = form.fields.findIndex((f) => f.id === fieldId);

        const newField: FormField = {
          ...field,
          id: newFieldId,
          label: `${field.label} (Copy)`,
          order: fieldIndex + 1,
          // Deep copy properties to avoid shared references with the original
          properties: {
            ...field.properties,
            ...(field.properties.options
              ? { options: field.properties.options.map((o) => ({ ...o })) }
              : {}),
            ...(field.properties.displayFieldIds
              ? { displayFieldIds: [...field.properties.displayFieldIds] }
              : {}),
            ...(field.properties.searchFieldIds
              ? { searchFieldIds: [...field.properties.searchFieldIds] }
              : {}),
          },
          // Deep copy validation rules to avoid shared mutable references
          validation: field.validation?.map((v) => ({ ...v })),
          // Deep copy conditional logic
          conditionalLogic: field.conditionalLogic ? { ...field.conditionalLogic } : undefined,
        };

        // Insert the new field right after the original
        const newFields = [...form.fields];
        newFields.splice(fieldIndex + 1, 0, newField);

        // Update order for all fields after the insertion
        const reorderedFields = newFields.map((f, index) => ({ ...f, order: index }));

        set((state) => ({
          forms: state.forms.map((f) =>
            f.id === formId
              ? {
                  ...f,
                  fields: reorderedFields,
                  updatedAt: new Date().toISOString(),
                }
              : f
          ),
          selectedFieldId: newFieldId,
        }));

        syncFormField(formId, 'fields');

        return newField;
      },

      reorderFields: (formId, fieldIds) => {
        pushHistory(formId);
        historyCoalesceKey = null;
        set((state) => ({
          forms: state.forms.map((form) => {
            if (form.id !== formId) return form;

            const fieldMap = new Map(form.fields.map((f) => [f.id, f]));
            const reorderedFields = fieldIds
              .map((id, index) => {
                const field = fieldMap.get(id);
                return field ? { ...field, order: index } : null;
              })
              .filter((f): f is FormField => f !== null);

            // Append any fields missing from fieldIds to prevent silent data loss
            const reorderedSet = new Set(fieldIds);
            for (const field of form.fields) {
              if (!reorderedSet.has(field.id)) {
                reorderedFields.push({ ...field, order: reorderedFields.length });
              }
            }

            return {
              ...form,
              fields: reorderedFields,
              updatedAt: new Date().toISOString(),
            };
          }),
        }));

        syncFormField(formId, 'fields');
      },

      setSelectedField: (fieldId) => { historyCoalesceKey = null; set({ selectedFieldId: fieldId }); },

      undoFields: (formId) => {
        const h = get().fieldHistory[formId];
        if (!h || h.past.length === 0) return;
        const form = get().forms.find((f) => f.id === formId);
        if (!form) return;
        historyCoalesceKey = null;
        const current = cloneFields(form.fields);
        const prev = h.past[h.past.length - 1];
        set((state) => ({
          forms: state.forms.map((f) =>
            f.id === formId ? { ...f, fields: cloneFields(prev), updatedAt: new Date().toISOString() } : f
          ),
          fieldHistory: { ...state.fieldHistory, [formId]: { past: h.past.slice(0, -1), future: [...h.future, current] } },
          // Keep the selection only if the restored state still contains it.
          selectedFieldId: prev.some((fl) => fl.id === state.selectedFieldId) ? state.selectedFieldId : null,
        }));
        syncFormField(formId, 'fields');
      },

      redoFields: (formId) => {
        const h = get().fieldHistory[formId];
        if (!h || h.future.length === 0) return;
        const form = get().forms.find((f) => f.id === formId);
        if (!form) return;
        historyCoalesceKey = null;
        const current = cloneFields(form.fields);
        const next = h.future[h.future.length - 1];
        set((state) => ({
          forms: state.forms.map((f) =>
            f.id === formId ? { ...f, fields: cloneFields(next), updatedAt: new Date().toISOString() } : f
          ),
          fieldHistory: { ...state.fieldHistory, [formId]: { past: [...h.past, current], future: h.future.slice(0, -1) } },
          selectedFieldId: next.some((fl) => fl.id === state.selectedFieldId) ? state.selectedFieldId : null,
        }));
        syncFormField(formId, 'fields');
      },

      updateFormSettings: (formId, settings) => {
        set((state) => ({
          forms: state.forms.map((form) =>
            form.id === formId
              ? {
                  ...form,
                  settings: { ...form.settings, ...settings },
                  updatedAt: new Date().toISOString(),
                }
              : form
          ),
        }));

        syncFormField(formId, 'settings');
      },

      updateFormTheme: (formId, theme) => {
        set((state) => ({
          forms: state.forms.map((form) =>
            form.id === formId
              ? {
                  ...form,
                  theme: { ...form.theme, ...theme },
                  updatedAt: new Date().toISOString(),
                }
              : form
          ),
        }));

        syncFormField(formId, 'theme');
      },

      // Sync all local forms to API
      syncToApi: async () => {
        const state = get();
        const errors: string[] = [];
        const conflicts: SyncConflict[] = [];
        let synced = 0;
        let unchanged = 0;

        // The server returns MySQL datetimes ("Y-m-d H:i:s", UTC); offline edits re-stamp updatedAt
        // to an ISO string (toISOString, has 'T'+'Z'). Normalize both to a UTC ISO for comparison,
        // and use the 'T' marker to tell a real offline edit apart from an untouched loaded value.
        const toUtc = (s: string) => (s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
        const wasEditedOffline = (s: string) => s.includes('T');

        for (const form of state.forms) {
          try {
            const existingResult = await api.getForm(form.id);
            const serverForm = existingResult.data?.form;

            if (existingResult.error || !serverForm) {
              // New form made offline → create it on the server.
              const createResult = await api.createForm(form);
              if (createResult.error) {
                errors.push(`Failed to sync "${form.title}": ${createResult.error}`);
              } else {
                synced++;
              }
              continue;
            }

            const localStr = form.updatedAt || '';
            const serverStr = serverForm.updatedAt || '';

            // Identical timestamp string → untouched on both sides → nothing to do.
            if (localStr === serverStr) {
              unchanged++;
              continue;
            }

            const localT = Date.parse(toUtc(localStr));
            const serverT = Date.parse(toUtc(serverStr));
            const localIsNewer = Number.isNaN(serverT) || Number.isNaN(localT) || localT > serverT;

            if (localIsNewer) {
              // Local holds the most recent edit → push it.
              const updateResult = await api.updateForm(form.id, form);
              if (updateResult.error) {
                errors.push(`Failed to update "${form.title}": ${updateResult.error}`);
              } else {
                synced++;
              }
            } else if (wasEditedOffline(localStr)) {
              // The cloud copy is newer than this form's offline edit → BOTH changed since they were
              // last in sync. Don't silently clobber either side; defer to the user.
              conflicts.push({
                id: form.id,
                title: form.title,
                localUpdatedAt: localStr,
                serverUpdatedAt: serverStr,
              });
            } else {
              // Local was never edited offline (still the old loaded value) and the cloud moved on →
              // keep the cloud version (the reload after switching pulls it). Nothing to push.
              unchanged++;
            }
          } catch (error) {
            errors.push(`Error syncing "${form.title}": ${error}`);
          }
        }

        return { success: errors.length === 0, synced, unchanged, conflicts, errors };
      },

      syncConflicts: null,
      syncSwitchAfter: false,

      setSyncConflicts: (conflicts, switchAfter = false) => {
        set({ syncConflicts: conflicts, syncSwitchAfter: switchAfter });
      },

      resolveSyncConflicts: async (decisions) => {
        const { syncConflicts: conflicts, syncSwitchAfter: switchAfter } = get();
        for (const c of conflicts ?? []) {
          const choice = decisions[c.id] ?? 'mine';
          try {
            if (choice === 'mine') {
              // Keep the offline version → push it over the cloud copy.
              const form = get().forms.find((f) => f.id === c.id);
              if (form) await api.updateForm(form.id, form);
            } else {
              // Keep the cloud version → pull it into the local store so it reflects the choice.
              const res = await api.getForm(c.id);
              if (res.data?.form) {
                set((s) => ({ forms: s.forms.map((f) => (f.id === c.id ? (res.data!.form as Form) : f)) }));
              }
            }
          } catch (e) {
            logger.error(`Failed to resolve conflict for "${c.title}":`, e);
          }
        }
        set({ syncConflicts: null, syncSwitchAfter: false });
        // For a reconnect, finish switching to cloud (reloads everything from the server).
        if (switchAfter) {
          get().setStorageMode('api');
        }
      },

      // Save a specific form to API
      saveFormToApi: async (formId: string) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) return false;

        try {
          const existingResult = await api.getForm(formId);

          if (existingResult.error || !existingResult.data) {
            const createResult = await api.createForm(form);
            return !createResult.error;
          } else {
            const updateResult = await api.updateForm(formId, form);
            return !updateResult.error;
          }
        } catch {
          return false;
        }
      },
    });
    },
    {
      name: 'formlogic-forms',
      partialize: (state) => ({
        // Only persist forms in local mode — API mode data is server-backed
        forms: state.storageMode === 'local' ? state.forms : [],
        storageMode: state.storageMode,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          // Restore storage mode from localStorage without triggering initialize()
          // (initialization is handled by AppInitializer after auth is ready)
          const savedMode = localStorage.getItem('formlogic_storage_mode');
          if (state && (savedMode === 'api' || savedMode === 'local')) {
            useFormStore.setState({ storageMode: savedMode });
          }
        };
      },
    }
  )
);
