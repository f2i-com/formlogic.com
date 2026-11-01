import { api } from './api';
import { useFormStore } from '../stores/formStore';
import type { FormField } from '../types/form';

export interface SaveFormFieldsResult {
  ok: boolean;
  /** Server/transport message when `ok` is false. */
  error?: string;
  /** True when the write was refused because a private form's schema could not be
   *  signed (the vault is locked, or the user holds no key) — callers surface the
   *  unlock dialog rather than the raw sentence. */
  needsVault?: boolean;
  /** True when the fields moved on after this copy was read (another tab, a device, an AI
   *  client). Nothing was written; a screen holding its own copy should load it again. */
  changedElsewhere?: boolean;
}

/**
 * The ONE way to write a form's field array from outside the form builder.
 *
 * Three rules that were previously the caller's problem, and that every caller got
 * wrong in at least one place:
 *
 *  1. A PUBLISHED PRIVATE form needs a freshly signed `encryptionSchema` with every
 *     field change, or the server refuses with `manifest_required`.
 *  2. `useFormStore` must be re-seeded afterwards. The builder resolves a form from
 *     the store and short-circuits on any cached copy that has fields, then saves the
 *     WHOLE array back. So a field added out-of-store (quick-add in the studio, a
 *     relation modal) was silently deleted by the next builder edit in the same
 *     session — the only server-side data loss in the app section. And since the
 *     builder names the fields it started from, a copy left behind turns that person's
 *     next edit into a false "changed somewhere else".
 *  3. The write replaces the whole list, so it says which state of the fields it was
 *     made from (`fieldsRevision`, as read with them): a list read before a field was
 *     added elsewhere would otherwise take that field out.
 *
 * `loadFullForm({ force: true })` writes state without scheduling a sync, so the
 * re-seed cannot echo back to the server.
 */
export async function saveFormFields(
  formId: string,
  nextFields: FormField[],
  opts: { isPrivate?: boolean; fieldsRevision?: string } = {}
): Promise<SaveFormFieldsResult> {
  let encryptionSchema: unknown;
  if (opts.isPrivate) {
    try {
      const { signPrivateFormSchema } = await import('./crypto/formCrypto');
      const signed = await signPrivateFormSchema(formId, JSON.stringify(nextFields));
      if (!signed) return { ok: false, needsVault: true, error: 'The private form schema could not be signed.' };
      encryptionSchema = signed.encryptionSchema;
    } catch (e) {
      return { ok: false, needsVault: true, error: e instanceof Error ? e.message : 'Could not sign the private form schema.' };
    }
  }

  const result = await api.updateForm(formId, {
    fields: nextFields,
    ...(opts.fieldsRevision ? { expectedFieldsRevision: opts.fieldsRevision } : {}),
    ...(encryptionSchema ? { encryptionSchema } : {}),
  });
  if (result.error) {
    if (result.code === 'form_changed') {
      await useFormStore.getState().loadFullForm(formId, { force: true });
      return { ok: false, changedElsewhere: true, error: 'This form was changed somewhere else, so this change was not saved. Check its latest fields and make the change again.' };
    }
    return { ok: false, error: typeof result.error === 'string' ? result.error : 'The change could not be saved.' };
  }

  // Re-seed the builder's copy so it cannot save a pre-edit array over this one.
  await useFormStore.getState().loadFullForm(formId, { force: true });
  return { ok: true };
}

/**
 * Bring the builder's copy up to date after a write that did not come through it or through
 * saveFormFields: the site chat's update_form runs on the server. A copy with an edit of its own
 * still on the way is left as it is, because replacing it would drop that edit without a word.
 * That one save does get refused, and it should: both changed the form at the same moment.
 */
export async function refreshFormFields(formId: string): Promise<void> {
  const { forms, savingFormIds, saveErrors, loadFullForm } = useFormStore.getState();
  const held = forms.find((form) => form.id === formId);
  if (!held?.fieldsRevision || savingFormIds[formId] || saveErrors[formId]) return;
  await loadFullForm(formId, { force: true });
}
