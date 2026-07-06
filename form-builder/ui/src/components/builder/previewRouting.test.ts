import { afterEach, describe, expect, it, vi } from 'vitest';
import { appFormPreviewUrl, openPreviewPlaceholder, openPreviewTab, standalonePreviewUrl } from './previewRouting';

// Pins the preview-in-context ROUTING DECISION shared by useFormPreview and
// PreviewContextChooser (pure URL builders + the tab-opener protocol — no DOM needed):
//
//  1. standalone preview → /preview/{id}?form=1 — the ?form=1 flag is load-bearing: it forces
//     the fillable FORM even when the form has a custom section screen, so "Preview form"
//     never silently opens the screen instead.
//  2. in-app preview → the REAL app runtime at /app/{slug}/form/{formId} (not a special
//     preview shell), so what the builder shows is exactly what members get.
//  3. the placeholder tab is claimed with window.open('', '_blank') — NO 'noopener' feature
//     (per spec that returns null and the handle is needed) — then w.opener is severed by
//     hand, so the opened page still never gets a window.opener handle back into the builder.
//  4. routing into a placeholder uses location.replace() (Back must not land on about:blank);
//     a placeholder the user closed while waiting is a CANCEL, not a re-open.
//  5. with no placeholder (sync gesture paths) a new tab is opened directly, opener severed;
//     if the popup is blocked the CURRENT tab navigates so a Preview click never does nothing.

/** Minimal Window stand-in for the node test env (no jsdom). */
function fakeTab({ closed = false }: { closed?: boolean } = {}) {
  return {
    closed,
    opener: {} as unknown,
    close: vi.fn(),
    location: { replace: vi.fn() },
    document: { title: '', body: { textContent: '', style: { cssText: '' } } },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('openPreviewPlaceholder', () => {
  it('opens a blank tab synchronously WITHOUT a features string and severs window.opener by hand', () => {
    const tab = fakeTab();
    const open = vi.fn().mockReturnValue(tab);
    vi.stubGlobal('window', { open });

    const result = openPreviewPlaceholder();

    // No 'noopener' in features — per spec that makes window.open return null and the
    // handle is needed to route the tab later. The opener link is severed manually.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(result).toBe(tab);
    expect(tab.opener).toBeNull();
    expect(tab.document.title).toBe('Opening preview…');
    expect(tab.document.body.textContent).toBe('Opening preview…');
  });

  it('returns null when the popup blocker eats even the synchronous open', () => {
    const open = vi.fn().mockReturnValue(null);
    vi.stubGlobal('window', { open });

    expect(openPreviewPlaceholder()).toBeNull();
  });
});

describe('openPreviewTab', () => {
  it('routes a live placeholder via location.replace so Back skips the blank page', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const tab = fakeTab();

    openPreviewTab('/preview/f1?form=1', tab as unknown as Window);

    expect(tab.location.replace).toHaveBeenCalledWith('/preview/f1?form=1');
    expect(open).not.toHaveBeenCalled();
  });

  it('treats a placeholder the user already closed as a cancel — no re-open, no navigation', () => {
    const open = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal('window', { open, location: { assign } });
    const tab = fakeTab({ closed: true });

    openPreviewTab('/preview/f1?form=1', tab as unknown as Window);

    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('without a placeholder opens a NEW tab and severs window.opener on it', () => {
    const tab = fakeTab();
    const open = vi.fn().mockReturnValue(tab);
    vi.stubGlobal('window', { open });

    openPreviewTab('/preview/f1?form=1');

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/preview/f1?form=1', '_blank');
    expect(tab.opener).toBeNull();
  });

  it('falls back to navigating the CURRENT tab when the popup is blocked', () => {
    const open = vi.fn().mockReturnValue(null);
    const assign = vi.fn();
    vi.stubGlobal('window', { open, location: { assign } });

    openPreviewTab('/preview/f1?form=1');

    expect(assign).toHaveBeenCalledWith('/preview/f1?form=1');
  });
});
