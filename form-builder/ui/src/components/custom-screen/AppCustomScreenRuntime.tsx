import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { SCREEN_CSP, createSdkRateLimiter } from './sdkRuntime';
import { compileScreenCode } from '../../lib/screenCompile';
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
  };
})();
`;

export function AppCustomScreenRuntime({
  screen,
  appSlug,
  appName,
  forms,
  onNavigate,
  className,
}: {
  screen: CustomScreen;
  appSlug: string;
  appName: string;
  forms: AppRuntimeForm[];
  onNavigate?: (target: string) => void;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rateRef = useRef(createSdkRateLimiter());
  const user = useAuthStore((s) => s.user);

  // Precompiled `js` is the norm; compile `ts` on the fly only when there's no `js` (e.g. AI-authored over MCP).
  const [compiledJs, setCompiledJs] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    if (!screen.js && screen.ts) {
      compileScreenCode(screen.ts).then((r) => { if (!cancelled) setCompiledJs(r.js); });
    }
    return () => { cancelled = true; };
  }, [screen.js, screen.ts]);
  const effectiveJs = screen.js || compiledJs || '';

  const srcDoc = useMemo(() => {
    const css = screen.css || '';
    const html = screen.html || '';
    const js = effectiveJs.replace(/<\/script>/gi, '<\\/script>');
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<script>${APP_SDK_SHIM}</script>`
      + `<style>html,body{margin:0;font-family:system-ui,sans-serif}${css}</style></head>`
      + `<body>${html}<script>${js}</script></body></html>`;
  }, [screen.html, screen.css, effectiveJs]);

  useEffect(() => {
    const formIds = new Set(forms.map((f) => f.formId));
    const ctxForms = forms.map((f) => ({ formId: f.formId, displayName: f.displayName, fields: f.fields }));

    const handler = async (e: MessageEvent) => {
      const m = e.data;
      if (!m || !m.__fl || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      let result: unknown;
      let error: string | undefined;
      if (!rateRef.current(String(m.action))) {
        iframeRef.current.contentWindow?.postMessage({ __flReply: true, id: m.id, error: 'Too many requests — slow down.' }, '*');
        return;
      }
      const requireForm = (id: unknown): string => {
        const fid = String(id || '');
        if (!formIds.has(fid)) throw new Error(`Unknown form: ${fid}`);
        return fid;
      };
      try {
        switch (m.action) {
          case 'context':
            result = { appName, appSlug, forms: ctxForms };
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
      iframeRef.current?.contentWindow?.postMessage({ __flReply: true, id: m.id, result, error }, '*');
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [appSlug, appName, forms, user, onNavigate]);

  return (
    <iframe
      ref={iframeRef}
      title="App home"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className || 'w-full h-full border-0'}
    />
  );
}
