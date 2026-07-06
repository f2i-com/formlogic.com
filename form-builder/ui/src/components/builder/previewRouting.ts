/**
 * URL builders + tab-opener shared by the preview-in-context mechanism
 * (useFormPreview + PreviewContextChooser). Kept in a plain .ts module so both
 * the hook and the modal component can share them without duplicating routes.
 */

/** Standalone fillable form — ?form=1 shows the form even when it has a custom screen. */
export const standalonePreviewUrl = (formId: string) => `/preview/${formId}?form=1`;

/** The real app runtime opened AT this form. */
export const appFormPreviewUrl = (slug: string, formId: string) => `/app/${slug}/form/${formId}`;

/** Every preview opens in a NEW TAB, always noopener. */
export function openPreviewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
