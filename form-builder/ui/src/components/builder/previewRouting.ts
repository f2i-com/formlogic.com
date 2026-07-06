/**
 * URL builders + tab-opener shared by the preview-in-context mechanism
 * (useFormPreview + PreviewContextChooser). Kept in a plain .ts module so both
 * the hook and the modal component can share them without duplicating routes.
 */

/** Standalone fillable form — ?form=1 shows the form even when it has a custom screen. */
export const standalonePreviewUrl = (formId: string) => `/preview/${formId}?form=1`;

/** The real app runtime opened AT this form. */
export const appFormPreviewUrl = (slug: string, formId: string) => `/app/${slug}/form/${formId}`;

/**
 * Open a blank placeholder tab SYNCHRONOUSLY, inside the click gesture, BEFORE any await.
 * Popup blockers (Safari always; Chrome once the transient activation expires on a slow
 * network) silently kill window.open calls made after an await — so the tab is claimed
 * now and routed later via openPreviewTab(url, tab) once the async route resolves.
 *
 * Deliberately NO 'noopener' in the features string: per the HTML spec, noopener (and
 * noreferrer, which implies it) makes window.open return null, and the handle is needed
 * to route the tab. The opener link is severed by hand instead (w.opener = null) — the
 * placeholder is our own same-origin about:blank and every URL later routed into it is
 * same-origin, so the reverse window.opener handle is what matters, not BCG isolation.
 *
 * Returns null when a popup blocker ate even the synchronous open — callers fall back to
 * same-tab navigation (via openPreviewTab with no live tab) so the click never does nothing.
 */
export function openPreviewPlaceholder(): Window | null {
  const w = window.open('', '_blank');
  if (!w) return null;
  try {
    w.opener = null;
    // A tiny holding page so the tab isn't a bare about:blank while contexts load.
    w.document.title = 'Opening preview…';
    if (w.document.body) {
      w.document.body.style.cssText = 'font-family:system-ui,sans-serif;padding:1.5rem;color:#6b7280';
      w.document.body.textContent = 'Opening preview…';
    }
  } catch {
    // Styling the placeholder is best-effort — routing still works on the bare handle.
  }
  return w;
}

/**
 * Route a preview. With a `tab` (the placeholder from openPreviewPlaceholder) the URL is
 * loaded into it via location.replace() so Back in the preview tab skips the blank
 * placeholder; a tab the user already CLOSED while waiting is treated as a cancel.
 * Without a tab this must be called synchronously inside a click gesture (the chooser
 * modal's option click, the local-mode fast path): it opens a new tab directly, severing
 * window.opener by hand, and if the popup is blocked it navigates the CURRENT tab instead.
 */
export function openPreviewTab(url: string, tab?: Window | null): void {
  if (tab) {
    if (!tab.closed) tab.location.replace(url);
    return;
  }
  const w = window.open(url, '_blank');
  if (w) {
    try {
      w.opener = null;
    } catch {
      // Already navigating cross-context — nothing to sever.
    }
    return;
  }
  // Popup blocked — never let a Preview click silently do nothing.
  window.location.assign(url);
}
