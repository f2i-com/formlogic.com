import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { SCREEN_CSP, createSdkRateLimiter, isScreenSdkActionAllowed } from './sdkRuntime';
import { screenPaletteCss, SCREEN_THEME_SHIM } from './screenTheme';
import { readableForegroundColor } from '../../lib/color';
import { resolveScreenAssets } from '../../lib/screenCompile';
import type { CustomScreen } from '../../types/form';
import type { AppRuntimeForm } from '../../types/app';

/**
 * Renders an APP's custom HOME screen in a sandboxed iframe. Same security model as
 * CustomScreenRuntime (opaque-origin iframe; the only capability is window.FormLogic, a postMessage
 * bridge), but the SDK is APP-scoped: it spans the app's forms, so submit/records take a formId, and
 * every call is authorized through the app runtime API (which checks app membership + that the form
 * belongs to this app).
 */

const APP_SDK_SHIM = `
(function(){
  var pending = {}, seq = 0;
  var port = typeof window.__flClaimPort === 'function' ? window.__flClaimPort() : null;
  function call(action, payload){
    return new Promise(function(resolve, reject){
      if (!port) { reject(new Error('Screen bridge unavailable.')); return; }
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      port.postMessage({ __fl: true, gen: window.__flGen, id: id, action: action, payload: payload || {} });
    });
  }
  if (port) {
    port.onmessage = function(e){
      var m = e.data;
      if (m && m.__flTheme) {
        document.documentElement.classList.toggle('fl-dark', m.__flTheme === 'dark');
        return;
      }
      if (!m || !m.__flReply || !pending[m.id]) return;
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    };
    port.start();
  }
  window.FormLogic = {
    /** { appName, forms: [{ formId, displayName, fields }] } */
    context: function(){ return call('context'); },
    /** The app's forms: [{ formId, displayName, fields }]. */
    forms: function(){ return call('forms'); },
    /** Save a response to a form in this app (runs its onSubmit). */
    submit: function(formId, answers){ return call('submit', { formId: formId, answers: answers }); },
    /** List a form's records (newest first). opts: { limit }. */
    records: function(formId, opts){ return call('records', { formId: formId, opts: opts }); },
    /** The signed-in user, or null. */
    currentUser: function(){ return call('currentUser'); },
    /** Navigate within the app: a formId opens that form; otherwise a path. */
    navigate: function(target){ return call('navigate', { target: target }); },
    toast: {
      success: function(msg){ return call('toast', { type: 'success', msg: String(msg) }); },
      error: function(msg){ return call('toast', { type: 'error', msg: String(msg) }); },
    },
    /** Escape a value for safe interpolation into innerHTML (prevents stored-XSS from record data). */
    escapeHtml: function(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); },
  };
})();
`;

/** The sandboxed host document (see CustomScreenRuntime for why not srcDoc). */
const SCREEN_HOST_URL = '/screen-host.html';

export function AppCustomScreenRuntime({
  screen,
  appSlug,
  appName,
  forms,
  accent,
  onNavigate,
  className,
}: {
  screen: CustomScreen;
  appSlug: string;
  appName: string;
  forms: AppRuntimeForm[];
  accent?: string;
  onNavigate?: (target: string) => void;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rateRef = useRef(createSdkRateLimiter());
  // Document generation (audit FL-15, parity with CustomScreenRuntime): bumped
  // whenever the srcDoc rebuilds and stamped into the shim (window.__flGen). The
  // dying predecessor document can still drain queued tasks after React commits
  // the new one — its RPCs must be refused, or a stale action could execute
  // against the NEW screen's forms/trust/user/navigation.
  const user = useAuthStore((s) => s.user);
  // Drive the screen's light/dark from the viewer's app-mode toggle.
  const colorScheme = useUIStore((s) => s.theme);
  const schemeRef = useRef(colorScheme);
  useEffect(() => { schemeRef.current = colorScheme; }, [colorScheme]);
  const accentColor = accent || '#6366f1';

  // Resolve to { html, css, js }: precompiled `js`, or compile `ts` / bundle multi-file `files` on the fly.
  const [assets, setAssets] = useState<{ html: string; css: string; js: string }>({ html: screen.html || '', css: screen.css || '', js: screen.js || '' });
  useEffect(() => {
    let cancelled = false;
    resolveScreenAssets({ html: screen.html, css: screen.css, js: screen.js, ts: screen.ts, files: screen.files, entry: screen.entry })
      .then((a) => { if (!cancelled) setAssets({ html: a.html, css: a.css, js: a.js }); });
    return () => { cancelled = true; };
  }, [screen.html, screen.css, screen.js, screen.ts, screen.files, screen.entry]);

  // Content changes start a new document generation. Snapshot its initial theme
  // without rebuilding the live document when only the viewer's theme changes.
  const documentKey = JSON.stringify([assets.html, assets.css, assets.js, accentColor]);
  const [documentState, setDocumentState] = useState({ key: documentKey, generation: 0, scheme: colorScheme });
  if (documentState.key !== documentKey) {
    setDocumentState({ key: documentKey, generation: documentState.generation + 1, scheme: colorScheme });
  }
  const { generation, scheme: initialScheme } = documentState;

  const srcDoc = useMemo(() => {
    const css = assets.css || '';
    const html = assets.html || '';
    const js = (assets.js || '').replace(/<\/script(?=[\s/>])/gi, '<\\/script');
    // The document keeps its initial palette; later theme changes use postMessage.
    const dark = initialScheme === 'dark';
    const palette = screenPaletteCss(accentColor, readableForegroundColor(accentColor));
    // Each rebuilt document gets a fresh generation stamp (audit FL-15).
    return `<!doctype html><html class="${dark ? 'fl-dark' : ''}"><head><meta charset="utf-8">`
      + `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<meta name="color-scheme" content="light dark">`
      + `<script>var __flGen=${generation};${APP_SDK_SHIM}${SCREEN_THEME_SHIM}</script>`
      + `<style>html,body{margin:0;font-family:system-ui,sans-serif}${palette}${css}</style></head>`
      + `<body>${html}<script>${js}</script></body></html>`;
    // Depend on the CONTENT strings, not the `assets` object identity (same reasoning
    // as CustomScreenRuntime): the async asset-resolve replaces `assets` with an
    // equal-valued object on mount, and recomputing here would bump the generation
    // and remount the iframe for nothing.
  }, [assets.html, assets.css, assets.js, accentColor, generation, initialScheme]);

  // A rebuilt document is a brand-new client: give it a fresh SDK rate budget so
  // the old document's spend can't throttle (or subsidize) the new one (FL-15).
  useEffect(() => {
    rateRef.current = createSdkRateLimiter();
  }, [srcDoc]);

  // Hand the composed document to the sandbox host exactly once per generation.
  // A second load on the same iframe indicates an unexpected in-frame navigation escape:
  // lock out the SDK bridge immediately and never re-send __flScreenDoc.
  const docSentRef = useRef(false);
  const loadCountRef = useRef(0);
  const escapedRef = useRef(false);
  const portRef = useRef<MessagePort | null>(null);
  const rpcHandlerRef = useRef<((e: MessageEvent, requestPort: MessagePort) => Promise<void>) | null>(null);
  const closeActivePort = useCallback(() => {
    if (portRef.current) {
      portRef.current.onmessage = null;
      try { portRef.current.close(); } catch { /* ignore */ }
      portRef.current = null;
    }
  }, []);
  const frameGenRef = useRef(generation);
  const ensureCurrentFrameRefs = useCallback(() => {
    if (frameGenRef.current !== generation) {
      frameGenRef.current = generation;
      docSentRef.current = false;
      loadCountRef.current = 0;
      escapedRef.current = false;
      closeActivePort();
    }
  }, [generation, closeActivePort]);
  useLayoutEffect(() => {
    ensureCurrentFrameRefs();
  }, [ensureCurrentFrameRefs]);

  const sendDocOnce = useCallback(() => {
    ensureCurrentFrameRefs();
    if (docSentRef.current || escapedRef.current) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    docSentRef.current = true;
    closeActivePort();
    const channel = new MessageChannel();
    const hostPort = channel.port1;
    portRef.current = hostPort;
    hostPort.onmessage = (e: MessageEvent) => {
      if (e.data && (e.data as { __flScreenClosed?: boolean }).__flScreenClosed) {
        escapedRef.current = true;
        closeActivePort();
        return;
      }
      void rpcHandlerRef.current?.(e, hostPort);
    };
    hostPort.start();
    win.postMessage({ __flScreenDoc: srcDoc }, '*', [channel.port2]);
    if (schemeRef.current !== initialScheme) {
      hostPort.postMessage({ __flTheme: schemeRef.current });
    }
  }, [ensureCurrentFrameRefs, closeActivePort, srcDoc, initialScheme]);

  const handleIframeLoad = useCallback(() => {
    ensureCurrentFrameRefs();
    loadCountRef.current += 1;
    if (loadCountRef.current === 1) {
      sendDocOnce();
    } else {
      // screen-host.html hydrates in place without document.open()/close(), so any second load
      // unconditionally indicates an unexpected navigation away from the initialized sandbox document.
      escapedRef.current = true;
      closeActivePort();
    }
  }, [ensureCurrentFrameRefs, sendDocOnce, closeActivePort]);

  useEffect(() => {
    const onReady = (e: MessageEvent) => {
      if (!e.data || !(e.data as { __flScreenHostReady?: boolean }).__flScreenHostReady) return;
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (e.origin !== 'null') return;
      if (loadCountRef.current === 1) {
        sendDocOnce();
      }
    };
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, [sendDocOnce]);

  // Push theme changes into the already-loaded iframe over its private MessagePort (instant, no reload).
  useEffect(() => {
    if (escapedRef.current || !portRef.current) return;
    portRef.current.postMessage({ __flTheme: colorScheme });
  }, [colorScheme]);

  useEffect(() => () => closeActivePort(), [srcDoc, closeActivePort]);

  useEffect(() => {
    const formIds = new Set(forms.map((f) => f.formId));
    const ctxForms = forms.map((f) => ({ formId: f.formId, displayName: f.displayName, fields: f.fields }));

    const handler = async (e: MessageEvent, requestPort: MessagePort) => {
      const m = e.data;
      if (!m || !m.__fl || escapedRef.current || portRef.current !== requestPort) return;
      // Only the CURRENT document generation may act (audit FL-15).
      if (m.gen !== generation) {
        requestPort.postMessage({ __flReply: true, id: m.id, error: 'This screen was reloaded — request ignored.' });
        return;
      }
      let result: unknown;
      let error: string | undefined;
      if (!rateRef.current(String(m.action))) {
        requestPort.postMessage({ __flReply: true, id: m.id, error: 'Too many requests — slow down.' });
        return;
      }
      const requireForm = (id: unknown): string => {
        const fid = String(id || '');
        if (!formIds.has(fid)) throw new Error(`Unknown form: ${fid}`);
        return fid;
      };
      try {
        if (!isScreenSdkActionAllowed(screen._trust, String(m.action))) {
          throw new Error('This SDK action is disabled for an unverified custom screen.');
        }
        switch (m.action) {
          case 'context':
            result = { appName, appSlug, forms: ctxForms, colorScheme: schemeRef.current, accent: accentColor };
            break;
          case 'forms':
            result = ctxForms;
            break;
          case 'submit': {
            const fid = requireForm(m.payload?.formId);
            const answers = (m.payload?.answers as Record<string, unknown>) || {};
            if (JSON.stringify(answers).length > 262144) throw new Error('Submission is too large');
            const res = await api.createAppResponse(appSlug, fid, { answers });
            if (res.error || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Submit failed');
            result = res.data.response;
            break;
          }
          case 'records': {
            const fid = requireForm(m.payload?.formId);
            const limit = Math.min(500, Math.max(1, Number(m.payload?.opts?.limit) || 100));
            const res = await api.getAppResponses(appSlug, fid, { limit });
            const rows = (res.data?.responses || []) as Array<Record<string, unknown>>;
            result = rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt }));
            break;
          }
          case 'currentUser':
            result = user ? { id: user.id, name: user.name, email: user.email } : null;
            break;
          case 'navigate': {
            const target = String(m.payload?.target || '');
            if (onNavigate) onNavigate(target); else toast.success(`Navigate: ${target}`);
            result = true;
            break;
          }
          case 'toast': {
            const msg = String(m.payload?.msg || '').slice(0, 200);
            if (m.payload?.type === 'error') toast.error(msg); else toast.success(msg);
            result = true;
            break;
          }
          default:
            error = `Unknown action: ${m.action}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Request failed';
      }
      // An awaited API request belongs to its original document; never deliver to a replacement or escaped navigation.
      if (escapedRef.current || portRef.current !== requestPort) return;
      requestPort.postMessage({ __flReply: true, id: m.id, result, error });
    };
    rpcHandlerRef.current = handler;
    return () => {
      if (rpcHandlerRef.current === handler) rpcHandlerRef.current = null;
    };
  }, [appSlug, appName, forms, user, onNavigate, accentColor, screen._trust, generation]);

  return (
    <iframe
      // A changed document remounts the iframe (audit FL-15): keying on the
      // generation gives the new document a FRESH WindowProxy, so pending RPCs
      // from the predecessor can never be confused with the current screen's.
      key={generation}
      ref={iframeRef}
      title="App home"
      sandbox="allow-scripts"
      src={SCREEN_HOST_URL}
      onLoad={handleIframeLoad}
      className={className || 'w-full h-full border-0'}
    />
  );
}
