import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { SCREEN_CSP, createSdkRateLimiter, isScreenSdkActionAllowed } from './sdkRuntime';
import { screenPaletteCss, SCREEN_THEME_SHIM } from './screenTheme';
import { readableForegroundColor } from '../../lib/color';
import { resolveScreenAssets } from '../../lib/screenCompile';

/**
 * Renders a custom screen ({ html, css, js }) inside a SANDBOXED iframe and bridges the FormLogic
 * SDK to the real backend.
 *
 * SECURITY MODEL: the iframe uses sandbox="allow-scripts" WITHOUT allow-same-origin, so its scripts
 * run in an opaque origin — they cannot read this app's cookies/DOM/localStorage, and cannot call
 * the API directly (cross-origin, no credentials). The ONLY way out is window.FormLogic, which
 * postMessages the trusted parent here; the parent authorizes the request (this user, THIS form) and
 * makes the real API call. So a custom screen can only do what the SDK exposes — nothing more.
 */

// Injected into the iframe — exposes window.FormLogic as a postMessage RPC bridge to the parent.
const SDK_SHIM = `
(function(){
  var pending = {}, seq = 0;
  function call(action, payload){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __fl: true, id: id, action: action, payload: payload || {} }, '*');
    });
  }
  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m || !m.__flReply || !pending[m.id]) return;
    var p = pending[m.id]; delete pending[m.id];
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  window.FormLogic = {
    /** Save a response to this form (runs the form's onSubmit script + validation). */
    submit: function(answers){ return call('submit', { answers: answers }); },
    /** List this form's records (newest first). opts: { limit }. */
    records: function(opts){ return call('records', { opts: opts }); },
    /** The signed-in user, or null. */
    currentUser: function(){ return call('currentUser'); },
    /** This screen's context: { formId, title, fields } — choice fields include options [{label, value}]. */
    context: function(){ return call('context'); },
    toast: {
      success: function(msg){ return call('toast', { type: 'success', msg: String(msg) }); },
      error: function(msg){ return call('toast', { type: 'error', msg: String(msg) }); },
    },
    /** Open the real form for a new record (only when the owner enabled "allow new records"). */
    openForm: function(){ return call('openForm'); },
    /** Open this form's records view (app runtime only — rejects on public links). */
    openRecords: function(){ return call('openRecords'); },
    /** Record screens only: the record this screen is rendered for ({ id, answers, submittedAt, status }). */
    record: function(){ return call('record'); },
    /** Record screens only: this record's related-record groups (same shape as the related API). */
    related: function(){ return call('related'); },
    /** Escape a value for safe interpolation into innerHTML (prevents stored-XSS from record data). */
    escapeHtml: function(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); },
  };
})();
`;

export interface CustomScreen { html?: string; css?: string; js?: string; ts?: string; files?: Array<{ path: string; content: string }>; entry?: string; allowNewResponses?: boolean; _trust?: 'owner' | 'verified' | 'untrusted' }

export function CustomScreenRuntime({
  screen,
  formId,
  formTitle,
  fields,
  className,
  publicMode = false,
  appSlug,
  accentColor,
  onOpenForm,
  onOpenRecords,
  record,
  fetchRelated,
}: {
  screen: CustomScreen;
  formId: string;
  formTitle?: string;
  fields?: Array<{ id: string; label: string; type: string; options?: Array<{ label: string; value: string }> }>;
  className?: string;
  /** Public link/embed context (anonymous): records() uses the gated public endpoint, not the owner API. */
  publicMode?: boolean;
  /** App-runtime context: route submit/records through the app API (membership + permission checks). */
  appSlug?: string;
  /** Accent for the injected --fl-* palette: the app accent in-app, else the form theme's primary. */
  accentColor?: string;
  /** Wired when "allow new records" is on — the SDK's openForm() reveals the real form. */
  onOpenForm?: () => void;
  /** Wired in the app runtime — the SDK's openRecords() opens this form's records table. */
  onOpenRecords?: () => void;
  /** Record screens: the record this screen renders for — exposed via FormLogic.record(). */
  record?: { id: string; answers: Record<string, unknown>; submittedAt?: string; status?: string };
  /** Record screens: fetch this record's related groups — exposed via FormLogic.related(). */
  fetchRelated?: () => Promise<unknown>;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rateRef = useRef(createSdkRateLimiter());
  const user = useAuthStore((s) => s.user);
  // Drive the screen's light/dark from the viewer's theme (same contract as the app-home runtime).
  const colorScheme = useUIStore((s) => s.theme);
  const schemeRef = useRef(colorScheme);
  schemeRef.current = colorScheme;

  // Resolve the screen to { html, css, js }: a single precompiled `js` (fast, public pages), or compile
  // `ts` / bundle a multi-file `files` project on the fly (lazy esbuild — never weighs on `js` screens).
  const [assets, setAssets] = useState<{ html: string; css: string; js: string }>({ html: screen.html || '', css: screen.css || '', js: screen.js || '' });
  useEffect(() => {
    let cancelled = false;
    resolveScreenAssets({ html: screen.html, css: screen.css, js: screen.js, ts: screen.ts, files: screen.files, entry: screen.entry })
      .then((a) => { if (!cancelled) setAssets({ html: a.html, css: a.css, js: a.js }); });
    return () => { cancelled = true; };
  }, [screen.html, screen.css, screen.js, screen.ts, screen.files, screen.entry]);

  const srcDoc = useMemo(() => {
    const css = assets.css || '';
    const html = assets.html || '';
    // Neutralize an early </script> in user code so it can't break out of its <script> block.
    const js = (assets.js || '').replace(/<\/script>/gi, '<\\/script>');
    // Initial mode from a ref so theme toggles update via postMessage without rebuilding the iframe.
    const dark = schemeRef.current === 'dark';
    const accent = accentColor || '#6366f1';
    const palette = screenPaletteCss(accent, readableForegroundColor(accent));
    // SDK shim goes in <head> so window.FormLogic exists before any user script (inline or block) runs.
    return `<!doctype html><html class="${dark ? 'fl-dark' : ''}"><head><meta charset="utf-8">`
      + `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<meta name="color-scheme" content="light dark">`
      + `<script>${SDK_SHIM}${SCREEN_THEME_SHIM}</script>`
      + `<style>html,body{margin:0;font-family:system-ui,sans-serif}${palette}${css}</style></head>`
      + `<body>${html}<script>${js}</script></body></html>`;
  }, [assets, accentColor]);

  // Push theme changes into the already-loaded iframe (instant, no reload).
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ __flTheme: colorScheme }, '*');
  }, [colorScheme]);

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const m = e.data;
      // Only accept SDK messages from OUR sandboxed iframe.
      if (!m || !m.__fl || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      let result: unknown;
      let error: string | undefined;
      if (!rateRef.current(String(m.action))) {
        iframeRef.current.contentWindow?.postMessage({ __flReply: true, id: m.id, error: 'Too many requests — slow down.' }, '*');
        return;
      }
      try {
        if (!isScreenSdkActionAllowed(screen._trust, String(m.action))) {
          throw new Error('This SDK action is disabled for an unverified custom screen.');
        }
        switch (m.action) {
          case 'submit': {
            const answers = (m.payload?.answers as Record<string, unknown>) || {};
            if (JSON.stringify(answers).length > 262144) throw new Error('Submission is too large');
            const res = appSlug
              ? await api.createAppResponse(appSlug, formId, { answers })
              : await api.submitResponse(formId, { answers });
            if (res.error || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Submit failed');
            result = (res.data as { response: unknown }).response;
            break;
          }
          case 'records': {
            const limit = Math.min(500, Math.max(1, Number(m.payload?.opts?.limit) || 100));
            if (appSlug) {
              const res = await api.getAppResponses(appSlug, formId, { limit });
              const rows = (res.data?.responses || []) as Array<Record<string, unknown>>;
              result = rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt, status: r.status, tags: r.tags }));
            } else if (publicMode) {
              const res = await api.getScreenRecords(formId, { limit });
              result = (res.data?.records || []).map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt }));
            } else {
              const res = await api.getResponses(formId, { limit });
              const rows = (res.data?.responses || []) as unknown as Array<Record<string, unknown>>;
              result = rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt, status: r.status, tags: r.tags }));
            }
            break;
          }
          case 'currentUser':
            result = user ? { id: user.id, name: user.name, email: user.email } : null;
            break;
          case 'context':
            result = { formId, title: formTitle || '', fields: fields || [] };
            break;
          case 'toast': {
            const msg = String(m.payload?.msg || '').slice(0, 200);
            if (m.payload?.type === 'error') toast.error(msg); else toast.success(msg);
            result = true;
            break;
          }
          case 'openForm': {
            if (onOpenForm) { onOpenForm(); result = true; }
            else throw new Error('New records are not enabled for this screen.');
            break;
          }
          case 'openRecords': {
            if (onOpenRecords) { onOpenRecords(); result = true; }
            else throw new Error('Records are not available here.');
            break;
          }
          case 'record': {
            if (!record) throw new Error('record() is only available on record screens.');
            result = { id: record.id, answers: record.answers, submittedAt: record.submittedAt, status: record.status };
            break;
          }
          case 'related': {
            if (!fetchRelated) throw new Error('related() is only available on record screens.');
            result = await fetchRelated();
            break;
          }
          default:
            error = `Unknown action: ${m.action}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Request failed';
      }
      iframeRef.current?.contentWindow?.postMessage({ __flReply: true, id: m.id, result, error }, '*');
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [formId, formTitle, fields, user, publicMode, appSlug, onOpenForm, onOpenRecords, record, fetchRelated, screen._trust]);

  return (
    <iframe
      ref={iframeRef}
      title="Custom screen"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className || 'w-full h-full border-0'}
    />
  );
}
