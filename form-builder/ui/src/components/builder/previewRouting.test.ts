import { afterEach, describe, expect, it, vi } from 'vitest';
import { appFormPreviewUrl, openPreviewTab, standalonePreviewUrl } from './previewRouting';

// Pins the preview-in-context ROUTING DECISION shared by useFormPreview and
// PreviewContextChooser (pure URL builders — no DOM needed):
//
//  1. standalone preview → /preview/{id}?form=1 — the ?form=1 flag is load-bearing: it forces
//     the fillable FORM even when the form has a custom section screen, so "Preview form"
//     never silently opens the screen instead.
//  2. in-app preview → the REAL app runtime at /app/{slug}/form/{formId} (not a special
//     preview shell), so what the builder shows is exactly what members get.
//  3. every preview opens in a NEW tab with noopener,noreferrer — the opened page must never
//     get a window.opener handle back into the builder.

describe('standalonePreviewUrl', () => {
  it('builds /preview/{id} with the form=1 override', () => {
    expect(standalonePreviewUrl('form_abc')).toBe('/preview/form_abc?form=1');
  });

  it('keeps the form=1 flag — removing it would show a custom screen instead of the form', () => {
    const url = standalonePreviewUrl('f1');
    expect(url).toContain('?form=1');
  });
});

describe('appFormPreviewUrl', () => {
  it('targets the real app runtime route for the slug + form', () => {
    expect(appFormPreviewUrl('minecab', 'form_abc')).toBe('/app/minecab/form/form_abc');
  });

  it('is the runtime route, not a preview shell', () => {
    expect(appFormPreviewUrl('s', 'f').startsWith('/app/')).toBe(true);
    expect(appFormPreviewUrl('s', 'f')).not.toContain('preview');
  });
});

describe('openPreviewTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always opens a NEW tab with noopener,noreferrer', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });

    openPreviewTab('/preview/f1?form=1');

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/preview/f1?form=1', '_blank', 'noopener,noreferrer');
  });
});
