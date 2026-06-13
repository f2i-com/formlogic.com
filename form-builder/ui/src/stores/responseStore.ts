import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import type { LocalFormResponse } from '../types/form';
import { useFormStore } from './formStore';

interface ResponseState {
  responses: LocalFormResponse[];

  // Current form response
  currentFormId: string | null;
  currentAnswers: Record<string, unknown>;
  currentStep: number;
  startTime: number | null;

  // Actions
  startResponse: (formId: string) => void;
  setAnswer: (fieldId: string, value: unknown) => void;
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (step: number) => void;
  submitResponse: () => LocalFormResponse | null;
  resetCurrentResponse: () => void;

  // Response queries
  getResponsesByFormId: (formId: string) => LocalFormResponse[];
  getResponseById: (id: string) => LocalFormResponse | undefined;
  updateResponse: (id: string, answers: Record<string, unknown>) => void;
  deleteResponse: (id: string) => void;
  deleteResponsesByFormId: (formId: string) => void;
}

export const useResponseStore = create<ResponseState>()(
  persist(
    (set, get) => ({
      responses: [],
      currentFormId: null,
      currentAnswers: {},
      currentStep: 0,
      startTime: null,

      startResponse: (formId) => {
        set({
          currentFormId: formId,
          currentAnswers: {},
          currentStep: 0,
          startTime: Date.now(),
        });
      },

      setAnswer: (fieldId, value) => {
        set((state) => ({
          currentAnswers: {
            ...state.currentAnswers,
            [fieldId]: value,
          },
        }));
      },

      nextStep: () => {
        set((state) => ({ currentStep: state.currentStep + 1 }));
      },

      prevStep: () => {
        set((state) => ({ currentStep: Math.max(0, state.currentStep - 1) }));
      },

      goToStep: (step) => {
        set({ currentStep: Math.max(0, step) });
      },

      submitResponse: () => {
        const state = get();
        if (!state.currentFormId || !state.startTime) return null;

        const response: LocalFormResponse = {
          id: uuidv4(),
          formId: state.currentFormId,
          answers: state.currentAnswers,
          submittedAt: new Date().toISOString(),
          completionTime: Math.max(0, Date.now() - state.startTime),
          metadata: {
            userAgent: navigator.userAgent,
            referrer: document.referrer || undefined,
          },
        };

        set((state) => ({
          responses: [...state.responses, response].slice(-500),
          currentFormId: null,
          currentAnswers: {},
          currentStep: 0,
          startTime: null,
        }));

        return response;
      },

      resetCurrentResponse: () => {
        set({
          currentFormId: null,
          currentAnswers: {},
          currentStep: 0,
          startTime: null,
        });
      },

      getResponsesByFormId: (formId) => {
        return get().responses.filter((r) => r.formId === formId);
      },

      getResponseById: (id) => {
        return get().responses.find((r) => r.id === id);
      },

      updateResponse: (id, answers) => {
        set((state) => ({
          responses: state.responses.map((r) =>
            r.id === id ? { ...r, answers } : r
          ),
        }));
      },

      deleteResponse: (id) => {
        set((state) => ({
          responses: state.responses.filter((r) => r.id !== id),
        }));
      },

      deleteResponsesByFormId: (formId) => {
        set((state) => ({
          responses: state.responses.filter((r) => r.formId !== formId),
        }));
      },
    }),
    {
      name: 'formlogic-responses',
      partialize: (state) => {
        // Read storageMode safely — default to 'local' if formStore isn't hydrated yet
        let storageMode = 'local';
        try { storageMode = useFormStore.getState().storageMode ?? 'local'; } catch { /* noop */ }
        return {
          // In API mode, responses are server-backed — don't waste localStorage
          // In local mode, keep the most recent 500
          responses: storageMode === 'api' ? [] : state.responses.slice(-500),
          // Don't persist in-progress answers (File objects can't survive JSON serialization)
          currentFormId: null,
          currentAnswers: {},
          currentStep: 0,
          startTime: null,
        };
      },
    }
  )
);
