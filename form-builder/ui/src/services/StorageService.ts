/**
 * Storage Service - Abstraction layer for form data persistence
 *
 * This service provides a unified interface for storing and retrieving form data,
 * allowing seamless switching between localStorage and API backends.
 */

import { api } from '../lib/api';
import type { Form } from '../types/form';

export type StorageMode = 'local' | 'api';

interface StorageProvider {
  // Forms
  getForms(): Promise<Form[]>;
  getForm(id: string): Promise<Form | null>;
  createForm(form: Omit<Form, 'id' | 'createdAt' | 'updatedAt'>): Promise<Form>;
  updateForm(id: string, updates: Partial<Form>): Promise<Form | null>;
  deleteForm(id: string): Promise<boolean>;
  duplicateForm(id: string): Promise<Form | null>;
}

// Local Storage Provider
class LocalStorageProvider implements StorageProvider {
  private readonly STORAGE_KEY = 'formlogic-forms';

  private loadForms(): Form[] {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  private saveForms(forms: Form[]): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(forms));
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }

  async getForms(): Promise<Form[]> {
    return this.loadForms();
  }

  async getForm(id: string): Promise<Form | null> {
    const forms = this.loadForms();
    return forms.find(f => f.id === id) || null;
  }

  async createForm(formData: Omit<Form, 'id' | 'createdAt' | 'updatedAt'>): Promise<Form> {
    const forms = this.loadForms();
    const now = new Date().toISOString();

    const newForm: Form = {
      ...formData,
      id: this.generateUuid(),
      createdAt: now,
      updatedAt: now,
    } as Form;

    forms.push(newForm);
    this.saveForms(forms);

    return newForm;
  }

  async updateForm(id: string, updates: Partial<Form>): Promise<Form | null> {
    const forms = this.loadForms();
    const index = forms.findIndex(f => f.id === id);

    if (index === -1) return null;

    forms[index] = {
      ...forms[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.saveForms(forms);
    return forms[index];
  }

  async deleteForm(id: string): Promise<boolean> {
    const forms = this.loadForms();
    const filtered = forms.filter(f => f.id !== id);

    if (filtered.length === forms.length) return false;

    this.saveForms(filtered);
    return true;
  }

  async duplicateForm(id: string): Promise<Form | null> {
    const form = await this.getForm(id);
    if (!form) return null;

    const now = new Date().toISOString();
    const newForm: Form = {
      ...form,
      id: this.generateUuid(),
      title: `${form.title} (Copy)`,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      fields: form.fields.map(field => ({
        ...field,
        id: this.generateUuid(),
      })),
    };

    const forms = this.loadForms();
    forms.push(newForm);
    this.saveForms(forms);

    return newForm;
  }
}

// API Storage Provider
class ApiStorageProvider implements StorageProvider {
  async getForms(): Promise<Form[]> {
    const result = await api.getForms();
    if (result.error || !result.data) {
      console.error('Failed to fetch forms:', result.error);
      return [];
    }
    return result.data.forms as Form[];
  }

  async getForm(id: string): Promise<Form | null> {
    const result = await api.getForm(id);
    if (result.error || !result.data) {
      return null;
    }
    return result.data.form as Form;
  }

  async createForm(formData: Omit<Form, 'id' | 'createdAt' | 'updatedAt'>): Promise<Form> {
    const result = await api.createForm(formData);
    if (result.error || !result.data) {
      throw new Error(result.error || 'Failed to create form');
    }
    return result.data.form as Form;
  }

  async updateForm(id: string, updates: Partial<Form>): Promise<Form | null> {
    const result = await api.updateForm(id, updates);
    if (result.error || !result.data) {
      console.error('Failed to update form:', result.error);
      return null;
    }
    return result.data.form as Form;
  }

  async deleteForm(id: string): Promise<boolean> {
    const result = await api.deleteForm(id);
    return !result.error && !!result.data?.success;
  }

  async duplicateForm(id: string): Promise<Form | null> {
    const result = await api.duplicateForm(id);
    if (result.error || !result.data) {
      return null;
    }
    return result.data.form as Form;
  }
}

// Storage Service singleton
class StorageService {
  private provider: StorageProvider;
  private mode: StorageMode;

  constructor() {
    // Check for API availability preference
    const preferApi = localStorage.getItem('formlogic_use_api') === 'true';
    this.mode = preferApi ? 'api' : 'local';
    this.provider = preferApi ? new ApiStorageProvider() : new LocalStorageProvider();
  }

  getMode(): StorageMode {
    return this.mode;
  }

  setMode(mode: StorageMode): void {
    this.mode = mode;
    this.provider = mode === 'api' ? new ApiStorageProvider() : new LocalStorageProvider();
    localStorage.setItem('formlogic_use_api', mode === 'api' ? 'true' : 'false');
  }

  async isApiAvailable(): Promise<boolean> {
    try {
      const result = await api.healthCheck();
      return !result.error && result.data?.status === 'ok';
    } catch {
      return false;
    }
  }

  // Delegate to current provider
  getForms = () => this.provider.getForms();
  getForm = (id: string) => this.provider.getForm(id);
  createForm = (form: Omit<Form, 'id' | 'createdAt' | 'updatedAt'>) => this.provider.createForm(form);
  updateForm = (id: string, updates: Partial<Form>) => this.provider.updateForm(id, updates);
  deleteForm = (id: string) => this.provider.deleteForm(id);
  duplicateForm = (id: string) => this.provider.duplicateForm(id);

  // Migration helper: Sync local forms to API
  async migrateToApi(): Promise<{ success: boolean; migrated: number; errors: string[] }> {
    const localProvider = new LocalStorageProvider();
    const apiProvider = new ApiStorageProvider();

    const localForms = await localProvider.getForms();
    const errors: string[] = [];
    let migrated = 0;

    for (const form of localForms) {
      try {
        // Check if form already exists in API
        const existing = await apiProvider.getForm(form.id);
        if (!existing) {
          await api.createForm(form);
          migrated++;
        }
      } catch (error) {
        errors.push(`Failed to migrate form "${form.title}": ${error}`);
      }
    }

    return { success: errors.length === 0, migrated, errors };
  }
}

// Export singleton instance
export const storage = new StorageService();
export { LocalStorageProvider, ApiStorageProvider };
