import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFormStore } from '../stores/formStore';
import { useVaultStore } from '../stores/vaultStore';
import { toast } from '../stores/toastStore';
import { TemplateSelector } from '../components/builder';
import type { FormTemplate } from '../data/formTemplates';

/**
 * Shared "Create New Form" flow. Every entry point ("New Form" / "Create Form" / the
 * mobile Create button) calls `openNewForm()` to show the template picker, then a
 * blank or template-based form is created on selection — so nothing creates a form
 * without going through the picker first.
 *
 * When the user opts into a Private (end-to-end encrypted) form, the freshly created
 * empty form has encryption enabled immediately (plan SS9.1 - private is chosen at
 * creation, before any publication). The opt-in is only offered when the user has an
 * UNLOCKED vault; otherwise the picker points them at Settings > Security first.
 *
 * Render the returned `newFormPicker` once in the component that uses the hook.
 */
export function useCreateFormFlow() {
  const navigate = useNavigate();
  const { createForm, addFields, setActiveForm } = useFormStore();
  const vaultStatus = useVaultStore((s) => s.status);
  const [open, setOpen] = useState(false);
  const creatingRef = useRef(false); // guard against a double-tap creating two drafts

  const handleSelect = async (template: FormTemplate | null, makePrivate = false) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setOpen(false);
    try {
      const form = await createForm(template ? template.name : 'Untitled Form');
      if (!form) return;
      if (template && template.fields.length > 0) {
        addFields(form.id, template.fields);
      }

      // E2EE: enable encryption on the fresh, empty, unpublished form. The schema
      // snapshot signed at enable is the CURRENT field set (empty, or the template's).
      if (makePrivate) {
        try {
          const { enableFormEncryption, markFormPrivate } = await import('../lib/crypto/formCrypto');
          const currentFields = useFormStore.getState().getForm(form.id)?.fields ?? [];
          await enableFormEncryption(form.id, JSON.stringify(currentFields));
          markFormPrivate(form.id);
          toast.success('Private form created', 'Responses will be end-to-end encrypted.');
        } catch (e) {
          // Fail closed (review 2026-07-22, blocker 2): an explicit PRIVATE choice
          // must never silently become a plaintext form the user believes is
          // encrypted — remove the created form and surface the error. The user
          // can create it again (or enable encryption later from form settings).
          const err = e as { code?: string; reasons?: string[]; message?: string };
          try {
            await useFormStore.getState().deleteForm(form.id);
          } catch {
            // Best effort — if the delete failed, say so explicitly.
            toast.error('Encryption failed — DELETE THIS FORM', 'This form could not be made private and could not be removed automatically. Delete it: it is NOT encrypted.');
            return;
          }
          const reasons = err.reasons?.length ? ` (${err.reasons.join('; ')})` : '';
          const retryHint = err.code === 'encryption_enabling' ? ' Encryption setup was still in progress — try again in a moment.' : '';
          toast.error('Could not make it private', `The form was removed rather than left unencrypted.${retryHint} ${err.message ?? ''}${reasons}`.trim());
          return;
        }
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
    <TemplateSelector
      isOpen={open}
      onClose={() => setOpen(false)}
      onSelectTemplate={handleSelect}
      canMakePrivate={vaultStatus === 'unlocked'}
    />
  );

  return { openNewForm: () => setOpen(true), newFormPicker };
}
