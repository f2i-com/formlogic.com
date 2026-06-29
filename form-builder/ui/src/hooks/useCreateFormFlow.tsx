import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFormStore } from '../stores/formStore';
import { toast } from '../stores/toastStore';
import { TemplateSelector } from '../components/builder';
import type { FormTemplate } from '../data/formTemplates';

/**
 * Shared "Create New Form" flow. Every entry point ("New Form" / "Create Form" / the
 * mobile Create button) calls `openNewForm()` to show the template picker, then a
 * blank or template-based form is created on selection — so nothing creates a form
 * without going through the picker first.
 *
 * Render the returned `newFormPicker` once in the component that uses the hook.
 */
export function useCreateFormFlow() {
  const navigate = useNavigate();
  const { createForm, addFields, setActiveForm } = useFormStore();
  const [open, setOpen] = useState(false);
  const creatingRef = useRef(false); // guard against a double-tap creating two drafts

  const handleSelect = async (template: FormTemplate | null) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setOpen(false);
    try {
      const form = await createForm(template ? template.name : 'Untitled Form');
      if (!form) return;
      if (template && template.fields.length > 0) {
        addFields(form.id, template.fields);
      }
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
      if (template) toast.success('Form Created', `Started with "${template.name}" template`);
    } catch {
      toast.error('Creation failed', 'Could not create a new form. Please try again.');
    } finally {
      creatingRef.current = false;
    }
  };

  const newFormPicker = (
    <TemplateSelector isOpen={open} onClose={() => setOpen(false)} onSelectTemplate={handleSelect} />
  );

  return { openNewForm: () => setOpen(true), newFormPicker };
}
