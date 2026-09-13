import type { FormField } from '../types/form';

/** Definitions come from the server's JSON template folders, not the application bundle. */
export interface FormTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel?: string;
  categoryIcon?: string;
  icon: string;
  fields: Omit<FormField, 'id' | 'order'>[];
  estimatedTime?: string;
}
export interface FormTemplateCategory { id: string; label: string; icon: string }
export interface FormTemplateCatalog { templates: FormTemplate[]; categories: FormTemplateCategory[]; skipped: number }
