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
}

/**
 * The ONE way to write a form's field array from outside the form builder.
 *
 * Two rules that were previously the caller's problem, and that every caller got
 * wrong in at least one place:
 *
 *  1. A PUBLISHED PRIVATE form needs a freshly signed `encryptionSchema` with every
 *     field change, or the server refuses with `manifest_required`.
 *  2. `useFormStore` must be re-seeded afterwards. The builder resolves a form from
 *     the store and short-circuits on any cached copy that has fields, then saves the
 *     WHOLE array back. So a field added out-of-store (quick-add in the studio, a
 *     relation modal) was silently deleted by the next builder edit in the same
 *     session — the only server-side data loss in the app section.
 *
 * `loadFullForm({ force: true })` writes state without scheduling a sync, so the
 * re-seed cannot echo back to the server.
 */
export async function saveFormFields(
  formId: string,
  nextFields: FormField[],
  opts: { isPrivate?: boolean } = {}
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
    ...(encryptionSchema ? { encryptionSchema } : {}),
  });
  if (result.error) {
    return { ok: false, error: typeof result.error === 'string' ? result.error : 'The change could not be saved.' };
  }

  // Re-seed the builder's copy so it cannot save a pre-edit array over this one.
  await useFormStore.getState().loadFullForm(formId, { force: true });
  return { ok: true };
}
