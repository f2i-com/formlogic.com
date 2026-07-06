import { useCallback, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useFormStore } from '../../stores/formStore';
import { PreviewContextChooser } from './PreviewContextChooser';
import { appFormPreviewUrl, openPreviewTab, standalonePreviewUrl } from './previewRouting';
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
 * static formId→app map goes stale and can't disambiguate. Instead, clicking Preview fetches
 * the form's app contexts FRESH via GET /api/forms/{formId}/app-contexts and routes in a NEW
 * TAB (noopener):
 *   • 0 contexts, or only draft/archived ones → /preview/{formId}?form=1 (standalone fillable
 *     form; ?form=1 shows the form even when it has a custom screen)
 *   • exactly 1 PUBLISHED context           → /app/{slug}/form/{formId} (the real app runtime)
 *   • 2+ PUBLISHED contexts                 → the PreviewContextChooser modal (app names +
 *                                             a "Standalone form" option)
 * Any fetch failure — and local/offline storage mode, where forms can't belong to server
 * apps — falls back to the standalone preview so Preview always works.
 */
export function useFormPreview(): UseFormPreviewResult {
  const [chooser, setChooser] = useState<{ formId: string; contexts: FormAppContext[] } | null>(null);

  const openPreview = useCallback((formId: string) => {
    // Local/offline forms live only in this browser — they can't belong to server apps.
    if (useFormStore.getState().storageMode !== 'api') {
      openPreviewTab(standalonePreviewUrl(formId));
      return;
    }
    void (async () => {
      let contexts: FormAppContext[];
      try {
        const res = await api.getFormAppContexts(formId);
        if (res.error || !res.data) {
          openPreviewTab(standalonePreviewUrl(formId));
          return;
        }
        contexts = res.data.contexts || [];
      } catch {
        openPreviewTab(standalonePreviewUrl(formId));
        return;
      }
      const published = contexts.filter((c) => c.isPublished);
      if (published.length === 0) {
        openPreviewTab(standalonePreviewUrl(formId));
      } else if (published.length === 1) {
        openPreviewTab(appFormPreviewUrl(published[0].slug, formId));
      } else {
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
