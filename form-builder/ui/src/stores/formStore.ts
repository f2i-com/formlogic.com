import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Form, FormField, FormSettings, FormTheme } from '../types/form';
import { api } from '../lib/api';
import { logger } from '../lib/logger';
import { toast } from './toastStore';

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

  // Check if ID already exists, if so append a number
  let finalId = baseId;
  let counter = 1;
  while (existingIds.includes(finalId)) {
    finalId = `${baseId}_${counter}`;
    counter++;
  }

  return finalId;
}

// Storage mode: 'local' for localStorage, 'api' for backend
type StorageMode = 'local' | 'api';

interface FormState {
  forms: Form[];
  activeFormId: string | null;
  selectedFieldId: string | null;
  isLoading: boolean;
  error: string | null;
  storageMode: StorageMode;
  isInitialized: boolean;
  savingFormIds: Set<string>;

  // Initialization
  initialize: () => Promise<void>;
  setStorageMode: (mode: StorageMode) => void;

  // Form actions
  createForm: (title: string, description?: string) => Promise<Form>;
  updateForm: (id: string, updates: Partial<Form>) => Promise<void>;
  deleteForm: (id: string) => Promise<void>;
  duplicateForm: (id: string) => Promise<Form | null>;
  getForm: (id: string) => Form | undefined;
  loadFullForm: (id: string) => Promise<Form | undefined>;
  setActiveForm: (id: string | null) => void;
  refreshForms: () => Promise<void>;

  // Field actions
  addField: (formId: string, field: Omit<FormField, 'id' | 'order'>) => FormField;
  updateField: (formId: string, fieldId: string, updates: Partial<FormField>) => void;
  deleteField: (formId: string, fieldId: string) => void;
  duplicateField: (formId: string, fieldId: string) => FormField | null;
  reorderFields: (formId: string, fieldIds: string[]) => void;
  setSelectedField: (fieldId: string | null) => void;

  // Settings & Theme
  updateFormSettings: (formId: string, settings: Partial<FormSettings>) => void;
  updateFormTheme: (formId: string, theme: Partial<FormTheme>) => void;

  // Sync
  syncToApi: () => Promise<{ success: boolean; synced: number; errors: string[] }>;
  saveFormToApi: (formId: string) => Promise<boolean>;
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
  primaryColor: '#6366f1',
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
  debounceTimers[formId] = setTimeout(saveFn, delay);
}

function clearDebounceTimer(formId: string) {
  if (debounceTimers[formId]) {
    clearTimeout(debounceTimers[formId]);
    delete debounceTimers[formId];
  }
}

function clearAllDebounceTimers() {
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
        const next = new Set(s.savingFormIds);
        if (saving) next.add(formId); else next.delete(formId);
        return { savingFormIds: next };
      });
    };

    const syncFormField = (formId: string, field: 'fields' | 'settings' | 'theme') => {
      if (get().storageMode === 'api') {
        markSaving(formId, true);
        debouncedSave(`${formId}-${field}`, async () => {
          try {
            const form = get().forms.find((f) => f.id === formId);
            if (form) {
              await api.updateForm(formId, { [field]: form[field] });
            }
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

    return ({
      forms: [],
      activeFormId: null,
      selectedFieldId: null,
      isLoading: false,
      error: null,
      storageMode: 'local' as StorageMode,
      isInitialized: false,
      savingFormIds: new Set<string>(),

      initialize: async () => {
        const state = get();
        if (state.isInitialized) return;

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
        localStorage.setItem('formlogic_storage_mode', mode);
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
        const form: Form = {
          id: uuidv4(),
          title,
          description,
          fields: [],
          settings: { ...defaultSettings },
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
              return form; // Return form so caller knows creation was attempted
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
            return form; // Return form so caller knows creation was attempted
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

        // If using API, sync only the changed fields to server (debounced)
        // Uses a separate debounce key to avoid conflicts with field/settings/theme syncs
        if (state.storageMode === 'api') {
          markSaving(id, true);
          debouncedSave(`${id}-meta`, async () => {
            try {
              await api.updateForm(id, updates);
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

        // Clear any pending debounce timers for this form
        clearDebounceTimer(`${id}-fields`);
        clearDebounceTimer(`${id}-settings`);
        clearDebounceTimer(`${id}-theme`);
        clearDebounceTimer(`${id}-meta`);

        // Optimistic update
        set((s) => ({
          forms: s.forms.filter((form) => form.id !== id),
          activeFormId: s.activeFormId === id ? null : s.activeFormId,
        }));

        // If using API, also delete on server
        if (state.storageMode === 'api') {
          try {
            await api.deleteForm(id);
          } catch (error) {
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

      loadFullForm: async (id) => {
        const state = get();
        // In local mode, the form is already fully loaded
        if (state.storageMode !== 'api') return state.forms.find((f) => f.id === id);

        // Check if the form already has fields loaded (use _fieldsLoaded flag
        // since a form with 0 fields is valid and shouldn't trigger a refetch)
        const existing = state.forms.find((f) => f.id === id);
        if (existing && (existing as Form & { _fieldsLoaded?: boolean })._fieldsLoaded) return existing;
        if (existing && existing.fields.length > 0) return existing;

        // Fetch full form (with fields) from API
        try {
          const result = await api.getForm(id);
          if (!result.error && result.data?.form) {
            const fullForm = { ...(result.data.form as Form), _fieldsLoaded: true } as Form;
            set((s) => ({
              forms: s.forms.map((f) => (f.id === id ? { ...f, ...fullForm } : f)),
            }));
            return fullForm;
          }
        } catch (error) {
          logger.error('Failed to load full form:', error);
        }
        return existing;
      },

      setActiveForm: (id) => set({ activeFormId: id, selectedFieldId: null }),

      addField: (formId, fieldData) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) throw new Error('Form not found');

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

      updateField: (formId, fieldId, updates) => {
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
        set((state) => ({
          forms: state.forms.map((form) =>
            form.id === formId
              ? {
                  ...form,
                  fields: form.fields
                    .filter((field) => field.id !== fieldId)
                    .map((field, index) => ({ ...field, order: index })),
                  updatedAt: new Date().toISOString(),
                }
              : form
          ),
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

      setSelectedField: (fieldId) => set({ selectedFieldId: fieldId }),

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
        let synced = 0;

        for (const form of state.forms) {
          try {
            // Check if form exists on server
            const existingResult = await api.getForm(form.id);

            if (existingResult.error || !existingResult.data) {
              // Create new form on server
              const createResult = await api.createForm(form);
              if (createResult.error) {
                errors.push(`Failed to sync "${form.title}": ${createResult.error}`);
              } else {
                synced++;
              }
            } else {
              // Update existing form
              const updateResult = await api.updateForm(form.id, form);
              if (updateResult.error) {
                errors.push(`Failed to update "${form.title}": ${updateResult.error}`);
              } else {
                synced++;
              }
            }
          } catch (error) {
            errors.push(`Error syncing "${form.title}": ${error}`);
          }
        }

        return { success: errors.length === 0, synced, errors };
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
