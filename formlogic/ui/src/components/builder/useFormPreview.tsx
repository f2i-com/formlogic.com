import { useCallback, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { flushFormSaves, useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { PreviewContextChooser } from './PreviewContextChooser';
import { appFormPreviewUrl, openPreviewPlaceholder, openPreviewTab, standalonePreviewUrl } from './previewRouting';
import type { FormAppContext } from '../../types/app';

export interface UseFormPreviewResult {
  /** Call with a formId (e.g. from an onClick) — fetches contexts fresh and opens/asks. */
  openPreview: (formId: string) => void;
  /** Render this once in the page tree — the chooser modal for the 2+-published-apps case. */
  previewChooser: ReactNode;
}

/**
 * THE shared "preview a form in context" mechanism (FormBuilder toolbar/Ctrl+P, FormsList
 * cards, Dashboard rows all route through here — don't fork per-surface copies).
 *
 * A form can be attached to any number of apps (companion apps share forms by form_id), so a
 * static formId→app map goes stale and can't disambiguate. Instead, clicking Preview opens a
 * blank placeholder tab SYNCHRONOUSLY (popup blockers kill window.open after an await),
 * flushes any pending debounced builder save (so the preview shows the just-edited copy, not
 * the pre-edit server copy), fetches the form's app contexts FRESH via
 * GET /api/forms/{formId}/app-contexts, then routes the placeholder:
 *   • 0 contexts, or only draft/archived ones → /preview/{formId}?form=1 (standalone fillable
 *     form; ?form=1 shows the form even when it has a custom screen)
 *   • exactly 1 PUBLISHED context           → /app/{slug}/form/{formId} (the real app runtime)
 *   • 2+ PUBLISHED contexts                 → the placeholder is closed and the
 *                                             PreviewContextChooser modal opens (its option
 *                                             click opens the tab synchronously itself)
 * Any fetch failure — and local/offline storage mode, where forms can't belong to server
 * apps — falls back to the standalone preview; if even the placeholder was popup-blocked,
 * openPreviewTab navigates the CURRENT tab so Preview always does something.
 */
export function useFormPreview(): UseFormPreviewResult {
  const [chooser, setChooser] = useState<{ formId: string; contexts: FormAppContext[] } | null>(null);

  const openPreview = useCallback((formId: string) => {
    // Platform-admin acting mode: the app-runtime preview shows record data (not
    // visible to admins), so ALWAYS open the standalone structural preview — and
    // under the acting route, so the new tab re-enters acting mode for this form.
    if (api.isAdminActing()) {
      const tab = openPreviewPlaceholder();
      void (async () => {
        await flushFormSaves(formId);
        openPreviewTab(`/admin${standalonePreviewUrl(formId)}`, tab);
      })();
      return;
    }
    // Local/offline forms live only in this browser — they can't belong to server apps
    // (and have no debounced server save to flush). Sync path, still inside the gesture.
    if (useFormStore.getState().storageMode !== 'api') {
      openPreviewTab(standalonePreviewUrl(formId));
      return;
    }
    // Claim the tab NOW, before any await — see openPreviewPlaceholder.
    const tab = openPreviewPlaceholder();
    void (async () => {
      // Push any pending debounced edit to the server BEFORE the preview tab loads it.
      // FL-SAVE-001: the preview tab renders the SERVER copy, so a failed flush means it
      // will show the last saved revision, not the just-typed one — say so instead of
      // letting a silent failure masquerade as an up-to-date preview.
      const { ok } = await flushFormSaves(formId);
      if (!ok) {
        toast.warning(
          'Previewing the last saved version',
          'Your newest edits could not be saved to the server — retry from the save indicator to preview them.'
        );
      }
      let contexts: FormAppContext[];
      try {
        const res = await api.getFormAppContexts(formId);
        if (res.error || !res.data) {
          openPreviewTab(standalonePreviewUrl(formId), tab);
          return;
        }
        contexts = res.data.contexts || [];
      } catch {
        openPreviewTab(standalonePreviewUrl(formId), tab);
        return;
      }
      const published = contexts.filter((c) => c.isPublished);
      if (published.length === 0) {
        openPreviewTab(standalonePreviewUrl(formId), tab);
      } else if (published.length === 1) {
        openPreviewTab(appFormPreviewUrl(published[0].slug, formId), tab);
      } else {
        // The chooser decides the destination — the placeholder can't be parked on a
        // meaningful URL, so close it; the modal's own click reopens synchronously.
        tab?.close();
        setChooser({ formId, contexts: published });
      }
    })();
  }, []);

  const previewChooser = (
    <PreviewContextChooser
      isOpen={chooser !== null}
      onClose={() => setChooser(null)}
      formId={chooser?.formId ?? ''}
      contexts={chooser?.contexts ?? []}
    />
  );

  return { openPreview, previewChooser };
}
