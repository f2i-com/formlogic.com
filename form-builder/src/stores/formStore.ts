import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { Form, FormField, FormSettings, FormTheme } from '../types/form';

interface FormState {
  forms: Form[];
  activeFormId: string | null;
  selectedFieldId: string | null;

  // Form actions
  createForm: (title: string, description?: string) => Form;
  updateForm: (id: string, updates: Partial<Form>) => void;
  deleteForm: (id: string) => void;
  duplicateForm: (id: string) => Form | null;
  getForm: (id: string) => Form | undefined;
  setActiveForm: (id: string | null) => void;

  // Field actions
  addField: (formId: string, field: Omit<FormField, 'id' | 'order'>) => FormField;
  updateField: (formId: string, fieldId: string, updates: Partial<FormField>) => void;
  deleteField: (formId: string, fieldId: string) => void;
  reorderFields: (formId: string, fieldIds: string[]) => void;
  setSelectedField: (fieldId: string | null) => void;

  // Settings & Theme
  updateFormSettings: (formId: string, settings: Partial<FormSettings>) => void;
  updateFormTheme: (formId: string, theme: Partial<FormTheme>) => void;
}

const defaultSettings: FormSettings = {
  presentationMode: 'both',
  defaultPresentationMode: 'typeform',
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

export const useFormStore = create<FormState>()(
  persist(
    (set, get) => ({
      forms: [],
      activeFormId: null,
      selectedFieldId: null,

      createForm: (title, description) => {
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

        set((state) => ({ forms: [...state.forms, form] }));
        return form;
      },

      updateForm: (id, updates) => {
        set((state) => ({
          forms: state.forms.map((form) =>
            form.id === id
              ? { ...form, ...updates, updatedAt: new Date().toISOString() }
              : form
          ),
        }));
      },

      deleteForm: (id) => {
        set((state) => ({
          forms: state.forms.filter((form) => form.id !== id),
          activeFormId: state.activeFormId === id ? null : state.activeFormId,
        }));
      },

      duplicateForm: (id) => {
        const form = get().forms.find((f) => f.id === id);
        if (!form) return null;

        const newForm: Form = {
          ...form,
          id: uuidv4(),
          title: `${form.title} (Copy)`,
          fields: form.fields.map((field) => ({ ...field, id: uuidv4() })),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'draft',
          responseCount: 0,
        };

        set((state) => ({ forms: [...state.forms, newForm] }));
        return newForm;
      },

      getForm: (id) => get().forms.find((f) => f.id === id),

      setActiveForm: (id) => set({ activeFormId: id, selectedFieldId: null }),

      addField: (formId, fieldData) => {
        const form = get().forms.find((f) => f.id === formId);
        if (!form) throw new Error('Form not found');

        const field: FormField = {
          ...fieldData,
          id: uuidv4(),
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

            return {
              ...form,
              fields: reorderedFields,
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
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
      },
    }),
    {
      name: 'formlogic-forms',
    }
  )
);
